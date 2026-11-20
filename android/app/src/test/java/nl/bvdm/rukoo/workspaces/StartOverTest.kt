package nl.bvdm.rukoo.workspaces

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Start over, a new `keyId` and a new generation all start a pass from the start, and the server's pass from the start lists no
 * removals (server/src/workspace.js `#changes` answers `removed: []` without a cursor). So, as for a `410`, the
 * workspace's cached bodies and notice rows go first: a message removed on the server meanwhile must leave the
 * timeline, the preview and its notification (contract §3.6, §3.10, §3.14). Each case runs the real alert engine on
 * the real chat cache, with the feed scripted as the server answers it.
 */
class StartOverTest {
    private val db = TestDb()

    @After
    fun tearDown() = db.close()

    private val ws = Ids.WS
    private val secret = Ids.event(5, 4)
    private val dm = room(Ids.DM, Ids.grant(4), head = 5, unread = 1, dm = true)
    private val timeline = (1L..5L).map { msg(it, room = 4, text = if (it == 5L) "the secret plan" else "hello $it") }

    /** The sync's hooks wired to a real alert engine, as WorkspaceService does. */
    private class AlertEvents(val store: () -> WorkspaceStore, val engine: ChatAlertEngine) : SyncEvents {
        val pages = CopyOnWriteArrayList<PageResult>()

        override suspend fun page(ws: String, result: PageResult) {
            pages += result
            engine.onPage(ws, result, store())
        }

        override suspend fun ran(ws: String, outcome: RunOutcome) =
            engine.afterRun(ws, store()) { throw WorkspaceError("network") }
    }

    private class Setup(val h: SyncHarness, val sink: ChatAlertRulesTest.RecordingSink, val events: AlertEvents)

    // A DM whose newest message, "the secret plan", is cached and shown in a notification with its notice row.
    private suspend fun TestScope.setup(): Setup {
        val h = SyncHarness(this, db).start()
        val sink = ChatAlertRulesTest.RecordingSink()
        val engine = ChatAlertEngine(sink, { ChatAlertRulesTest.Words }, { true }, { _, _ -> false })
        val events = AlertEvents({ h.store }, engine)
        h.sync.close()
        h.sync = WorkspaceSync(ws, h.store, h.client, backgroundScope, h.clock, events, h.timing)
        h.sync.applier.apply(ws, feed(dm, next = "cursor1"), "cursor0")
        h.store.tx { appendEvents(ws, Ids.DM, timeline) }
        engine.afterRun(ws, h.store) { throw WorkspaceError("network") }
        val key = ChatAlertRules.roomKey(ws, Ids.DM)
        assertEquals(setOf(key), sink.activeKeys())
        assertTrue("the alert shows the secret", sink.shown.single().toString().contains("the secret plan"))
        assertTrue(secret in h.store.read { noticesForRoom(ws, Ids.DM) }.map { it.message })
        return Setup(h, sink, events)
    }

    // What the server answers once the message was removed: the pass from the start lists the room, removed: [].
    private fun SyncHarness.serverAfterRemoval(keyId: String? = Ids.KEY, generation: String = Ids.GEN): EventsRoute {
        http.on("GET", route()) { ok(WorkspaceDetails.serializer(), details(generation = generation, keyId = keyId)) }
        http.on("GET", route("/changes")) { call ->
            assertNull("a pass from the start", call.query("after"))
            ok(FeedPage.serializer(), feed(dm, next = "fresh"))
        }
        val events = EventsRoute((1L..4L).map { msg(it, room = 4) } + msg(5, room = 4, redacted = true))
        http.on("GET", route("/conversations/${Ids.DM}/events")) { events.answer(it) }
        return events
    }

    private suspend fun Setup.assertSecretGone() {
        val store = h.store
        assertFalse(
            "no cached body holds the removed text",
            store.read { eventsFrom(ws, Ids.DM, 0, 10_000) }.any { it.text == "the secret plan" },
        )
        assertTrue(store.read { lastMessage(ws, Ids.DM) }?.text != "the secret plan")
        assertEquals(emptyList<Notice>(), store.read { noticesForRoom(ws, Ids.DM) })
        assertTrue("its notification is taken back", sink.activeKeys().isEmpty())
        assertEquals(ChatAlertRules.workspacePrefix(ws), sink.cleared.last())
        val reset = events.pages.first { it.reset }
        assertTrue(secret in reset.removed.getValue(Ids.DM))
        assertTrue(Ids.DM in reset.changed)
    }

    @Test
    fun `Start over drops a removed message's body, preview and notification, and keeps rooms, reads, drafts, mute and the outbox`() = runTest {
        val s = setup()
        val h = s.h
        h.store.tx {
            // Read here to 3 and already reported, so the run posts no read.
            setRoomFields(ws, Ids.DM, mapOf("readLocal" to 3L, "readSent" to 3L))
            putDraft(ws, Ids.DM, null, Draft("half a reply"))
            insertOutbox(
                OutboxRow(local = "AAAAAAAAAAAAAAAAAAAAAA", ws = ws, room = Ids.DM, actor = Ids.ME, grantId = Ids.grant(4), generation = Ids.GEN,
                    text = "unsent", mentions = emptyList(), root = null, state = "queued", reason = null, createdAt = 1),
            )
        }
        h.serverAfterRemoval()
        h.sync.reload()
        // Before the pass runs, the cache already holds no body of the workspace.
        assertEquals(emptyList<Event>(), h.events(Ids.DM))
        assertNull(h.room(Ids.DM)!!.lo)
        val outcome = h.sync.now()
        assertTrue(outcome.pass)
        s.assertSecretGone()
        assertNull(h.store.read { eventById(ws, secret) })
        val row = h.room(Ids.DM)!!
        assertEquals(3L, row.readLocal)
        assertEquals(5L, row.notified)
        h.store.read {
            assertEquals("half a reply", getDraft(ws, Ids.DM, null)!!.text)
            assertEquals(listOf("queued", "lookup"), getOutbox("AAAAAAAAAAAAAAAAAAAAAA")!!.let { listOf(it.state, it.reason) })
        }
        assertTrue("the run after the pass alerts nothing again", s.sink.activeKeys().isEmpty())
        h.http.verify()
    }

    @Test
    fun `Start over reloads the open room's bodies from the server`() = runTest {
        val s = setup()
        val h = s.h
        // The DM is open on the range cached while the message still stood, which reaches its head.
        h.sync.loader.open(Ids.DM)
        assertEquals("the open needed no request", emptyList<ScriptedHttp.Call>(), h.http.calls.toList())
        assertEquals("the secret plan", h.store.read { lastMessage(ws, Ids.DM)!! }.text)
        h.serverAfterRemoval()
        h.sync.reload()
        h.sync.now()
        val reloaded = h.events(Ids.DM)
        assertEquals((1L..5L).toList(), reloaded.map { it.seq })
        val preview = h.store.read { lastMessage(ws, Ids.DM)!! }
        assertEquals(5L, preview.seq)
        assertTrue(preview.redacted)
        assertNull(preview.text)
        s.assertSecretGone()
        h.http.verify()
    }

    @Test
    fun `a new keyId drops a removed message's body, preview and notification before its pass`() = runTest {
        val s = setup()
        val h = s.h
        h.store.tx { putDraft(ws, Ids.DM, null, Draft("half a reply")) }
        h.serverAfterRemoval(keyId = "key2")
        h.sync.details()
        assertEquals("key2", h.ws().keyId)
        assertEquals(emptyList<Event>(), h.events(Ids.DM))
        assertTrue("the notification went with the key change", s.sink.activeKeys().isEmpty())
        val outcome = h.sync.now()
        assertTrue(outcome.pass)
        s.assertSecretGone()
        assertNull(h.store.read { eventById(ws, secret) })
        assertEquals("half a reply", h.store.read { getDraft(ws, Ids.DM, null)!!.text })
        assertEquals(5L, h.room(Ids.DM)!!.notified)
        h.http.verify()
    }

    // A restored backup may lack messages this phone saw, so a new generation drops bodies, notice rows and alerts in
    // the restore's transaction, as the desktop does (src/main/workspaces/sync.js restore()).
    @Test
    fun `a new generation drops a removed message's body, preview and notification before its pass`() = runTest {
        val s = setup()
        val h = s.h
        h.store.tx { putDraft(ws, Ids.DM, null, Draft("half a reply")) }
        h.serverAfterRemoval(generation = Ids.GEN2)
        h.sync.details()
        assertEquals(Ids.GEN2, h.ws().generation)
        assertEquals(emptyList<Event>(), h.events(Ids.DM))
        assertEquals(emptyList<Notice>(), h.store.read { noticesForRoom(ws, Ids.DM) })
        assertTrue("the shown alert went with the restore", s.sink.activeKeys().isEmpty())
        val outcome = h.sync.now()
        assertTrue(outcome.pass)
        s.assertSecretGone()
        assertNull(h.store.read { eventById(ws, secret) })
        assertEquals("half a reply", h.store.read { getDraft(ws, Ids.DM, null)!!.text })
        // The old generation's positions say nothing of the new one's seqs: its pass takes them from the restored feed
        // (read 0), so the unread message alerts again as after any later pass.
        val row = h.room(Ids.DM)!!
        assertEquals(listOf(0L, 0L, 0L), listOf(row.readLocal, row.readSent, row.notified))
        h.http.verify()
    }
}
