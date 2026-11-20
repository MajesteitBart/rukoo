package nl.bvdm.rukoo.workspaces

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Room history (contract §3.7), the cases of desktop's chat-history.test.js: opening an uncached, a slightly behind and
 * a far behind room, opening at an old seq, older pages to the floor, threads whose root is older than the cache, a
 * history page from before a grant change, and a removed message that stays removed. The events route answers with
 * the server's paging rules over a list each test sets up.
 */
class RoomLoaderTest {
    private val db = TestDb()

    @After
    fun tearDown() = db.close()

    private val ws = Ids.WS
    private val general = Ids.GENERAL

    private suspend fun SyncHarness.withRoom(head: Long, floor: Long = 1, read: Long = 0, events: List<WireEvent> = (1L..head).map { msg(it) }): EventsRoute {
        sync.applier.apply(ws, feed(room(head = head, floor = floor, read = read), next = "cursor1"), "cursor0")
        val route = EventsRoute(events, head, floor)
        http.on("GET", route("/conversations/$general/events")) { route.answer(it) }
        return route
    }

    private suspend fun SyncHarness.cacheRange(range: LongRange) {
        store.tx { appendEvents(ws, general, range.map { msg(it) }) }
    }

    private fun SyncHarness.eventCalls() = http.calls("GET", route("/conversations/$general/events")).map { c ->
        listOfNotNull(c.query("after")?.let { "after=$it" }, c.query("before")?.let { "before=$it" }, "limit=${c.query("limit")}").joinToString("&")
    }

    private suspend fun SyncHarness.range(): Pair<Long?, Long?> = room()!!.let { it.lo to it.hi }

    @Test
    fun `opening an uncached room loads the newest page`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom(head = 80, read = 70)
        h.sync.loader.open(general)
        assertEquals(listOf("before=81&limit=50"), h.eventCalls())
        assertEquals(31L to 80L, h.range())
        assertEquals((31L..80L).toList(), h.events().map { it.seq })
        val load = h.sync.loader.rooms.value.getValue(general)
        assertEquals(70L, load.readAtOpen)
        assertFalse(load.loading)
        assertTrue(load.complete)
        assertTrue(h.sync.loader.hasOlder(h.room()!!))
        h.http.verify()
    }

    @Test
    fun `a room a little behind pages forward until it reaches its head`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom(head = 250)
        h.cacheRange(1L..40L)
        h.sync.loader.open(general)
        assertEquals(listOf("after=40&limit=100", "after=140&limit=100", "after=240&limit=100"), h.eventCalls())
        assertEquals(1L to 250L, h.range())
        assertEquals(250, h.events().size)
    }

    @Test
    fun `a room far behind drops its range and loads the newest page`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom(head = 400)
        h.cacheRange(1L..40L)
        h.sync.loader.open(general)
        assertEquals(listOf("before=401&limit=50"), h.eventCalls())
        assertEquals(351L to 400L, h.range())
        assertEquals(50, h.events().size)
    }

    @Test
    fun `opening at an old seq pages back until it is in range`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom(head = 400)
        h.sync.loader.open(general, at = 120)
        assertEquals(
            listOf("before=401&limit=50", "before=351&limit=100", "before=251&limit=100", "before=151&limit=100"),
            h.eventCalls(),
        )
        assertEquals(51L to 400L, h.range())
        assertTrue(h.sync.loader.rooms.value.getValue(general).complete)
    }

    @Test
    fun `opening at a seq the backfill can't reach opens at the oldest loaded event, incomplete`() = runTest {
        val h = SyncHarness(this, db, SyncTiming(backfillPages = 3)).start()
        h.withRoom(head = 600)
        h.sync.loader.open(general, at = 5)
        assertEquals(4, h.eventCalls().size)
        assertEquals(251L to 600L, h.range())
        assertFalse(h.sync.loader.rooms.value.getValue(general).complete)
    }

    @Test
    fun `older pages go back to the floor and then there is nothing older`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom(head = 120, floor = 21)
        h.sync.loader.open(general)
        assertEquals(71L to 120L, h.range())
        assertTrue(h.sync.loader.hasOlder(h.room()!!))
        h.sync.loader.older(general)
        assertEquals("before=71&limit=50", h.eventCalls().last())
        assertEquals(21L to 120L, h.range())
        assertFalse(h.sync.loader.hasOlder(h.room()!!))
        // Nothing more to ask for.
        h.sync.loader.older(general)
        assertEquals(2, h.eventCalls().size)
    }

    @Test
    fun `an empty older page means there is nothing older`() = runTest {
        val h = SyncHarness(this, db).start()
        val route = h.withRoom(head = 80)
        h.sync.loader.open(general)
        route.events = route.events.filter { it.seq >= 31 }
        h.sync.loader.older(general)
        assertFalse(h.sync.loader.hasOlder(h.room()!!))
    }

    @Test
    fun `a thread whose root is older than the cache pages back to it`() = runTest {
        val h = SyncHarness(this, db).start()
        val root = Ids.event(10)
        h.withRoom(head = 400, events = (1L..400L).map { if (it >= 395) msg(it, root = root) else msg(it) })
        h.sync.loader.open(general)
        h.sync.loader.ensureThread(general, root)
        assertEquals(listOf("before=401&limit=50", "before=351&limit=100", "before=251&limit=100", "before=151&limit=100", "before=51&limit=100"), h.eventCalls())
        assertEquals("message 10", h.store.read { eventById(ws, root)!! }.text)
        assertEquals((395L..400L).toList(), h.store.read { replies(ws, general, root) }.map { it.seq })
        val load = h.sync.loader.threads.value.getValue(ThreadKey(general, root))
        assertTrue(load.complete)
        assertFalse(load.expired)
        assertFalse(load.loading)
        // A root already cached costs nothing.
        h.sync.loader.ensureThread(general, root)
        assertEquals(5, h.eventCalls().size)
    }

    @Test
    fun `a thread whose root went with retention shows as expired`() = runTest {
        val h = SyncHarness(this, db).start()
        val root = Ids.event(3)
        h.withRoom(head = 100, floor = 20, events = (1L..100L).map { if (it >= 95) msg(it, root = root) else msg(it) })
        h.sync.loader.open(general)
        h.sync.loader.ensureThread(general, root)
        val load = h.sync.loader.threads.value.getValue(ThreadKey(general, root))
        assertTrue(load.expired)
        assertEquals(20L, h.room()!!.lo)
    }

    @Test
    fun `a thread out of reach is incomplete, and Load earlier pages on towards the root`() = runTest {
        val h = SyncHarness(this, db, SyncTiming(eventsNewest = 10, eventsPage = 10, backfillPages = 2)).start()
        val root = Ids.event(5)
        h.withRoom(head = 100, events = (1L..100L).map { if (it >= 99) msg(it, root = root) else msg(it) })
        h.sync.loader.open(general)
        val key = ThreadKey(general, root)
        h.sync.loader.ensureThread(general, root)
        assertFalse(h.sync.loader.threads.value.getValue(key).complete)
        assertEquals(71L, h.room()!!.lo)
        h.sync.loader.loadThread(general, root)
        assertFalse(h.sync.loader.threads.value.getValue(key).complete)
        assertEquals(51L, h.room()!!.lo)
        h.sync.loader.loadThread(general, root)
        assertEquals(31L, h.room()!!.lo)
        h.sync.loader.loadThread(general, root)
        assertEquals(11L, h.room()!!.lo)
        assertFalse(h.sync.loader.threads.value.getValue(key).complete)
        h.sync.loader.loadThread(general, root)
        assertEquals(1L, h.room()!!.lo)
        assertTrue(h.sync.loader.threads.value.getValue(key).complete)
        assertEquals("message 5", h.store.read { eventById(ws, root)!! }.text)
    }

    @Test
    fun `a history page that started under the old grant is discarded`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.apply(ws, feed(room(head = 10), next = "cursor1"), "cursor0")
        val route = EventsRoute((1L..10L).map { msg(it) })
        val started = CompletableDeferred<Unit>()
        val gate = CompletableDeferred<Unit>()
        h.http.on("GET", h.route("/conversations/$general/events")) {
            started.complete(Unit)
            gate.await()
            route.answer(it)
        }
        val opening = launch { h.sync.loader.open(general) }
        started.await()
        // The person left and joined again while the page was on its way.
        h.sync.applier.apply(ws, feed(room(head = 10, grant = Ids.grant(2)), next = "cursor2"), "cursor1")
        gate.complete(Unit)
        opening.join()
        assertEquals(Ids.grant(2), h.room()!!.grantId)
        assertEquals(null to null, h.range())
        assertEquals(emptyList<Event>(), h.events())
    }

    @Test
    fun `a message removed while a history page was on its way stays removed`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.apply(ws, feed(room(head = 10), next = "cursor1"), "cursor0")
        val route = EventsRoute((1L..10L).map { msg(it, text = "body $it") })
        val started = CompletableDeferred<Unit>()
        val gate = CompletableDeferred<Unit>()
        h.http.on("GET", h.route("/conversations/$general/events")) {
            started.complete(Unit)
            gate.await()
            route.answer(it)
        }
        val opening = launch { h.sync.loader.open(general) }
        started.await()
        h.sync.applier.apply(ws, feed(room(head = 10, removed = listOf(Ids.event(5))), next = "cursor2"), "cursor1")
        gate.complete(Unit)
        opening.join()
        val five = h.store.read { eventById(ws, Ids.event(5))!! }
        assertTrue(five.redacted)
        assertNull(five.text)
        assertEquals("body 6", h.store.read { eventById(ws, Ids.event(6))!! }.text)
        assertEquals(1L to 10L, h.range())
    }

    @Test
    fun `leaving and joining an open room twice keeps its whole history within reach`() = runTest {
        val h = SyncHarness(this, db).start()
        val route = h.withRoom(head = 120, read = 120)
        h.sync.loader.open(general)
        h.sync.loader.older(general)
        h.sync.loader.older(general)
        assertEquals(1L to 120L, h.range())
        assertFalse(h.sync.loader.hasOlder(h.room()!!))
        var head = 120L
        for (cycle in 1..2) {
            // Left and joined again while the room stayed open: a new grant, and the two events inline after the old
            // roomAfter, which refill the emptied cache.
            head += 2
            route.events = (1L..head).map { msg(it) }
            route.head = head
            h.feedPages(feed(room(head = head, grant = Ids.grant(cycle + 1), read = head - 2), inline = listOf(msg(head - 1), msg(head)), next = "cursor${cycle + 1}"))
            h.sync.now()
            assertEquals(Ids.grant(cycle + 1), h.room()!!.grantId)
            assertEquals(head - 1 to head, h.range())
            assertTrue("cycle $cycle: the earlier history is within reach", h.sync.loader.hasOlder(h.room()!!))
            val load = h.sync.loader.rooms.value.getValue(general)
            assertEquals("cycle $cycle: the New divider follows the new row", head - 2, load.readAtOpen)
            assertTrue(load.complete)
            // The server gives the whole history back, and it loads to the floor again.
            h.sync.loader.older(general)
            assertEquals("before=${head - 1}&limit=50", h.eventCalls().last())
            h.sync.loader.older(general)
            h.sync.loader.older(general)
            assertEquals(1L to head, h.range())
            assertEquals((1L..head).toList(), h.events().map { it.seq })
            assertFalse(h.sync.loader.hasOlder(h.room()!!))
        }
        h.http.verify()
    }

    @Test
    fun `an open room whose cache removedMore dropped loads its older history again`() = runTest {
        val h = SyncHarness(this, db).start()
        val route = h.withRoom(head = 80, read = 80)
        h.sync.loader.open(general)
        h.sync.loader.older(general)
        assertEquals(1L to 80L, h.range())
        assertFalse(h.sync.loader.hasOlder(h.room()!!))
        // More messages were removed than the feed can list: the cache goes whole and the inline event refills it.
        route.events = ((1L..39L) + (80L..81L)).map { msg(it) }
        route.head = 81
        h.feedPages(feed(room(head = 81, read = 80, removedMore = true), inline = listOf(msg(81)), next = "cursor2"))
        h.sync.now()
        assertEquals(81L to 81L, h.range())
        assertTrue(h.sync.loader.hasOlder(h.room()!!))
        h.sync.loader.older(general)
        assertEquals("before=81&limit=50", h.eventCalls().last())
        assertEquals(((1L..39L) + (80L..81L)).toList(), h.events().map { it.seq })
        assertFalse(h.sync.loader.hasOlder(h.room()!!))
        h.http.verify()
    }

    @Test
    fun `the open room is named in the feed and catches up after each run`() = runTest {
        val h = SyncHarness(this, db).start()
        val route = h.withRoom(head = 10)
        h.sync.loader.open(general)
        assertEquals(1L to 10L, h.range())
        // New messages: the page raises head without carrying them, and the room catches up after the run.
        route.events = (1L..15L).map { msg(it) }
        route.head = 15
        h.feedPages(feed(room(head = 15), next = "cursor2"))
        h.sync.now()
        val changes = h.http.calls("GET", h.route("/changes")).last()
        assertEquals(general, changes.query("active"))
        assertEquals("10", changes.query("roomAfter"))
        assertEquals("after=10&limit=100", h.eventCalls().last())
        assertEquals(1L to 15L, h.range())
        // Inline events that follow the range need no request.
        val calls = h.eventCalls().size
        h.feedPages(feed(room(head = 17), inline = listOf(msg(16), msg(17)), next = "cursor3"))
        h.sync.now()
        assertEquals(1L to 17L, h.range())
        assertEquals(calls, h.eventCalls().size)
        // A closed room isn't named.
        h.sync.loader.close(general)
        h.feedPages(feed(next = "cursor4"))
        h.sync.now()
        assertNull(h.http.calls("GET", h.route("/changes")).last().query("active"))
        h.http.verify()
    }

    @Test
    fun `an open room keeps its range while open and is cut back to ROOM_CACHE_MAX when it closes`() = runTest {
        val h = SyncHarness(this, db, SyncTiming(roomCacheMax = 50)).start()
        h.withRoom(head = 200)
        h.sync.loader.open(general)
        h.sync.loader.older(general)
        h.sync.loader.older(general)
        assertEquals(51L to 200L, h.range())
        assertEquals(150, h.events().size)
        h.sync.loader.close(general)
        assertEquals(151L to 200L, h.range())
        assertEquals(50, h.events().size)
        assertNull(h.sync.loader.rooms.value[general])
    }

    @Test
    fun `opening another room cuts the last one back to ROOM_CACHE_MAX`() = runTest {
        val h = SyncHarness(this, db, SyncTiming(roomCacheMax = 50)).start()
        h.withRoom(head = 200)
        h.sync.applier.apply(ws, feed(room(id = Ids.RANDOM, name = "random", head = 0, floor = 0), next = "cursor2"), "cursor1")
        h.sync.loader.open(general)
        h.sync.loader.older(general)
        h.sync.loader.older(general)
        assertEquals(150, h.events().size)
        // No close: the UI went straight to another room.
        h.sync.loader.open(Ids.RANDOM)
        assertEquals(151L to 200L, h.range())
        assertEquals(50, h.events().size)
        assertEquals(Ids.RANDOM, h.sync.loader.openRoom)
        assertNull(h.sync.loader.rooms.value[general])
        h.http.verify()
    }

    @Test
    fun `a room still open when the process died is cut back at the next sync's first run, also offline`() = runTest {
        val h = SyncHarness(this, db, SyncTiming(roomCacheMax = 50)).start()
        h.sync.applier.apply(ws, feed(room(head = 150), room(id = Ids.RANDOM, name = "random", head = 120), next = "cursor1"), "cursor0")
        // What open rooms gathered; neither was closed.
        h.store.tx {
            appendEvents(ws, general, (1L..150L).map { msg(it) }, Int.MAX_VALUE)
            appendEvents(ws, Ids.RANDOM, (1L..120L).map { msg(it, room = 2) }, Int.MAX_VALUE)
        }
        h.restart()
        // The new sync opens one of them before its first run, which finds no network.
        h.sync.loader.open(Ids.RANDOM)
        h.http.on("GET", h.route("/changes")) { throw WorkspaceError("network") }
        assertEquals("network", h.sync.now().error?.code)
        assertEquals(101L to 150L, h.range())
        assertEquals(50, h.events().size)
        assertEquals("the open room keeps its range", 120, h.events(Ids.RANDOM).size)
        h.http.verify()
    }

    @Test
    fun `a room that went asks the feed for its eviction`() = runTest {
        val h = SyncHarness(this, db).start()
        h.sync.applier.apply(ws, feed(room(head = 10), next = "cursor1"), "cursor0")
        h.http.on("GET", h.route("/conversations/$general/events")) { throw refusal(404, "not_found", "conversation") }
        h.feedPages(feed(evictions = listOf(general), next = "cursor2"))
        h.sync.loader.open(general)
        assertEquals("not_found", h.sync.loader.rooms.value[general]?.error)
        // The run the loader asked for; the sync's timers live in backgroundScope.
        advanceTimeBy(1_000)
        assertNull(h.room())
        assertNull("an evicted room is no longer open", h.sync.loader.openRoom)
        h.http.verify()
    }
}
