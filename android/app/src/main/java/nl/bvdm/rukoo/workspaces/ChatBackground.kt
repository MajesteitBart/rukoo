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
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
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
 * - **Phone tools.** While Phone tools' foreground service runs ([phoneTools]) and the phone has a network, the
 *   service keeps team chat connected in the background as well ([WorkspaceService.stayConnected]). Android keeps a
 *   process with a foreground service running, so the sockets can stay open; without a network they close, and they
 *   open again when one comes up.
 * - **Background.** [ChatSyncWorker] runs every 15 minutes with a network, as unique periodic work, scheduled only
 *   while a workspace is cached and cancelled when the account, followed at least once, has none: signed out, team
 *   chat off, no cache or no workspace. It keeps running in Phone tools' window too, for when the service stops.
 */
class ChatBackground(
    private val context: Context,
    private val scope: CoroutineScope,
    private val service: () -> WorkspaceService,
    /** Whether Phone tools' foreground service runs: its server listens (McpStatus.running). */
    private val phoneTools: Flow<Boolean>,
) {
    @Volatile private var started = false

    // Whether the phone has a default network; true until the callback says otherwise, or when it can't be watched.
    private val online = MutableStateFlow(true)

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
        // hasWorkspaces stays silent until the service followed the account, so a process WorkManager started for
        // ChatSyncWorker doesn't cancel that worker on the empty first state, and an app start keeps the work's schedule.
        scope.launch(Dispatchers.Default) {
            service().hasWorkspaces.collect { schedule(it) }
        }
        watchNetwork()
        scope.launch(Dispatchers.Default) {
            combine(phoneTools, online) { tools, net -> stayConnected(tools, net) }.distinctUntilChanged().collect { service().stayConnected(it) }
        }
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
        val tracker = DefaultNetwork<Network>()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                online.value = tracker.available(network)
                if (ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) service().nudge()
            }

            override fun onLost(network: Network) {
                online.value = tracker.lost(network)
            }
        }
        try {
            // Before the callback, so a phone without a network starts offline; the callback's first onAvailable follows.
            online.value = connectivity.activeNetwork != null
            connectivity.registerDefaultNetworkCallback(callback)
        } catch (e: RuntimeException) {
            // Too many callbacks or no permission: the 60 s runs still catch up, and the window counts as online.
            online.value = true
            AppLog.w(TAG, "No network callback", e)
        }
    }

    /**
     * The default network as its callback reports it. When the default moves from one network to another, the new
     * one's onAvailable can come before or after the old one's onLost; only losing the current one is going offline.
     */
    internal class DefaultNetwork<N : Any> {
        private var current: N? = null

        /** [network] is the default now: online. */
        @Synchronized
        fun available(network: N): Boolean {
            current = network
            return true
        }

        /** [network] went: offline only when it was the current default. Returns whether the phone is online. */
        @Synchronized
        fun lost(network: N): Boolean {
            if (current == network) current = null
            return current != null
        }
    }

    companion object {
        private const val TAG = "ChatBackground"

        /** The wait before the next foreground run: [ChatTiming.catchUpEvery] ± [ChatTiming.catchUpJitter]. */
        fun catchUpDelay(timing: ChatTiming, random: Double = ThreadLocalRandom.current().nextDouble()): Long =
            timing.catchUpEvery + Math.round((random * 2 - 1) * timing.catchUpJitter)

        /** Team chat stays connected in the background while Phone tools runs and the phone has a network. */
        fun stayConnected(phoneTools: Boolean, online: Boolean): Boolean = phoneTools && online
    }
}
