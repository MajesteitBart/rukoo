package nl.bvdm.rukoo.workspaces

import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import nl.bvdm.rukoo.account.AccountStatus
import nl.bvdm.rukoo.account.BorrowedSession
import nl.bvdm.rukoo.account.ServerInfo
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.ui.ScreenState
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The workspace service (contract §3.1, §3.3, §3.4, §3.10, §3.11, §7.2): it follows the account, keeps one cache file
 * per session and deletes it at every end of one, makes no workspace request without team chat on the server, lists
 * workspaces and adds or removes them, waits for the first run of a workspace it made or joined, keeps the pending
 * join of a sign-up in memory, counts attention and unsent messages, keeps one socket for the workspace on screen
 * while the app is in the foreground, and wires the feed's runs to the alerts. On a real chat cache, with the account
 * and the sockets faked and the workspace routes scripted, under virtual time.
 */
class WorkspaceServiceTest {
    private val db = TestDb()

    @After
    fun tearDown() = db.close()

    private val ws = Ids.WS

    // ---- the harness ----

    internal class FakeAccount(info: ServerInfo?) : ChatAccount {
        val statusFlow = MutableStateFlow(AccountStatus(server = SERVER, defaultServer = SERVER, info = info))
        private val ended = MutableSharedFlow<Unit>(extraBufferCapacity = 16)
        @Volatile var session: BorrowedSession? = null
        val refused = CopyOnWriteArrayList<BorrowedSession>()
        @Volatile var infoRefreshes = 0
        /** Every GET /v1/info fails, as without network. */
        @Volatile var infoFails = false

        override val status: StateFlow<AccountStatus> get() = statusFlow
        override val sessionEnded: SharedFlow<Unit> get() = ended
        override fun borrowSession(): BorrowedSession? = session

        override fun sessionRefused(session: BorrowedSession) {
            refused += session
            if (this.session === session) signOut()
        }

        override suspend fun refreshInfo() {
            infoRefreshes += 1
            if (infoFails) throw java.io.IOException("offline")
        }

        fun signIn(tag: String) {
            session = BorrowedSession(SERVER, "token-$tag", tag, Any())
            statusFlow.value = statusFlow.value.copy(signedIn = true, email = "me@example.com")
        }

        fun signOut() {
            session = null
            ended.tryEmit(Unit)
            statusFlow.value = statusFlow.value.copy(signedIn = false, email = null)
        }
    }

    /** A socket that opens when started and, like the real one, never again once closed. */
    class FakeSocket(val url: String, val listener: WorkspaceSocket.Listener) : ChatSocket {
        override val state = MutableStateFlow(SocketState.OFF)
        @Volatile var starts = 0
        @Volatile var closes = 0
        @Volatile var checks = 0

        override fun start() {
            starts += 1
            if (closes == 0) state.value = SocketState.OPEN
        }

        override fun nudge() {}

        override fun check() {
            checks += 1
        }

        override fun close() {
            closes += 1
            state.value = SocketState.OFF
        }
    }

    class FakeSockets : ChatSockets {
        val opened = CopyOnWriteArrayList<FakeSocket>()
        override fun open(url: String, ticket: suspend () -> SocketTicket, listener: WorkspaceSocket.Listener, scope: CoroutineScope, pacing: SocketPacing): ChatSocket =
            FakeSocket(url, listener).also { opened += it }
    }

    /** Real [WorkspaceSocket]s, each kept as the service got it, so a test can call one the service let go of. */
    class RecordingSockets(private val real: ChatSockets) : ChatSockets {
        val opened = CopyOnWriteArrayList<ChatSocket>()
        override fun open(url: String, ticket: suspend () -> SocketTicket, listener: WorkspaceSocket.Listener, scope: CoroutineScope, pacing: SocketPacing): ChatSocket =
            real.open(url, ticket, listener, scope, pacing).also { opened += it }
    }

    internal class Harness(val scope: TestScope, val db: TestDb, info: ServerInfo? = CHAT_INFO) {
        val http = ScriptedHttp()
        val clock = Clock { TestDb.NOW + scope.testScheduler.currentTime }
        val account = FakeAccount(info)
        val sink = ChatAlertRulesTest.RecordingSink()
        val settings = MutableStateFlow(AppSettings())
        val screen = ScreenState(clock)
        val sockets = FakeSockets()
        /** Other sockets than [sockets], such as [RecordingSockets]. */
        var chatSockets: ChatSockets? = null
        lateinit var service: WorkspaceService
        /** The app's GET /v1/info while signed out too (WorkspaceService autoInfo). */
        var autoInfo = false
        var timing = ChatTiming()

        /** What GET /v1/workspaces lists: IDs, with the names and roles below. */
        @Volatile var listing: List<String> = emptyList()
        val roles = HashMap<String, String>()

        init {
            http.on("GET", "/v1/workspaces") { ok(WorkspaceList.serializer(), WorkspaceList(listing.map { WorkspaceRef(it, name(it), roles[it] ?: "member") })) }
        }

        fun name(id: String) = if (id == Ids.WS) "Team" else "Other"

        /**
         * Starts the service, by default as an app in the foreground ([WorkspaceService.resumed] before the account is
         * followed); [foreground] false starts it as a process the system started in the background.
         */
        fun start(foreground: Boolean = true): WorkspaceService {
            service = WorkspaceService(
                account = account,
                http = http,
                file = db.file,
                driver = db.driver,
                sockets = chatSockets ?: sockets,
                scope = scope.backgroundScope,
                settings = settings,
                screen = screen,
                sink = sink,
                words = { ChatAlertRulesTest.Words },
                clock = clock,
                timing = timing,
                io = Dispatchers.Unconfined,
                random = { 0.5 },
                autoInfo = autoInfo,
            ).start()
            if (foreground) service.resumed()
            return service
        }

        /** Writes a cache file for session [tag] before the service starts, then closes it. */
        suspend fun seed(tag: String = "mine", block: WorkspaceStore.StoreTx.() -> Unit = {}) {
            val store = db.store()
            store.tx {
                setMeta(WorkspaceService.META_SESSION, tag)
                setMeta(WorkspaceService.META_SERVER, SERVER)
                block()
            }
            store.close()
        }

        fun route(w: String = Ids.WS, rest: String = "") = "/v1/workspaces/$w$rest"

        fun list(vararg ids: String) {
            listing = ids.toList()
        }

        /** A workspace whose routes answer: GET /, a feed of [rooms], me and Olga as members (me in my [roles] role), and empty directories. */
        fun workspace(w: String = Ids.WS, vararg rooms: Change) {
            http.on("GET", route(w)) { ok(WorkspaceDetails.serializer(), details(ws = w)) }
            http.on("GET", route(w, "/changes")) { ok(FeedPage.serializer(), feed(*rooms, next = "c1")) }
            http.on("GET", route(w, "/members")) {
                ok(MembersPage.serializer(), MembersPage(listOf(Member(Ids.ME, name = "Me", role = roles[w] ?: "member", state = "active"), Member(Ids.OLGA, name = "Olga", role = "member", state = "active"))))
            }
            http.on("GET", route(w, "/channels")) { ok(ChannelsPage.serializer(), ChannelsPage()) }
            http.on("GET", route(w, "/blocks")) { ok(BlocksPage.serializer(), BlocksPage()) }
        }
    }

    /** A synced workspace row, as a finished first pass leaves it. */
    private fun WorkspaceStore.StoreTx.syncedWs(id: String = Ids.WS, name: String = "Team") {
        insertWs(
            WsRow(
                id = id, name = name, role = "member", me = Ids.ME, myName = "Me", generation = Ids.GEN, keyId = Ids.KEY,
                cursor = "c0", passing = false, fresh = false, membersStale = false, channelsStale = false, blocksStale = false,
            ),
        )
    }

    private suspend fun <T> Flow<T>.until(what: String = "the expected state", test: (T) -> Boolean): T = try {
        withTimeout(10_000) { first(test) }
    } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
        fail("timed out waiting for $what")
        throw e
    }

    private fun files(file: File) = listOf(file, File(file.path + "-wal"), File(file.path + "-shm"))

    // ---- following the account ----

    @Test
    fun `signed out at start, the cache and its side files go and nothing is asked`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs() }
        File(db.file.path + "-wal").writeText("")
        File(db.file.path + "-shm").writeText("")
        val s = h.start()
        assertTrue(s.awaitReady())
        runCurrent()
        assertTrue("no cache file is left", files(db.file).none { it.exists() })
        assertTrue(h.http.calls.isEmpty())
        val state = s.state.until { it.available }
        assertFalse(state.signedIn)
        assertTrue(state.workspaces.isEmpty())
        assertEquals(ChatAlertRules.PREFIX, h.sink.cleared.single())
    }

    @Test
    fun `a server without team chat makes no workspace request and no cache`() = runTest {
        val h = Harness(this, db, info = ServerInfo(protocol = 1, features = listOf("booking")))
        h.account.signIn("mine")
        val s = h.start()
        assertTrue(s.awaitReady())
        advanceTimeBy(2 * ChatTiming.HOUR)
        assertTrue(h.http.calls.isEmpty())
        assertFalse(db.file.exists())
        val state = s.state.until { it.signedIn }
        assertFalse(state.available)
        try {
            s.createWorkspace("Team", "Me")
            fail("no workspace calls without team chat")
        } catch (e: WorkspaceError) {
            assertEquals("server", e.code)
        }
        assertTrue("the server's info is asked again every hour", h.account.infoRefreshes >= 2)
    }

    // A fresh install started before the network was up (RUK-234 review): Chat and onboarding's way to it show soon
    // after the network comes, not at the next hourly tick. Desktop's chat-join.test.js checks the same.
    @Test
    fun `a signed-out ask that failed comes again after 15 s, a minute and five minutes, then hourly`() = runTest {
        val h = Harness(this, db, info = null)
        h.autoInfo = true
        h.account.infoFails = true
        h.start()
        runCurrent()
        assertEquals(1, h.account.infoRefreshes)
        for ((wait, asked) in listOf(15_000L to 2, 60_000L to 3, 300_000L to 4)) {
            advanceTimeBy(wait - 1)
            runCurrent()
            assertEquals("not before $wait ms", asked - 1, h.account.infoRefreshes)
            advanceTimeBy(1)
            runCurrent()
            assertEquals("after $wait ms", asked, h.account.infoRefreshes)
        }
        // No more retries of their own: the hourly tick asks next.
        advanceTimeBy(50 * ChatTiming.MINUTE)
        runCurrent()
        assertEquals(4, h.account.infoRefreshes)
        h.account.infoFails = false
        advanceTimeBy(10 * ChatTiming.MINUTE)
        runCurrent()
        assertEquals(5, h.account.infoRefreshes)
    }

    @Test
    fun `the foreground or a network that came up asks again after a failure, within the gate`() = runTest {
        val h = Harness(this, db, info = null)
        h.autoInfo = true
        h.account.infoFails = true
        val s = h.start(foreground = false)
        runCurrent()
        assertEquals(1, h.account.infoRefreshes)
        // Within 15 s of the last ask, coming to the foreground asks nothing.
        advanceTimeBy(5_000)
        s.resumed()
        runCurrent()
        assertEquals(1, h.account.infoRefreshes)
        // The first retry fails too, and the next would wait a minute.
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(2, h.account.infoRefreshes)
        // A network comes up 20 s later (ChatBackground's callback nudges): it asks at once, and the retry timer goes.
        advanceTimeBy(20_000)
        h.account.infoFails = false
        s.nudge()
        runCurrent()
        assertEquals(3, h.account.infoRefreshes)
        advanceTimeBy(5 * ChatTiming.MINUTE)
        s.paused()
        s.resumed()
        runCurrent()
        assertEquals("after an answer nothing asks again before the hour", 3, h.account.infoRefreshes)
    }

    @Test
    fun `switching servers and back keeps the first server's retry`() = runTest {
        val h = Harness(this, db, info = null)
        h.autoInfo = true
        h.account.infoFails = true
        h.start()
        runCurrent()
        assertEquals(1, h.account.infoRefreshes)
        // Another server for a moment: it is asked and fails, with a retry of its own.
        advanceTimeBy(5_000)
        h.account.statusFlow.value = h.account.statusFlow.value.copy(server = "https://chat.example.com")
        runCurrent()
        assertEquals(2, h.account.infoRefreshes)
        // Back within the short gap: nothing asks at once, and the first server's retry still comes at 15 s.
        advanceTimeBy(5_000)
        h.account.statusFlow.value = h.account.statusFlow.value.copy(server = SERVER)
        runCurrent()
        assertEquals(2, h.account.infoRefreshes)
        advanceTimeBy(5_000)
        runCurrent()
        assertEquals(3, h.account.infoRefreshes)
        // The other server's retry comes while it isn't configured: it asks nothing.
        advanceTimeBy(5_000)
        runCurrent()
        assertEquals(3, h.account.infoRefreshes)
    }

    @Test
    fun `team chat turned off on the server stops the outbox's queued rows and its timer until it is back`() = runTest {
        val h = Harness(this, db)
        h.seed {
            syncedWs()
            upsertRoom(ws, room())
            setMeta(Outbox.CLOCK_OFFSET, "0")
            setMeta(Outbox.CLOCK_AT, TestDb.NOW.toString())
            // Waiting out a backoff: the outbox's timer sends it in 30 s.
            insertOutbox(OutboxRow("local1", ws, Ids.GENERAL, Ids.ME, Ids.grant(1), Ids.GEN, "hello", emptyList(), null, nextAt = TestDb.NOW + 30_000, createdAt = 1))
        }
        h.list(ws)
        h.workspace(ws, room())
        val post = h.route(ws, "/conversations/${Ids.GENERAL}/messages")
        h.http.on("POST", post) { ok(SendAck.serializer(), SendAck(messageId = Ids.event(11), seq = 11), status = 201) }
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.workspaces.isNotEmpty() && it.connection == Connection.ONLINE }
        runCurrent()
        assertTrue("not due yet", h.http.calls("POST", post).isEmpty())

        h.account.statusFlow.value = h.account.statusFlow.value.copy(info = ServerInfo(protocol = 1, features = listOf("booking")))
        s.state.until("team chat off") { !it.available }
        runCurrent()
        val before = h.http.calls.size
        advanceTimeBy(2 * ChatTiming.MINUTE)
        assertEquals("no workspace request while team chat is off, the outbox's timer included", before, h.http.calls.size)
        assertEquals(1, s.state.value.unsent)

        h.account.statusFlow.value = h.account.statusFlow.value.copy(info = CHAT_INFO)
        withTimeout(10_000) { while (h.http.calls("POST", post).isEmpty()) delay(100) }
        s.state.until("sent once team chat is back") { it.unsent == 0 }
        h.http.verify()
    }

    @Test
    fun `ChatSyncWorker's schedule waits for the account, so a cached workspace never reads as none at start`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs() }
        h.list(ws)
        h.workspace(ws, room())
        h.account.signIn("mine")
        val s = h.start()
        val seen = CopyOnWriteArrayList<Boolean>()
        backgroundScope.launch(start = CoroutineStart.UNDISPATCHED) { s.hasWorkspaces.collect { seen += it } }
        assertTrue("nothing before the service followed the account", seen.isEmpty())
        s.state.until { it.workspaces.isNotEmpty() && it.connection == Connection.ONLINE }
        runCurrent()
        assertEquals(listOf(true), seen.toList())

        h.account.signOut()
        s.state.until { !it.signedIn }
        runCurrent()
        assertEquals(listOf(true, false), seen.toList())
    }

    @Test
    fun `signed out at start, ChatSyncWorker's schedule says no workspace once the account was followed`() = runTest {
        val h = Harness(this, db)
        val s = h.start()
        val seen = CopyOnWriteArrayList<Boolean>()
        backgroundScope.launch(start = CoroutineStart.UNDISPATCHED) { s.hasWorkspaces.collect { seen += it } }
        assertTrue(seen.isEmpty())
        assertTrue(s.awaitReady())
        runCurrent()
        assertEquals(listOf(false), seen.toList())
    }

    @Test
    fun `unsent messages a broken cache took are reported once, until the UI takes the count`() = runTest {
        val h = Harness(this, db)
        h.seed {
            syncedWs()
            upsertRoom(ws, room())
            for (local in listOf("l1", "l2")) {
                insertOutbox(OutboxRow(local, ws, Ids.GENERAL, Ids.ME, Ids.grant(1), Ids.GEN, "hi", emptyList(), null, createdAt = 1))
            }
            // A newer Rukoo's file: replaced, its outbox counted first.
            sql.exec("UPDATE meta SET value = ? WHERE key = 'schema'", (ChatDb.SCHEMA_VERSION + 1).toString())
        }
        h.list()
        h.account.signIn("mine")
        val s = h.start()
        val state = s.state.until("listed after the cache was made again") { it.signedIn && it.connection == Connection.ONLINE }
        assertEquals("later states still carry it", 2, state.lostUnsent)
        assertTrue(state.workspaces.isEmpty())
        assertEquals(2, s.takeLostUnsent())
        assertEquals(0, s.state.until { it.lostUnsent == 0 }.lostUnsent)
        assertEquals(0, s.takeLostUnsent())
    }

    @Test
    fun `a cache of another session is deleted and made again for this one`() = runTest {
        val h = Harness(this, db)
        h.seed(tag = "someone-else") { syncedWs(Ids.WS2, "Old") }
        h.list()
        h.account.signIn("mine")
        val s = h.start()
        val state = s.state.until("signed in with an empty list") { it.signedIn && it.connection == Connection.ONLINE }
        assertTrue(state.workspaces.isEmpty())
        s.close()
        val store = db.store()
        assertEquals("mine", store.read { getMeta(WorkspaceService.META_SESSION) })
        assertTrue(store.read { listWs() }.isEmpty())
        store.close()
        h.http.verify()
    }

    @Test
    fun `this session's cache shows at once and then syncs in the background`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs(); upsertRoom(ws, room(head = 2, unread = 1)) }
        val listing = CompletableDeferred<Unit>()
        h.http.once("GET", "/v1/workspaces") {
            listing.await()
            ok(WorkspaceList.serializer(), WorkspaceList(listOf(WorkspaceRef(ws, "Team", "member"))))
        }
        h.list(ws)
        val feedGate = CompletableDeferred<Unit>()
        h.http.on("GET", h.route(ws, "/changes")) {
            feedGate.await()
            ok(FeedPage.serializer(), feed(room(head = 5, unread = 3), next = "c1"))
        }
        // The channel's unread messages get the one page an alert may load for replies to the person (issue #376).
        val events = EventsRoute((1L..5L).map { msg(it) })
        h.http.on("GET", h.route(ws, "/conversations/${Ids.GENERAL}/events")) { events.answer(it) }
        h.account.signIn("mine")
        val s = h.start()
        val cached = s.state.until("the cached workspace") { it.workspaces.isNotEmpty() }
        assertEquals(WorkspaceStatus.OK, cached.workspaces.single().status)
        assertEquals("cached rooms show before any answer", 2L, s.view(ws).first().rooms.single().head)
        listing.complete(Unit)
        feedGate.complete(Unit)
        s.view(ws).until("the synced room") { it.rooms.single().head == 5L }
        h.http.verify()
    }

    @Test
    fun `the end of the session deletes the cache and takes back every alert`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs() }
        h.list(ws)
        h.workspace(ws, room())
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.workspaces.isNotEmpty() }
        assertTrue(db.file.exists())
        h.account.signOut()
        s.state.until("signed out") { !it.signedIn }
        runCurrent()
        assertTrue(files(db.file).none { it.exists() })
        assertTrue(s.state.value.workspaces.isEmpty())
        assertEquals(ChatAlertRules.PREFIX, h.sink.cleared.last())
        assertNull(s.takePendingJoin())
    }

    @Test
    fun `a 401 from a workspace route signs the account out once and deletes the cache`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs() }
        h.list(ws)
        h.http.on("GET", h.route(ws, "/changes")) { throw refusal(401, "signed_out", scope = "account") }
        h.account.signIn("mine")
        val s = h.start()
        s.state.until("signed out by the 401") { it.available && !it.signedIn }
        runCurrent()
        assertEquals(1, h.account.refused.size)
        assertFalse(db.file.exists())
    }

    @Test
    fun `an answer for an ended session never reaches the next session's cache`() = runTest {
        val h = Harness(this, db)
        val first = CompletableDeferred<Unit>()
        h.http.once("GET", "/v1/workspaces") {
            first.await()
            ok(WorkspaceList.serializer(), WorkspaceList(listOf(WorkspaceRef(Ids.WS2, "Stale", "member"))))
        }
        h.account.signIn("one")
        val s = h.start()
        runCurrent()
        assertEquals(1, h.http.calls("GET", "/v1/workspaces").size)
        h.account.signOut()
        h.account.signIn("two")
        s.state.until("the second session listed") { it.signedIn && it.connection == Connection.ONLINE }
        first.complete(Unit)
        advanceTimeBy(5_000)
        assertTrue("the first session's listing was dropped", s.state.value.workspaces.isEmpty())
        h.http.verify()
    }

    // ---- listing ----

    @Test
    fun `a new workspace gets a row and a first pass, and one the listing leaves out stays until its own 404`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs(Ids.WS2, "Old") }
        h.list(ws)
        h.workspace(ws, room())
        var gone = false
        h.http.on("GET", h.route(Ids.WS2)) { if (gone) throw refusal(404, "not_found", scope = "workspace") else throw refusal(503, "server") }
        h.http.on("GET", h.route(Ids.WS2, "/changes")) { ok(FeedPage.serializer(), feed(next = "c1")) }
        h.account.signIn("mine")
        val s = h.start()
        val state = s.state.until("both workspaces synced") { st -> st.workspaces.size == 2 && st.workspaces.all { it.status == WorkspaceStatus.OK } }
        assertEquals(setOf(ws, Ids.WS2), state.workspaces.map { it.id }.toSet())
        assertEquals("the new one ran its first pass", 1, s.view(ws).first().rooms.size)
        assertTrue(h.http.calls("GET", h.route(Ids.WS2)).isNotEmpty())

        gone = true
        s.refresh()
        s.state.until("the one that went is removed") { st -> st.workspaces.map { it.id } == listOf(ws) }
        h.http.verify()
    }

    @Test
    fun `a removed workspace whose deletion SQLite refuses stays hidden and is deleted on a later try`() = runTest {
        val h = Harness(this, db)
        h.seed {
            syncedWs(ws)
            syncedWs(Ids.WS2, "Old")
            sql.exec("CREATE TRIGGER keep_ws2 BEFORE DELETE ON ws WHEN old.id = '${Ids.WS2}' BEGIN SELECT RAISE(ABORT, 'refused'); END")
        }
        h.list(ws)
        h.workspace(ws, room())
        h.http.on("GET", h.route(Ids.WS2)) { throw refusal(404, "not_found", scope = "workspace") }
        h.account.signIn("mine")
        val s = h.start()
        s.state.until("the one that went is hidden") { st -> st.workspaces.map { it.id } == listOf(ws) }
        // Another connection to the same file sees the row SQLite kept, and lets the next try delete it.
        val other = db.store()
        assertEquals(1L, other.read { sql.long("SELECT COUNT(*) FROM ws WHERE id = ?", Ids.WS2) })
        other.tx { sql.exec("DROP TRIGGER keep_ws2") }
        other.close()
        advanceTimeBy(ChatTiming().wipeRetry + 1)
        runCurrent()
        val check = db.store()
        assertEquals("deleted on the retry", 0L, check.read { sql.long("SELECT COUNT(*) FROM ws WHERE id = ?", Ids.WS2) })
        check.close()
        assertEquals(listOf(ws), s.state.value.workspaces.map { it.id })
    }

    @Test
    fun `the listing on resume comes at most once a minute`() = runTest {
        val h = Harness(this, db)
        h.list()
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.connection == Connection.ONLINE }
        assertEquals(1, h.http.calls("GET", "/v1/workspaces").size)
        s.resumed()
        advanceTimeBy(30_000)
        s.nudge()
        runCurrent()
        assertEquals(1, h.http.calls("GET", "/v1/workspaces").size)
        advanceTimeBy(31_000)
        s.nudge()
        runCurrent()
        assertEquals(2, h.http.calls("GET", "/v1/workspaces").size)
    }

    @Test
    fun `a role someone gives me reaches the workspace list with the members reload`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs() }
        h.list(ws)
        h.workspace(ws, room())
        h.account.signIn("mine")
        val s = h.start()
        s.state.until("the workspace synced") { st -> st.connection == Connection.ONLINE && st.workspaces.singleOrNull()?.status == WorkspaceStatus.OK }
        assertEquals("member", s.state.value.workspaces.single().role)

        // An admin makes me admin: my feed marks the members directory stale; no GET / is due.
        h.http.once("GET", h.route(ws, "/changes")) { ok(FeedPage.serializer(), feed(room(), directory = Directory(members = true), next = "c2")) }
        h.http.once("GET", h.route(ws, "/members")) {
            ok(MembersPage.serializer(), MembersPage(listOf(Member(Ids.ME, name = "Me", role = "admin", state = "active"), Member(Ids.OLGA, name = "Olga", role = "owner", state = "active"))))
        }
        val gets = h.http.calls("GET", h.route(ws)).size
        s.refresh(ws)
        assertEquals("admin", s.state.until("my new role in the workspace list") { st -> st.workspaces.singleOrNull()?.role == "admin" }.workspaces.single().role)
        val view = s.view(ws).first()
        assertEquals("admin", view.ws.role)
        assertEquals("admin", view.me.role)
        assertEquals("no GET / brought it", gets, h.http.calls("GET", h.route(ws)).size)
        h.http.verify()
    }

    // ---- agents in channels ----

    @Test
    fun `an agent made, changed and removed reaches the directory at once, and one gone already counts as removed`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs() }
        h.list(ws)
        h.workspace(ws, room())
        h.account.signIn("mine")
        val s = h.start()
        s.state.until("the workspace synced") { st -> st.connection == Connection.ONLINE && st.workspaces.singleOrNull()?.status == WorkspaceStatus.OK }

        val clark = Ids.id("u", 9, 'C')
        val made = Agent(clark, "Clark", Ids.ME, "sponsor")
        val key = "rka_" + clark.removePrefix("u_") + "." + "k".repeat(43)
        val me = Member(Ids.ME, name = "Me", role = "member", state = "active")
        h.http.once("POST", h.route(ws, "/agents")) { ok(MadeAgent.serializer(), MadeAgent(made, key), status = 201) }
        h.http.once("GET", h.route(ws, "/members")) {
            ok(MembersPage.serializer(), MembersPage(listOf(me, Member(clark, Member.KIND_AGENT, "Clark", "member", "active", agent = made.settings))))
        }
        // Only the chosen people go, and only for "members": the service drops a list a choice doesn't use.
        val got = s.createAgent(ws, "  Clark ", "sponsor", listOf(Ids.OLGA), agents = false)
        assertEquals(key, got.key)
        val sent = h.http.calls("POST", h.route(ws, "/agents")).single().body!!.jsonObject
        assertEquals("Clark", (sent.getValue("name") as JsonPrimitive).content)
        assertEquals(0, sent.getValue("members").jsonArray.size)
        val view = s.view(ws).until("the agent in the directory") { v -> v.members.any { it.isAgent } }
        assertEquals(made.settings, view.members.single { it.isAgent }.agent)

        // A change names the chosen people once each.
        val changed = made.copy(answers = "members", members = listOf(Ids.OLGA), agents = true)
        h.http.once("PATCH", h.route(ws, "/agents/$clark")) { ok(AgentAnswer.serializer(), AgentAnswer(changed)) }
        h.http.once("GET", h.route(ws, "/members")) {
            ok(MembersPage.serializer(), MembersPage(listOf(me, Member(clark, Member.KIND_AGENT, "Clark", "member", "active", agent = changed.settings))))
        }
        s.updateAgent(ws, clark, "Clark", "members", listOf(Ids.OLGA, Ids.OLGA), agents = true)
        val patched = h.http.calls("PATCH", h.route(ws, "/agents/$clark")).single().body!!.jsonObject
        assertEquals(listOf(Ids.OLGA), patched.getValue("members").jsonArray.map { (it as JsonPrimitive).content })
        s.view(ws).until("the changed settings") { v -> v.members.any { it.agent?.agents == true } }

        // A key that isn't this agent's is no answer the config can use.
        h.http.once("POST", h.route(ws, "/agents/$clark/key")) { ok(MadeAgent.serializer(), MadeAgent(made, "rka_short.key")) }
        try {
            s.newAgentKey(ws, clark)
            fail("a key of the wrong shape is refused")
        } catch (e: WorkspaceError) {
            assertEquals("server", e.code)
        }

        // Removed meanwhile by its sponsor on another device: the 404 counts as done, and the directory loads again.
        h.http.once("DELETE", h.route(ws, "/agents/$clark")) { throw refusal(404, "not_found") }
        h.http.once("GET", h.route(ws, "/members")) { ok(MembersPage.serializer(), MembersPage(listOf(me))) }
        s.removeAgent(ws, clark)
        s.view(ws).until("the agent gone from the directory") { v -> v.members.none { it.isAgent } }
        h.http.verify()
    }

    // ---- making and joining ----

    @Test
    fun `making a workspace returns after its first run, with its rooms, selected`() = runTest {
        val h = Harness(this, db)
        h.http.on("POST", "/v1/workspaces") {
            h.roles[ws] = "owner"
            h.list(ws)
            ok(Joined.serializer(), Joined(details(ws = ws).workspace, Member(Ids.ME, name = "Me", role = "owner", state = "active")), status = 201)
        }
        h.workspace(ws, room())
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.connection == Connection.ONLINE }
        assertEquals(ws, s.createWorkspace("Team", "Me"))
        val view = s.view(ws).first()
        assertEquals(listOf(Ids.GENERAL), view.rooms.map { it.id })
        assertEquals("owner", view.ws.role)
        assertEquals(ws, s.state.until { it.selected == ws }.selected)
        h.http.verify()
    }

    @Test
    fun `joining with a link previews, joins and keeps the sign-up's pending join until it is used`() = runTest {
        val h = Harness(this, db)
        h.list()
        val secret = "s".repeat(43)
        val link = InviteLink(SERVER, ws, secret)
        h.http.on("POST", h.route(ws, "/invites/preview")) {
            ok(InvitePreview.serializer(), InvitePreview(WorkspaceRef(ws, "Team"), "member", 1, IssuerName("Olga"), 0))
        }
        h.http.on("POST", h.route(ws, "/join")) {
            h.list(ws)
            ok(Joined.serializer(), Joined(details(ws = ws).workspace, Member(Ids.ME, name = "Me", role = "member", state = "active")), status = 201)
        }
        h.workspace(ws, room())
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.connection == Connection.ONLINE }

        s.rememberJoin(link)
        assertTrue(s.state.until { it.pendingJoin }.pendingJoin)

        val preview = s.previewInvite(link)
        assertEquals("Olga", preview.issuer.name)
        assertFalse(preview.already)
        assertEquals(ws, s.join(link, "Me"))
        assertEquals(1, s.view(ws).first().rooms.size)
        assertFalse("the join used the pending link", s.state.until { !it.pendingJoin }.pendingJoin)
        assertNull(s.takePendingJoin())
        assertTrue("already a member now", s.previewInvite(link).already)

        try {
            s.previewInvite(InviteLink("https://elsewhere.example", ws, secret))
            fail("a link for another server")
        } catch (e: WorkspaceError) {
            assertEquals("other_server", e.code)
        }
        h.http.verify()
    }

    @Test
    fun `the pending join is taken once and belongs to its session`() = runTest {
        val h = Harness(this, db)
        h.list()
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.connection == Connection.ONLINE }
        val link = InviteLink(SERVER, ws, "s".repeat(43))
        s.rememberJoin(link)
        assertEquals(link, s.takePendingJoin())
        assertNull(s.takePendingJoin())
        s.rememberJoin(link)
        h.account.signOut()
        h.account.signIn("another")
        s.state.until { it.signedIn && it.connection == Connection.ONLINE }
        assertFalse(s.state.value.pendingJoin)
        assertNull(s.takePendingJoin())
    }

    @Test
    fun `the pending join waits on disk across a restart until it is joined or let go`() = runTest {
        val h = Harness(this, db)
        h.list()
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.connection == Connection.ONLINE }
        val link = InviteLink(SERVER, ws, "s".repeat(43))
        s.rememberJoin(link)
        assertTrue(File(db.file.parentFile, "chat-join.json").exists())
        assertEquals(link, s.takePendingJoin())
        // Shown once in this process; it stays on disk.
        assertFalse(s.state.until { !it.pendingJoin }.pendingJoin)
        s.close()

        // The next start of the same session offers it again; Cancel in the Join sheet lets it go.
        val again = h.start()
        assertTrue(again.state.until { it.pendingJoin }.pendingJoin)
        assertEquals(link, again.takePendingJoin())
        again.dropPendingJoin()
        assertFalse(File(db.file.parentFile, "chat-join.json").exists())
        again.close()
        val third = h.start()
        third.state.until { it.connection == Connection.ONLINE }
        assertFalse(third.state.value.pendingJoin)
        assertNull(third.takePendingJoin())
    }

    @Test
    fun `a pending join older than an invitation lasts, or of another session, is no pending join`() = runTest {
        val h = Harness(this, db)
        h.list()
        val file = File(db.file.parentFile, "chat-join.json")
        file.parentFile?.mkdirs()
        val link = "$SERVER/join#w=$ws&i=${"s".repeat(43)}"
        file.writeText("""{"link":"$link","tag":"mine","at":${TestDb.NOW - 8 * 24 * 60 * 60 * 1000L}}""")
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.connection == Connection.ONLINE }
        assertFalse(s.state.value.pendingJoin)
        assertNull(s.takePendingJoin())
        assertFalse(file.exists())
        s.close()

        file.writeText("""{"link":"$link","tag":"someone-else","at":${TestDb.NOW}}""")
        val other = h.start()
        other.state.until { it.connection == Connection.ONLINE }
        assertFalse(other.state.value.pendingJoin)
        assertFalse("another session's join goes once the cache opens", file.exists())
    }

    @Test
    fun `a server that claims rukoo's address as its home gets no rukoo links, and new links name it`() = runTest {
        val info = CHAT_INFO.copy(workspace = CHAT_INFO.workspace!!.copy(home = WorkspaceHome("https://rukoo.io")))
        val h = Harness(this, db, info)
        h.seed { syncedWs() }
        h.list(ws)
        h.workspace(ws, room())
        val secret = "s".repeat(43)
        h.http.on("POST", h.route(ws, "/invites/preview")) {
            ok(InvitePreview.serializer(), InvitePreview(WorkspaceRef(ws, "Team"), "member", 1, IssuerName("Olga"), 0))
        }
        h.http.on("POST", h.route(ws, "/invites")) { ok(CreatedInvite.serializer(), CreatedInvite(Invite("i_" + "A".repeat(22), "member"), secret), status = 201) }
        h.account.signIn("mine")
        val s = h.start()
        val state = s.state.until { it.workspaces.isNotEmpty() && it.connection == Connection.ONLINE }
        // Only the app's own list makes addresses one server: what the server says of its home adds nothing.
        assertEquals(listOf(SERVER), state.linkServers)
        for (claimed in listOf("https://rukoo.io", "https://rukoo-account.bvdm.ai")) {
            try {
                s.previewInvite(InviteLink(claimed, ws, secret))
                fail("a link for another server: $claimed")
            } catch (e: WorkspaceError) {
                assertEquals("other_server", e.code)
            }
        }
        assertTrue(h.http.calls("POST", h.route(ws, "/invites/preview")).isEmpty())
        // A pending link the service refuses as another server's goes, so a restart doesn't offer it again.
        s.rememberJoin(InviteLink("https://elsewhere.example", ws, secret))
        assertTrue(s.state.until { it.pendingJoin }.pendingJoin)
        try {
            s.previewInvite(InviteLink("https://elsewhere.example", ws, secret))
            fail("a link for another server")
        } catch (e: WorkspaceError) {
            assertEquals("other_server", e.code)
        }
        assertFalse(s.state.until { !it.pendingJoin }.pendingJoin)
        assertFalse(File(db.file.parentFile, "chat-join.json").exists())
        // Its own links preview, and new links name the configured server.
        assertTrue(s.previewInvite(InviteLink(SERVER, ws, secret)).already)
        assertEquals("$SERVER/join#w=$ws&i=$secret", s.createInvite(ws, "member", emptyList(), 86_400).link)
    }

    @Test
    fun `leaving a workspace removes it and its alerts, then lists again`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs() }
        h.list(ws)
        h.workspace(ws, room())
        h.http.on("DELETE", h.route(ws, "/members/me")) { WorkspaceAnswer(204, null) }
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.workspaces.isNotEmpty() && it.connection == Connection.ONLINE }
        val lists = h.http.calls("GET", "/v1/workspaces").size
        h.list()
        s.leaveWorkspace(ws)
        s.state.until("the workspace went") { it.workspaces.isEmpty() }
        advanceTimeBy(1_000)
        assertTrue(h.http.calls("GET", "/v1/workspaces").size > lists)
        assertTrue(ChatAlertRules.workspacePrefix(ws) in h.sink.cleared)
        h.http.verify()
    }

    @Test
    fun `a workspace waiting for a newer Rukoo refuses writes before they reach the server`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs() }
        h.list(ws)
        h.workspace(ws, room())
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.workspaces.isNotEmpty() && it.connection == Connection.ONLINE }
        // The server asks for an update: the feed parks the workspace.
        h.http.once("GET", h.route(ws, "/changes")) { throw refusal(426, "upgrade_required") }
        s.refresh(ws)
        s.state.until("the upgrade state") { it.workspaces.single().status == WorkspaceStatus.UPGRADE }
        val before = h.http.calls.size
        for (write in listOf<suspend () -> Unit>(
            { s.leaveWorkspace(ws) },
            { s.renameMe(ws, "New name") },
            { s.createInvite(ws, "member", emptyList(), 86_400) },
            { s.redact(ws, Ids.GENERAL, Ids.event(1, 1)) },
        )) {
            try {
                write()
                fail("a write went through in the upgrade state")
            } catch (e: WorkspaceError) {
                assertEquals("upgrade_required", e.code)
            }
        }
        assertEquals("nothing reached the server", before, h.http.calls.size)
        assertTrue(s.state.value.workspaces.isNotEmpty())
    }

    // ---- what the UI reads ----

    @Test
    fun `attention counts DMs' unread and channels' mentions, mute silences a room, and unsent counts the outbox`() = runTest {
        val h = Harness(this, db)
        h.seed {
            syncedWs()
            upsertRoom(ws, room(Ids.DM, dm = true, head = 2, unread = 2))
            upsertRoom(ws, room(Ids.GENERAL, head = 5, unread = 3, mentions = 1))
            upsertRoom(ws, room(Ids.RANDOM, name = "random", head = 4, unread = 4))
            setRoomFields(ws, Ids.DM, mapOf("notified" to 2L))
            setRoomFields(ws, Ids.GENERAL, mapOf("notified" to 5L))
            insertOutbox(OutboxRow("local1", ws, Ids.RANDOM, Ids.ME, Ids.grant(1), Ids.GEN, "hello", emptyList(), null, state = "held", reason = "stale_grant", createdAt = 1))
        }
        val gate = CompletableDeferred<Unit>()
        h.http.once("GET", "/v1/workspaces") {
            gate.await()
            ok(WorkspaceList.serializer(), WorkspaceList(listOf(WorkspaceRef(ws, "Team", "member"))))
        }
        h.http.on("GET", h.route(ws, "/changes")) {
            gate.await()
            ok(FeedPage.serializer(), feed(next = "c1"))
        }
        h.account.signIn("mine")
        val s = h.start()
        val state = s.state.until { it.workspaces.isNotEmpty() }
        assertEquals(3, state.attention)
        assertTrue(state.unread)
        assertEquals(1, state.unsent)
        assertEquals(3, state.workspaces.single().attention)
        s.setMuted(ws, Ids.DM, true)
        assertEquals(1, s.state.until { it.attention != 3 }.attention)
        val dm = s.view(ws).first().rooms.single { it.id == Ids.DM }
        assertTrue(dm.muted)
        assertEquals(0, dm.attention)
    }

    @Test
    fun `the socket is open only for the workspace on screen while the app is in the foreground`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs(); syncedWs(Ids.WS2, "Other") }
        h.list(ws, Ids.WS2)
        h.workspace(ws)
        h.workspace(Ids.WS2)
        h.account.signIn("mine")
        val s = h.start(foreground = false)
        s.state.until { it.workspaces.size == 2 }
        s.onScreen(ws, null, null)
        runCurrent()
        assertTrue("no socket in the background", h.sockets.opened.isEmpty())
        assertEquals(ws, h.screen.current.chatWorkspace)

        s.resumed()
        runCurrent()
        val first = h.sockets.opened.single()
        assertEquals("ws://127.0.0.1:1/v1/workspaces/$ws/socket", first.url)
        assertEquals(SocketState.OPEN, s.state.until { st -> st.workspaces.any { it.socket == SocketState.OPEN } }.workspaces.single { it.id == ws }.socket)

        s.onScreen(Ids.WS2, null, null)
        runCurrent()
        assertEquals(1, first.closes)
        assertEquals(2, h.sockets.opened.size)
        assertTrue(h.sockets.opened[1].url.endsWith("/${Ids.WS2}/socket"))

        s.paused()
        runCurrent()
        assertEquals(1, h.sockets.opened[1].closes)
        s.onScreen(null, null, null)
        s.resumed()
        runCurrent()
        assertEquals("nothing on screen, no socket", 2, h.sockets.opened.size)
        assertNull(h.screen.current.chatWorkspace)
    }

    @Test
    fun `a wake on the socket runs the workspace's feed`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs() }
        h.list(ws)
        h.workspace(ws)
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.workspaces.isNotEmpty() && it.connection == Connection.ONLINE }
        s.onScreen(ws, null, null)
        s.resumed()
        advanceTimeBy(1_000)
        val runs = h.http.calls("GET", h.route(ws, "/changes")).size
        h.sockets.opened.single().listener.wake()
        advanceTimeBy(1_000)
        assertEquals(runs + 1, h.http.calls("GET", h.route(ws, "/changes")).size)
    }

    @Test
    fun `the room on screen opens, is known for alerts, and closes when it leaves`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs(); upsertRoom(ws, room(head = 3)) }
        h.list(ws)
        h.workspace(ws, room(head = 3))
        val events = EventsRoute((1L..3L).map { msg(it) })
        h.http.on("GET", h.route(ws, "/conversations/${Ids.GENERAL}/events")) { events.answer(it) }
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.workspaces.isNotEmpty() && it.connection == Connection.ONLINE }
        h.screen.setForeground(true)
        s.onScreen(ws, Ids.GENERAL, null)
        s.timeline(ws, Ids.GENERAL).until("the room loaded") { it.events.size == 3 }
        assertEquals(Ids.GENERAL, h.screen.current.chatRoom)
        assertTrue(ChatAlertRules.onScreen(h.screen.current, ws, Ids.GENERAL))
        s.onScreen(ws, null, null)
        assertNull(h.screen.current.chatRoom)
        h.http.verify()
    }

    @Test
    fun `the room on screen and the room list carry the roster revision, which one agent replaced by another moves`() = runTest {
        val clark = Ids.id("u", 4, 'C')
        val dot = Ids.id("u", 5, 'D')
        val withClark = listOf(msg(1), msg(2), joined(3, clark))
        val h = Harness(this, db)
        h.seed { syncedWs(); upsertRoom(ws, room(head = 3).copy(agents = 1)); appendEvents(ws, Ids.GENERAL, withClark) }
        h.list(ws)
        // Before h.workspace's feed, so this one answers: the first route that matches does.
        val row = java.util.concurrent.atomic.AtomicReference(room(head = 3).copy(agents = 1))
        h.http.on("GET", h.route(ws, "/changes")) { ok(FeedPage.serializer(), feed(row.get(), next = "c1")) }
        h.workspace(ws)
        val events = EventsRoute(withClark)
        h.http.on("GET", h.route(ws, "/conversations/${Ids.GENERAL}/events")) { events.answer(it) }
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.workspaces.isNotEmpty() && it.connection == Connection.ONLINE }
        h.screen.setForeground(true)
        s.onScreen(ws, Ids.GENERAL, null)
        val before = s.timeline(ws, Ids.GENERAL).until("the room with Clark") { it.room.roster == 3L }.room
        assertEquals(3L, s.view(ws).first().rooms.single().roster)

        // Clark is taken out and Dot added before the next run: the feed's row keeps two people and one agent, and
        // only its head moves on. The run ends by catching the open room up, which brings the two events.
        events.events = withClark + listOf(left(4, clark), joined(5, dot))
        events.head = 5
        row.set(room(head = 5).copy(agents = 1))
        withTimeout(10_000) { while (h.sockets.opened.isEmpty()) delay(100) }
        h.sockets.opened.last().listener.wake()
        val after = s.timeline(ws, Ids.GENERAL).until("the room with Dot") { it.room.roster == 5L }.room
        assertEquals(before.members to before.agents, after.members to after.agents)
        s.view(ws).until("the room list with Dot") { v -> v.rooms.single().roster == 5L }
        h.http.verify()
    }

    @Test
    fun `a run alerts the rooms that ask for it, and reading the room takes the alert back`() = runTest {
        val h = Harness(this, db)
        h.seed {
            syncedWs()
            replaceMembers(ws, listOf(Member(Ids.ME, name = "Me", role = "member", state = "active"), Member(Ids.OLGA, name = "Olga", role = "member", state = "active")))
            upsertRoom(ws, room(Ids.DM, dm = true, head = 1))
            appendEvents(ws, Ids.DM, listOf(msg(1, room = 4)))
        }
        h.list(ws)
        h.http.on("GET", h.route(ws)) { ok(WorkspaceDetails.serializer(), details()) }
        h.http.on("GET", h.route(ws, "/changes")) {
            ok(FeedPage.serializer(), feed(room(Ids.DM, dm = true, head = 2, unread = 2), inline = emptyList(), next = "c1"))
        }
        h.http.on("GET", h.route(ws, "/conversations/${Ids.DM}/events")) {
            ok(EventPage.serializer(), EventPage(listOf(msg(1, room = 4), msg(2, text = "are you there?", room = 4)), head = 2, floor = 1))
        }
        h.http.on("POST", h.route(ws, "/conversations/${Ids.DM}/read")) { ok(ReadAck.serializer(), ReadAck(2)) }
        h.account.signIn("mine")
        val s = h.start()
        // delay, not advanceTimeBy: it suspends, so the timeout can end the wait.
        withTimeout(10_000) { while (h.sink.shown.isEmpty()) delay(100) }
        val alert = h.sink.shown.single()
        assertEquals("Olga", alert.title)
        assertEquals("Olga: are you there?", alert.lines.last().let { "${it.author}: ${it.text}" })
        assertEquals(setOf(ChatAlertRules.roomKey(ws, Ids.DM)), h.sink.activeKeys())

        s.markRead(ws, Ids.DM, 2)
        withTimeout(10_000) { while (h.sink.activeKeys().isNotEmpty()) delay(100) }
        assertEquals(0, s.view(ws).first().rooms.single().unread)
    }

    @Test
    fun `removing a message takes back the alert that showed it at once, also when the confirming run fails`() = runTest {
        val h = Harness(this, db)
        val channel = Ids.GENERAL
        val message = msg(1, text = "@Me body to remove", mentions = listOf(mention(bytes = 3)))
        h.seed {
            syncedWs()
            upsertRoom(ws, room(id = channel, head = 1, unread = 1, mentions = 1).copy(role = "manager"))
            appendEvents(ws, channel, listOf(message))
        }
        h.list(ws)
        h.http.once("GET", h.route(ws, "/changes")) { ok(FeedPage.serializer(), feed(next = "after")) }
        h.http.on("GET", h.route(ws, "/changes")) { throw WorkspaceError("network") }
        h.http.once("POST", h.route(ws, "/conversations/$channel/messages/${message.id}/redact")) { ok(RedactAck.serializer(), RedactAck(message.id)) }
        h.account.signIn("mine")
        val s = h.start()
        withTimeout(10_000) { while (h.sink.shown.isEmpty()) delay(100) }
        assertEquals("@Me body to remove", h.sink.shown.single().lines.single().text)

        s.redact(ws, channel, message.id)
        assertFalse(ChatAlertRules.roomKey(ws, channel) in h.sink.activeKeys())
    }

    @Test
    fun `alerts an earlier process left behind without notice rows go when the cache opens`() = runTest {
        val h = Harness(this, db)
        val noticed = Ids.id("d", 32)
        h.seed {
            syncedWs()
            upsertRoom(ws, room(Ids.DM, dm = true, head = 1))
            upsertRoom(ws, room(noticed, dm = true, head = 1, unread = 1))
            addNotices(ws, noticed, listOf(Notice(Ids.event(1, 32), 1)))
        }
        val stale = ChatAlertRules.roomKey(ws, Ids.DM)
        val kept = ChatAlertRules.roomKey(ws, noticed)
        h.sink.posted(stale)
        h.sink.posted(kept)
        h.account.signIn("mine")
        val s = h.start(foreground = false)
        assertTrue(s.awaitReady())
        assertEquals(setOf(kept), h.sink.activeKeys())
    }

    @Test
    fun `a DM whose cache removedMore dropped no longer shows the preview its alert loaded`() = runTest {
        val h = Harness(this, db)
        h.seed {
            syncedWs()
            replaceMembers(ws, listOf(Member(Ids.ME, name = "Me", role = "member", state = "active"), Member(Ids.OLGA, name = "Olga", role = "member", state = "active")))
            upsertRoom(ws, room(Ids.DM, dm = true, head = 1, read = 1))
        }
        h.list(ws)
        h.http.on("GET", h.route(ws)) { ok(WorkspaceDetails.serializer(), details()) }
        h.http.once("GET", h.route(ws, "/changes")) { ok(FeedPage.serializer(), feed(room(Ids.DM, dm = true, head = 2, read = 1, unread = 1), next = "c1")) }
        h.http.on("GET", h.route(ws, "/changes")) { ok(FeedPage.serializer(), feed(next = "c2")) }
        h.http.on("GET", h.route(ws, "/conversations/${Ids.DM}/events")) {
            ok(EventPage.serializer(), EventPage(listOf(msg(2, text = "are you there?", room = 4)), head = 2, floor = 1))
        }
        h.http.on("POST", h.route(ws, "/conversations/${Ids.DM}/read")) { ok(ReadAck.serializer(), ReadAck(2)) }
        h.account.signIn("mine")
        val s = h.start()
        withTimeout(10_000) { while (h.sink.shown.isEmpty()) delay(100) }
        s.view(ws).until("the preview the alert loaded") { v -> v.rooms.single().preview?.text == "are you there?" }
        // Read here: the alert's notice rows go, so the removal below can't name the preview through them.
        s.markRead(ws, Ids.DM, 2)
        withTimeout(10_000) { while (h.sink.activeKeys().isNotEmpty()) delay(100) }

        h.http.once("GET", h.route(ws, "/changes")) {
            ok(FeedPage.serializer(), feed(room(Ids.DM, dm = true, head = 3, read = 2, removed = listOf(Ids.event(1, 4)), removedMore = true), next = "c3"))
        }
        s.refresh(ws)
        s.view(ws).until("the DM without the removed preview") { v -> v.rooms.single().preview == null }
    }

    @Test
    fun `the background catch-up lists, runs every cached workspace and alerts, and does nothing signed out`() = runTest {
        val h = Harness(this, db)
        h.seed {
            syncedWs()
            replaceMembers(ws, listOf(Member(Ids.ME, name = "Me", role = "member", state = "active"), Member(Ids.OLGA, name = "Olga", role = "member", state = "active")))
            upsertRoom(ws, room(Ids.DM, dm = true, head = 1))
            appendEvents(ws, Ids.DM, listOf(msg(1, room = 4)))
        }
        h.list(ws)
        // The first runs, at start, find nothing new; the worker's run finds Olga's message.
        var pages = 0
        h.http.on("GET", h.route(ws, "/changes")) {
            pages += 1
            val head = if (h.http.calls("GET", "/v1/workspaces").size >= 2) 2L else 1L
            ok(FeedPage.serializer(), feed(room(Ids.DM, dm = true, head = head, unread = (head - 1).toInt()), next = "c$pages"))
        }
        h.http.on("GET", h.route(ws, "/conversations/${Ids.DM}/events")) {
            ok(EventPage.serializer(), EventPage(listOf(msg(1, room = 4), msg(2, text = "back in the office?", room = 4)), head = 2, floor = 1))
        }
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.workspaces.isNotEmpty() && it.connection == Connection.ONLINE }
        advanceTimeBy(5_000)
        assertTrue(h.sink.shown.isEmpty())

        assertEquals(1, s.backgroundCatchUp(60_000))
        assertEquals("back in the office?", h.sink.shown.single().lines.last().text)

        h.account.signOut()
        s.state.until { !it.signedIn }
        assertNull(s.backgroundCatchUp(60_000))
    }

    @Test
    fun `a process started in the background syncs only inside the worker's window, and its retries end with it`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs() }
        h.list(ws)
        h.http.on("GET", h.route(ws, "/changes")) { throw WorkspaceError("network") }
        h.account.signIn("mine")
        val s = h.start(foreground = false)
        assertTrue(s.awaitReady())
        advanceTimeBy(ChatTiming.HOUR)
        assertTrue("no feed request without the foreground or a worker", h.http.calls("GET", h.route(ws, "/changes")).isEmpty())
        assertTrue("no listing either", h.http.calls("GET", "/v1/workspaces").isEmpty())

        assertEquals(1, s.backgroundCatchUp(60_000))
        val feeds = h.http.calls("GET", h.route(ws, "/changes")).size
        assertEquals(1, feeds)
        assertEquals(1, h.http.calls("GET", "/v1/workspaces").size)
        advanceTimeBy(ChatTiming.HOUR)
        assertEquals("the failed run's retries waited for the next window", feeds, h.http.calls("GET", h.route(ws, "/changes")).size)

        s.resumed()
        advanceTimeBy(1_000)
        assertTrue("the foreground runs it", h.http.calls("GET", h.route(ws, "/changes")).size > feeds)
        s.paused()
    }

    // ---- Phone tools' window (stayConnected) ----

    private fun FakeSocket.ws() = url.substringAfter("/workspaces/").substringBefore("/")

    private fun Harness.feeds(w: String = Ids.WS) = http.calls("GET", route(w, "/changes")).size

    @Test
    fun `while Phone tools runs, every workspace keeps a socket in the background and runs every five minutes`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs(); syncedWs(Ids.WS2, "Other") }
        h.list(ws, Ids.WS2)
        h.workspace(ws)
        h.workspace(Ids.WS2)
        h.account.signIn("mine")
        val s = h.start(foreground = false)
        assertTrue(s.awaitReady())
        advanceTimeBy(ChatTiming.HOUR)
        assertTrue("no socket in the background without the window", h.sockets.opened.isEmpty())
        assertEquals(0, h.feeds())

        s.stayConnected(true)
        advanceTimeBy(1_000)
        assertTrue(s.windowOpen)
        assertEquals(setOf(ws, Ids.WS2), h.sockets.opened.map { it.ws() }.toSet())
        assertTrue(h.sockets.opened.all { it.state.value == SocketState.OPEN })
        val first = h.feeds()
        assertTrue("the window runs every workspace when it opens", first >= 1 && h.feeds(Ids.WS2) >= 1)

        advanceTimeBy(ChatTiming.MINUTE)
        assertEquals("no minute runs in the background", first, h.feeds())
        advanceTimeBy(4 * ChatTiming.MINUTE + 1_000)
        assertEquals("a run five minutes on", first + 1, h.feeds())

        // A wake runs that workspace's feed at once, as in the foreground.
        h.sockets.opened.single { it.ws() == ws }.listener.wake()
        advanceTimeBy(1_000)
        assertEquals(first + 2, h.feeds())

        s.stayConnected(false)
        advanceTimeBy(1_000)
        assertFalse(s.windowOpen)
        assertTrue("closing the window closes its sockets", h.sockets.opened.all { it.closes == 1 && it.state.value == SocketState.OFF })
        val closed = h.feeds()
        advanceTimeBy(ChatTiming.HOUR)
        assertEquals("no runs after the window closed", closed, h.feeds())
        // A wake that comes in late on a socket that closed does nothing.
        h.sockets.opened.first().listener.wake()
        advanceTimeBy(1_000)
        assertEquals(closed, h.feeds())
    }

    @Test
    fun `the window needs team chat notifications on`() = runTest {
        val h = Harness(this, db)
        h.settings.value = AppSettings(notifyChat = false)
        h.seed { syncedWs() }
        h.list(ws)
        h.workspace(ws)
        h.account.signIn("mine")
        val s = h.start(foreground = false)
        assertTrue(s.awaitReady())
        s.stayConnected(true)
        advanceTimeBy(10 * ChatTiming.MINUTE)
        assertFalse(s.windowOpen)
        assertTrue(h.sockets.opened.isEmpty())
        assertEquals(0, h.feeds())

        h.settings.value = AppSettings(notifyChat = true)
        advanceTimeBy(1_000)
        assertTrue(s.windowOpen)
        assertEquals(listOf(ws), h.sockets.opened.map { it.ws() })

        h.settings.value = AppSettings(notifyChat = false)
        advanceTimeBy(1_000)
        assertFalse(s.windowOpen)
        assertEquals(1, h.sockets.opened.single().closes)
    }

    @Test
    fun `the window keeps sockets for the most recently active workspaces only`() = runTest {
        val h = Harness(this, db)
        h.timing = ChatTiming(windowSockets = 1)
        h.seed {
            syncedWs()
            syncedWs(Ids.WS2, "Other")
            updateWs(Ids.WS2, mapOf("activeAt" to TestDb.NOW))
        }
        h.list(ws, Ids.WS2)
        h.workspace(ws)
        h.workspace(Ids.WS2)
        h.account.signIn("mine")
        val s = h.start(foreground = false)
        assertTrue(s.awaitReady())
        s.stayConnected(true)
        advanceTimeBy(1_000)
        assertEquals(listOf(Ids.WS2), h.sockets.opened.map { it.ws() })
        assertTrue("the one without a socket still runs", h.feeds(ws) >= 1)

        // In the foreground the workspace on screen gets its socket as well.
        s.onScreen(ws, null, null)
        s.resumed()
        advanceTimeBy(1_000)
        assertEquals(setOf(ws, Ids.WS2), h.sockets.opened.filter { it.state.value == SocketState.OPEN }.map { it.ws() }.toSet())
        // Back in the background, the window's own choice is left.
        s.paused()
        advanceTimeBy(1_000)
        assertEquals(listOf(Ids.WS2), h.sockets.opened.filter { it.state.value == SocketState.OPEN }.map { it.ws() })
    }

    @Test
    fun `signing out in the window closes its sockets and stops its runs`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs() }
        h.list(ws)
        h.workspace(ws)
        h.account.signIn("mine")
        val s = h.start(foreground = false)
        assertTrue(s.awaitReady())
        s.stayConnected(true)
        advanceTimeBy(1_000)
        val socket = h.sockets.opened.single()

        h.account.signOut()
        s.state.until { !it.signedIn }
        advanceTimeBy(1_000)
        assertEquals(1, socket.closes)
        val feeds = h.feeds()
        advanceTimeBy(ChatTiming.HOUR)
        assertEquals("no runs signed out", feeds, h.feeds())
        assertEquals("no new socket signed out", 1, h.sockets.opened.size)
    }

    private fun Harness.tickets(w: String = Ids.WS) = http.calls("POST", route(w, "/socket-ticket")).size

    /** A workspace in the window with real sockets whose `POST /socket-ticket` answers [ticket]; returns the sockets. */
    private suspend fun TestScope.windowWithRealSockets(h: Harness, ticket: suspend (ScriptedHttp.Call) -> WorkspaceAnswer): RecordingSockets {
        // On the test's clock, so Retry-After and the backoff run on virtual time.
        val real = RecordingSockets(OkHttpChatSockets(OkHttpClient(), now = h.clock::now))
        h.chatSockets = real
        h.seed { syncedWs() }
        h.list(ws)
        h.workspace(ws)
        h.http.on("POST", h.route(ws, "/socket-ticket"), ticket)
        h.account.signIn("mine")
        val s = h.start(foreground = false)
        assertTrue(s.awaitReady())
        s.stayConnected(true)
        advanceTimeBy(1_000)
        return real
    }

    // The review's interleaving: a nudge (or a 4003 recheck) takes the socket out of the map, reconciliation then
    // removes and closes it, and the nudge goes on to start or nudge it. Whatever reaches a closed socket afterwards, it
    // stays closed, and the workspace never has two.
    @Test
    fun `a socket the window closed never starts again, whatever reaches it later`() = runTest {
        val h = Harness(this, db)
        // Every ticket fails on the server, so each attempt is one POST /socket-ticket and nothing reaches the network.
        val real = windowWithRealSockets(h) { throw WorkspaceError("server", 503) }
        val first = real.opened.single()
        assertTrue(h.tickets() >= 1)

        h.service.stayConnected(false)
        advanceTimeBy(1_000)
        assertEquals(SocketState.OFF, first.state.value)
        val tickets = h.tickets()
        first.start()
        first.nudge()
        advanceTimeBy(10 * ChatTiming.MINUTE)
        assertEquals("the closed socket stays closed", SocketState.OFF, first.state.value)
        assertEquals("and asks for no ticket", tickets, h.tickets())

        h.service.stayConnected(true)
        advanceTimeBy(1_000)
        assertEquals("one new socket when the window opens again", 2, real.opened.size)
        assertEquals("never two at once for one workspace", 1, real.opened.count { it.state.value != SocketState.OFF })
        h.service.stayConnected(false)
        advanceTimeBy(1_000)
        assertTrue(real.opened.all { it.state.value == SocketState.OFF })
    }

    @Test
    fun `a ticket 429's Retry-After holds for the workspace while the window closes and opens`() = runTest {
        val h = Harness(this, db)
        windowWithRealSockets(h) { throw refusal(429, "rate_limited", retryAfter = "120") }
        assertEquals(1, h.tickets())
        // The network comes and goes: each time the window closes and opens again, with a new socket.
        repeat(5) {
            h.service.stayConnected(false)
            advanceTimeBy(2_000)
            h.service.stayConnected(true)
            advanceTimeBy(2_000)
        }
        assertEquals("no ticket before Retry-After", 1, h.tickets())
        advanceTimeBy(120_000)
        assertEquals("one ticket once it passed", 2, h.tickets())
        h.service.stayConnected(false)
    }

    @Test
    fun `network flaps while a ticket hangs ask for a few tickets, not one per flap`() = runTest {
        val h = Harness(this, db)
        windowWithRealSockets(h) { kotlinx.coroutines.awaitCancellation() }
        assertEquals(1, h.tickets())
        repeat(20) {
            h.service.stayConnected(false)
            advanceTimeBy(100)
            h.service.stayConnected(true)
            advanceTimeBy(100)
        }
        assertTrue("20 flaps in 4 s asked ${h.tickets()} tickets", h.tickets() <= 4)
        h.service.stayConnected(false)
    }

    @Test
    fun `a network handoff in the window pings the open sockets and runs every workspace once`() = runTest {
        val h = Harness(this, db)
        h.seed { syncedWs(); syncedWs(Ids.WS2, "Other") }
        h.list(ws, Ids.WS2)
        h.workspace(ws)
        h.workspace(Ids.WS2)
        h.account.signIn("mine")
        val s = h.start(foreground = false)
        assertTrue(s.awaitReady())
        s.networkMoved()
        advanceTimeBy(1_000)
        assertEquals("nothing outside the window", 0, h.feeds())

        s.stayConnected(true)
        advanceTimeBy(1_000)
        val feeds = h.feeds()
        val other = h.feeds(Ids.WS2)
        s.networkMoved()
        advanceTimeBy(1_000)
        assertTrue(h.sockets.opened.all { it.checks == 1 })
        assertEquals(feeds + 1, h.feeds())
        assertEquals(other + 1, h.feeds(Ids.WS2))

        s.stayConnected(false)
        advanceTimeBy(1_000)
        s.networkMoved()
        advanceTimeBy(1_000)
        assertTrue("closed sockets aren't pinged", h.sockets.opened.all { it.checks == 1 })
        assertEquals(feeds + 1, h.feeds())
    }

    /**
     * Two workspaces whose tickets answer [ticket], with real sockets whose backoff takes the low end of each step: 0.5,
     * 1, 2, 4, 8, 16 and then 30 s.
     */
    private suspend fun TestScope.twoWithRealSockets(h: Harness, foreground: Boolean, ticket: suspend (ScriptedHttp.Call) -> WorkspaceAnswer): WorkspaceService {
        h.chatSockets = OkHttpChatSockets(OkHttpClient(), now = h.clock::now, random = { 0.0 })
        h.seed { syncedWs(); syncedWs(Ids.WS2, "Other") }
        h.list(ws, Ids.WS2)
        h.workspace(ws)
        h.workspace(Ids.WS2)
        h.http.on("POST", h.route(ws, "/socket-ticket"), ticket)
        h.http.on("POST", h.route(Ids.WS2, "/socket-ticket"), ticket)
        h.account.signIn("mine")
        val s = h.start(foreground)
        assertTrue(s.awaitReady())
        return s
    }

    @Test
    fun `the socket of the workspace on screen tries at once when the person returns to it, whatever backoff it met`() = runTest {
        val h = Harness(this, db)
        val s = twoWithRealSockets(h, foreground = true) { throw WorkspaceError("server", 503) }
        s.onScreen(ws, null, null)
        // Tickets at 0, 0.5, 1.5, 3.5, 7.5, 15.5 and 31.5 s; the next waits until 61.5 s.
        advanceTimeBy(40_000)
        val before = h.tickets()
        assertEquals(7, before)

        s.onScreen(Ids.WS2, null, null)
        advanceTimeBy(100)
        s.onScreen(ws, null, null)
        advanceTimeBy(100)
        assertEquals("a ticket at once for the workspace the person came back to", before + 1, h.tickets())
    }

    @Test
    fun `a foreground nudge leaves the backoff of Phone tools' other sockets alone`() = runTest {
        val h = Harness(this, db)
        val s = twoWithRealSockets(h, foreground = false) { throw WorkspaceError("server", 503) }
        s.stayConnected(true)
        advanceTimeBy(40_000)
        val mine = h.tickets()
        val other = h.tickets(Ids.WS2)
        assertEquals(7, other)

        s.onScreen(ws, null, null)
        s.resumed()
        advanceTimeBy(100)
        assertTrue("the workspace on screen tries at once", h.tickets() > mine)
        assertEquals("the other keeps its wait", other, h.tickets(Ids.WS2))

        // A network that comes back in the foreground nudges too.
        s.nudge()
        advanceTimeBy(100)
        assertEquals(other, h.tickets(Ids.WS2))
        s.stayConnected(false)
    }

    @Test
    fun `Retry-After holds for the workspace on screen when the person returns to it`() = runTest {
        val h = Harness(this, db)
        val s = twoWithRealSockets(h, foreground = true) { throw refusal(429, "rate_limited", retryAfter = "120") }
        s.onScreen(ws, null, null)
        advanceTimeBy(1_000)
        assertEquals(1, h.tickets())
        s.onScreen(Ids.WS2, null, null)
        advanceTimeBy(100)
        s.onScreen(ws, null, null)
        s.nudge()
        advanceTimeBy(100)
        assertEquals("no ticket before Retry-After", 1, h.tickets())
        advanceTimeBy(120_000)
        assertEquals(2, h.tickets())
    }

    // The review's interleaving: reconciliation has listed the workspace, and the removal path runs before it makes
    // the socket, either before it looks at the workspace again ([rechecked] false) or after ([rechecked] true).
    // Returns the service once the dust settled.
    private suspend fun TestScope.removedWhileReconciling(h: Harness, rechecked: Boolean): WorkspaceService {
        h.seed { syncedWs() }
        h.list(ws)
        h.workspace(ws, room())
        h.http.on("DELETE", h.route(ws, "/members/me")) { WorkspaceAnswer(204, null) }
        h.account.signIn("mine")
        val s = h.start()
        s.state.until { it.workspaces.isNotEmpty() && it.connection == Connection.ONLINE }
        h.list()
        var ran = false
        s.beforeSocketInstall = { w, after ->
            if (w == ws && after == rechecked && !ran) {
                ran = true
                backgroundScope.launch { s.leaveWorkspace(ws) }
                // Until the removal reached the sockets: it took back the workspace's alerts just before.
                while (ChatAlertRules.workspacePrefix(ws) !in h.sink.cleared) delay(10)
            }
        }
        s.onScreen(ws, null, null)
        advanceTimeBy(5_000)
        assertTrue("the removal ran in between", ran)
        return s
    }

    @Test
    fun `a workspace removed while reconciliation holds it in its list gets no socket`() = runTest {
        val h = Harness(this, db)
        val s = removedWhileReconciling(h, rechecked = false)
        assertEquals("no socket made for the removed workspace", 0, h.sockets.opened.count { it.ws() == ws })
        assertFalse("no socket left", ws in s.socketWorkspaces())
        assertFalse("no waits left", ws in s.pacedWorkspaces())
    }

    @Test
    fun `a workspace removed just as reconciliation makes its socket keeps no socket and no waits`() = runTest {
        val h = Harness(this, db)
        val s = removedWhileReconciling(h, rechecked = true)
        assertEquals("its socket was made before the removal reached the sockets", 1, h.sockets.opened.count { it.ws() == ws })
        assertTrue("the socket made before the removal is closed", h.sockets.opened.filter { it.ws() == ws }.all { it.closes == 1 })
        assertFalse("no socket left", ws in s.socketWorkspaces())
        assertFalse("no waits left", ws in s.pacedWorkspaces())
    }

    @Test
    fun `in the window a message notifies from the background, also in the room that was on screen`() = runTest {
        val h = Harness(this, db)
        h.seed {
            syncedWs()
            replaceMembers(ws, listOf(Member(Ids.ME, name = "Me", role = "member", state = "active"), Member(Ids.OLGA, name = "Olga", role = "member", state = "active")))
            upsertRoom(ws, room(Ids.DM, dm = true, head = 1))
            appendEvents(ws, Ids.DM, listOf(msg(1, room = 4)))
        }
        h.list(ws)
        h.http.on("GET", h.route(ws)) { ok(WorkspaceDetails.serializer(), details()) }
        h.http.on("GET", h.route(ws, "/changes")) {
            ok(FeedPage.serializer(), feed(room(Ids.DM, dm = true, head = 2, unread = 1), inline = emptyList(), next = "c1"))
        }
        h.http.on("GET", h.route(ws, "/conversations/${Ids.DM}/events")) {
            ok(EventPage.serializer(), EventPage(listOf(msg(1, room = 4), msg(2, text = "still there?", room = 4)), head = 2, floor = 1))
        }
        h.account.signIn("mine")
        val s = h.start(foreground = false)
        assertTrue(s.awaitReady())
        // The DM was on screen when the app went to the background; in the background it isn't on screen any more.
        s.onScreen(ws, Ids.DM, null)
        advanceTimeBy(ChatTiming.HOUR)
        assertTrue("nothing runs before the window", h.sink.shown.isEmpty())

        s.stayConnected(true)
        withTimeout(10_000) { while (h.sink.shown.isEmpty()) delay(100) }
        assertEquals("Olga: still there?", h.sink.shown.single().lines.last().let { "${it.author}: ${it.text}" })
    }

    @Test
    fun `the window's runs come five minutes apart, give or take 30 seconds`() {
        val t = ChatTiming()
        assertEquals(5 * ChatTiming.MINUTE - 30_000, WorkspaceService.windowCatchUpDelay(t, 0.0))
        assertEquals(5 * ChatTiming.MINUTE, WorkspaceService.windowCatchUpDelay(t, 0.5))
        assertEquals(5 * ChatTiming.MINUTE + 30_000, WorkspaceService.windowCatchUpDelay(t, 1.0))
        assertEquals(5 * ChatTiming.MINUTE + 30_000, WorkspaceService.windowCatchUpDelay(t, 7.0))
    }

    @Test
    fun `sockets go to the workspace on screen, then the most recently active, up to the cap`() {
        val c = listOf(SocketCandidate("a", 10), SocketCandidate("b", 30), SocketCandidate("c", null), SocketCandidate("d", 20))
        assertEquals(emptySet<String>(), WorkspaceService.socketsFor(c, null, 0))
        assertEquals(setOf("c"), WorkspaceService.socketsFor(c, "c", 0))
        assertEquals(listOf("b", "d"), WorkspaceService.socketsFor(c, null, 2).toList())
        assertEquals(listOf("c", "b", "d"), WorkspaceService.socketsFor(c, "c", 2).toList())
        assertEquals(listOf("b", "d", "a", "c"), WorkspaceService.socketsFor(c, null, 9).toList())
        assertEquals("a workspace not in a good state gets none", emptySet<String>(), WorkspaceService.socketsFor(c, "gone", 0))
        assertEquals(emptySet<String>(), WorkspaceService.socketsFor(c, null, -1))
    }

    @Test
    fun `turning team chat notifications off shows in the state and silences alerts`() = runTest {
        val h = Harness(this, db)
        h.list()
        h.account.signIn("mine")
        val s = h.start()
        assertTrue(s.state.until { it.signedIn }.notifications)
        h.settings.value = AppSettings(notifyChat = false)
        assertFalse(s.state.until { !it.notifications }.notifications)
    }

    @Test
    fun `the state carries the server's team chat details`() = runTest {
        val h = Harness(this, db)
        h.list()
        h.account.signIn("mine")
        val s = h.start()
        val state = s.state.until { it.signedIn && it.available }
        assertEquals(SERVER, state.server)
        assertEquals("127.0.0.1:1", state.host)
        assertTrue(state.inviteSignups)
        assertEquals(ChatRetention(90, 14), state.retention)
        assertEquals(ChatLimits(10, 100), state.limits)
        assertEquals("invite", state.signups)
        assertNotNull(state.operator)
    }

    companion object {
        const val SERVER = "http://127.0.0.1:1"

        val CHAT_INFO = ServerInfo(
            protocol = 1,
            operator = nl.bvdm.rukoo.account.ServerOperator(name = "Test operator", url = "https://example.com"),
            signups = "invite",
            features = listOf(WORKSPACES_FEATURE),
            workspace = WorkspaceServerInfo(
                versions = listOf(WORKSPACE_VERSION),
                limits = WorkspaceServerLimits(workspacesPerAccount = 10, members = 100),
                retention = WorkspaceRetention(contentDays = 90, feedDays = 14),
                inviteSignups = true,
            ),
        )
    }
}
