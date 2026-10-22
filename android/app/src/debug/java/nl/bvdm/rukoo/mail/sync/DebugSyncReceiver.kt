package nl.bvdm.rukoo.mail.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.appContainer

/**
 * Debug builds only: `adb shell am broadcast -n nl.bvdm.rukoo.debug/nl.bvdm.rukoo.mail.sync.DebugSyncReceiver`
 * syncs the way SyncWorker does, also from a stopped process, so new-mail notifications can be tested without
 * waiting for WorkManager's 15-minute period. Only senders holding DUMP (adb's shell, never an app) get through.
 */
class DebugSyncReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val done = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.Default).launch {
            try {
                runCatching { context.appContainer.mail.refresh(null) }
            } finally {
                done.finish()
            }
        }
    }
}
