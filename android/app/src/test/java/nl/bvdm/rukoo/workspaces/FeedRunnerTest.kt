package nl.bvdm.rukoo.workspaces

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The feed loop (contract §3.6 "A run", §3.19): one run at a time, at least 500 ms between starts, 50 pages then a
 * second's pause, the sync backoff and what resets it, `Retry-After`, a malformed page, and the directories a run
 * loads at its end. Virtual time makes the gaps exact.
 */
class FeedRunnerTest {
    private val db = TestDb()

    @After
    fun tearDown() = db.close()

    private val ws = Ids.WS

    /** `GET /changes` answering page after page, each continuing from the last, and when each request came. */
    private class Feed(private val h: SyncHarness, private val more: Boolean = false) {
        val times = CopyOnWriteArrayList<Long>()
        var gate: CompletableDeferred<Unit>? = null
        var fail: (() -> WorkspaceError)? = null
        private var n = 0

        init {
            h.http.on("GET", h.route("/changes")) {
                times += h.scope.testScheduler.currentTime
                gate?.await()
                fail?.let { throw it() }
                n += 1
                ok(FeedPage.serializer(), feed(room(head = n.toLong()), next = "page$n", more = more))
            }
        }
    }

    @Test
    fun `wakes during a run make exactly one more run, at least 500 ms after the first started`() = runTest {
        val h = SyncHarness(this, db).start()
        val feed = Feed(h)
        feed.gate = CompletableDeferred()
        h.sync.request()
        runCurrent()
        assertEquals(listOf(0L), feed.times.toList())
        assertTrue(h.sync.runner.state.value.running)
        advanceTimeBy(100)
        repeat(3) { h.sync.request() }
        feed.gate!!.complete(Unit)
        // advanceTimeBy, not advanceUntilIdle: the sync's timers live in backgroundScope, which the latter ignores.
        advanceTimeBy(10_000)
        assertEquals(listOf(0L, 500L), feed.times.toList())
        assertFalse(h.sync.runner.state.value.running)
        assertEquals("page2", h.ws().cursor)
    }

    @Test
    fun `runs start at least 500 ms apart`() = runTest {
        val h = SyncHarness(this, db).start()
        val feed = Feed(h)
        h.sync.now()
        advanceTimeBy(100)
        h.sync.now()
        h.sync.now()
        assertEquals(listOf(0L, 500L, 1_000L), feed.times.toList())
    }

    @Test
    fun `now waits for a run that starts after it`() = runTest {
        val h = SyncHarness(this, db).start()
        val feed = Feed(h)
        feed.gate = CompletableDeferred()
        h.sync.request()
        runCurrent()
        val waiting = async { h.sync.now() }
        runCurrent()
        feed.gate!!.complete(Unit)
        val outcome = waiting.await()
        assertTrue(outcome.ok)
        assertEquals(2, feed.times.size)
        assertEquals("the outcome is the second run's", "page2", h.ws().cursor)
    }

    /**
     * A run held in flight that then answers [ending], which stops the feed, and a now() asked while it ran. Fails
     * instead of hanging when now() is still waiting once the run is over. Returns what now() heard.
     */
    private suspend fun TestScope.nowDuringAnEndingRun(ending: () -> WorkspaceError): RunOutcome {
        val h = SyncHarness(this, db).start()
        val feed = Feed(h)
        feed.gate = CompletableDeferred()
        feed.fail = ending
        h.sync.request()
        runCurrent()
        val waiting = async { h.sync.now() }
        runCurrent()
        feed.gate!!.complete(Unit)
        advanceTimeBy(10_000)
        assertTrue("now() still waits for a run that never comes", waiting.isCompleted)
        assertEquals("no run followed", 1, feed.times.size)
        return waiting.await()
    }

    @Test
    fun `now during a run that quarantines the workspace hears quarantined`() = runTest {
        assertTrue(nowDuringAnEndingRun { refusal(409, "history_regressed") }.quarantined)
    }

    @Test
    fun `now during a run that parks the workspace hears upgrade`() = runTest {
        assertTrue(nowDuringAnEndingRun { refusal(426, "upgrade_required") }.upgrade)
    }

    @Test
    fun `now during a run that ends with the session hears signed_out`() = runTest {
        assertEquals("signed_out", nowDuringAnEndingRun { WorkspaceError("signed_out") }.error?.code)
    }

    @Test
    fun `a run stops after PAGES_PER_RUN pages and the next follows a second later`() = runTest {
        val h = SyncHarness(this, db, SyncTiming(pagesPerRun = 3)).start()
        val feed = Feed(h, more = true)
        val outcome = h.sync.now()
        assertTrue(outcome.more)
        assertEquals(3, feed.times.size)
        assertEquals("page3", h.ws().cursor)
        advanceTimeBy(999)
        assertEquals(3, feed.times.size)
        advanceTimeBy(2)
        assertEquals(1_000L, feed.times[3])
        h.sync.close()
        // Every page asked for 64 rooms.
        assertTrue(h.http.calls("GET", h.route("/changes")).all { it.query("limit") == "64" })
    }

    @Test
    fun `a failing run backs off 5, 15, 30, 60, then every 120 s, and a wake resets it`() = runTest {
        val h = SyncHarness(this, db).start()
        val feed = Feed(h)
        feed.fail = { WorkspaceError("network") }
        val outcome = h.sync.now()
        assertEquals("network", outcome.error?.code)
        assertEquals("network", h.sync.runner.state.value.error)
        advanceTimeBy(350_001)
        assertEquals(listOf(0L, 5_000L, 20_000L, 50_000L, 110_000L, 230_000L, 350_000L), feed.times.toList())
        // The catch-up timer waits the backoff out; a wake doesn't.
        h.sync.request(reset = false)
        advanceTimeBy(1_000)
        assertEquals(7, feed.times.size)
        h.sync.request()
        runCurrent()
        assertEquals(351_001L, feed.times.last())
        // A good run ends the backoff: the next failure starts from 5 s again.
        feed.fail = null
        h.sync.now()
        assertEquals(null, h.sync.runner.state.value.error)
        assertEquals(0, h.sync.runner.state.value.failures)
        feed.fail = { refusal(503, "server") }
        val start = h.scope.testScheduler.currentTime
        h.sync.now()
        advanceTimeBy(5_001)
        assertEquals(start + 5_500, feed.times.last())
        h.sync.close()
    }

    @Test
    fun `a 429 waits Retry-After before the next run`() = runTest {
        val h = SyncHarness(this, db).start()
        val feed = Feed(h)
        feed.fail = { refusal(429, "rate_limited", retryAfter = "7") }
        val outcome = h.sync.now()
        assertEquals("rate_limited", outcome.error?.code)
        feed.fail = null
        h.sync.request()
        advanceTimeBy(6_999)
        assertEquals(1, feed.times.size)
        advanceTimeBy(2)
        assertEquals(listOf(0L, 7_000L), feed.times.toList())
        assertEquals("page1", h.ws().cursor)
    }

    @Test
    fun `a page with one bad field changes nothing, and a later run gets the good one`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.apply(ws, feed(room(head = 3), next = "cursor1"), "cursor0")
        val before = h.room()
        h.http.once("GET", h.route("/changes")) { ok(FeedPage.serializer(), feed(room(head = -1), next = "bad")) }
        h.http.on("GET", h.route("/changes")) { ok(FeedPage.serializer(), feed(room(head = 7), next = "good")) }
        val outcome = h.sync.now()
        assertEquals("server", outcome.error?.code)
        assertTrue(outcome.error!!.message!!.endsWith("changes.changes[0].head"))
        assertEquals(before, h.room())
        assertEquals("cursor1", h.ws().cursor)
        assertEquals("server", h.sync.runner.state.value.error)
        advanceTimeBy(5_001)
        assertEquals(7L, h.room()!!.head)
        assertEquals("good", h.ws().cursor)
        assertNull(h.sync.runner.state.value.error)
    }

    @Test
    fun `a run loads GET slash first when the generation isn't known yet`() = runTest {
        val h = SyncHarness(this, db).start(seed = false)
        h.store.tx { insertWs(WsRow(id = ws, name = "Team", role = "member")) }
        h.http.on("GET", h.route()) { ok(WorkspaceDetails.serializer(), details()) }
        h.http.on("GET", h.route("/changes")) { ok(FeedPage.serializer(), feed(room(head = 2), next = "first")) }
        h.http.on("GET", h.route("/members")) { ok(MembersPage.serializer(), recorded("members")) }
        h.http.on("GET", h.route("/channels")) { ok(ChannelsPage.serializer(), recorded("channels")) }
        h.http.on("GET", h.route("/blocks")) { ok(BlocksPage.serializer(), recorded("blocks")) }
        val outcome = h.sync.now()
        assertTrue(outcome.pass)
        assertEquals(h.route(), h.http.calls.first().route)
        val row = h.ws()
        assertEquals(Ids.GEN, row.generation)
        assertEquals(Ids.ME, row.me)
        assertEquals("Me", row.myName)
        assertNotNull(row.syncedAt)
        assertNotNull(h.store.read { getMeta(FeedApplier.META_CLOCK_OFFSET) })
        // The first pass marked every directory stale and the run loaded them.
        assertFalse(row.membersStale || row.channelsStale || row.blocksStale)
        h.store.read {
            assertEquals(WorkspaceVectors.exchange("members").responseBody!!.jsonObject.getValue("members").jsonArray.size, listMembers(ws).size)
            assertTrue(listChannels(ws).isNotEmpty())
            assertEquals(1, listBlocks(ws).size)
        }
        assertEquals(listOf("page", "ran"), h.events.log.toList())
        h.http.verify()
    }

    @Test
    fun `a guest has no channel directory, a server without blocks has none, and a failure keeps the flag`() = runTest {
        val h = SyncHarness(this, db).start(seed = false)
        h.seedWs(role = "guest")
        // Rows from when the person was a full member; then every directory turns stale.
        h.store.tx { replaceChannels(ws, listOf(Channel(Ids.RANDOM, "random", "workspace"))) }
        h.store.tx { updateWs(ws, mapOf("membersStale" to true, "channelsStale" to true, "blocksStale" to true)) }
        h.http.on("GET", h.route("/members")) { throw WorkspaceError("network") }
        h.http.on("GET", h.route("/blocks")) { throw refusal(404, "not_found") }
        assertTrue(h.sync.directory())
        val row = h.ws()
        assertTrue("a failed load keeps its flag for the next run", row.membersStale)
        assertFalse(row.channelsStale)
        assertFalse(row.blocksStale)
        h.store.read {
            assertEquals(emptyList<Channel>(), listChannels(ws))
            assertEquals(emptyList<Block>(), listBlocks(ws))
        }
        assertTrue(h.http.calls("GET", h.route("/channels")).isEmpty())
    }

    @Test
    fun `a members reload that changes my role sets the workspace's role and my name`() = runTest {
        val h = SyncHarness(this, db).start(seed = false)
        h.seedWs(role = "member")
        // Someone made me admin: my feed marks the members directory stale, and GET / isn't due.
        h.feedPages(feed(room(head = 2), directory = Directory(members = true), next = "cursor1"))
        h.http.on("GET", h.route("/members")) {
            ok(MembersPage.serializer(), MembersPage(listOf(
                Member(Ids.ME, name = "Me Renamed", role = "admin", state = "active"),
                Member(Ids.OLGA, name = "Olga", role = "owner", state = "active"),
            )))
        }
        val seen = CopyOnWriteArrayList<DbChange>()
        backgroundScope.launch { h.store.changes.collect { seen += it } }
        runCurrent()
        h.sync.now()
        val row = h.ws()
        assertEquals("admin", row.role)
        assertEquals("Me Renamed", row.myName)
        assertFalse(row.membersStale)
        assertTrue("the workspace list hears the change", seen.any { it.affects(ws) })
        assertTrue("no GET / was needed", h.http.calls("GET", h.route()).isEmpty())
        // A page that leaves me out (a long directory) keeps what the row had.
        h.store.tx { replaceMembers(ws, listOf(Member(Ids.OLGA, name = "Olga", role = "owner", state = "active")), more = true) }
        assertEquals("admin", h.ws().role)
        assertEquals("Me Renamed", h.ws().myName)
        h.http.verify()
    }

    @Test
    fun `a stopped runner drops its pending run and its waiters hear skipped`() = runTest {
        val h = SyncHarness(this, db).start()
        val feed = Feed(h)
        h.sync.now()
        val waiting = async { h.sync.now() }
        runCurrent()
        h.sync.runner.stop()
        assertTrue(waiting.await().skipped)
        advanceTimeBy(10_000)
        assertEquals(1, feed.times.size)
        assertTrue(h.sync.now().skipped)
    }

    @Test
    fun `the open room's inline events reach the cache through a run`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.apply(ws, feed(room(head = 2), next = "cursor1"), "cursor0")
        h.store.tx { appendEvents(ws, Ids.GENERAL, listOf(msg(1), msg(2))) }
        h.sync.loader.open(Ids.GENERAL)
        h.feedPages(feed(room(head = 3), inline = listOf(msg(3, text = "live")), next = "cursor2"))
        h.sync.now()
        assertEquals("live", h.store.read { eventById(ws, Ids.event(3))!! }.text)
        val page = h.events.pages.last()
        assertEquals(Ids.GENERAL, page.appendedRoom)
        // The request named the open room and where its cache ends.
        val query = h.http.calls("GET", h.route("/changes")).last()
        assertEquals(Ids.GENERAL, query.query("active"))
        assertEquals("2", query.query("roomAfter"))
        assertEquals(listOf(3L), page.appended.map { it.seq })
        assertEquals(3L, h.room()!!.hi)
        h.http.verify()
    }
}
