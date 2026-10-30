package nl.bvdm.rukoo.mail.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import nl.bvdm.rukoo.account.AccountBackground
import nl.bvdm.rukoo.appContainer
import nl.bvdm.rukoo.core.AppLog

/**
 * The background sync WorkManager runs every 15 minutes with a network (Android's minimum interval):
 * every account syncs, and new inbox mail is announced through [MailNotices] and [MailNotifier].
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        return try {
            val container = applicationContext.appContainer
            try {
                container.mail.refresh(null)
            } finally {
                // The new mail's categories, and what other devices sorted, travel with every background sync.
                AccountBackground.afterMailSync(container.account, container.categories)
                // A notification waiting for Jev's category, while a category is muted, shows before the work ends:
                // Android may end the process soon after. The sort above asked Jev; the wait itself is at most HOLD.
                container.mailNotices?.let { notices -> withTimeoutOrNull(MailNotices.HOLD + SETTLE_SLACK_MS) { notices.settle() } }
            }
            Result.success()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // A failing account shows its error in the app; the next period tries again.
            AppLog.w("SyncWorker", "background sync failed", e)
            Result.success()
        }
    }

    private companion object {
        const val SETTLE_SLACK_MS = 5_000L
    }
}
