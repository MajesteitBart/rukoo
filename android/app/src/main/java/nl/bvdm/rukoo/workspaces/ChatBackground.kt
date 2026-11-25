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
            windowWanted(phoneTools, network.state, NETWORK_SETTLE).collect { service().stayConnected(it) }
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
     * What [DefaultNetwork] says about the default network. [usable]: it reported both its capabilities and its blocked
     * status, and has internet, isn't suspended and isn't blocked. [pending]: a new default said onAvailable and hasn't
     * reported both yet. [losses] goes up whenever a usable stretch ends, so a loss and recovery that a collector never
     * saw still shows.
     */
    internal data class NetState(val usable: Boolean = false, val pending: Boolean = false, val losses: Int = 0)

    /**
     * The phone's default network as its callback reports it (ConnectivityManager.NetworkCallback), and whether
     * Android says it is usable: a default network whose capabilities include internet and not suspended, and whose
     * access isn't blocked. Until the callback says so, and for good when it can't be watched, it isn't.
     *
     * Since Android 8, onAvailable is followed at once by onCapabilitiesChanged and onBlockedStatusChanged, so a new
     * default counts once both came, and until then it is [NetState.pending], not usable. When the default moves to
     * another network, the default callback sends the new one's onAvailable and no onLost for the old one; an onLost for
     * a network that isn't the current one is ignored. The old network is remembered only to tell a handoff: a move from
     * one usable network to another without a loss between, which [capabilities] and [blocked] return.
     */
    internal class DefaultNetwork<N : Any> {
        private val _state = MutableStateFlow(NetState())
        val state: StateFlow<NetState> = _state.asStateFlow()

        private var watched = true
        private var current: N? = null

        // What the current network reported; null until it did.
        private var capable: Boolean? = null
        private var blocked: Boolean? = null

        // The network the current usable stretch was last usable on, or null after a loss: for telling a handoff only.
        private var usableOn: N? = null
        private var losses = 0

        /** [network] is the default now; it counts once its capabilities and blocked status come. */
        @Synchronized
        fun available(network: N) {
            if (!watched || network == current) return
            current = network
            capable = null
            blocked = null
            report()
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
            capable = null
            blocked = null
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
            val net = current?.takeIf { watched }
            val pending = net != null && (capable == null || blocked == null)
            val now = net?.takeIf { capable == true && blocked == false }
            val handoff = now != null && usableOn != null && usableOn != now
            when {
                now != null -> usableOn = now
                // A new default that hasn't reported both keeps the stretch open, for telling a handoff.
                pending -> Unit
                usableOn != null -> {
                    usableOn = null
                    losses++
                }
            }
            _state.value = NetState(usable = now != null, pending = pending, losses = losses)
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
         * once and opens only once both have held for [settle], so changes within that time come to nothing. A loss the
         * flow folded into a recovery ([NetState.losses]) closes it and starts the settle again. While a new default
         * network reports itself ([NetState.pending]) an open window stays open, for a handoff, and closes when that
         * takes longer than [settle].
         */
        internal fun windowWanted(phoneTools: Flow<Boolean>, network: Flow<NetState>, settle: Long): Flow<Boolean> = channelFlow {
            // The loss count the window opened at, or null while it is closed.
            var openAt: Int? = null
            combine(phoneTools, network) { tools, net -> tools to net }.distinctUntilChanged().collectLatest { (tools, net) ->
                val at = openAt
                when {
                    tools && net.usable -> {
                        if (at == net.losses) return@collectLatest
                        if (at != null) {
                            openAt = null
                            send(false)
                        }
                        delay(settle)
                        openAt = net.losses
                        send(true)
                    }
                    tools && net.pending && at != null -> {
                        delay(settle)
                        openAt = null
                        send(false)
                    }
                    else -> {
                        openAt = null
                        send(false)
                    }
                }
            }
        }.distinctUntilChanged()
    }
}
