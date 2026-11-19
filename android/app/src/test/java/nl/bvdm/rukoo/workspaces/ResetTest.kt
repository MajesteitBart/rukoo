package nl.bvdm.rukoo.workspaces

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * When the feed has to start again or stop (contract §3.6): `410 reset_required`, `409 history_regressed` and Start
 * over, a restore found through `GET /`, a new key, the removal path, `426` and `401`. The refusals are the real
 * server's recorded answers where the recording has one. The restore and Start over cases also prove that their
 * outbox marks commit in the same transaction as the rest (one change on the cache's change feed).
 */
class ResetTest {
    private val db = TestDb()

    @After
    fun tearDown() = db.close()

    private val ws = Ids.WS

    private fun refusedWith(name: String): WorkspaceError = WorkspaceVectors.exchange(name).let { WorkspaceError.fromAnswer(it.status, it.body) }

    private fun outbox(local: String, generation: String = Ids.GEN, state: String = "queued", reason: String? = null, room: String = Ids.GENERAL) =
        OutboxRow(local = local, ws = ws, room = room, actor = Ids.ME, grantId = Ids.grant(1), generation = generation, text = "unsent $local",
            mentions = emptyList(), root = null, state = state, reason = reason, createdAt = local.first().code.toLong())

    private suspend fun SyncHarness.withRoom(change: Change = room(head = 5, unread = 2), events: List<WireEvent> = (1L..5L).map { msg(it) }) {
        sync.applier.apply(ws, feed(change, next = "cursor1"), "cursor0")
        store.tx { appendEvents(ws, change.conversation, events) }
    }

    private fun SyncHarness.answerDetails(d: WorkspaceDetails = details()) {
        http.on("GET", route()) { ok(WorkspaceDetails.serializer(), d) }
    }

    private suspend fun SyncHarness.outboxState(local: String): List<String?> = store.read { getOutbox(local)!! }.let { listOf(it.state, it.reason) }

    @Test
    fun `a 410 drops every cached event and alert, keeps rooms, members, drafts and the outbox, then runs GET slash and a pass`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        h.store.tx {
            addNotices(ws, Ids.GENERAL, listOf(Notice(Ids.event(5), 5)))
            replaceMembers(ws, listOf(Member(Ids.ME, name = "Me", role = "member", state = "active"), Member(Ids.OLGA, name = "Olga", role = "owner", state = "active")))
            putDraft(ws, Ids.GENERAL, null, Draft("draft"))
            insertOutbox(outbox("AAAAAAAAAAAAAAAAAAAAAA"))
        }
        h.http.once("GET", h.route("/changes")) { throw refusedWith("bad cursor") }
        h.answerDetails()
        h.http.on("GET", h.route("/changes")) { ok(FeedPage.serializer(), feed(room(head = 5), next = "fresh")) }
        val outcome = h.sync.now()
        assertTrue(outcome.ok)
        assertTrue(outcome.pass)
        val calls = h.http.calls.map { "${it.method} ${it.route}" + (it.query("after")?.let { a -> " after=$a" } ?: "") }
        assertEquals(listOf("GET ${h.route("/changes")} after=cursor1", "GET ${h.route()}", "GET ${h.route("/changes")}"), calls)
        assertEquals(emptyList<Event>(), h.events())
        assertNull(h.room()!!.lo)
        h.store.read {
            assertEquals(emptyList<Notice>(), noticesForRoom(ws, Ids.GENERAL))
            assertEquals(2, listMembers(ws).size)
            assertEquals("draft", getDraft(ws, Ids.GENERAL, null)!!.text)
            assertEquals(1, countUnsent())
        }
        val row = h.ws()
        assertFalse(row.passing)
        assertEquals("fresh", row.cursor)
        // The service heard the reset first, with the alert to take back.
        assertEquals(listOf(Ids.event(5)), h.events.pages.first().removed[Ids.GENERAL])
        h.http.verify()
    }

    @Test
    fun `the WK-7 case - a message removed while the phone was away loses its body everywhere once the reset runs`() = runTest {
        val h = SyncHarness(this, db).start()
        val dm = room(Ids.DM, Ids.grant(4), head = 5, dm = true)
        h.withRoom(dm, (1L..5L).map { msg(it, room = 4, text = if (it == 5L) "the secret plan" else "hello $it") })
        h.store.tx { addNotices(ws, Ids.DM, listOf(Notice(Ids.event(5, 4), 5))) }
        assertEquals("the secret plan", h.store.read { lastMessage(ws, Ids.DM)!! }.text)
        // While the phone was away the message was removed and the cursor expired.
        h.http.once("GET", h.route("/changes")) { throw refusedWith("bad cursor") }
        h.answerDetails()
        h.http.on("GET", h.route("/changes")) { ok(FeedPage.serializer(), feed(dm, next = "fresh")) }
        h.sync.now()
        // Timeline, preview and alert lose the body.
        assertNull(h.store.read { eventById(ws, Ids.event(5, 4)) })
        assertNull(h.store.read { lastMessage(ws, Ids.DM) })
        assertEquals(emptyList<Notice>(), h.store.read { noticesForRoom(ws, Ids.DM) })
        assertTrue(Ids.event(5, 4) in h.events.pages.first().removed.getValue(Ids.DM))
        // Opening the DM again loads what the server has now: the message removed.
        val route = EventsRoute((1L..4L).map { msg(it, room = 4) } + msg(5, room = 4, redacted = true))
        h.http.on("GET", h.route("/conversations/${Ids.DM}/events")) { route.answer(it) }
        h.sync.loader.open(Ids.DM)
        val preview = h.store.read { lastMessage(ws, Ids.DM)!! }
        assertEquals(5L, preview.seq)
        assertTrue(preview.redacted)
        assertNull(preview.text)
        h.http.verify()
    }

    @Test
    fun `a second 410 in one run ends it with server`() = runTest {
        val h = SyncHarness(this, db).start()
        h.http.on("GET", h.route("/changes")) { throw refusedWith("bad cursor") }
        h.answerDetails()
        val outcome = h.sync.now()
        assertEquals("server", outcome.error?.code)
        assertEquals(410, outcome.error?.status)
        assertEquals(2, h.http.calls("GET", h.route("/changes")).size)
        assertEquals("server", h.sync.runner.state.value.error)
    }

    @Test
    fun `409 history_regressed stops the workspace, and Start over brings it back`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        h.store.tx { insertOutbox(outbox("BBBBBBBBBBBBBBBBBBBBBB")) }
        h.http.once("GET", h.route("/changes")) { throw refusal(409, "history_regressed", "workspace") }
        val outcome = h.sync.now()
        assertTrue(outcome.quarantined)
        assertEquals("quarantined", h.ws().state)
        assertEquals(emptyList<Event>(), h.events())
        for (r in h.store.read { listRooms(ws) }) assertEquals(listOf(0, 0), listOf(r.unread, r.mentions))
        assertTrue("quarantined" in h.events.log)
        // Stopped: a run does nothing, and nothing sends.
        val calls = h.http.calls.size
        assertTrue(h.sync.now().skipped)
        assertEquals(calls, h.http.calls.size)
        assertEquals(emptyList<OutboxRow>(), h.store.read { nextDue(Long.MAX_VALUE, 10) })
        // The UI's history calls say why.
        try {
            h.sync.loader.older(Ids.GENERAL)
            throw AssertionError("older should refuse")
        } catch (e: WorkspaceError) {
            assertEquals("paused", e.code)
        }

        h.answerDetails()
        h.http.on("GET", h.route("/changes")) { ok(FeedPage.serializer(), feed(room(head = 6), next = "fresh")) }
        h.sync.reload()
        val row = h.ws()
        assertEquals("ok", row.state)
        assertTrue(row.passing)
        assertNull(row.cursor)
        assertEquals(listOf("queued", "lookup"), h.outboxState("BBBBBBBBBBBBBBBBBBBBBB"))
        val after = h.sync.now()
        assertTrue(after.pass)
        val tail = h.http.calls.drop(calls).map { it.route }
        assertEquals("Start over loads GET / before the pass", listOf(h.route(), h.route("/changes")), tail.take(2))
        assertFalse(h.ws().passing)
        assertEquals(6L, h.room()!!.head)
        h.http.verify()
    }

    @Test
    fun `Start over marks unsent rows for a lookup inside its own transaction`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        h.store.tx {
            insertOutbox(outbox("AAAAAAAAAAAAAAAAAAAAAA", state = "sending"))
            insertOutbox(outbox("BBBBBBBBBBBBBBBBBBBBBB", state = "held", reason = "stale_grant"))
            insertOutbox(outbox("CCCCCCCCCCCCCCCCCCCCCC", state = "failed", reason = "quota"))
            updateWs(ws, mapOf("state" to "quarantined"))
        }
        val seen = CopyOnWriteArrayList<DbChange>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { h.store.changes.collect { seen += it } }
        val marked = h.sync.applier.startOver(ws)
        assertEquals(2, marked)
        assertEquals("one transaction: one change for the workspace", listOf(DbChange(ws)), seen.toList())
        assertEquals(listOf("queued", "lookup"), h.outboxState("AAAAAAAAAAAAAAAAAAAAAA"))
        assertEquals(listOf("queued", "lookup"), h.outboxState("BBBBBBBBBBBBBBBBBBBBBB"))
        assertEquals(listOf("failed", "quota"), h.outboxState("CCCCCCCCCCCCCCCCCCCCCC"))
        val row = h.ws()
        assertEquals(listOf<Any?>("ok", null, true), listOf(row.state, row.cursor, row.passing))
    }

    @Test
    fun `a new generation from GET slash restores - events go and the old generation's unsent rows wait for a lookup, in one transaction`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        h.store.tx {
            insertOutbox(outbox("CCCCCCCCCCCCCCCCCCCCCC", state = "sending"))
            insertOutbox(outbox("DDDDDDDDDDDDDDDDDDDDDD", state = "held", reason = "stale_grant"))
            insertOutbox(outbox("EEEEEEEEEEEEEEEEEEEEEE", state = "failed", reason = "quota"))
            insertOutbox(outbox("FFFFFFFFFFFFFFFFFFFFFF", generation = Ids.GEN2))
        }
        h.answerDetails(details(generation = Ids.GEN2, time = TestDb.NOW + 5_000))
        val seen = CopyOnWriteArrayList<DbChange>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { h.store.changes.collect { seen += it } }
        h.sync.details()
        assertEquals("one transaction: one change for the workspace", listOf(DbChange(ws)), seen.toList())
        assertEquals(listOf("queued", "lookup"), h.outboxState("CCCCCCCCCCCCCCCCCCCCCC"))
        assertEquals(listOf("queued", "lookup"), h.outboxState("DDDDDDDDDDDDDDDDDDDDDD"))
        assertEquals(listOf("failed", "quota"), h.outboxState("EEEEEEEEEEEEEEEEEEEEEE"))
        assertEquals(listOf("queued", null), h.outboxState("FFFFFFFFFFFFFFFFFFFFFF"))
        val row = h.ws()
        assertEquals(Ids.GEN2, row.generation)
        assertTrue(row.passing)
        assertNull(row.cursor)
        assertEquals(emptyList<Event>(), h.events())
        assertTrue("restored" in h.events.log)
        // The clock came with it: server time minus local time.
        assertEquals("5000", h.store.read { getMeta(FeedApplier.META_CLOCK_OFFSET) })
        assertEquals(TestDb.NOW.toString(), h.store.read { getMeta(FeedApplier.META_CLOCK_AT) })
    }

    @Test
    fun `a new key starts a pass and leaves cached events and the outbox alone`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        h.store.tx { insertOutbox(outbox("AAAAAAAAAAAAAAAAAAAAAA", state = "sending")) }
        h.answerDetails(details(keyId = "key2"))
        h.sync.details()
        val row = h.ws()
        assertEquals("key2", row.keyId)
        assertTrue(row.passing)
        assertNull(row.cursor)
        assertEquals(5, h.events().size)
        assertEquals(listOf("sending", null), h.outboxState("AAAAAAAAAAAAAAAAAAAAAA"))
        assertFalse("restored" in h.events.log)
    }

    @Test
    fun `a 404 for the workspace deletes it and tells the service`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        h.http.on("GET", h.route("/changes")) { throw refusedWith("not a member") }
        val outcome = h.sync.now()
        assertTrue(outcome.gone)
        assertNull(h.store.read { getWs(ws) })
        assertEquals(emptyList<RoomRow>(), h.store.read { listRooms(ws) })
        assertEquals(listOf("removed"), h.events.log.filter { it == "removed" })
        // The runner stopped: nothing more goes out.
        h.sync.request()
        advanceTimeBy(600_000)
        assertEquals(1, h.http.calls.size)
        assertTrue(h.sync.now().skipped)
    }

    @Test
    fun `the service can close the sync when it hears of the removal`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        lateinit var sync: WorkspaceSync
        val closing = object : SyncEvents {
            override suspend fun removed(ws: String) = sync.close()
        }
        sync = WorkspaceSync(ws, h.store, h.client, backgroundScope, h.clock, closing)
        h.http.on("GET", h.route("/changes")) { throw refusal(404, "not_found", "workspace") }
        assertTrue(sync.now().gone)
        assertTrue(sync.closed)
        assertNull(h.store.read { getWs(ws) })
        // The service's own call that found the removal goes the same way and comes back normally.
        h.seedWs()
        sync = WorkspaceSync(ws, h.store, h.client, backgroundScope, h.clock, closing)
        sync.removed()
        assertTrue(sync.closed)
        assertNull(h.store.read { getWs(ws) })
    }

    @Test
    fun `426 parks the workspace until Rukoo is updated`() = runTest {
        val h = SyncHarness(this, db).start()
        h.http.on("GET", h.route("/changes")) { throw refusedWith("upgrade required") }
        val outcome = h.sync.now()
        assertTrue(outcome.upgrade)
        assertEquals("upgrade", h.ws().state)
        assertTrue("parked" in h.events.log)
        assertTrue(h.sync.now().skipped)
        assertEquals(1, h.http.calls.size)
    }

    @Test
    fun `a 401 tells the account once and the run ends without a retry`() = runTest {
        val h = SyncHarness(this, db).start()
        h.http.on("GET", h.route("/changes")) { throw refusedWith("signed out workspace route") }
        val outcome = h.sync.now()
        assertEquals("signed_out", outcome.error?.code)
        assertEquals(1, h.refused.size)
        advanceTimeBy(600_000)
        assertEquals(1, h.http.calls.size)
        assertNotNull(h.store.read { getWs(ws) })
    }
}
