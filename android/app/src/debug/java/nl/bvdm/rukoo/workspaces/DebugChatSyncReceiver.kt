package nl.bvdm.rukoo.workspaces

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager

/**
 * Debug builds only: `adb shell am broadcast -n nl.bvdm.rukoo.debug/nl.bvdm.rukoo.workspaces.DebugChatSyncReceiver`
 * runs ChatSyncWorker once, also from a stopped process, so team chat's background catch-up and its alerts can be
 * tested without waiting for WorkManager's 15-minute period. Only senders holding DUMP (adb's shell, never an app) get
 * through. The catch-up runs as work, not in the broadcast, so a slow server can't hold the receiver past its deadline.
 */
class DebugChatSyncReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<ChatSyncWorker>().build())
    }
}
