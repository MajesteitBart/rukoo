package nl.bvdm.rukoo.workspaces

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import nl.bvdm.rukoo.appContainer
import nl.bvdm.rukoo.core.AppLog

/**
 * Runs ChatPush again when a PUT or DELETE of the push endpoint failed for a reason that passes (429, 503, no
 * network), after Retry-After or the backoff, and when a registration with the distributor is due again. One unique
 * job with a network, apart from ChatSyncWorker, which runs only while a workspace is cached: a phone that just signed
 * in and closed Rukoo still gets its endpoint to the server.
 */
class PushRetryWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        try {
            applicationContext.appContainer.push.run()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            AppLog.w(TAG, "Push retry failed", e)
        }
        return Result.success()
    }

    companion object {
        private const val TAG = "PushRetryWorker"
        const val WORK_NAME = "rukoo-push-retry"

        /**
         * Runs ChatPush after [delayMs] with a network, replacing a retry already planned, so they never pile up. null
         * takes back a planned retry that hasn't started; one that runs finishes, as it may be the caller.
         */
        fun schedule(context: Context, delayMs: Long?) {
            try {
                val work = WorkManager.getInstance(context)
                if (delayMs == null) {
                    val waiting = work.getWorkInfosForUniqueWork(WORK_NAME).get().any { it.state == WorkInfo.State.ENQUEUED }
                    if (waiting) work.cancelUniqueWork(WORK_NAME)
                    return
                }
                val request = OneTimeWorkRequestBuilder<PushRetryWorker>()
                    .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .build()
                work.enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request)
            } catch (e: IllegalStateException) {
                AppLog.w(TAG, "WorkManager unavailable for a push retry", e)
            }
        }
    }
}
