package nl.bvdm.rukoo.workspaces

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.core.AppLog

/**
 * When team chat syncs without the person asking (contract §3.11, android.md "Foreground, background and resume").
 *
 * - **Foreground.** While the app is started ([ProcessLifecycleOwner]): on resume the service runs its workspaces,
 *   lists again at most once a minute, opens the socket for the workspace on screen and kicks the outbox
 *   ([WorkspaceService.resumed]); then every 60 s ± 10 s every workspace runs ([WorkspaceService.catchUp]), which
 *   catches dropped wakes and renews the socket's lease. On stop the socket closes ([WorkspaceService.paused]).
 * - **Network.** A network that comes back while the app is in the foreground counts as a resume
 *   ([WorkspaceService.nudge]): runs, the socket and the outbox try at once.
 * - **Background.** [ChatSyncWorker] runs every 15 minutes with a network, as unique periodic work, scheduled only
 *   while a workspace is cached and cancelled when none is.
 */
class ChatBackground(
    private val context: Context,
    private val scope: CoroutineScope,
    private val service: () -> WorkspaceService,
) {
    @Volatile private var started = false

    fun start() {
        if (started) return
        started = true
        scope.launch(Dispatchers.Main) {
            ProcessLifecycleOwner.get().lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                val chat = service()
                chat.resumed()
                try {
                    while (true) {
                        delay(catchUpDelay(chat.timing))
                        chat.catchUp()
                    }
                } finally {
                    chat.paused()
                }
            }
        }
        scope.launch(Dispatchers.Default) {
            service().hasWorkspaces.collect { schedule(it) }
        }
        watchNetwork()
    }

    /** Starts or stops ChatSyncWorker, depending on whether a workspace is cached. */
    fun schedule(hasWorkspaces: Boolean) {
        val work = try {
            WorkManager.getInstance(context)
        } catch (e: IllegalStateException) {
            AppLog.w(TAG, "WorkManager unavailable", e)
            return
        }
        if (!hasWorkspaces) {
            work.cancelUniqueWork(ChatSyncWorker.WORK_NAME)
            return
        }
        val request = PeriodicWorkRequestBuilder<ChatSyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        work.enqueueUniquePeriodicWork(ChatSyncWorker.WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    private fun watchNetwork() {
        val connectivity = context.getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) service().nudge()
            }
        }
        try {
            connectivity.registerDefaultNetworkCallback(callback)
        } catch (e: RuntimeException) {
            // Too many callbacks or no permission: the 60 s runs still catch up.
            AppLog.w(TAG, "No network callback", e)
        }
    }

    companion object {
        private const val TAG = "ChatBackground"

        /** The wait before the next foreground run: [ChatTiming.catchUpEvery] ± [ChatTiming.catchUpJitter]. */
        fun catchUpDelay(timing: ChatTiming, random: Double = ThreadLocalRandom.current().nextDouble()): Long =
            timing.catchUpEvery + Math.round((random * 2 - 1) * timing.catchUpJitter)
    }
}
