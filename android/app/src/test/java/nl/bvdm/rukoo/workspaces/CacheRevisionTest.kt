package nl.bvdm.rukoo.workspaces

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The cache revision (contract §3.6, §3.7): every reset, Start over, new key, restore, quarantine, park and removal
 * raises it in its own transaction, and an answer or refusal to a request recorded under an older revision is dropped
 * before it writes. Each case holds an answer in flight across the change, as the late answers of review 207B did.
 */
class CacheRevisionTest {
    private val db = TestDb()

    @After
    fun tearDown() = db.close()

    private val ws = Ids.WS
    private val general = Ids.GENERAL

    @Test
    fun `the revision goes up with every transaction that starts the cache over, and only those`() = runTest {
        val h = SyncHarness(this, db).start()
        h.store.tx { upsertRoom(ws, room()) }
        val a = h.sync.applier
        val seen = mutableListOf(h.store.revision(ws))
        suspend fun step(what: String, up: Boolean, block: suspend () -> Unit) {
            block()
            val now = h.store.revision(ws)
            if (up) assertTrue("$what raises it", now > seen.last()) else assertEquals("$what leaves it", seen.last(), now)
            seen += now
        }
        step("a feed page", false) { a.apply(ws, feed(room(head = 11), next = "cursor1"), "cursor0") }
        step("GET / with the same generation and key", false) { a.restore(ws, details(), TestDb.NOW, TestDb.NOW) }
        step("a 410 reset", true) { a.reset(ws) }
        step("Start over", true) { a.startOver(ws) }
        step("a new key", true) { a.restore(ws, details(keyId = "key2"), TestDb.NOW, TestDb.NOW) }
        step("a restore", true) { a.restore(ws, details(generation = Ids.GEN2, keyId = "key2"), TestDb.NOW, TestDb.NOW) }
        step("a quarantine", true) { a.quarantine(ws) }
        step("a park", true) { a.park(ws) }
        step("the removal", true) { a.removeWorkspace(ws) }
        assertEquals("another workspace keeps its own", 0L, h.store.revision(Ids.WS2))
    }

    @Test
    fun `a history page asked before a restore is dropped when it arrives after the restore's pass`() = runTest {
        val h = SyncHarness(this, db).start()
        h.store.tx { upsertRoom(ws, room(head = 5)) }
        h.feedPages(feed(next = "primed"))
        h.sync.runFeed()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        h.http.once("GET", h.route("/conversations/$general/events")) {
            started.complete(Unit)
            release.await()
            ok(EventPage.serializer(), EventPage(listOf(msg(4, text = "missing from the backup"), msg(5)), 5, 1))
        }
        // What the restored server answers once the room loads again.
        h.http.on("GET", h.route("/conversations/$general/events")) {
            ok(EventPage.serializer(), EventPage((1L..3L).map { msg(it, text = "restored $it") }, 3, 1))
        }
        val opening = async { h.sync.loader.open(general) }
        started.await()
        // GET / finds the restore; its pass installs the restored room at head 3.
        h.http.once("GET", h.route()) { ok(WorkspaceDetails.serializer(), details(generation = Ids.GEN2)) }
        h.sync.details(inRun = true)
        h.feedPages(feed(room(head = 3), next = "restored"))
        // The run's end catches the open room up, after the load in flight lets go of the loader.
        val rebuilding = async { h.sync.runFeed() }
        runCurrent()
        assertEquals("restored", h.ws().cursor)
        assertEquals(3L, h.room()!!.head)
        release.complete(Unit)
        opening.await()
        rebuilding.await()
        assertEquals("the old page didn't raise the head", 3L, h.room()!!.head)
        assertTrue("the old page's text didn't come back", h.events().none { it.text == "missing from the backup" })
        assertEquals(listOf("restored 1", "restored 2", "restored 3"), h.events().map { it.text })
        assertNull(h.sync.loader.rooms.value[general]?.error)
        h.http.verify()
    }

    @Test
    fun `a pass page asked before Start over is dropped, though both passes send no cursor`() = runTest {
        val h = SyncHarness(this, db).start()
        h.store.tx { updateWs(ws, mapOf("cursor" to null, "passing" to true)) }
        val revision = h.store.revision(ws)
        h.sync.applier.startOver(ws)
        assertNull(h.ws().cursor)
        val stale = h.sync.applier.apply(ws, feed(room(name = "from before"), next = "old"), null, revision = revision)
        assertNull(stale)
        assertNull(h.room())
        assertNull(h.ws().cursor)
        // The same page under the current revision goes in.
        h.sync.applier.apply(ws, feed(room(name = "now"), next = "new"), null, revision = h.store.revision(ws))!!
        assertEquals("now", h.room()!!.name)
    }

    @Test
    fun `a late 409 from before Start over doesn't quarantine the started-over workspace`() = runTest {
        val h = SyncHarness(this, db).start()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        h.http.once("GET", h.route("/changes")) {
            started.complete(Unit)
            release.await()
            throw refusal(409, "history_regressed")
        }
        h.http.on("GET", h.route("/changes")) { ok(FeedPage.serializer(), feed(room(head = 2), next = "fresh")) }
        // Start over's pass asks GET / first.
        h.http.on("GET", h.route()) { ok(WorkspaceDetails.serializer(), details()) }
        val running = async { h.sync.runFeed() }
        started.await()
        h.sync.applier.startOver(ws)
        release.complete(Unit)
        val outcome = running.await()
        assertFalse(outcome.quarantined)
        assertEquals(FeedApplier.STATE_OK, h.ws().state)
        assertEquals("the run went on with the new pass", "fresh", h.ws().cursor)
        assertTrue(h.events.log.none { it == "quarantined" })
    }

    @Test
    fun `a GET slash answer older than the restore another answer installed doesn't put the old generation back`() = runTest {
        val h = SyncHarness(this, db).start()
        h.store.tx {
            upsertRoom(ws, room(head = 5))
            insertOutbox(OutboxRow("AAAAAAAAAAAAAAAAAAAAAA", ws, general, Ids.ME, Ids.grant(1), Ids.GEN2, "new gen", emptyList(), null, createdAt = 1))
        }
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        h.http.once("GET", h.route()) {
            started.complete(Unit)
            release.await()
            ok(WorkspaceDetails.serializer(), details(generation = Ids.GEN))
        }
        val slow = async { h.sync.details() }
        started.await()
        h.http.once("GET", h.route()) { ok(WorkspaceDetails.serializer(), details(generation = Ids.GEN2)) }
        h.sync.details()
        assertEquals(Ids.GEN2, h.ws().generation)
        val restores = h.events.log.count { it == "restored" }
        release.complete(Unit)
        slow.await()
        assertEquals("the old answer is dropped", Ids.GEN2, h.ws().generation)
        assertEquals("no second restore", restores, h.events.log.count { it == "restored" })
        assertEquals("the new generation's send isn't marked for a lookup", null, h.store.read { getOutbox("AAAAAAAAAAAAAAAAAAAAAA")!!.reason })
        h.http.verify()
    }

    @Test
    fun `a read report answered after a restore's pass leaves the restored read position`() = runTest {
        val h = SyncHarness(this, db, SyncTiming(readFlushMs = 0)).start()
        h.store.tx { upsertRoom(ws, room(head = 10, read = 5)) }
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        h.http.once("POST", h.route("/conversations/$general/read")) {
            started.complete(Unit)
            release.await()
            ok(ReadAck.serializer(), ReadAck(10))
        }
        h.sync.reads.mark(general, 10)
        started.await()
        h.http.once("GET", h.route()) { ok(WorkspaceDetails.serializer(), details(generation = Ids.GEN2)) }
        h.sync.details(inRun = true)
        h.feedPages(feed(room(head = 6, read = 5, unread = 1), next = "restored"))
        h.sync.runFeed()
        release.complete(Unit)
        advanceTimeBy(1)
        runCurrent()
        val r = h.room()!!
        assertEquals(5L, r.read)
        assertEquals(5L, r.readSent)
        assertEquals(1, r.unread)
    }

    @Test
    fun `a 410 whose GET slash failed asks GET slash again before the pass, and finds a restore made meanwhile`() = runTest {
        val h = SyncHarness(this, db).start()
        h.http.once("GET", h.route("/changes")) { throw refusal(410, "reset_required") }
        h.http.once("GET", h.route()) { throw WorkspaceError("network") }
        val failed = runCatching { h.sync.runFeed() }.exceptionOrNull()
        assertEquals("network", (failed as WorkspaceError).code)
        assertTrue(h.ws().passing)
        assertNull(h.ws().cursor)
        // The server was restored meanwhile: the next run's GET / finds it before any page of the pass.
        h.http.once("GET", h.route()) { ok(WorkspaceDetails.serializer(), details(generation = Ids.GEN2)) }
        h.feedPages(feed(room(head = 3), next = "restored"))
        h.sync.runFeed()
        assertEquals(Ids.GEN2, h.ws().generation)
        assertEquals("restored", h.ws().cursor)
        assertEquals(
            listOf("GET /changes", "GET /", "GET /", "GET /changes"),
            h.http.calls.map { "${it.method} ${it.route.removePrefix(h.route()).ifEmpty { "/" }}" },
        )
        h.http.verify()
    }

    @Test
    fun `a pass from the start after a restart asks GET slash first, and again while its answer is dropped`() = runTest {
        val h = SyncHarness(this, db).start()
        // A pass from the start under way when the process ended: no GET / answered in this process yet.
        h.store.tx { updateWs(ws, mapOf("cursor" to null, "passing" to true)) }
        h.restart()
        // The first answer arrives after the cache started over meanwhile: dropped, and asked again.
        h.http.once("GET", h.route()) {
            h.store.tx { bumpRevision(ws) }
            ok(WorkspaceDetails.serializer(), details(generation = Ids.GEN2))
        }
        h.http.on("GET", h.route()) { ok(WorkspaceDetails.serializer(), details()) }
        h.feedPages(feed(room(head = 2), next = "first"))
        h.sync.runFeed()
        assertEquals(Ids.GEN, h.ws().generation)
        assertEquals("first", h.ws().cursor)
        assertEquals(
            listOf("GET /", "GET /", "GET /changes"),
            h.http.calls.map { "${it.method} ${it.route.removePrefix(h.route()).ifEmpty { "/" }}" },
        )
        h.http.verify()
    }

    @Test
    fun `a directory answer that arrives after a reset is dropped and its flag stays`() = runTest {
        val h = SyncHarness(this, db).start()
        h.store.tx { updateWs(ws, mapOf("membersStale" to true)) }
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        h.http.once("GET", h.route("/members")) {
            started.complete(Unit)
            release.await()
            ok(MembersPage.serializer(), MembersPage(listOf(Member(Ids.ME, name = "Old", role = "admin", state = "active"))))
        }
        val loading = async { h.sync.directory() }
        started.await()
        h.sync.applier.reset(ws)
        release.complete(Unit)
        assertFalse(loading.await())
        assertTrue(h.ws().membersStale)
        assertTrue(h.store.read { listMembers(ws) }.isEmpty())
        assertNotEquals("admin", h.ws().role)
    }
}
