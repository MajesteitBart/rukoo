package nl.bvdm.rukoo.workspaces

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import nl.bvdm.rukoo.appContainer
import nl.bvdm.rukoo.core.AppLog

/**
 * Team chat's background catch-up, which WorkManager runs every 15 minutes with a network as unique periodic work
 * [WORK_NAME] (ChatBackground schedules it while a workspace is cached). It lists the workspaces, runs the most
 * recently active ones until their feeds have no more pages, sends what the outbox holds, and alerts the rooms that
 * ask for it, all within [BUDGET_MS]. It always succeeds, as SyncWorker does: errors show in the app.
 *
 * Android's 15-minute minimum and the phone's battery management make this best-effort. With a UnifiedPush distributor
 * on the phone, a push wake runs the same catch-up at once as one-time work [PUSH_WORK] ([runNow], ChatPush), and the
 * periodic run stays as the fallback. Each run also lets ChatPush send the server its endpoint again when that is due.
 */
class ChatSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        try {
            val container = applicationContext.appContainer
            // Workspaces a push wake named run first, and a wake that comes in meanwhile makes it run once more.
            container.push.catchUpRounds { first ->
                val ran = container.workspaces.backgroundCatchUp(BUDGET_MS, first)
                AppLog.i(TAG, if (ran == null) "Chat catch-up skipped: no team chat session" else "Chat catch-up ran $ran workspaces")
            }
            container.push.run()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            AppLog.w(TAG, "Background chat catch-up failed", e)
        }
        return Result.success()
    }

    companion object {
        private const val TAG = "ChatSyncWorker"

        /** The unique periodic work's name. */
        const val WORK_NAME = "rukoo-chat-sync"

        /** How long one catch-up may take, the outbox included. */
        const val BUDGET_MS = 60_000L

        /** The one-time work a push wake starts. */
        const val PUSH_WORK = "rukoo-chat-push"

        /**
         * Runs the catch-up now, for a push wake: expedited while Android gives Rukoo the quota, as it does for a few
         * seconds after a distributor delivered a high-priority message, else as soon as it can. A run that is going
         * on is never cancelled: a newer wake queues one more run after it, and the run going on sees the wake too
         * (ChatPush.catchUpRounds).
         */
        fun runNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<ChatSyncWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            try {
                WorkManager.getInstance(context).enqueueUniqueWork(PUSH_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
            } catch (e: IllegalStateException) {
                AppLog.w(TAG, "WorkManager unavailable for a push wake", e)
            }
        }
    }
}
