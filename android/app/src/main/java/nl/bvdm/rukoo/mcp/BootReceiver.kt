package nl.bvdm.rukoo.mcp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.appContainer

/** Brings Rukoo's tools back after a reboot or an app update, when they were on (dudan's PhoneControlStarter). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        // Made on the main thread, like every other start of the app; its MCP controller follows the settings too.
        val container = context.appContainer
        val pending = goAsync()
        CoroutineScope(Dispatchers.Default).launch {
            try {
                // Read from disk: the in-memory settings may not have loaded yet in a fresh process.
                if (container.settings.current().mcpEnabled) RukooMcpService.start(context)
            } finally {
                pending.finish()
            }
        }
    }
}
