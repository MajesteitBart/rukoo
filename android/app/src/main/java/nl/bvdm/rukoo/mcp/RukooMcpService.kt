package nl.bvdm.rukoo.mcp

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * The foreground service (type specialUse) that keeps Rukoo's MCP server listening on the Tailscale
 * address while the app is in the background. A shell for now: nothing starts it yet.
 */
class RukooMcpService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        stopSelf(startId)
        return START_NOT_STICKY
    }
}
