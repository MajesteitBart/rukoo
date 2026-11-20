package nl.bvdm.rukoo.workspaces

import androidx.sqlite.SQLiteDriver
import java.io.File
import java.net.URI
import java.text.Collator
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel as Queue
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.onSubscription
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import nl.bvdm.rukoo.account.AccountService
import nl.bvdm.rukoo.account.AccountStatus
import nl.bvdm.rukoo.account.BorrowedSession
import nl.bvdm.rukoo.account.ServerInfo
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.ui.ScreenState
import okhttp3.OkHttpClient

/** What the workspace service needs of the Rukoo account (contract §3.1, §3.4); [AccountChat] gives it from AccountService. */
internal interface ChatAccount {
    /** The account's status: signed in, the configured server and its saved `GET /v1/info`. */
    val status: StateFlow<AccountStatus>

    /** Once per end of a session: sign-out, a 401, deletion. */
    val sessionEnded: SharedFlow<Unit>

    fun borrowSession(): BorrowedSession?

    fun sessionRefused(session: BorrowedSession)

    /** `GET /v1/info` again; the account keeps the answer, and [status] carries it. */
    suspend fun refreshInfo()
}

/** [ChatAccount] over the app's AccountService, which is made on first use, off the main thread. */
internal class AccountChat(private val account: () -> AccountService) : ChatAccount {
    override val status: StateFlow<AccountStatus> get() = account().status
    override val sessionEnded: SharedFlow<Unit> get() = account().sessionEnded
    override fun borrowSession(): BorrowedSession? = account().borrowSession()
    override fun sessionRefused(session: BorrowedSession) {
        account().sessionRefused(session)
    }
    override suspend fun refreshInfo() {
        account().serverInfo()
    }
}

/** A wake socket as the service drives it; [OkHttpChatSockets] makes [WorkspaceSocket]s, tests make fakes. */
interface ChatSocket {
    val state: StateFlow<SocketState>
    fun start()
    fun stop()
    fun nudge()
}

fun interface ChatSockets {
    fun open(url: String, ticket: suspend () -> SocketTicket, listener: WorkspaceSocket.Listener, scope: CoroutineScope): ChatSocket
}

/** [WorkspaceSocket]s on a client derived from the app's shared one. */
class OkHttpChatSockets(private val client: OkHttpClient, private val timing: WorkspaceSocket.Timing = WorkspaceSocket.Timing()) : ChatSockets {
    override fun open(url: String, ticket: suspend () -> SocketTicket, listener: WorkspaceSocket.Listener, scope: CoroutineScope): ChatSocket {
        val socket = WorkspaceSocket(client, url, ticket, listener, scope, timing)
        return object : ChatSocket {
            override val state: StateFlow<SocketState> get() = socket.state
            override fun start() = socket.start()
            override fun stop() = socket.stop()
            override fun nudge() = socket.nudge()
        }
    }
}

/** The service's waits (contract §3.11, §3.19), in milliseconds; tests make them short. */
data class ChatTiming(
    val sync: SyncTiming = SyncTiming(),
    val outbox: Outbox.Timing = Outbox.Timing(),
    /** `LIST_EVERY`: `GET /v1/workspaces` while signed in. */
    val listEvery: Long = 30 * MINUTE,
    /** On resume, at most one listing this often. */
    val listResumeGap: Long = MINUTE,
    /** `INFO_EVERY`: `GET /v1/info` while signed in. */
    val infoEvery: Long = HOUR,
    /** On resume the selected workspace runs at once, at most this often; the others spread over [resumeSpread]. */
    val resumeRunGap: Long = 5 * SECOND,
    val resumeSpread: Long = 10 * SECOND,
    /** ChatBackground's runs in the foreground: every 60 s ± 10 s. */
    val catchUpEvery: Long = MINUTE,
    val catchUpJitter: Long = 10 * SECOND,
    /** Writes that meet a 429 try again after `Retry-After`, this many times in all within [writeRetryWindow]. */
    val writeRetries: Int = 3,
    val writeRetryWindow: Long = 30 * SECOND,
    /** `NOTIFY_ROOMS`. */
    val notifyRooms: Int = ChatAlertRules.NOTIFY_ROOMS,
    /** ChatSyncWorker: the most recently active workspaces it runs. */
    val workerWorkspaces: Int = 10,
    /** A socket closed with 4003 whose `GET /` failed on the network tries again after this. */
    val socketRecheck: Long = 5 * SECOND,
) {
    companion object {
        const val SECOND = 1_000L
        const val MINUTE = 60 * SECOND
        const val HOUR = 60 * MINUTE
    }
}

/**
 * Team chat on the phone (contract §3, §7.2): [Workspaces] over the chat cache ([WorkspaceStore]), the workspace
 * routes ([WorkspaceClient]), one [WorkspaceSync] per workspace (feed, history, reads), the [Outbox], a wake socket
 * and the alerts ([ChatAlertEngine]).
 *
 * **Following the account (§3.1, §3.4).** Chat is `available` when the configured server's saved `GET /v1/info` lists
 * `workspaces-v1` and protocol 1; without it nothing here makes a request. The cache is one file per signed-in
 * session, `filesDir/chat/chat.db`, tagged with the session. Signed out, it is deleted. Signed in with a file of
 * another session or server, it is deleted and made again; with a matching one it shows at once and syncs in the
 * background. Every end of a session deletes it: sign-out, a 401 from any route, deletion, a server change. Each
 * session's work runs in its own scope ([Live]), which the end cancels, so a late answer never touches the next
 * session's cache.
 *
 * **The network.** `GET /v1/workspaces` at start, every 30 minutes, on resume (at most once a minute), after a
 * workspace was made, joined, left, deleted or removed. A new ID gets a row and a pass; one the listing leaves out is
 * asked `GET /`, whose 404 removes it, so absence alone never removes one. While the app is in the foreground, the
 * workspace on screen keeps a wake socket. [ChatBackground] runs every workspace every 60 s in the foreground and
 * [ChatSyncWorker] every 15 minutes in the background. Every write that changes shared state asks for a run, so the
 * feed confirms what changed; the writes whose result the UI opens next wait for that run.
 *
 * **Alerts.** After each run, [ChatAlertEngine] alerts due rooms and takes back what was read or removed.
 */
class WorkspaceService internal constructor(
    private val account: ChatAccount,
    private val http: WorkspaceHttp,
    /** The cache file: `ChatDb.fileIn(filesDir)`. */
    private val file: File,
    private val driver: SQLiteDriver,
    /** Null where no socket can be opened (tests that don't need one). */
    private val sockets: ChatSockets?,
    scope: CoroutineScope,
    private val settings: StateFlow<AppSettings>,
    private val screen: ScreenState,
    sink: ChatAlertSink,
    words: () -> ChatAlertWords,
    private val clock: Clock = Clock.System,
    val timing: ChatTiming = ChatTiming(),
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val random: () -> Double = { ThreadLocalRandom.current().nextDouble() },
) : Workspaces {
    private val scope = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]))
    private val lifecycle = Mutex()
    private val liveFlow = MutableStateFlow<Live?>(null)
    private val live: Live? get() = liveFlow.value

    @Volatile private var info: ServerInfo? = null
    @Volatile private var configured = ""
    @Volatile private var signedIn = false
    @Volatile private var available = false
    @Volatile private var storage = true

    // Unsent messages broken cache files took with them, until the UI takes the count (§3.4).
    private val lostUnsent = AtomicInteger()
    @Volatile private var followed: String? = null
    @Volatile private var pending: PendingJoin? = null
    @Volatile private var foreground = false
    @Volatile private var onScreenNow = OnScreen()
    @Volatile private var started = false

    /** Goes up at every end of a session; work of an older one is dropped. */
    @Volatile var epoch = 0
        private set

    private val ready = CompletableDeferred<Unit>()

    // Goes up whenever a workspace's sync is made or dropped, so the flows find the current one.
    private val syncVersion = MutableStateFlow(0)
    private val stateTicks = Queue<Unit>(Queue.CONFLATED)
    private val _state = MutableStateFlow(ChatState(notifications = settings.value.notifyChat))
    override val state: StateFlow<ChatState> = _state.asStateFlow()

    // Whether ChatSyncWorker should be scheduled, from states computed after the service followed the account once:
    // null before that, as the first state (signed out, no workspaces) says nothing about the account.
    private val scheduled = MutableStateFlow<Boolean?>(null)

    private val alerts = ChatAlertEngine(sink, words, { settings.value.notifyChat }, ::isOnScreen, timing.notifyRooms)

    private data class PendingJoin(val link: InviteLink, val tag: String)

    private data class OnScreen(val ws: String? = null, val room: String? = null, val thread: String? = null)

    private class LiveSocket(val ws: String, val socket: ChatSocket, val watch: Job)

    /** Starts following the account and the timers. Returns this. */
    fun start(): WorkspaceService {
        if (started) return this
        started = true
        scope.launch {
            for (tick in stateTicks) {
                try {
                    // Read before computing: a state begun before the first follow ended may miss the account.
                    val followedOnce = ready.isCompleted
                    val s = computeState()
                    _state.value = s
                    if (followedOnce) scheduled.value = s.signedIn && s.available && s.workspaces.isNotEmpty()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    AppLog.w(TAG, "Chat state failed", e)
                }
            }
        }
        scope.launch { account.status.collect { follow() } }
        scope.launch { account.sessionEnded.collect { follow() } }
        scope.launch { settings.map { it.notifyChat }.distinctUntilChanged().collect { stateChanged() } }
        scope.launch {
            while (true) {
                delay(timing.listEvery)
                if (isLive()) quietly { list() }
            }
        }
        scope.launch {
            while (true) {
                delay(timing.infoEvery)
                if (signedIn) refreshInfo()
            }
        }
        return this
    }

    /** Stops everything this service started; the cache stays on disk. For tests and a process that ends. */
    suspend fun close() {
        lifecycle.withLock {
            val l = liveFlow.value
            liveFlow.value = null
            if (l != null) {
                l.shutdown()
                try {
                    l.store.close()
                } catch (e: Exception) {
                    // Closing is best effort; the file stays for the next start.
                }
            }
        }
        scope.cancel()
    }

    /** Waits until the service followed the account once, for the background worker in a process that just started. */
    suspend fun awaitReady(timeoutMs: Long = READY_WAIT): Boolean = withTimeoutOrNull(timeoutMs) { ready.await() } != null

    // ---- following the account (§3.1, §3.4) ----

    private fun isLive(): Boolean {
        val l = live
        return l != null && !l.closed && signedIn && available
    }

    // The account said something: a sign-in, a sign-out, another server, new server info. Only the signature of
    // signed in, server and session tag changes the cache; availability starts or stops the network.
    private suspend fun follow() = lifecycle.withLock {
        val status = account.status.value
        val session = account.borrowSession()
        val sig = if (session == null) "out\n${status.server}" else "in\n${session.server}\n${session.tag}"
        info = status.info
        configured = status.server
        val nowAvailable = status.info?.teamChat == true
        val changed = sig != followed
        val availableChanged = nowAvailable != available
        followed = sig
        signedIn = session != null
        available = nowAvailable
        if (changed) {
            endSession(signedOut = session == null)
            if (session == null) {
                discard()
            } else {
                openCache(session)
                refreshInfo()
                startNetwork()
            }
        } else if (availableChanged && session != null) {
            if (nowAvailable && live == null) openCache(session)
            if (isLive()) startNetwork() else stopNetwork()
        }
        if (!ready.isCompleted) ready.complete(Unit)
        stateChanged()
    }

    // Whatever the old session started stops: its answers are dropped, its runs and sockets end, its alerts go and
    // its cache is deleted.
    private suspend fun endSession(signedOut: Boolean) {
        epoch += 1
        val l = liveFlow.value
        liveFlow.value = null
        if (l != null) {
            l.shutdown()
            try {
                l.store.wipe()
            } catch (e: Exception) {
                AppLog.w(TAG, "The chat cache couldn't be deleted", e)
            }
        }
        // Alerts posted before this process started go when the session is known to have ended.
        if (l != null || signedOut) alerts.clear()
        syncVersion.update { it + 1 }
    }

    // Signed out: the cache file and its -wal and -shm files go, unsent messages with them.
    private suspend fun discard() {
        lostUnsent.set(0)
        storage = true
        pending = null
        withContext(io) { ChatDb.deleteFiles(file) }
    }

    // Signed in: this session's cache, made when there is none. A file of another session or server goes first.
    // Without team chat on the server an existing file is still checked, and a stranger's deleted, but none is made.
    private suspend fun openCache(session: BorrowedSession) {
        if (!available && !withContext(io) { file.exists() }) return
        val store = try {
            var store = WorkspaceStore(ChatDb.open(file, driver, io), clock::now)
            val (tag, server) = store.read { getMeta(META_SESSION) to getMeta(META_SERVER) }
            if ((tag != null && tag != session.tag) || (server != null && server != session.server)) {
                store.wipe()
                alerts.clear()
                store = WorkspaceStore(ChatDb.open(file, driver, io), clock::now)
            }
            store.tx {
                if (getMeta(META_SESSION) == null) {
                    setMeta(META_SESSION, session.tag)
                    setMeta(META_SERVER, session.server)
                }
                // A workspace parked for a newer protocol tries again once per start: this may be the newer Rukoo.
                sql.exec("UPDATE ws SET state = 'ok' WHERE state = 'upgrade'")
            }
            store
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            AppLog.w(TAG, "The chat cache couldn't be opened", e)
            storage = false
            return
        }
        storage = true
        lostUnsent.addAndGet(store.lostUnsent)
        if (pending?.tag != session.tag) pending = null
        val l = Live(session, store)
        l.selected = quietly { store.read { getMeta(META_SELECTED)?.takeIf { getWs(it) != null } } }
        quietly { l.outbox.start() }
        l.begin()
        liveFlow.value = l
        l.screenEvents.trySend(OnScreen() to onScreenNow)
    }

    private fun refreshInfo() {
        if (!signedIn) return
        scope.launch { quietly { account.refreshInfo() } }
    }

    private suspend fun startNetwork() {
        val l = live ?: return
        if (!isLive()) return
        l.scope.launch { quietly { list() } }
        for (row in quietly { l.store.read { listWs() } }.orEmpty()) {
            if (row.state == FeedApplier.STATE_OK) l.sync(row.id)?.request()
        }
        updateSockets(l)
    }

    // Team chat went off on the server: no request goes out, the outbox's queued rows and its backoff timer included.
    // The cache stays until the session ends; when team chat comes back, each workspace's first good run lets its
    // queue send again.
    private suspend fun stopNetwork() {
        val l = live ?: return
        for (row in quietly { l.store.read { listWs() } }.orEmpty()) l.outbox.forget(row.id)
        l.stopSyncs()
    }

    // ---- one session ----

    /** One signed-in session's cache and work. Its scope ends at the end of the session, with everything it started. */
    private inner class Live(val session: BorrowedSession, val store: WorkspaceStore) {
        val tag: String get() = session.tag
        val server: String get() = session.server
        private val job = SupervisorJob(this@WorkspaceService.scope.coroutineContext[Job])
        val scope = CoroutineScope(this@WorkspaceService.scope.coroutineContext + job)

        @Volatile var closed = false

        // Borrows the session at call time, and only this one: after another sign-in an old call fails with
        // signed_out instead of reaching the server as the next account.
        val client = WorkspaceClient(http, { account.borrowSession()?.takeIf { it.tag == tag } }, { account.sessionRefused(it) })
        val syncs = ConcurrentHashMap<String, WorkspaceSync>()

        /** The workspaces with a good run in this session, for the connection state. */
        val ran: MutableSet<String> = ConcurrentHashMap.newKeySet()
        val outbox = Outbox(store, client, scope, OutboxHooks(this), timing.outbox, clock::now)

        @Volatile var selected: String? = null
        @Volatile var socket: LiveSocket? = null
        val socketLock = Mutex()
        val listLock = Any()
        @Volatile var listing: Deferred<List<WorkspaceRef>?>? = null
        @Volatile var listedAt: Long? = null
        @Volatile var listError: String? = null
        val nudgedAt = ConcurrentHashMap<String, Long>()
        val screenEvents = Queue<Pair<OnScreen, OnScreen>>(Queue.UNLIMITED)

        fun begin() {
            scope.launch { store.changes.collect { stateChanged() } }
            scope.launch { for (change in screenEvents) applyScreen(this@Live, change.first, change.second) }
        }

        fun stopSyncs() {
            socket?.let {
                it.socket.stop()
                it.watch.cancel()
            }
            socket = null
            val all = syncs.values.toList()
            syncs.clear()
            for (s in all) s.close()
            syncVersion.update { it + 1 }
        }

        fun shutdown() {
            closed = true
            stopSyncs()
            outbox.close()
            screenEvents.close()
            job.cancel()
        }

        /** The workspace's sync, made on first use; null for a workspace the cache doesn't have, or without a session. */
        suspend fun sync(ws: String): WorkspaceSync? {
            if (closed || !isLive()) return null
            syncs[ws]?.let { if (!it.closed) return it }
            val exists = try {
                store.read { getWs(ws) != null }
            } catch (e: WorkspaceError) {
                false
            }
            if (!exists || closed) return null
            return synchronized(syncs) {
                syncs[ws]?.takeIf { !it.closed } ?: WorkspaceSync(ws, store, client, scope, clock, Events(this), timing.sync).also { s ->
                    syncs[ws] = s
                    s.scope.launch { s.runner.state.collect { stateChanged() } }
                    syncVersion.update { it + 1 }
                }
            }
        }
    }

    /** What the feed tells this service about one workspace. */
    private inner class Events(private val l: Live) : SyncEvents {
        override suspend fun page(ws: String, result: PageResult) = alerts.onPage(ws, result, l.store)

        override suspend fun ran(ws: String, outcome: RunOutcome) {
            l.ran += ws
            l.outbox.synced(ws)
            alerts.afterRun(ws, l.store) { room -> newest(l, ws, room) }
            l.outbox.kick(ws)
            stateChanged()
        }

        override suspend fun restored(ws: String) {
            // Unsent messages of the old generation were marked for a lookup in the restore's transaction. A restore
            // found outside a run (the outbox, a socket) needs a run for its pass; during one this asks for one more.
            l.outbox.kick(ws)
            l.syncs[ws]?.request()
        }

        override suspend fun quarantined(ws: String) {
            updateSockets(l)
            stateChanged()
        }

        override suspend fun parked(ws: String) {
            updateSockets(l)
            stateChanged()
        }

        override suspend fun removed(ws: String) = workspaceGone(l, ws)

        override suspend fun read(ws: String, room: String, readLocal: Long) = alerts.onRead(ws, room, l.store)
    }

    // A room's newest events for its alert (§3.10).
    private suspend fun newest(l: Live, ws: String, room: RoomRow): EventPage {
        val s = l.syncs[ws] ?: throw WorkspaceError("not_found", scope = "workspace")
        val page = s.call { events(ws, room.id, before = room.head + 1, limit = ChatAlertRules.FETCH) }
        FeedApplier.check(page)
        return page
    }

    /** What the outbox asks of this service: the restore, the removal path and the upgrade state. */
    private inner class OutboxHooks(private val l: Live) : Outbox.Hooks {
        override suspend fun restored(ws: String, details: WorkspaceDetails) {
            val s = l.sync(ws) ?: return
            try {
                guarded(l, s) { s.details() }
            } catch (e: WorkspaceError) {
                // The next run's GET / finds the generation.
            }
            s.request()
        }

        override fun removed(ws: String) {
            l.scope.launch {
                val s = l.sync(ws) ?: return@launch
                quietly { guarded(l, s) { s.removed() } }
            }
        }

        override fun upgrade(ws: String) {
            updateSockets(l)
            stateChanged()
        }
    }

    // The removal path's end (§3.6): the row and everything under it went in the sync's transaction. Called from
    // inside that sync, which this closes last.
    private fun workspaceGone(l: Live, ws: String) {
        val s = l.syncs.remove(ws)
        l.ran -= ws
        l.nudgedAt.remove(ws)
        l.outbox.forget(ws)
        alerts.onWorkspaceGone(ws)
        l.socket?.takeIf { it.ws == ws }?.let {
            it.socket.stop()
            it.watch.cancel()
            l.socket = null
        }
        syncVersion.update { it + 1 }
        l.scope.launch {
            if (l.selected == ws) quietly { pickSelected(l) }
            quietly { list() }
            updateSockets(l)
            stateChanged()
        }
        stateChanged()
        s?.close()
    }

    // ---- listing (§3.11) ----

    // GET /v1/workspaces: new workspaces get a row and a first pass; one no longer listed is asked GET /, whose 404
    // removes it. A failed listing changes nothing. One listing at a time.
    private suspend fun list(): List<WorkspaceRef>? {
        val l = live ?: return null
        if (!isLive()) return null
        val job = synchronized(l.listLock) {
            l.listing?.takeIf { it.isActive } ?: l.scope.async { listNow(l) }.also { l.listing = it }
        }
        return job.await()
    }

    private suspend fun listNow(l: Live): List<WorkspaceRef>? {
        try {
            val refs = try {
                l.client.list()
            } catch (e: WorkspaceError) {
                if (!l.closed) {
                    l.listError = if (e.internal) "server" else e.code
                    stateChanged()
                }
                return null
            }
            if (l.closed) return null
            val listed = refs.filter { WorkspaceIds.isWorkspace(it.id) && it.name.isNotBlank() }.distinctBy { it.id }
            val known = l.store.read { listWs().mapTo(HashSet()) { it.id } }
            l.store.tx {
                for (w in listed) insertWs(WsRow(w.id, w.name.take(NAME_MAX), w.role.takeIf { it in ROLES } ?: "member"))
            }
            l.listedAt = clock.now()
            l.listError = null
            val ids = listed.mapTo(HashSet()) { it.id }
            val selected = l.selected
            if (selected == null || (selected !in known && selected !in ids)) pickSelected(l)
            for (id in ids - known) l.sync(id)?.request()
            for (id in known - ids) {
                l.scope.launch {
                    val s = l.sync(id) ?: return@launch
                    quietly { guarded(l, s) { s.details() } }
                }
            }
            updateSockets(l)
            stateChanged()
            return listed
        } catch (e: WorkspaceError) {
            return null
        }
    }

    private val byName: Comparator<WsRow> = Comparator { a, b ->
        val c = Collator.getInstance().compare(a.name, b.name)
        if (c != 0) c else a.id.compareTo(b.id)
    }

    private suspend fun pickSelected(l: Live) = setSelected(l, l.store.read { listWs() }.sortedWith(byName).firstOrNull()?.id)

    private suspend fun setSelected(l: Live, ws: String?) {
        l.selected = ws
        l.store.tx { if (ws != null) setMeta(META_SELECTED, ws) else deleteMeta(META_SELECTED) }
    }

    // Recent activity in the workspace: the background worker runs the most recent first.
    private suspend fun touch(l: Live, ws: String) {
        quietly { l.store.tx { if (getWs(ws) != null) updateWs(ws, mapOf("activeAt" to clock.now())) } }
    }

    // ---- sockets (§3.11): one, for the workspace on screen, while the app is in the foreground ----

    private fun updateSockets(l: Live? = live) {
        if (l == null || l.closed) return
        l.scope.launch { l.socketLock.withLock { reconcileSocket(l) } }
    }

    private suspend fun reconcileSocket(l: Live) {
        val ws = onScreenNow.ws
        val ok = ws != null && quietly { l.store.read { getWs(ws)?.state } } == FeedApplier.STATE_OK
        val wanted = if (foreground && ok && isLive() && sockets != null && !l.closed) ws else null
        val current = l.socket
        if (current != null && current.ws != wanted) {
            current.socket.stop()
            current.watch.cancel()
            l.socket = null
            stateChanged()
        }
        if (wanted == null || l.socket != null || sockets == null) return
        val url = try {
            WorkspaceSocket.socketUrl(l.server, wanted)
        } catch (e: IllegalArgumentException) {
            return
        }
        val socket = sockets.open(url, { l.client.socketTicket(wanted) }, SocketListener(l, wanted), l.scope)
        val watch = l.scope.launch { socket.state.collect { stateChanged() } }
        l.socket = LiveSocket(wanted, socket, watch)
        socket.start()
    }

    private inner class SocketListener(private val l: Live, private val ws: String) : WorkspaceSocket.Listener {
        private fun mine() = !l.closed && l.socket?.ws == ws

        override fun opened() {
            if (!mine()) return
            // Wakes sent while it was down are lost: a run catches up.
            l.scope.launch { l.sync(ws)?.request() }
            l.outbox.kick(ws, retryNow = true)
        }

        override fun wake() {
            if (mine()) l.scope.launch { l.sync(ws)?.request() }
        }

        override fun leaseEnded() = wake()

        // 4003: GET / says whether the person is still a member; its 404 runs the removal path.
        override fun removed() {
            if (mine()) l.scope.launch { recheck(restart = true) }
        }

        override fun parked(error: WorkspaceError) {
            if (!mine()) return
            when {
                error.code == "not_found" && error.scope == "workspace" -> l.scope.launch { recheck(restart = false) }
                error.code == "upgrade_required" -> l.scope.launch {
                    val s = l.sync(ws) ?: return@launch
                    if (quietly { s.applier.park(ws) } == true) {
                        updateSockets(l)
                        stateChanged()
                    }
                }
            }
        }

        private suspend fun recheck(restart: Boolean) {
            val s = l.sync(ws) ?: return
            try {
                guarded(l, s) { s.details() }
            } catch (e: WorkspaceError) {
                if (restart && e.code in RECHECKED) {
                    delay(e.retryAfterS?.times(1000) ?: timing.socketRecheck)
                    if (mine()) l.socket?.socket?.start()
                }
                return
            }
            if (restart && mine() && quietly { l.store.read { getWs(ws)?.state } } == FeedApplier.STATE_OK) l.socket?.socket?.start()
        }
    }

    // ---- foreground, background and resume (ChatBackground, ChatSyncWorker) ----

    /** The app came to the foreground: the socket for the workspace on screen, runs, listing and the outbox (§3.11). */
    fun resumed() {
        foreground = true
        updateSockets()
        nudge()
    }

    /** The app left the foreground: the socket closes. Runs and read reports already under way go on. */
    fun paused() {
        foreground = false
        updateSockets()
    }

    /**
     * Focus, resume or a network that came back (§3.11): list again at most once a minute, run the selected workspace
     * now (at most once per 5 s) and the others spread over 10 s, reconnect a socket that is down, kick the outbox.
     */
    fun nudge() {
        val l = live ?: return
        if (!isLive()) return
        l.scope.launch {
            val now = clock.now()
            val listed = l.listedAt
            if (listed == null || now - listed >= timing.listResumeGap) launch { quietly { list() } }
            for (row in quietly { l.store.read { listWs() } }.orEmpty()) {
                if (row.state != FeedApplier.STATE_OK) continue
                val s = l.sync(row.id) ?: continue
                if (row.id == l.selected) {
                    val last = l.nudgedAt[row.id]
                    if (last == null || now - last >= timing.resumeRunGap) {
                        l.nudgedAt[row.id] = now
                        s.request(reset = true)
                    }
                } else {
                    val wait = (random() * timing.resumeSpread).toLong()
                    launch {
                        delay(wait)
                        s.request(reset = true)
                    }
                }
            }
            l.socket?.socket?.let { if (it.state.value == SocketState.OFF) it.start() else it.nudge() }
            updateSockets(l)
            l.outbox.kick(retryNow = true)
        }
    }

    /** ChatBackground's runs in the foreground (every 60 s ± 10 s): every workspace, waiting out a backoff. */
    fun catchUp() {
        val l = live ?: return
        if (!isLive()) return
        l.scope.launch {
            for (row in quietly { l.store.read { listWs() } }.orEmpty()) {
                if (row.state == FeedApplier.STATE_OK) l.sync(row.id)?.request(reset = false)
            }
        }
    }

    /**
     * Whether a workspace is cached while team chat is on, for scheduling ChatSyncWorker. It says nothing until the
     * service followed the account once, so a process that WorkManager started for the worker doesn't read the empty
     * first state as "no workspace" and cancel the worker under way.
     */
    val hasWorkspaces: Flow<Boolean>
        get() = scheduled.filterNotNull().distinctUntilChanged()

    /**
     * ChatSyncWorker's catch-up (android.md "Foreground, background and resume"): list, then the most recently active
     * workspaces, at most [ChatTiming.workerWorkspaces], each run until its feed has no more pages, then the outbox, all
     * within [budgetMs]. Alerts follow each run. Returns how many workspaces ran, or null when signed out, team chat is
     * off or there is no cache.
     */
    suspend fun backgroundCatchUp(budgetMs: Long): Int? {
        awaitReady()
        val l = live ?: return null
        if (!isLive()) return null
        val started = clock.now()
        var ran = 0
        withTimeoutOrNull(budgetMs) {
            quietly { list() }
            val rows = quietly { l.store.read { listWs() } }.orEmpty()
                .filter { it.state == FeedApplier.STATE_OK }
                .sortedByDescending { it.activeAt ?: 0 }
                .take(timing.workerWorkspaces)
            for (row in rows) {
                val s = l.sync(row.id) ?: continue
                var runs = 0
                while (runs++ < WORKER_RUNS) {
                    val outcome = quietly { guarded(l, s) { s.now(reset = true) } } ?: break
                    if (!outcome.more) break
                }
                ran += 1
            }
        }
        val left = budgetMs - (clock.now() - started)
        if (left > 0 && !l.closed) quietly { l.outbox.flush(left) }
        return ran
    }

    // ---- what the UI reads ----

    private fun stateChanged() {
        stateTicks.trySend(Unit)
    }

    private suspend fun computeState(): ChatState {
        val l = live
        val i = info
        val w = i?.workspace
        var summaries = emptyList<WorkspaceSummary>()
        var unsent = 0
        if (l != null && !l.closed) {
            try {
                val (rows, totals, count) = l.store.read { Triple(listWs(), totals(), countUnsent()) }
                summaries = rows.sortedWith(byName).map { summary(l, it, totals[it.id]) }
                unsent = count
            } catch (e: WorkspaceError) {
                // The cache closed meanwhile; the next state comes with the next session.
            }
        }
        var attention = 0
        var unread = false
        for (s in summaries) {
            attention += s.attention
            unread = unread || s.unread
        }
        val operator = i?.operator?.let { o -> o.name?.trim()?.takeIf { it.isNotEmpty() }?.let { ChatOperator(it.take(NAME_MAX), o.url?.take(2000)) } }
        return ChatState(
            available = available,
            storage = storage,
            signedIn = signedIn,
            server = configured,
            host = hostOf(configured),
            operator = operator,
            jurisdiction = i?.hosting?.jurisdiction?.takeIf { it in JURISDICTIONS },
            signups = i?.signups?.takeIf { it in SIGNUPS },
            inviteSignups = w?.inviteSignups == true,
            retention = w?.retention?.let { ChatRetention(it.contentDays, it.feedDays) },
            limits = w?.limits?.let { ChatLimits(it.workspacesPerAccount, it.members) },
            notifications = settings.value.notifyChat,
            pendingJoin = pendingJoin() != null,
            unsent = unsent,
            lostUnsent = lostUnsent.get(),
            selected = l?.selected,
            connection = connection(l, summaries),
            attention = minOf(attention, BADGE_CAP),
            unread = unread,
            workspaces = summaries,
        )
    }

    private fun connection(l: Live?, workspaces: List<WorkspaceSummary>): Connection {
        if (l == null || !isLive()) return Connection.IDLE
        val w = workspaces.firstOrNull { it.id == l.selected } ?: workspaces.firstOrNull()
        if (w == null) {
            if (l.listError == "network") return Connection.OFFLINE
            return if (l.listedAt != null) Connection.ONLINE else Connection.CONNECTING
        }
        return when {
            w.error == "network" -> Connection.OFFLINE
            w.status == WorkspaceStatus.QUARANTINED || w.status == WorkspaceStatus.UPGRADE -> Connection.IDLE
            w.socket == SocketState.OPEN -> Connection.ONLINE
            w.socket != SocketState.CONNECTING && w.id in l.ran && w.error == null -> Connection.ONLINE
            else -> Connection.CONNECTING
        }
    }

    private class Totals(val attention: Int, val unread: Boolean)

    // Attention and unread per workspace (§3.10): a muted room asks for nothing, a DM for its unread messages and a
    // channel for its mentions.
    private fun WorkspaceStore.StoreTx.totals(): Map<String, Totals> = sql.query(
        """SELECT ws, SUM(CASE WHEN muted = 1 THEN 0 WHEN kind = 'dm' THEN unread ELSE mentions END),
                  MAX(CASE WHEN muted = 0 AND unread > 0 THEN 1 ELSE 0 END)
           FROM room GROUP BY ws""",
    ) { r -> r.text(0) to Totals(minOf(r.long(1), BADGE_CAP.toLong()).toInt(), r.long(2) != 0L) }.toMap()

    private fun summary(l: Live, row: WsRow, totals: Totals?): WorkspaceSummary {
        val runner = l.syncs[row.id]?.runner?.state?.value
        return WorkspaceSummary(
            id = row.id,
            name = row.name,
            role = row.role,
            status = when {
                row.state == FeedApplier.STATE_QUARANTINED -> WorkspaceStatus.QUARANTINED
                row.state == FeedApplier.STATE_UPGRADE -> WorkspaceStatus.UPGRADE
                row.fresh -> WorkspaceStatus.LOADING
                else -> WorkspaceStatus.OK
            },
            syncing = runner?.running == true,
            socket = l.socket?.takeIf { it.ws == row.id }?.socket?.state?.value ?: SocketState.OFF,
            error = runner?.error,
            attention = totals?.attention ?: 0,
            unread = totals?.unread ?: false,
        )
    }

    // What changed in the cache of [l], as ticks, starting with one now.
    private fun ticks(l: Live, which: (DbChange) -> Boolean): Flow<Unit> =
        l.store.changes.onSubscription { emit(DbChange(null)) }.filter(which).map { }

    @OptIn(ExperimentalCoroutinesApi::class)
    override fun view(ws: String): Flow<WorkspaceView> = liveFlow.flatMapLatest { l ->
        if (l == null) {
            emptyFlow()
        } else {
            combine(ticks(l) { it.affects(ws) }, state.map { s -> s.workspaces.firstOrNull { it.id == ws } }.distinctUntilChanged()) { _, s -> s }
                .conflate()
                .mapNotNull { s -> buildView(l, ws, s) }
        }
    }

    private suspend fun buildView(l: Live, ws: String, known: WorkspaceSummary?): WorkspaceView? = try {
        l.store.read {
            val row = getWs(ws) ?: return@read null
            val members = listMembers(ws)
            val me = members.firstOrNull { it.id == row.me } ?: Member(row.me.orEmpty(), "human", row.myName.orEmpty(), row.role, "active", 0)
            val rooms = listRooms(ws).map { r -> r.toRoom(if (r.kind == RoomKind.DM.wire) lastMessage(ws, r.id) else null) }
            val summary = known ?: summary(l, row, Totals(minOf(rooms.sumOf { it.attention }, BADGE_CAP), rooms.any { !it.muted && it.unread > 0 }))
            WorkspaceView(summary, me, rooms, members, row.membersMore, listChannels(ws), listBlocks(ws))
        }
    } catch (e: WorkspaceError) {
        null
    }

    // [block] with the workspace's current sync, and again when it is replaced.
    @OptIn(ExperimentalCoroutinesApi::class)
    private fun <T> withSync(l: Live, ws: String, block: (WorkspaceSync?) -> Flow<T>): Flow<T> = syncVersion.flatMapLatest {
        flow {
            val s = l.syncs[ws]?.takeIf { !it.closed } ?: l.sync(ws)
            emitAll(block(s))
        }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    override fun timeline(ws: String, room: String): Flow<RoomTimeline> = liveFlow.flatMapLatest { l ->
        if (l == null) {
            emptyFlow()
        } else {
            withSync(l, ws) { s ->
                combine(ticks(l) { it.affects(ws, room) }, s?.loader?.rooms ?: flowOf(emptyMap())) { _, loads -> loads[room] }
                    .conflate()
                    .mapNotNull { load -> buildTimeline(l, s, ws, room, load) }
            }
        }
    }

    private suspend fun buildTimeline(l: Live, s: WorkspaceSync?, ws: String, room: String, load: RoomLoad?): RoomTimeline? = try {
        l.store.read {
            val r = getRoom(ws, room) ?: return@read null
            val events = eventsFrom(ws, room, 0, Int.MAX_VALUE)
            RoomTimeline(
                room = r.toRoom(null),
                events = events,
                pending = Outbox.pending(outboxForRoom(ws, room)),
                replies = replySummaries(events),
                readAtOpen = load?.readAtOpen ?: r.readLocal,
                hasOlder = s?.loader?.hasOlder(r) ?: (r.lo != null && r.lo > r.floor),
                complete = load?.complete ?: true,
                loading = load?.loading ?: false,
                draft = getDraft(ws, room, null)?.draft,
            )
        }
    } catch (e: WorkspaceError) {
        null
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    override fun thread(ws: String, room: String, root: String): Flow<ThreadTimeline> = liveFlow.flatMapLatest { l ->
        if (l == null) {
            emptyFlow()
        } else {
            withSync(l, ws) { s ->
                combine(ticks(l) { it.affects(ws, room) }, s?.loader?.threads ?: flowOf(emptyMap())) { _, loads -> loads[ThreadKey(room, root)] }
                    .conflate()
                    .mapNotNull { load -> buildThread(l, ws, room, root, load) }
            }
        }
    }

    private suspend fun buildThread(l: Live, ws: String, room: String, root: String, load: ThreadLoad?): ThreadTimeline? = try {
        l.store.read {
            getRoom(ws, room) ?: return@read null
            val rootEvent = if (roomOfEvent(ws, root) == room) eventById(ws, root) else null
            ThreadTimeline(
                root = rootEvent,
                replies = replies(ws, room, root),
                pending = Outbox.pending(outboxForRoom(ws, room)).filter { it.root == root },
                complete = load?.complete ?: (rootEvent != null),
                expired = load?.expired ?: false,
                draft = getDraft(ws, room, root)?.draft,
                loading = load?.loading ?: false,
            )
        }
    } catch (e: WorkspaceError) {
        null
    }

    // ---- the calls ----

    private fun requireLive(): Live {
        if (!signedIn) throw WorkspaceError("signed_out")
        if (!available) throw WorkspaceError("server", message = "Team chat is off on this server.")
        val l = live
        // Signed in with team chat on and still no cache: it couldn't open, or the session is changing.
        if (l == null || l.closed) throw WorkspaceError(if (!storage) "not_saved" else "signed_out")
        return l
    }

    // A sync closed under a call means its workspace or the session went: the call says which, unless the caller
    // itself was cancelled.
    private suspend fun <T> guarded(l: Live, s: WorkspaceSync, block: suspend () -> T): T = try {
        block()
    } catch (e: CancellationException) {
        if (s.closed && currentCoroutineContext().isActive) {
            throw if (!l.closed && live === l) WorkspaceError("not_found", scope = "workspace") else WorkspaceError("signed_out")
        }
        throw e
    }

    private suspend fun <T> onWs(ws: String, block: suspend (Live, WorkspaceSync) -> T): T {
        val l = requireLive()
        val s = l.sync(ws) ?: throw WorkspaceError("not_found", scope = "workspace")
        return guarded(l, s) { block(l, s) }
    }

    // A write with the 429 rule of §4.4: it waits Retry-After and tries again, up to three times in all within 30 s,
    // then fails with rate_limited.
    private suspend fun <T> retrying(block: suspend () -> T): T {
        val started = clock.now()
        var attempt = 0
        while (true) {
            try {
                return block()
            } catch (e: WorkspaceError) {
                if (e.code == "rate_limited" && attempt + 1 < timing.writeRetries) {
                    val wait = (e.retryAfterS ?: 1) * 1000
                    if (clock.now() + wait - started <= timing.writeRetryWindow) {
                        attempt += 1
                        delay(wait)
                        continue
                    }
                }
                throw e
            }
        }
    }

    // A write to one workspace's routes, whose 404 for the workspace runs the removal path.
    private suspend fun <T> write(s: WorkspaceSync, block: suspend WorkspaceClient.() -> T): T = retrying { s.call(block) }

    // A write outside one workspace's routes (making a workspace, previewing, joining). A 404 here is about the link's
    // workspace and never removes one the person is in.
    private suspend fun <T> writeTop(l: Live, block: suspend WorkspaceClient.() -> T): T = retrying { l.client.block() }

    // A run after a write, so the feed confirms it. With [wait], until that run ended; its failure doesn't fail the
    // write, which the server already took.
    private suspend fun confirm(s: WorkspaceSync, wait: Boolean = false) {
        if (!wait) {
            s.request()
            return
        }
        try {
            s.now()
        } catch (e: CancellationException) {
            if (!s.closed || !currentCoroutineContext().isActive) throw e
        }
    }

    private suspend fun row(l: Live, ws: String): WsRow = l.store.read { getWs(ws) } ?: throw WorkspaceError("not_found", scope = "workspace")

    override suspend fun select(ws: String?) {
        val l = requireLive()
        if (ws != null) row(l, ws)
        setSelected(l, ws)
        if (ws != null) {
            touch(l, ws)
            l.sync(ws)?.request()
        }
        updateSockets(l)
        stateChanged()
    }

    override fun onScreen(ws: String?, room: String?, thread: String?) {
        val next = OnScreen(ws, room?.takeIf { ws != null }, thread?.takeIf { ws != null && room != null })
        val prev = onScreenNow
        if (next == prev) return
        onScreenNow = next
        screen.update { it.copy(chatWorkspace = next.ws, chatRoom = next.room) }
        val l = live ?: return
        l.screenEvents.trySend(prev to next)
        if (prev.ws != next.ws) updateSockets(l)
    }

    // The room on screen opens in its workspace's loader, so the feed brings its new events inline and it catches up;
    // the one that left the screen closes, which resets its New divider and cuts its range back (§3.7).
    private suspend fun applyScreen(l: Live, prev: OnScreen, next: OnScreen) {
        if (prev.ws == next.ws && prev.room == next.room) return
        val prevWs = prev.ws
        val prevRoom = prev.room
        if (prevWs != null && prevRoom != null) {
            l.syncs[prevWs]?.let { s -> quietly { guarded(l, s) { s.loader.close(prevRoom) } } }
        }
        val ws = next.ws ?: return
        val room = next.room ?: return
        val s = l.sync(ws) ?: return
        touch(l, ws)
        l.scope.launch { quietly { guarded(l, s) { s.loader.open(room) } } }
    }

    private fun isOnScreen(ws: String, room: String): Boolean = ChatAlertRules.onScreen(screen.current, ws, room)

    override suspend fun refresh(ws: String?) {
        val l = live ?: return
        if (!isLive()) return
        if (ws != null) {
            val s = l.sync(ws) ?: throw WorkspaceError("not_found", scope = "workspace")
            quietly { guarded(l, s) { s.now() } }
            return
        }
        quietly { list() }
        val all = quietly { l.store.read { listWs() } }.orEmpty().mapNotNull { l.sync(it.id) }
        val runs = all.map { s -> l.scope.async { quietly { guarded(l, s) { s.now() } } } }
        for (r in runs) r.await()
    }

    override suspend fun reload(ws: String) = onWs(ws) { l, s ->
        s.reload()
        l.outbox.kick(ws)
        updateSockets(l)
        stateChanged()
    }

    override suspend fun open(ws: String, room: String, at: Long?) = onWs(ws) { l, s ->
        touch(l, ws)
        s.loader.open(room, at)
    }

    override suspend fun loadOlder(ws: String, room: String) = onWs(ws) { _, s -> s.loader.older(room) }

    override suspend fun loadThread(ws: String, room: String, root: String) = onWs(ws) { _, s -> s.loader.loadThread(room, root) }

    override suspend fun roomMembers(ws: String, room: String): List<RoomMember> = onWs(ws) { l, s ->
        val r = l.store.read { getRoom(ws, room) } ?: throw WorkspaceError("not_found", scope = "conversation")
        if (r.kind == RoomKind.DM.wire) {
            r.participants.orEmpty().distinct().map { RoomMember(it, "member") }
        } else {
            s.requireUsable()
            s.call { channelMembers(ws, room) }
        }
    }

    override fun markRead(ws: String, room: String, seq: Long) {
        val l = live ?: return
        l.scope.launch {
            val s = l.sync(ws) ?: return@launch
            quietly { guarded(l, s) { s.reads.mark(room, seq) } }
        }
    }

    override suspend fun markAllRead(ws: String, room: String) {
        onWs(ws) { _, s -> s.reads.markAll(room) }
    }

    override suspend fun setMuted(ws: String, room: String, muted: Boolean) {
        val l = requireLive()
        l.store.tx {
            getRoom(ws, room) ?: throw WorkspaceError("not_found", scope = "conversation")
            setRoomFields(ws, room, mapOf("muted" to muted))
        }
    }

    override suspend fun saveDraft(ws: String, room: String, root: String?, draft: Draft?) {
        val l = requireLive()
        l.store.tx {
            getRoom(ws, room) ?: throw WorkspaceError("not_found", scope = "conversation")
            if (draft == null || draft.text.isEmpty()) deleteDraft(ws, room, root) else putDraft(ws, room, root, draft)
        }
    }

    override suspend fun send(ws: String, room: String, root: String?, text: String, mentions: List<Mention>): String =
        requireLive().outbox.enqueue(ws, room, root, text, mentions)

    override suspend fun resend(localId: String, mode: ResendMode) = requireLive().outbox.resend(localId, mode)

    override suspend fun discard(localId: String) = requireLive().outbox.discard(localId)

    override suspend fun redact(ws: String, room: String, message: String) = onWs(ws) { l, s ->
        l.outbox.redact(ws, room, message)
        confirm(s)
    }

    // ---- workspaces ----

    // The workspace the person made or joined, from the answer: its row, and for a new one its details, so me, the
    // generation and the clock are there before the first run. A row that was there keeps what it has.
    private suspend fun adopt(l: Live, answer: Joined, t0: Long, t1: Long): String {
        val workspace = answer.workspace ?: throw WorkspaceError("server", message = "the answer names no workspace")
        val details = WorkspaceDetails(workspace, answer.me)
        FeedApplier.check(details, workspace.id)
        val known = l.store.read { getWs(workspace.id) }
        l.store.tx { insertWs(WsRow(workspace.id, workspace.name, answer.me.role)) }
        if (known?.generation == null) FeedApplier(l.store, clock, timing.sync).restore(workspace.id, details, t0, t1)
        stateChanged()
        return workspace.id
    }

    // After making or joining: list again, select the new workspace and wait for its first run (§3.3).
    private suspend fun arrive(l: Live, ws: String) {
        quietly { list() }
        if (l.closed) throw WorkspaceError("signed_out")
        row(l, ws)
        select(ws)
        val s = l.sync(ws) ?: throw WorkspaceError("not_found", scope = "workspace")
        guarded(l, s) { confirm(s, wait = true) }
    }

    override suspend fun createWorkspace(name: String, displayName: String): String {
        val l = requireLive()
        val t0 = clock.now()
        val answer = writeTop(l) { create(name.trim(), displayName.trim()) }
        val t1 = clock.now()
        if (l.closed) throw WorkspaceError("signed_out")
        val ws = adopt(l, answer, t0, t1)
        arrive(l, ws)
        return ws
    }

    private fun checkLink(link: InviteLink) {
        if (link.server != configured) throw WorkspaceError("other_server")
        if (!WorkspaceIds.isWorkspace(link.workspace) || !WorkspaceIds.SECRET.matches(link.secret)) throw WorkspaceError("bad_link")
    }

    override suspend fun previewInvite(link: InviteLink): InvitePreview {
        val l = requireLive()
        checkLink(link)
        val already = l.store.read { getWs(link.workspace) != null }
        try {
            val preview = writeTop(l) { previewInvite(link.workspace, link.secret) }
            if (preview.workspace.id != link.workspace) throw WorkspaceError("server", message = "the preview names another workspace")
            return preview.copy(already = already || l.store.read { getWs(link.workspace) != null })
        } catch (e: WorkspaceError) {
            if (!already) throw e
            // A member's own workspace: the card says so and offers Open, whatever became of the invitation.
            val row = l.store.read { getWs(link.workspace) } ?: throw e
            val channels = l.store.read { listRooms(link.workspace).count { it.kind == RoomKind.CHANNEL.wire && !it.archived } }
            return InvitePreview(
                workspace = WorkspaceRef(row.id, row.name),
                role = if (row.role == "guest") "guest" else "member",
                channels = channels,
                issuer = IssuerName(""),
                expiresAt = 0,
                already = true,
            )
        }
    }

    override suspend fun join(link: InviteLink, displayName: String): String {
        val l = requireLive()
        checkLink(link)
        val t0 = clock.now()
        val answer = writeTop(l) { join(link.workspace, link.secret, displayName.trim()) }.value
        val t1 = clock.now()
        if (answer.workspace?.id != link.workspace) throw WorkspaceError("server", message = "the answer names another workspace")
        if (l.closed) throw WorkspaceError("signed_out")
        val ws = adopt(l, answer, t0, t1)
        // The link of a sign-up is used now.
        if (pending?.link?.secret == link.secret) {
            pending = null
            stateChanged()
        }
        arrive(l, ws)
        return ws
    }

    override fun rememberJoin(link: InviteLink) {
        val tag = account.borrowSession()?.tag ?: return
        pending = PendingJoin(link, tag)
        stateChanged()
    }

    private fun pendingJoin(): InviteLink? {
        val p = pending ?: return null
        return p.link.takeIf { signedIn && account.borrowSession()?.tag == p.tag }
    }

    override fun takePendingJoin(): InviteLink? {
        val link = pendingJoin()
        if (pending != null) {
            pending = null
            stateChanged()
        }
        return link
    }

    // As desktop's chatState call takes it: reported once, then 0. A file broken later in the session adds to it.
    override fun takeLostUnsent(): Int {
        val lost = lostUnsent.getAndSet(0)
        if (lost != 0) stateChanged()
        return lost
    }

    override suspend fun leaveWorkspace(ws: String) {
        onWs(ws) { l, s ->
            try {
                write(s) { leave(ws) }
            } catch (e: WorkspaceError) {
                // Gone already: the call ran the removal path.
                if (e.code == "not_found" && e.scope == "workspace") return@onWs
                throw e
            }
            guarded(l, s) { s.removed() }
        }
    }

    override suspend fun deleteWorkspace(ws: String) {
        onWs(ws) { l, s ->
            try {
                write(s) { deleteWorkspace(ws) }
            } catch (e: WorkspaceError) {
                if (e.code == "not_found" && e.scope == "workspace") return@onWs
                throw e
            }
            guarded(l, s) { s.removed() }
        }
    }

    // ---- members ----

    private suspend fun updateMember(l: Live, ws: String, m: Member) {
        l.store.tx {
            sql.exec("UPDATE member SET name = ?, role = ?, state = ? WHERE ws = ? AND id = ?", m.name, m.role, m.state, ws, m.id)
            sql.touch(ws)
            if (getWs(ws)?.me == m.id) updateWs(ws, mapOf("myName" to m.name, "role" to m.role))
        }
    }

    override suspend fun renameMe(ws: String, name: String) {
        onWs(ws) { l, s ->
            val me = write(s) { renameMe(ws, name.trim()) }
            updateMember(l, ws, me)
            confirm(s)
        }
    }

    override suspend fun setRole(ws: String, member: String, role: String) {
        onWs(ws) { l, s ->
            val answer = write(s) { setRole(ws, member, role) }
            updateMember(l, ws, answer)
            confirm(s, wait = answer.id == row(l, ws).me)
        }
    }

    override suspend fun removeMember(ws: String, member: String) {
        val l = requireLive()
        // Removing yourself is leaving.
        if (member == row(l, ws).me) return leaveWorkspace(ws)
        onWs(ws) { _, s ->
            try {
                write(s) { removeMember(ws, member) }
            } catch (e: WorkspaceError) {
                // Someone already gone counts as removed.
                if (!(e.code == "not_found" && e.scope == null)) throw e
            }
            l.store.tx { updateWs(ws, mapOf("membersStale" to true)) }
            confirm(s)
        }
    }

    // ---- invitations ----

    override suspend fun invites(ws: String): List<Invite> = onWs(ws) { _, s -> s.call { invites(ws) } }

    override suspend fun createInvite(ws: String, role: String, channels: List<String>, expiresIn: Long): String = onWs(ws) { l, s ->
        val made = write(s) { createInvite(ws, role, channels, expiresIn) }
        confirm(s)
        InviteLink.format(l.server, ws, made.secret)
    }

    override suspend fun withdrawInvite(ws: String, invite: String) {
        onWs(ws) { _, s ->
            write(s) { withdrawInvite(ws, invite) }
            confirm(s)
        }
    }

    // ---- channels ----

    private suspend fun putChannel(l: Live, ws: String, c: Channel) {
        l.store.tx {
            if (getWs(ws) == null) return@tx
            sql.exec(
                """INSERT INTO channel (ws, id, name, visibility, archived, joined, role, members) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (ws, id) DO UPDATE SET name = excluded.name, visibility = excluded.visibility,
                     archived = excluded.archived, joined = excluded.joined, role = excluded.role, members = excluded.members""",
                ws, c.id, c.name, c.visibility, c.archived, c.joined, c.role, c.members,
            )
            sql.touch(ws)
        }
    }

    // A channel write whose answer is the channel; the run that follows puts its room in the cache, so it is waited for.
    private suspend fun changeChannel(ws: String, block: suspend WorkspaceClient.() -> Channel): Channel = onWs(ws) { l, s ->
        val channel = write(s, block)
        putChannel(l, ws, channel)
        confirm(s, wait = true)
        channel
    }

    override suspend fun createChannel(ws: String, name: String, visibility: String): String =
        changeChannel(ws) { createChannel(ws, name.trim(), visibility) }.id

    override suspend fun renameChannel(ws: String, channel: String, name: String) {
        changeChannel(ws) { renameChannel(ws, channel, name.trim()) }
    }

    override suspend fun archiveChannel(ws: String, channel: String) {
        changeChannel(ws) { archiveChannel(ws, channel) }
    }

    override suspend fun joinChannel(ws: String, channel: String) {
        changeChannel(ws) { joinChannel(ws, channel) }
    }

    override suspend fun addToChannel(ws: String, channel: String, member: String) {
        onWs(ws) { _, s ->
            write(s) { admit(ws, channel, member) }
            confirm(s)
        }
    }

    override suspend fun setChannelRole(ws: String, channel: String, member: String, role: String) {
        onWs(ws) { l, s ->
            write(s) { setChannelRole(ws, channel, member, role) }
            confirm(s, wait = member == row(l, ws).me)
        }
    }

    override suspend fun removeFromChannel(ws: String, channel: String, member: String) {
        val l = requireLive()
        // Removing yourself is leaving.
        if (member == row(l, ws).me) return leaveChannel(ws, channel, null)
        onWs(ws) { _, s ->
            write(s) { removeFromChannel(ws, channel, member) }
            confirm(s)
        }
    }

    override suspend fun leaveChannel(ws: String, channel: String, successor: String?) {
        onWs(ws) { _, s ->
            try {
                write(s) { leaveChannel(ws, channel, successor) }
            } catch (e: WorkspaceError) {
                if (!(e.code == "not_found" && e.scope == "conversation")) throw e
            }
            confirm(s, wait = true)
        }
    }

    // ---- direct messages and blocks (§3.12) ----

    // 201 and 200 alike open the room the server answered with, which goes into the cache at once (it is the room's
    // feed row), unless a pass is under way: then the run brings it.
    override suspend fun startDm(ws: String, members: List<String>): String = onWs(ws) { l, s ->
        val dm = startDmOnce(s, ws, members)
        FeedApplier.check(dm, "dm")
        // Null when a pass is under way; else whether the DM came back under a new grant, which emptied its cache.
        val grantChanged = l.store.tx {
            val row = getWs(ws)
            if (row == null || row.passing) {
                null
            } else {
                val up = upsertRoom(ws, dm)
                recount(ws, dm.conversation)
                up.grantChanged
            }
        }
        if (grantChanged == true) s.loader.onCacheDropped(listOf(dm.conversation))
        confirm(s, wait = grantChanged == null)
        dm.conversation
    }

    // The set finds the same DM, so a start whose answer got lost is safe to send once more.
    private suspend fun startDmOnce(s: WorkspaceSync, ws: String, members: List<String>): Change = try {
        write(s) { startDm(ws, members) }.value
    } catch (e: WorkspaceError) {
        if (e.code != "network") throw e
        write(s) { startDm(ws, members) }.value
    }

    override suspend fun leaveDm(ws: String, room: String) {
        onWs(ws) { _, s ->
            try {
                write(s) { leaveDm(ws, room) }
            } catch (e: WorkspaceError) {
                if (!(e.code == "not_found" && e.scope == "conversation")) throw e
            }
            confirm(s, wait = true)
        }
    }

    override suspend fun block(ws: String, member: String) {
        onWs(ws) { l, s ->
            val block = write(s) { block(ws, member) }.value
            l.store.tx {
                sql.exec(
                    "INSERT INTO block (ws, member, at) VALUES (?, ?, ?) ON CONFLICT (ws, member) DO UPDATE SET at = excluded.at",
                    ws, block.member, block.at,
                )
                sql.touch(ws)
            }
            afterBlocks(l, s, ws)
        }
    }

    override suspend fun unblock(ws: String, member: String) {
        onWs(ws) { l, s ->
            write(s) { unblock(ws, member) }
            l.store.tx {
                sql.exec("DELETE FROM block WHERE ws = ? AND member = ?", ws, member)
                sql.touch(ws)
            }
            afterBlocks(l, s, ws)
        }
    }

    // The server's block list replaces the cached one; when it can't load now, the row written above stands and the
    // next run loads it. The run closes or keeps shared DMs.
    private suspend fun afterBlocks(l: Live, s: WorkspaceSync, ws: String) {
        l.store.tx { updateWs(ws, mapOf("blocksStale" to true)) }
        quietly { s.directory() }
        confirm(s, wait = true)
    }

    // ---- helpers ----

    // Runs [block]; a failure becomes null, except that cancelling the caller stays cancelling.
    private suspend fun <T> quietly(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        if (currentCoroutineContext().isActive) null else throw e
    } catch (e: Exception) {
        null
    }

    companion object {
        private const val TAG = "WorkspaceService"

        /** `meta` keys (§3.5). */
        const val META_SESSION = "session"
        const val META_SERVER = "server"
        const val META_SELECTED = "selected"

        private const val NAME_MAX = 200
        private const val BADGE_CAP = 100

        /** A worker waits this long for the account to load in a process it started. */
        private const val READY_WAIT = 10_000L

        /** Runs per workspace in one background catch-up, while its feed has more pages. */
        private const val WORKER_RUNS = 4

        private val ROLES = setOf("owner", "admin", "member", "guest")
        private val JURISDICTIONS = setOf("eu", "us", "fedramp")
        private val SIGNUPS = setOf("open", "invite", "closed")

        // Failures a socket's recheck after a 4003 waits out before it connects again.
        private val RECHECKED = setOf("network", "server", "rate_limited")

        /** The host of a credential URL, with its port when it has one, for text. */
        fun hostOf(server: String): String = try {
            val uri = URI(server)
            val host = uri.host ?: ""
            if (uri.port > 0) "$host:${uri.port}" else host
        } catch (e: Exception) {
            ""
        }
    }
}

/** A cached room as the UI shows it (§4.6 `Room`): `read` is this phone's `readLocal`, and a muted room asks for nothing. */
internal fun RoomRow.toRoom(preview: Event?): Room {
    val kind = RoomKind.of(kind)
    return Room(
        id = id,
        kind = kind,
        name = if (kind == RoomKind.DM) null else name,
        visibility = visibility,
        archived = archived,
        closedReason = closedReason,
        participants = participants,
        startedBy = startedBy,
        role = role,
        members = members,
        head = head,
        floor = floor,
        lastAt = lastAt,
        read = readLocal,
        unread = unread,
        mentions = mentions,
        attention = if (muted) 0 else if (kind == RoomKind.DM) unread else mentions,
        muted = muted,
        hasCache = hasCache,
        preview = preview,
    )
}

/**
 * Each root's cached replies among [events] (§3.13): how many, the newest seq and time, and up to three repliers,
 * newest first. Removed replies count, as their rows stay.
 */
internal fun replySummaries(events: List<Event>): Map<String, ReplySummary> {
    val byRoot = LinkedHashMap<String, MutableList<Event>>()
    for (e in events) {
        val root = e.root ?: continue
        if (!e.isMessage) continue
        byRoot.getOrPut(root) { ArrayList() } += e
    }
    return byRoot.mapValues { (_, replies) ->
        val newest = replies.maxBy { it.seq }
        val authors = replies.sortedByDescending { it.seq }.map { it.actor }.distinct().take(3)
        ReplySummary(replies.size, newest.seq, newest.at, authors)
    }
}
