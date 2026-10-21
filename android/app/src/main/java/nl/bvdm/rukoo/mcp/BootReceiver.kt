package nl.bvdm.rukoo.mcp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Starts the MCP service after a reboot or an app update when phone tools are on. A shell for now. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> Unit
        }
    }
}
