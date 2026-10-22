package nl.bvdm.rukoo.mail.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import nl.bvdm.rukoo.appContainer
import nl.bvdm.rukoo.core.AppLog

/**
 * The background sync WorkManager runs every 15 minutes with a network (Android's minimum interval):
 * every account syncs, and new inbox mail is announced through [MailNotifier].
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        return try {
            applicationContext.appContainer.mail.refresh(null)
            Result.success()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // A failing account shows its error in the app; the next period tries again.
            AppLog.w("SyncWorker", "background sync failed", e)
            Result.success()
        }
    }
}
