package nl.bvdm.rukoo.workspaces

import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Late answers of follow-up review 207 (contract §3.6, §3.7, §3.11): a `GET /` older than one already applied, a feed
 * refusal whose reset or quarantine would land after Start over, a directory load that read the role before a restore,
 * an outbox `426` that parks without raising the revision, a worker's run that pages on after its budget, an open
 * room's read position after a restored pass, a history floor that empties the cached range, and a removal SQLite
 * refuses. Each case holds the late answer, or the step before its write, across the change.
 */
class LateAnswerTest {
    private val ws = Ids.WS
    private val general = Ids.GENERAL

    /** Holds the dispatch after [hold] is set, once, until the test runs it. */
    private class HoldNext(private val delegate: CoroutineDispatcher) : CoroutineDispatcher() {
        @Volatile var hold = false
        val held = CompletableDeferred<Runnable>()
        override fun dispatch(context: CoroutineContext, block: Runnable) {
            if (!hold) return delegate.dispatch(context, block)
            hold = false
            held.complete(Runnable { delegate.dispatch(context, block) })
        }
    }

    /** Holds its second dispatch until the test runs it. */
    private class HoldSecond(private val delegate: CoroutineDispatcher) : CoroutineDispatcher() {
        private var calls = 0
        val held = CompletableDeferred<Runnable>()
        override fun dispatch(context: CoroutineContext, block: Runnable) {
            val next = Runnable { delegate.dispatch(context, block) }
            if (++calls == 2) held.complete(next) else next.run()
        }
    }

    private val db = TestDb()

    @After
    fun tearDown() = db.close()

    @Test
    fun `a GET slash answer older than one already applied doesn't undo a promotion`() = runTest {
        val h = SyncHarness(this, db).start()
        h.store.tx { updateWs(ws, mapOf("role" to "guest")) }
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        h.http.once("GET", h.route()) {
            started.complete(Unit)
            release.await()
            ok(WorkspaceDetails.serializer(), details(role = "guest"))
        }
        val old = async { h.sync.details(inRun = true) }
        started.await()
        h.http.once("GET", h.route()) { ok(WorkspaceDetails.serializer(), details(role = "member")) }
        h.sync.details(inRun = true)
        assertEquals("member", h.ws().role)
        // Both answered under the same revision: only the order they started in tells them apart.
        assertEquals(0L, h.store.revision(ws))
        release.complete(Unit)
        old.await()
        assertEquals("the older answer is dropped", "member", h.ws().role)
        h.http.verify()
    }

    @Test
    fun `a GET slash answer older than one already applied doesn't start a restore`() = runTest {
        val h = SyncHarness(this, db).start()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        h.http.once("GET", h.route()) {
            started.complete(Unit)
            release.await()
            ok(WorkspaceDetails.serializer(), details(generation = Ids.GEN2))
        }
        val old = async { h.sync.details(inRun = true) }
        started.await()
        h.http.once("GET", h.route()) { ok(WorkspaceDetails.serializer(), details(generation = Ids.GEN)) }
        h.sync.details(inRun = true)
        release.complete(Unit)
        old.await()
        assertEquals(Ids.GEN, h.ws().generation)
        assertFalse(h.ws().passing)
        assertTrue(h.events.log.none { it == "restored" })
    }

    @Test
    fun `a 409 whose quarantine waits behind Start over doesn't stop the started-over cache`() = runTest {
        val io = HoldNext(StandardTestDispatcher(testScheduler))
        val db = TestDb(io)
        try {
            val h = SyncHarness(this, db).start()
            h.http.once("GET", h.route("/changes")) {
                // The refusal's own transaction is the next one: it waits until Start over committed.
                io.hold = true
                throw refusal(409, "history_regressed")
            }
            val run = async { h.sync.runFeed() }
            val quarantine = io.held.await()
            h.sync.applier.startOver(ws)
            h.http.on("GET", h.route()) { ok(WorkspaceDetails.serializer(), details()) }
            h.http.on("GET", h.route("/changes")) { ok(FeedPage.serializer(), feed(next = "fresh")) }
            quarantine.run()
            val outcome = run.await()
            assertFalse(outcome.quarantined)
            assertEquals(FeedApplier.STATE_OK, h.ws().state)
            assertEquals("the run went on with Start over's pass", "fresh", h.ws().cursor)
            assertTrue(h.events.log.none { it == "quarantined" })
        } finally {
            db.close()
        }
    }

    @Test
    fun `a 410 whose reset waits behind Start over doesn't reset the started-over cache again`() = runTest {
        val io = HoldNext(StandardTestDispatcher(testScheduler))
        val db = TestDb(io)
        try {
            val h = SyncHarness(this, db).start()
            h.http.once("GET", h.route("/changes")) {
                io.hold = true
                throw refusal(410, "reset_required")
            }
            val run = async { h.sync.runFeed() }
            val reset = io.held.await()
            h.sync.applier.startOver(ws)
            val afterStartOver = h.store.revision(ws)
            h.http.on("GET", h.route()) { ok(WorkspaceDetails.serializer(), details()) }
            h.http.on("GET", h.route("/changes")) { ok(FeedPage.serializer(), feed(next = "fresh")) }
            reset.run()
            run.await()
            assertEquals("the late 410 didn't reset again", afterStartOver, h.store.revision(ws))
            assertTrue(h.events.pages.none { it.reset })
            assertEquals("fresh", h.ws().cursor)
        } finally {
            db.close()
        }
    }

    @Test
    fun `the channels load follows the role of the revision it compares with`() = runTest {
        val db = TestDb(StandardTestDispatcher(testScheduler, "sqlite"))
        try {
            val h = SyncHarness(this, db).start()
            h.store.tx { updateWs(ws, mapOf("role" to "guest", "channelsStale" to true)) }
            // Held right after the read that the channels load follows (the second time the directory resumes).
            val gated = HoldSecond(StandardTestDispatcher(testScheduler, "directory"))
            val directory = async(gated, start = CoroutineStart.UNDISPATCHED) { h.sync.directory() }
            val resume = gated.held.await()
            // A restore that promoted me commits before the guest path writes.
            h.sync.applier.restore(ws, details(generation = Ids.GEN2, role = "member"), h.clock.now(), h.clock.now())
            assertEquals("member", h.ws().role)
            resume.run()
            directory.await()
            assertTrue("the guest path didn't mark the new generation's channels current without asking", h.ws().channelsStale)
        } finally {
            db.close()
        }
    }

    @Test
    fun `an outbox 426 raises the revision, so a history page on its way doesn't write into the parked cache`() = runTest {
        val h = SyncHarness(this, db).start()
        h.store.tx {
            upsertRoom(ws, room(head = 2))
            setMeta(Outbox.CLOCK_AT, h.clock.now().toString())
            setMeta(Outbox.CLOCK_OFFSET, "0")
        }
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        h.http.once("GET", h.route("/conversations/$general/events")) {
            started.complete(Unit)
            release.await()
            ok(EventPage.serializer(), EventPage(listOf(msg(1), msg(2)), 2, 1))
        }
        val opening = async { h.sync.loader.open(general) }
        started.await()
        h.http.once("POST", h.route("/conversations/$general/messages")) { throw refusal(426, "upgrade_required") }
        val box = Outbox(h.store, h.client, backgroundScope, now = h.clock::now)
        val before = h.store.revision(ws)
        box.enqueue(ws, general, null, "Test", emptyList())
        box.synced(ws)
        runCurrent()
        assertEquals(FeedApplier.STATE_UPGRADE, h.ws().state)
        assertTrue("the park raised the revision", h.store.revision(ws) > before)
        release.complete(Unit)
        opening.await()
        assertTrue("the page from before the park wrote nothing", h.events().isEmpty())
    }

    @Test
    fun `a worker's run whose budget ran out makes no more requests outside the window and keeps its cursor`() = runTest {
        val h = SyncHarness(this, db).start()
        var window = true
        val sync = WorkspaceSync(ws, h.store, h.client, backgroundScope, h.clock, automatic = { window })
        h.http.once("GET", h.route("/changes")) {
            delay(100)
            ok(FeedPage.serializer(), feed(next = "first", more = true))
        }
        h.http.on("GET", h.route("/changes")) { ok(FeedPage.serializer(), feed(next = "later")) }
        // The worker stops waiting after 25 ms, and its window closes.
        assertNull(withTimeoutOrNull(25) { sync.now() })
        window = false
        advanceTimeBy(5_000)
        runCurrent()
        assertEquals("only the request made inside the window", 1, h.http.calls("GET", h.route("/changes")).size)
        assertEquals("the page that answered kept its cursor", "first", h.ws().cursor)
        // The next window continues from there.
        window = true
        assertTrue(sync.now().ok)
        assertEquals("later", h.ws().cursor)
        assertEquals("first", h.http.calls("GET", h.route("/changes")).last().query("after"))
    }

    @Test
    fun `a pass someone waits for pages on after the window closed`() = runTest {
        val h = SyncHarness(this, db).start()
        var window = true
        val sync = WorkspaceSync(ws, h.store, h.client, backgroundScope, h.clock, automatic = { window })
        h.http.once("GET", h.route("/changes")) {
            window = false
            ok(FeedPage.serializer(), feed(next = "first", more = true))
        }
        h.http.on("GET", h.route("/changes")) { ok(FeedPage.serializer(), feed(next = "second")) }
        assertTrue(sync.now().ok)
        assertEquals("second", h.ws().cursor)
    }

    @Test
    fun `the open room takes its New divider from the restored pass`() = runTest {
        val h = SyncHarness(this, db).start()
        h.store.tx {
            upsertRoom(ws, room(head = 10, read = 10))
            appendEvents(ws, general, (1L..10L).map { msg(it) })
        }
        h.sync.loader.open(general)
        assertEquals(10L, h.sync.loader.rooms.value.getValue(general).readAtOpen)
        h.http.once("GET", h.route()) { ok(WorkspaceDetails.serializer(), details(generation = Ids.GEN2)) }
        h.sync.details(inRun = true)
        val resetsBefore = h.sync.loader.rooms.value.getValue(general).resets
        h.feedPages(feed(room(head = 6, read = 5, unread = 1), next = "restored"))
        h.http.once("GET", h.route("/conversations/$general/events")) {
            ok(EventPage.serializer(), EventPage((1L..6L).map { msg(it) }, 6, 1))
        }
        h.sync.runFeed()
        assertEquals(5L, h.room()!!.readLocal)
        val load = h.sync.loader.rooms.value.getValue(general)
        assertEquals("the divider follows the restored read position", 5L, load.readAtOpen)
        assertTrue("the screen hears its read position was replaced", load.resets > resetsBefore)
    }

    @Test
    fun `a forward page whose floor empties the cached range still takes back the alerts of what the floor took`() = runTest {
        val h = SyncHarness(this, db).start()
        h.store.tx {
            upsertRoom(ws, room(head = 5))
            appendEvents(ws, general, listOf(msg(1), msg(2)))
            addNotices(ws, general, listOf(Notice(Ids.event(2), 2)))
        }
        h.http.once("GET", h.route("/conversations/$general/events")) {
            ok(EventPage.serializer(), EventPage(listOf(msg(4), msg(5)), 5, 4))
        }
        h.sync.loader.open(general)
        assertEquals(4L, h.room()!!.floor)
        assertTrue(h.events().isEmpty())
        // The alerted message among them: its alert goes with it.
        assertEquals(setOf(Ids.event(1), Ids.event(2)), h.events.pages.flatMap { it.removed[general].orEmpty() }.toSet())
    }

    @Test
    fun `a removal SQLite refuses hides the workspace at once, runs the removal hook, and deletes it on a later try`() = runTest {
        val h = SyncHarness(this, db).start()
        h.store.tx {
            upsertRoom(ws, room())
            sql.exec("CREATE TRIGGER keep_ws BEFORE DELETE ON ws BEGIN SELECT RAISE(ABORT, 'refused'); END")
        }
        h.http.once("GET", h.route()) { throw refusal(404, "not_found", scope = "workspace") }
        val failed = runCatching { h.sync.details() }.exceptionOrNull() as WorkspaceError
        assertEquals("not_found", failed.code)
        assertNull("hidden from every cache read", h.store.read { getWs(ws) })
        assertTrue(h.store.read { listWs() }.isEmpty())
        assertTrue("the removal hook ran", h.events.log.contains("removed"))
        assertEquals("the row is still on disk", 1L, h.store.read { sql.long("SELECT COUNT(*) FROM ws") })
        assertTrue(h.store.hasHidden)
        // A second removal of the same workspace does nothing more.
        assertFalse(h.sync.applier.removeWorkspace(ws))
        h.store.tx { sql.exec("DROP TRIGGER keep_ws") }
        assertTrue(h.store.deleteHidden())
        assertFalse(h.store.hasHidden)
        assertEquals(0L, h.store.read { sql.long("SELECT COUNT(*) FROM ws") })
        assertEquals(0L, h.store.read { sql.long("SELECT COUNT(*) FROM room") })
    }
}
