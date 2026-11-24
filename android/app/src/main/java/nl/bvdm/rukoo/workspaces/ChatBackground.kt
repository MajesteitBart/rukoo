package nl.bvdm.rukoo.workspaces

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
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
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.collectLatest
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
 * - **Phone tools.** While Phone tools' foreground service runs ([phoneTools]) and Android says the default network
 *   is usable ([DefaultNetwork]), the service keeps team chat connected in the background as well
 *   ([WorkspaceService.stayConnected]). The window closes at once when the network goes, is blocked or can't be
 *   watched, and opens again only after the network has been usable for [NETWORK_SETTLE], so a network that comes
 *   and goes doesn't open and close it each time. A default network that moves to another usable one runs the
 *   service's catch-up once ([WorkspaceService.networkMoved]).
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

    private val network = DefaultNetwork<Network>()

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
            windowWanted(phoneTools, network.usable, NETWORK_SETTLE).collect { service().stayConnected(it) }
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
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        if (connectivity == null) {
            network.unwatched()
            AppLog.w(TAG, "No connectivity service: Phone tools' window stays closed")
            return
        }
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                this@ChatBackground.network.available(network)
                if (ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) service().nudge()
            }

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                val ok = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_SUSPENDED)
                if (this@ChatBackground.network.capabilities(network, ok)) service().networkMoved()
            }

            override fun onBlockedStatusChanged(network: Network, blocked: Boolean) {
                if (this@ChatBackground.network.blocked(network, blocked)) service().networkMoved()
            }

            override fun onLost(network: Network) {
                this@ChatBackground.network.lost(network)
            }
        }
        try {
            connectivity.registerDefaultNetworkCallback(callback)
        } catch (e: RuntimeException) {
            // Too many callbacks or no permission: the foreground's 60 s runs still catch up; the window stays closed.
            network.unwatched()
            AppLog.w(TAG, "No network callback: Phone tools' window stays closed", e)
        }
    }

    /**
     * The phone's default network as its callback reports it (ConnectivityManager.NetworkCallback), and whether
     * Android says it is usable: a default network whose capabilities include internet and not suspended, and whose
     * access isn't blocked. Until the callback says so, and for good when it can't be watched, it isn't.
     *
     * Since Android 8, onAvailable is followed at once by onCapabilitiesChanged and onBlockedStatusChanged, so a new
     * default is judged on those. When the default moves to another network, the default callback sends the new one's
     * onAvailable and no onLost for the old one; an onLost for a network that isn't the current one is ignored. A move
     * from one usable network to another without a gap is a handoff, which [capabilities] and [blocked] return.
     */
    internal class DefaultNetwork<N : Any> {
        private val _usable = MutableStateFlow(false)
        val usable: StateFlow<Boolean> = _usable.asStateFlow()

        private var watched = true
        private var current: N? = null
        private var capable = false
        private var blocked = false

        // The network last reported usable, or null when none was.
        private var usableOn: N? = null

        /** [network] is the default now; it counts once its capabilities come. */
        @Synchronized
        fun available(network: N) {
            if (!watched || network == current) return
            current = network
            capable = false
            blocked = false
        }

        /** The default's capabilities: [ok] when it has internet and isn't suspended. Returns whether it's a handoff. */
        @Synchronized
        fun capabilities(network: N, ok: Boolean): Boolean {
            if (!watched || network != current) return false
            capable = ok
            return report()
        }

        /** Android blocked or unblocked the default's access, as in Data Saver or a firewall. Returns whether it's a handoff. */
        @Synchronized
        fun blocked(network: N, blocked: Boolean): Boolean {
            if (!watched || network != current) return false
            this.blocked = blocked
            return report()
        }

        /** No default network any more, when [network] was it. */
        @Synchronized
        fun lost(network: N) {
            if (!watched || network != current) return
            current = null
            report()
        }

        /** The network can't be watched: not usable, from now on. */
        @Synchronized
        fun unwatched() {
            watched = false
            current = null
            report()
        }

        private fun report(): Boolean {
            val now = current?.takeIf { watched && capable && !blocked }
            val handoff = usableOn != null && now != null && usableOn != now
            usableOn = now
            _usable.value = now != null
            return handoff
        }
    }

    companion object {
        private const val TAG = "ChatBackground"

        /** How long the default network must stay usable before Phone tools' window opens again. */
        const val NETWORK_SETTLE = 5_000L

        /** The wait before the next foreground run: [ChatTiming.catchUpEvery] ± [ChatTiming.catchUpJitter]. */
        fun catchUpDelay(timing: ChatTiming, random: Double = ThreadLocalRandom.current().nextDouble()): Long =
            timing.catchUpEvery + Math.round((random * 2 - 1) * timing.catchUpJitter)

        /**
         * Whether Phone tools' window should be open: while Phone tools runs and the network is usable. It closes at
         * once and opens only once both have held for [settle], so changes within that time come to nothing.
         */
        fun windowWanted(phoneTools: Flow<Boolean>, usable: Flow<Boolean>, settle: Long): Flow<Boolean> = channelFlow {
            combine(phoneTools, usable) { tools, net -> tools && net }.distinctUntilChanged().collectLatest { open ->
                if (open) delay(settle)
                send(open)
            }
        }.distinctUntilChanged()
    }
}
