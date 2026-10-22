package nl.bvdm.rukoo.mcp

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.net.BindException
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import nl.bvdm.rukoo.MainActivity
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.appContainer
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.ui.Notifications

/**
 * Keeps Rukoo's MCP server listening on the Tailscale address while "Let agents use Rukoo on this phone" is on
 * (a port of dudan's PhoneControlService). It is a foreground service so Android neither freezes the process nor
 * cuts its network while the phone idles; its notification is silent and says where it listens and for whom.
 */
class RukooMcpService : Service() {
    private val scope = MainScope()
    private var runtime: McpRuntime? = null
    private var starting: Job? = null
    private var shown: Pair<String?, List<String>>? = null

    override fun onBind(intent: Intent?): IBinder? = null

    private val controller: AndroidMcpController? get() = appContainer.mcp as? AndroidMcpController

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val control = controller
        try {
            // Android 14 introduced the specialUse type; before that a foreground service needs none.
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
            ServiceCompat.startForeground(this, Notifications.SERVICE_NOTIFICATION_ID, notification(control?.status?.value ?: McpStatus()), type)
        } catch (e: Exception) {
            // Android refuses when Rukoo is in the background; the next time it is on screen retries.
            AppLog.w(TAG, "could not start in the foreground", e)
            control?.backgroundRefused()
            stopSelf()
            return START_NOT_STICKY
        }
        if (control == null || !control.wanted()) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_RESTART) {
            // A new port or a new debug address: a new socket, in this same service.
            starting?.cancel()
            watchers.forEach { it.cancel() }
            watchers.clear()
            runtime?.stop()
            runtime = null
            control.stopped()
        }
        if (runtime == null && starting?.isActive != true) starting = scope.launch { startServer(control) }
        return START_STICKY
    }

    private val watchers = mutableListOf<Job>()

    private suspend fun startServer(control: AndroidMcpController) {
        val port = control.port()
        val candidate = control.runtime(port)
        try {
            withContext(Dispatchers.IO) { candidate.start() }
        } catch (e: CancellationException) {
            // Turned off while the socket was opening: onDestroy has run and won't see this server.
            candidate.stop()
            throw e
        } catch (e: BindException) {
            AppLog.w(TAG, "port $port is in use", e)
            control.failed(McpStatus.ERROR_PORT_IN_USE, port, null)
            stopSelf()
            return
        } catch (e: IOException) {
            AppLog.w(TAG, "could not listen on port $port", e)
            control.failed(McpStatus.ERROR_FAILED, port, e.javaClass.simpleName)
            stopSelf()
            return
        }
        runtime = candidate
        control.listening(candidate.server.localPort)
        // Tailscale can come up, go away or change address while the server runs: the status and the notification
        // follow it. The server itself needs no rebind, since it filters per connection.
        watchers += scope.launch {
            while (isActive) {
                control.refreshAddress()
                delay(ADDRESS_POLL_MS)
            }
        }
        watchers += scope.launch {
            control.status.map { (it.advertised ?: it.address) to it.agents }.distinctUntilChanged().collect { update(it) }
        }
    }

    private fun update(state: Pair<String?, List<String>>) {
        if (state == shown) return
        shown = state
        val manager = getSystemService(NotificationManager::class.java) ?: return
        runCatching { manager.notify(Notifications.SERVICE_NOTIFICATION_ID, notification(controller?.status?.value ?: McpStatus())) }
    }

    private fun notification(status: McpStatus): Notification {
        val open = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return NotificationCompat.Builder(this, Notifications.CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(getString(R.string.mcp_notification_title))
            .setContentText(McpTexts.notification(this, status))
            .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE))
            .setOngoing(true)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    override fun onDestroy() {
        runtime?.stop()
        runtime = null
        controller?.stopped()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "Mcp"
        private const val ADDRESS_POLL_MS = 10_000L
        private const val ACTION_RESTART = "nl.bvdm.rukoo.mcp.RESTART"

        /** Asks Android to start the service; false when it refused (Rukoo in the background). */
        fun start(context: Context, restart: Boolean = false): Boolean = try {
            val intent = Intent(context, RukooMcpService::class.java)
            if (restart) intent.action = ACTION_RESTART
            ContextCompat.startForegroundService(context, intent)
            true
        } catch (e: IllegalStateException) {
            AppLog.w(TAG, "not allowed to start from the background", e)
            false
        } catch (e: SecurityException) {
            AppLog.w(TAG, "not allowed to start", e)
            false
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RukooMcpService::class.java))
        }
    }
}
