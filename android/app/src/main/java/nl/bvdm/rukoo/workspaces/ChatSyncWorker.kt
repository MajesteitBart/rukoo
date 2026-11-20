package nl.bvdm.rukoo.workspaces

import android.content.Context
import androidx.work.CoroutineWorker
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
 * Android's 15-minute minimum and the phone's battery management make this best-effort, so a mention can arrive late
 * until a push relay exists (contract §1.4).
 */
class ChatSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        try {
            val ran = applicationContext.appContainer.workspaces.backgroundCatchUp(BUDGET_MS)
            AppLog.i(TAG, if (ran == null) "Chat catch-up skipped: no team chat session" else "Chat catch-up ran $ran workspaces")
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
    }
}
