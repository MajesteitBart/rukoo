package nl.bvdm.rukoo.workspaces

import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A pass (contract §3.6): a first or rebuilding fetch without a cursor collects its rooms in `pass_room` and installs
 * them with its last page, as desktop's chat-sync.test.js checks for a first pass over several pages, a restart between
 * pages and evictions. The paged answers are the real server's recorded `limit=2` pages.
 */
class PassTest {
    private val db = TestDb()

    @After
    fun tearDown() = db.close()

    private val ws = Ids.WS

    private suspend fun SyncHarness.startPass(fresh: Boolean = true) {
        store.tx { updateWs(ws, mapOf("cursor" to null, "passing" to true, "fresh" to fresh)) }
    }

    @Test
    fun `a pass over several pages installs its rooms only with the last page`() = runTest {
        val h = SyncHarness(this, db).start(seed = false)
        val w = WorkspaceVectors.id("workspace")
        h.store.tx { insertWs(WsRow(id = w, name = "Acme", role = "owner", me = WorkspaceVectors.id("olga"), generation = Ids.GEN)) }
        val first = recorded<FeedPage>("feed small page")
        val last = recorded<FeedPage>("feed next page")
        assertTrue(first.more)
        assertFalse(last.more)
        val partial = h.sync.applier.apply(w, first, null)!!
        assertTrue(partial.partial)
        // Halfway: the rooms wait in pass_room, the room list still shows what it showed before, and the cursor is stored.
        h.store.read {
            assertEquals(emptyList<RoomRow>(), listRooms(w))
            assertEquals(2, listPassRooms(w).size)
            assertEquals(first.next, getWs(w)!!.cursor)
            assertTrue(getWs(w)!!.passing)
        }
        val installed = h.sync.applier.apply(w, last, first.next)!!
        assertTrue(installed.pass)
        h.store.read {
            val rooms = listRooms(w)
            assertEquals((first.changes + last.changes).map { it.conversation }.toSet(), rooms.map { it.id }.toSet())
            assertEquals(emptyList<Change>(), listPassRooms(w))
            val row = getWs(w)!!
            assertFalse(row.passing)
            assertFalse(row.fresh)
            assertEquals(last.next, row.cursor)
            // The first pass alerts nothing: every room counts as notified up to its head.
            for (r in rooms) assertEquals(r.head, r.notified)
            // The first page asked for the directories.
            assertTrue(row.membersStale && row.channelsStale && row.blocksStale)
        }
        assertEquals(3, installed.changed.size)
    }

    @Test
    fun `a room that changes during the pass ends with its newer state`() = runTest {
        val h = SyncHarness(this, db).start()
        h.startPass()
        h.sync.applier.apply(ws, feed(room(head = 5, name = "before"), room(Ids.RANDOM, Ids.grant(2), name = "random"), next = "p1", more = true), null)
        h.sync.applier.apply(ws, feed(room(head = 9, name = "after"), next = "p2"), "p1")
        val r = h.room()!!
        assertEquals(9L, r.head)
        assertEquals("after", r.name)
        assertNotNull(h.room(Ids.RANDOM))
    }

    @Test
    fun `a room the pass didn't list is deleted with its unsent messages`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.apply(ws, feed(room(head = 3), room(Ids.RANDOM, Ids.grant(2), name = "random"), next = "cursor1"), "cursor0")
        h.store.tx {
            insertOutbox(OutboxRow("AAAAAAAAAAAAAAAAAAAAAA", ws, Ids.RANDOM, Ids.ME, Ids.grant(2), Ids.GEN, "unsent", emptyList(), null, createdAt = 1))
        }
        h.startPass(fresh = false)
        // Evictions wait for the install: a page with more to come leaves the room alone.
        h.sync.applier.apply(ws, feed(room(head = 3), evictions = listOf(Ids.RANDOM), next = "p1", more = true), null)
        assertNotNull(h.room(Ids.RANDOM))
        val result = h.sync.applier.apply(ws, feed(next = "p2"), "p1")!!
        assertNull(h.room(Ids.RANDOM))
        assertNotNull(h.room())
        assertEquals(listOf(Ids.RANDOM), result.evicted)
        assertEquals(mapOf(Ids.RANDOM to 1), result.droppedSends)
        assertEquals(0, h.store.read { countUnsent() })
    }

    @Test
    fun `removals and floors on a page of the pass apply to cached events at once`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.apply(ws, feed(room(head = 6), next = "cursor1"), "cursor0")
        h.store.tx { appendEvents(ws, Ids.GENERAL, (1L..6L).map { msg(it) }) }
        h.startPass(fresh = false)
        val result = h.sync.applier.apply(ws, feed(room(head = 6, floor = 2, removed = listOf(Ids.event(4))), next = "p1", more = true), null)!!
        // The room row waits for the install, but the removal and the floor already took effect.
        assertEquals(1L, h.room()!!.floor)
        assertEquals((2L..6L).toList(), h.events().map { it.seq })
        assertTrue(h.store.read { eventById(ws, Ids.event(4))!! }.redacted)
        assertEquals(setOf(Ids.event(1), Ids.event(4)), result.removed.getValue(Ids.GENERAL).toSet())
        // A room the phone doesn't have yet still remembers what was removed in it.
        h.sync.applier.apply(ws, feed(room(Ids.PROJECT, Ids.grant(3), name = "project", removed = listOf(Ids.event(2, 3))), next = "p2", more = true), "p1")
        assertTrue(h.store.read { hasTombstone(ws, Ids.event(2, 3)) })
    }

    @Test
    fun `a later pass keeps notified, mute, drafts and read positions, and alerts as usual`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.apply(ws, feed(room(head = 5), next = "cursor1"), "cursor0")
        h.store.tx {
            setRoomFields(ws, Ids.GENERAL, mapOf("notified" to 3L, "muted" to true, "readLocal" to 4L))
            putDraft(ws, Ids.GENERAL, null, Draft("still typing"))
        }
        h.startPass(fresh = false)
        h.sync.applier.apply(ws, feed(room(head = 12, read = 2), next = "p1"), null)
        val r = h.room()!!
        assertEquals(3L, r.notified)
        assertTrue(r.muted)
        assertEquals(4L, r.readLocal)
        assertEquals(12L, r.head)
        assertEquals("still typing", h.store.read { getDraft(ws, Ids.GENERAL, null) }!!.text)
        // They survive closing the file and opening it again.
        h.restart()
        assertTrue(h.room()!!.muted)
        assertEquals("still typing", h.store.read { getDraft(ws, Ids.GENERAL, null) }!!.text)
    }

    @Test
    fun `the install prunes tombstones older than 14 days`() = runTest {
        val h = SyncHarness(this, db).start()
        val now = h.clock.now()
        h.store.tx {
            addTombstones(ws, listOf(Ids.event(1)), now - 15L * 24 * 3600 * 1000)
            addTombstones(ws, listOf(Ids.event(2)), now - 1L * 24 * 3600 * 1000)
        }
        h.startPass()
        h.sync.applier.apply(ws, feed(room(), next = "p1"), null)
        assertFalse(h.store.read { hasTombstone(ws, Ids.event(1)) })
        assertTrue(h.store.read { hasTombstone(ws, Ids.event(2)) })
    }

    @Test
    fun `a restart between pages goes on from the stored cursor and pass_room`() = runTest {
        val h = SyncHarness(this, db, SyncTiming(pagesPerRun = 1, moreAfterMs = 600_000)).start()
        h.startPass()
        h.feedPages(feed(room(head = 4), next = "p1", more = true))
        val first = h.sync.now()
        assertTrue(first.more)
        assertEquals(1, h.store.read { listPassRooms(ws) }.size)
        assertEquals(emptyList<RoomRow>(), h.store.read { listRooms(ws) })
        h.restart()
        h.feedPages(feed(room(Ids.RANDOM, Ids.grant(2), name = "random", head = 2), next = "p2"))
        val second = h.sync.now()
        assertTrue(second.pass)
        val feedCalls = h.http.calls("GET", h.route("/changes"))
        assertNull("the pass started without a cursor", feedCalls[0].query("after"))
        assertEquals("the restart went on from the stored cursor", "p1", feedCalls[1].query("after"))
        assertEquals(setOf(Ids.GENERAL, Ids.RANDOM), h.store.read { listRooms(ws) }.map { it.id }.toSet())
        assertFalse(h.ws().passing)
        h.http.verify()
    }

    @Test
    fun `a 410 on the pass's cursor starts it again from nothing`() = runTest {
        val h = SyncHarness(this, db, SyncTiming(pagesPerRun = 1, moreAfterMs = 600_000)).start()
        h.startPass()
        h.feedPages(feed(room(Ids.RANDOM, Ids.grant(2), name = "random"), next = "p1", more = true))
        h.sync.now()
        assertEquals(listOf(Ids.RANDOM), h.store.read { listPassRooms(ws) }.map { it.conversation })
        // The cursor expired: the recorded answer of the real server to a cursor it can't use.
        val gone = WorkspaceVectors.exchange("bad cursor")
        h.http.once("GET", h.route("/changes")) { throw WorkspaceError.fromAnswer(gone.status, gone.body) }
        h.http.once("GET", h.route()) { ok(WorkspaceDetails.serializer(), details()) }
        h.http.on("GET", h.route("/changes")) { ok(FeedPage.serializer(), feed(room(head = 2), next = "p9")) }
        val outcome = h.sync.now()
        assertTrue(outcome.pass)
        val feedCalls = h.http.calls("GET", h.route("/changes"))
        assertEquals("p1", feedCalls[1].query("after"))
        assertNull("the pass started over", feedCalls[2].query("after"))
        // Only the rooms of the new pass are installed.
        assertEquals(listOf(Ids.GENERAL), h.store.read { listRooms(ws) }.map { it.id })
        h.http.verify()
    }

    @Test
    fun `no open room is named while a pass runs`() = runTest {
        val h = SyncHarness(this, db).start()
        h.feedPages(feed(room(head = 0), next = "cursor1"))
        h.sync.now()
        h.sync.loader.open(Ids.GENERAL)
        h.startPass(fresh = false)
        h.feedPages(feed(room(head = 0), next = "p1"), feed(room(head = 0), next = "cursor2"))
        h.sync.now()
        h.sync.now()
        val feedCalls = h.http.calls("GET", h.route("/changes"))
        assertNull("the pass names no open room", feedCalls[1].query("active"))
        assertEquals(Ids.GENERAL, feedCalls[2].query("active"))
        h.http.verify()
    }
}
