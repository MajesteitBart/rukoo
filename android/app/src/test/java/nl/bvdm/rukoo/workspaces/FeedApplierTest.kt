package nl.bvdm.rukoo.workspaces

import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * An incremental feed page (contract §3.6) on real SQLite: what each part of a page does to the cache, that a page and
 * its cursor commit together, the whole-answer check, and the real server's recorded feed answers going through it.
 * These are the page cases of desktop's chat-sync.test.js; PassTest and ResetTest hold the rest.
 */
class FeedApplierTest {
    private val db = TestDb()

    @After
    fun tearDown() = db.close()

    private val ws = Ids.WS
    private val general = Ids.GENERAL

    private suspend fun FeedApplier.page(page: FeedPage, sent: String? = "cursor0", active: String? = null): PageResult =
        apply(ws, page, sent, active) ?: throw AssertionError("the page wasn't applied")

    private suspend fun SyncHarness.cache(room: String, events: List<WireEvent>) {
        store.tx { appendEvents(ws, room, events) }
    }

    private fun outbox(local: String, room: String = general, grant: String = Ids.grant(1), state: String = "queued", reason: String? = null) =
        OutboxRow(local = local, ws = ws, room = room, actor = Ids.ME, grantId = grant, generation = Ids.GEN, text = "unsent $local",
            mentions = emptyList(), root = null, state = state, reason = reason, createdAt = 1)

    @Test
    fun `a new room comes in uncached with its read positions at the server's, and the cursor with it`() = runTest {
        val h = SyncHarness(this, db).start()
        val result = h.sync.applier.page(feed(room(read = 4, unread = 6, head = 10), next = "cursor1"))
        val r = h.room()!!
        assertNull(r.lo)
        assertNull(r.hi)
        assertEquals(listOf(4L, 4L, 4L), listOf(r.read, r.readLocal, r.readSent))
        assertEquals(6, r.unread)
        assertEquals("cursor1", h.ws().cursor)
        assertEquals(setOf(general), result.changed)
        assertFalse(result.pass)
    }

    @Test
    fun `every field follows the feed while this phone's read positions only rise`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.page(feed(room(read = 2, head = 10), next = "cursor1"))
        h.store.tx { setRoomFields(ws, general, mapOf("readLocal" to 8L, "readSent" to 6L)) }
        h.sync.applier.page(feed(room(read = 5, head = 12, name = "renamed", unread = 7), next = "cursor2"), sent = "cursor1")
        val r = h.room()!!
        assertEquals("renamed", r.name)
        assertEquals(12L, r.head)
        assertEquals(5L, r.read)
        assertEquals(8L, r.readLocal)
        assertEquals(6L, r.readSent)
        // The cache doesn't cover what comes after readLocal, so the server's numbers stand until the next page.
        assertEquals(7, r.unread)
        // A higher server read moves both up.
        h.sync.applier.page(feed(room(read = 11, head = 12), next = "cursor3"), sent = "cursor2")
        assertEquals(listOf(11L, 11L, 11L), h.room()!!.let { listOf(it.read, it.readLocal, it.readSent) })
    }

    @Test
    fun `a changed grant empties the room and leaves its unsent messages on the old grant`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.page(feed(room(head = 5), next = "cursor1"))
        h.cache(general, (1L..5L).map { msg(it) })
        h.store.tx { insertOutbox(outbox("AAAAAAAAAAAAAAAAAAAAAA")) }
        val result = h.sync.applier.page(
            feed(room(head = 6, grant = Ids.grant(2)), room(Ids.RANDOM, Ids.grant(3), head = 2, name = "random"), next = "cursor2"),
            sent = "cursor1",
        )
        val r = h.room()!!
        assertEquals(Ids.grant(2), r.grantId)
        assertNull(r.lo)
        assertNull(r.hi)
        assertEquals(emptyList<Event>(), h.events())
        // The room loader hears of it; a new room had no cache to drop.
        assertEquals(setOf(general), result.cacheDropped)
        // The server's 409 stale_grant decides about the unsent message, not this phone.
        val row = h.store.read { getOutbox("AAAAAAAAAAAAAAAAAAAAAA")!! }
        assertEquals(Ids.grant(1), row.grantId)
        assertEquals("queued", row.state)
    }

    @Test
    fun `a floor deletes the events below it and takes their alerts back`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.page(feed(room(head = 10), next = "cursor1"))
        h.cache(general, (4L..10L).map { msg(it) })
        // Alerts on screen: one for a cached message below the new floor, one for a message that was never cached.
        h.store.tx { addNotices(ws, general, listOf(Notice(Ids.event(4), 4), Notice(Ids.event(2), 2), Notice(Ids.event(9), 9))) }
        val result = h.sync.applier.page(feed(room(head = 10, floor = 6), next = "cursor2"), sent = "cursor1")
        val r = h.room()!!
        assertEquals(6L, r.floor)
        assertEquals(6L, r.lo)
        assertEquals(10L, r.hi)
        assertEquals((6L..10L).toList(), h.events().map { it.seq })
        assertEquals(setOf(Ids.event(2), Ids.event(4), Ids.event(5)), result.removed.getValue(general).toSet())
        // A floor above the whole range empties it.
        h.sync.applier.page(feed(room(head = 14, floor = 12), next = "cursor3"), sent = "cursor2")
        assertNull(h.room()!!.lo)
        assertNull(h.room()!!.hi)
    }

    @Test
    fun `removed IDs leave tombstones and lose their text, cached or not`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.page(feed(room(head = 5), next = "cursor1"))
        h.cache(general, (1L..5L).map { msg(it, mentions = listOf(mention(Ids.ME, 4))) })
        val never = Ids.event(40)
        val result = h.sync.applier.page(feed(room(head = 6, removed = listOf(Ids.event(3), never)), next = "cursor2"), sent = "cursor1")
        val gone = h.store.read { eventById(ws, Ids.event(3))!! }
        assertTrue(gone.redacted)
        assertNull(gone.text)
        assertEquals(emptyList<Mention>(), gone.mentions)
        assertEquals("message 2", h.store.read { eventById(ws, Ids.event(2))!! }.text)
        assertTrue(h.store.read { hasTombstone(ws, Ids.event(3)) })
        assertTrue("an ID that was never cached gets a tombstone too", h.store.read { hasTombstone(ws, never) })
        assertEquals(mapOf(general to listOf(Ids.event(3))), result.redacted)
        assertEquals(setOf(Ids.event(3), never), result.removed.getValue(general).toSet())
    }

    @Test
    fun `removedMore drops the room's cache whole and takes every alert of the room back`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.page(feed(room(head = 3), next = "cursor1"))
        h.cache(general, (1L..3L).map { msg(it) })
        h.store.tx { addNotices(ws, general, listOf(Notice(Ids.event(30), 30))) }
        val result = h.sync.applier.page(feed(room(head = 3, removedMore = true), next = "cursor2"), sent = "cursor1")
        assertNull(h.room()!!.lo)
        assertEquals(emptyList<Event>(), h.events())
        assertEquals(setOf(Ids.event(1), Ids.event(2), Ids.event(3), Ids.event(30)), result.removed.getValue(general).toSet())
        assertEquals(setOf(general), result.cacheDropped)
    }

    @Test
    fun `an eviction deletes the room with its events, unsent messages, drafts and notices`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.page(feed(room(head = 3), room(Ids.RANDOM, Ids.grant(2), head = 2, name = "random"), next = "cursor1"))
        h.cache(general, (1L..3L).map { msg(it) })
        h.store.tx {
            insertOutbox(outbox("AAAAAAAAAAAAAAAAAAAAAA"))
            insertOutbox(outbox("BBBBBBBBBBBBBBBBBBBBBB"))
            putDraft(ws, general, null, Draft("half a thought"))
            addNotices(ws, general, listOf(Notice(Ids.event(3), 3)))
        }
        // An eviction for a room the page also lists, and one for a room this phone never had, change nothing.
        val result = h.sync.applier.page(
            feed(room(Ids.RANDOM, Ids.grant(2), head = 3, name = "random"), evictions = listOf(general, Ids.RANDOM, Ids.PROJECT), next = "cursor2"),
            sent = "cursor1",
        )
        assertNull(h.room())
        assertNotNull(h.room(Ids.RANDOM))
        assertEquals(listOf(general), result.evicted)
        assertEquals(mapOf(general to 2), result.droppedSends)
        h.store.read {
            assertEquals(0, countUnsent())
            assertNull(getDraft(ws, general, null))
            assertEquals(emptyList<Notice>(), noticesForRoom(ws, general))
            assertEquals(emptyList<Event>(), eventsFrom(ws, general, 0, 100))
        }
    }

    @Test
    fun `inline events append only when they follow the cached range at once`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.page(feed(room(head = 5), next = "cursor1"))
        h.cache(general, (1L..5L).map { msg(it) })
        val result = h.sync.applier.page(feed(room(head = 7), inline = listOf(msg(6), msg(7)), next = "cursor2"), sent = "cursor1", active = general)
        assertEquals(7L, h.room()!!.hi)
        assertEquals(general, result.appendedRoom)
        assertEquals(listOf(6L, 7L), result.appended.map { it.seq })
        // A gap: the loader catches the room up instead.
        val gap = h.sync.applier.page(feed(room(head = 10), inline = listOf(msg(9), msg(10)), next = "cursor3"), sent = "cursor2", active = general)
        assertEquals(7L, h.room()!!.hi)
        assertEquals(10L, h.room()!!.head)
        assertNull(gap.appendedRoom)
        // Inline events of a room that isn't the open one are ignored.
        h.sync.applier.page(feed(room(head = 10), inline = listOf(msg(8)), next = "cursor4"), sent = "cursor3", active = null)
        assertEquals(7L, h.room()!!.hi)
    }

    @Test
    fun `inline events fill an uncached room only when they end at its head`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.page(feed(room(head = 10), next = "cursor1"))
        h.sync.applier.page(feed(room(head = 10), inline = listOf(msg(8), msg(9)), next = "cursor2"), sent = "cursor1", active = general)
        assertNull(h.room()!!.lo)
        h.sync.applier.page(feed(room(head = 10), inline = listOf(msg(8), msg(9), msg(10)), next = "cursor3"), sent = "cursor2", active = general)
        assertEquals(8L, h.room()!!.lo)
        assertEquals(10L, h.room()!!.hi)
    }

    @Test
    fun `an inline event removed earlier is stored removed, and a redaction removes its target`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.page(feed(room(head = 5), next = "cursor1"))
        h.cache(general, (1L..5L).map { msg(it) })
        h.store.tx { addTombstones(ws, listOf(Ids.event(6))) }
        val result = h.sync.applier.page(
            feed(room(head = 7), inline = listOf(msg(6, text = "should not come back"), redaction(7, Ids.event(3), 3)), next = "cursor2"),
            sent = "cursor1",
            active = general,
        )
        val six = h.store.read { eventById(ws, Ids.event(6))!! }
        assertTrue(six.redacted)
        assertNull(six.text)
        val three = h.store.read { eventById(ws, Ids.event(3))!! }
        assertTrue(three.redacted)
        assertNull(three.text)
        assertTrue(h.store.read { hasTombstone(ws, Ids.event(3)) })
        assertTrue(Ids.event(3) in result.removed.getValue(general))
    }

    @Test
    fun `the directory flags mark members, channels and blocks stale`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.page(feed(directory = Directory(members = true, channels = false, blocks = true), next = "cursor1"))
        with(h.ws()) {
            assertTrue(membersStale)
            assertFalse(channelsStale)
            assertTrue(blocksStale)
        }
    }

    @Test
    fun `the badges recount from the cache when this phone read further than the server`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.page(feed(room(head = 10), next = "cursor1"))
        h.cache(general, (1L..10L).map { seq ->
            when (seq) {
                8L -> msg(seq, actor = Ids.ME)
                9L -> msg(seq, text = "@Me look", mentions = listOf(mention(Ids.ME, 3)))
                else -> msg(seq)
            }
        })
        h.store.tx { setRoomFields(ws, general, mapOf("readLocal" to 6L)) }
        h.sync.applier.page(feed(room(head = 10, read = 2, unread = 8, mentions = 1), next = "cursor2"), sent = "cursor1")
        // After 6: 7, 9 and 10 are someone else's; 8 is the person's own; 9 mentions them.
        val r = h.room()!!
        assertEquals(3, r.unread)
        assertEquals(1, r.mentions)
    }

    @Test
    fun `a page and its cursor go in one transaction, so a failure part way changes nothing`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.page(feed(room(head = 5), room(Ids.RANDOM, Ids.grant(2), head = 1, name = "random"), next = "cursor1"))
        h.cache(general, (1L..5L).map { msg(it) })
        // A message cached in another room under the ID the inline event will use: the unique index refuses it.
        h.cache(Ids.RANDOM, listOf(msg(1).copy(id = Ids.event(6))))
        val before = h.room()!!
        try {
            h.sync.applier.page(
                feed(room(head = 6, removed = listOf(Ids.event(2)), name = "renamed"), inline = listOf(msg(6)), next = "cursor2"),
                sent = "cursor1",
                active = general,
            )
            fail("the clash should fail the page")
        } catch (e: WorkspaceError) {
            assertEquals("not_saved", e.code)
        }
        assertEquals(before, h.room())
        assertEquals("cursor1", h.ws().cursor)
        assertEquals("message 2", h.store.read { eventById(ws, Ids.event(2))!! }.text)
        assertFalse(h.store.read { hasTombstone(ws, Ids.event(2)) })
    }

    @Test
    fun `a page answered for a cursor that moved meanwhile changes nothing`() = runTest {
        val h = SyncHarness(this, db).start()
        assertNull(h.sync.applier.apply(ws, feed(room(head = 5), next = "cursor9"), "older-cursor"))
        assertNull(h.room())
        assertEquals("cursor0", h.ws().cursor)
        h.store.tx { updateWs(ws, mapOf("state" to "quarantined")) }
        assertNull(h.sync.applier.apply(ws, feed(room(head = 5), next = "cursor9"), "cursor0"))
        assertNull(h.room())
    }

    @Test
    fun `a page with one bad field is refused whole, naming the field`() {
        val good = room()
        fun refusedAt(page: FeedPage): String = try {
            FeedApplier.check(page)
            throw AssertionError("the page should be refused")
        } catch (e: WorkspaceError) {
            assertEquals("server", e.code)
            e.message!!.substringAfter("at ")
        }
        FeedApplier.check(feed(good, room(Ids.DM, Ids.grant(4), dm = true, closedReason = "left"), inline = listOf(msg(9), msg(10))))
        assertEquals("changes.changes[0].head", refusedAt(feed(good.copy(head = -1))))
        assertEquals("changes.changes[0].read", refusedAt(feed(good.copy(read = 11))))
        assertEquals("changes.changes[0].unread", refusedAt(feed(good.copy(unread = 101))))
        assertEquals("changes.changes[0].grant", refusedAt(feed(good.copy(grant = "g_1"))))
        assertEquals("changes.changes[0].conversation", refusedAt(feed(good.copy(conversation = "c_../../x"))))
        assertEquals("changes.changes[0].role", refusedAt(feed(good.copy(role = null))))
        assertEquals("changes.changes[0].removed", refusedAt(feed(good.copy(removed = (1L..65L).map { Ids.event(it) }))))
        assertEquals("changes.changes[0].closedReason", refusedAt(feed(room(Ids.DM, dm = true).copy(archived = true))))
        assertEquals("changes.changes[0].participants", refusedAt(feed(room(Ids.DM, dm = true).copy(participants = listOf(Ids.ME)))))
        assertEquals("changes.changes", refusedAt(feed(good, good)))
        assertEquals("changes.inlineEvents[1].seq", refusedAt(feed(good, inline = listOf(msg(5), msg(5)))))
        assertEquals("changes.inlineEvents[0].mentions", refusedAt(feed(good, inline = listOf(msg(5, text = "hi", mentions = listOf(Mention(Ids.ME, 0, 9)))))))
        assertEquals("changes.inlineEvents[0].text", refusedAt(feed(good, inline = listOf(msg(5, text = "")))))
        assertEquals("changes.next", refusedAt(feed(good, next = "not a cursor")))
        assertEquals("changes.evictions", refusedAt(feed(evictions = listOf(Ids.GENERAL, Ids.GENERAL))))
    }

    @Test
    fun `every recorded feed, events and workspace answer passes the check`() {
        var feeds = 0
        var pages = 0
        for (e in WorkspaceVectors.exchanges) {
            if (e.status != 200 || e.method != "GET") continue
            val route = e.path.substringBefore('?')
            when {
                route.endsWith("/changes") -> {
                    FeedApplier.check(decodeWire<FeedPage>(e.responseBody!!))
                    feeds++
                }
                route.endsWith("/events") -> {
                    FeedApplier.check(decodeWire<EventPage>(e.responseBody!!))
                    pages++
                }
                Regex("^/v1/workspaces/w_[A-Za-z0-9_-]{22}$").matches(route) -> {
                    val d = decodeWire<WorkspaceDetails>(e.responseBody!!)
                    FeedApplier.check(d, d.workspace.id)
                }
            }
        }
        assertTrue("the recording has feed answers", feeds >= 6)
        assertTrue("the recording has events answers", pages >= 2)
        // A DM's feed row, as POST /dms answers it, passes too.
        FeedApplier.check(recorded<FeedPage>("feed with closed dm").changes.first { it.kind == "dm" })
    }

    @Test
    fun `a removal the real server listed takes the text of a cached message and leaves a tombstone`() = runTest {
        val h = SyncHarness(this, db).start(seed = false)
        val w = WorkspaceVectors.id("workspace")
        val general = WorkspaceVectors.id("general")
        val mila = WorkspaceVectors.id("mila")
        val message = WorkspaceVectors.id("message")
        h.store.tx { insertWs(WsRow(id = w, name = "Acme", role = "member", me = mila, myName = "Mila", generation = Ids.GEN)) }
        val applier = h.sync.applier
        // Mila's first pass: general and Project X, and the channel she left listed as an eviction.
        val first = recorded<FeedPage>("member feed")
        assertTrue(first.evictions.isNotEmpty())
        val installed = applier.apply(w, first, null)!!
        assertTrue(installed.pass)
        assertEquals(first.changes.map { it.conversation }.toSet(), h.store.read { listRooms(w) }.map { it.id }.toSet())
        // The first pass alerts nothing.
        for (r in h.store.read { listRooms(w) }) assertEquals(r.head, r.notified)
        // She opens general: its events, as the server answered them.
        val grant = h.store.read { getRoom(w, general)!! }.grantId
        val events = recorded<EventPage>("events")
        assertNotNull(applier.applyHistory(w, general, grant, events, HistoryMode.NEWEST))
        assertTrue(h.store.read { eventById(w, message)!! }.text!!.isNotEmpty())
        // Olga removes her message; Mila's next page lists it.
        val after = recorded<FeedPage>("member feed after")
        assertEquals(listOf(message), after.changes.single().removed)
        val result = applier.apply(w, after, first.next)!!
        val gone = h.store.read { eventById(w, message)!! }
        assertTrue(gone.redacted)
        assertNull(gone.text)
        assertTrue(h.store.read { hasTombstone(w, message) })
        assertEquals(listOf(message), result.redacted.getValue(general))
        assertEquals(after.next, h.store.read { getWs(w)!!.cursor })
        // The reply to it keeps its row and its text.
        val reply = h.store.read { eventById(w, WorkspaceVectors.id("reply"))!! }
        assertEquals(message, reply.root)
        assertFalse(reply.redacted)
    }
}
