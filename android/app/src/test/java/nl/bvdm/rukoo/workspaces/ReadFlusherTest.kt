package nl.bvdm.rukoo.workspaces

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Read positions (contract §3.9), the cases of desktop's chat-read.test.js on virtual time: reports coalesce to one
 * `POST /read` per 5 s per room, positions never go back, `readLocal` survives a restart and the next run reports it,
 * the badges recount from the cache at once, a block keeps the blocked person's mentions out of the recount, and mute
 * and drafts outlast a restart.
 */
class ReadFlusherTest {
    private val db = TestDb()

    @After
    fun tearDown() = db.close()

    private val ws = Ids.WS
    private val general = Ids.GENERAL

    /** The `POST /read` reports per room, as (virtual time, seq). A failing route answers `network`. */
    private class ReadRoute(private val scope: TestScope, h: SyncHarness, vararg rooms: String) {
        val posts = HashMap<String, CopyOnWriteArrayList<Pair<Long, Long>>>()
        var attempts = 0
        @Volatile var fail = false

        init {
            for (room in rooms) {
                val list = CopyOnWriteArrayList<Pair<Long, Long>>()
                posts[room] = list
                h.http.on("POST", h.route("/conversations/$room/read")) { call ->
                    attempts++
                    if (fail) throw WorkspaceError("network")
                    val seq = (call.body as JsonObject).getValue("seq").jsonPrimitive.long
                    list += scope.testScheduler.currentTime to seq
                    ok(ReadAck.serializer(), ReadAck(seq))
                }
            }
        }
    }

    // general: 10 messages from Olga, except 8 by the person; 3 and 9 mention them. The server counts 9 unread, 2 mentions.
    private suspend fun SyncHarness.withRoom(events: List<WireEvent> = defaultEvents()) {
        sync.applier.apply(
            ws,
            feed(room(head = 10, unread = 9, mentions = 2), room(Ids.RANDOM, Ids.grant(2), head = 4, name = "random"), next = "cursor1"),
            "cursor0",
        )
        store.tx { appendEvents(ws, general, events) }
    }

    private fun defaultEvents() = (1L..10L).map { seq ->
        when (seq) {
            8L -> msg(seq, actor = Ids.ME)
            3L, 9L -> msg(seq, text = "@Me hi", mentions = listOf(mention(Ids.ME, 3)))
            else -> msg(seq)
        }
    }

    @Test
    fun `reports coalesce to one POST per 5 s per room`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        val reads = ReadRoute(this, h, general, Ids.RANDOM)
        assertTrue(h.sync.reads.mark(general, 3))
        runCurrent()
        h.sync.reads.mark(general, 5)
        advanceTimeBy(1_000)
        h.sync.reads.mark(general, 7)
        // Another room has its own gap.
        h.sync.reads.mark(Ids.RANDOM, 2)
        runCurrent()
        advanceTimeBy(3_999)
        assertEquals(listOf(0L to 3L), reads.posts.getValue(general).toList())
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(0L to 3L, 5_000L to 7L), reads.posts.getValue(general).toList())
        assertEquals(listOf(1_000L to 2L), reads.posts.getValue(Ids.RANDOM).toList())
        val r = h.room()!!
        assertEquals(listOf(7L, 7L, 7L), listOf(r.readLocal, r.readSent, r.read))
        h.http.verify()
    }

    @Test
    fun `read positions never go back and stop at the head`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        ReadRoute(this, h, general)
        assertTrue(h.sync.reads.mark(general, 7))
        assertFalse(h.sync.reads.mark(general, 4))
        assertEquals(7L, h.room()!!.readLocal)
        assertTrue(h.sync.reads.mark(general, 99))
        assertEquals(10L, h.room()!!.readLocal)
        assertFalse(h.sync.reads.mark(general, 10))
        // A feed row from before this phone's report doesn't move it back either.
        h.sync.applier.apply(ws, feed(room(head = 10, read = 2, unread = 8), next = "cursor2"), "cursor1")
        assertEquals(10L, h.room()!!.readLocal)
        assertEquals(listOf(general to 7L, general to 10L), h.events.reads.toList())
    }

    @Test
    fun `reading recounts the badges from the cache at once, and Mark as read reports the head`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        val reads = ReadRoute(this, h, general)
        h.sync.reads.mark(general, 5)
        // After 5: 6, 7, 9 and 10 are Olga's, 8 is the person's own; 9 mentions them.
        assertEquals(listOf(4, 1), h.room()!!.let { listOf(it.unread, it.mentions) })
        advanceTimeBy(5_000)
        h.sync.reads.markAll(general)
        assertEquals(listOf(0, 0), h.room()!!.let { listOf(it.unread, it.mentions) })
        runCurrent()
        assertEquals(10L, reads.posts.getValue(general).last().second)
    }

    @Test
    fun `a block leaves the blocked person's mentions out of the recount and keeps their posts unread`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom(
            (1L..10L).map { seq ->
                when (seq) {
                    6L -> msg(seq, actor = Ids.SAM, text = "@Me hi", mentions = listOf(mention(Ids.ME, 3)))
                    7L -> msg(seq, text = "@Me hi", mentions = listOf(mention(Ids.ME, 3)))
                    8L -> msg(seq, actor = Ids.SAM)
                    else -> msg(seq)
                }
            },
        )
        ReadRoute(this, h, general)
        h.store.tx { replaceBlocks(ws, listOf(Block(Ids.SAM, 1))) }
        h.sync.reads.mark(general, 5)
        assertEquals(listOf(5, 1), h.room()!!.let { listOf(it.unread, it.mentions) })
    }

    @Test
    fun `without the messages after the read position the server's badges stand`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom((8L..10L).map { msg(it) })
        ReadRoute(this, h, general)
        h.sync.reads.mark(general, 3)
        assertEquals(listOf(9, 2), h.room()!!.let { listOf(it.unread, it.mentions) })
        assertEquals(3L, h.room()!!.readLocal)
    }

    @Test
    fun `readLocal survives a restart and the next run reports it`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        val reads = ReadRoute(this, h, general)
        reads.fail = true
        h.sync.reads.mark(general, 6)
        runCurrent()
        assertEquals(1, reads.attempts)
        assertEquals(listOf(6L, 0L), h.room()!!.let { listOf(it.readLocal, it.readSent) })
        h.restart()
        reads.fail = false
        h.feedPages(feed(room(head = 10, read = 0, unread = 9, mentions = 2), next = "cursor2"))
        h.sync.now()
        assertEquals(listOf(6L), reads.posts.getValue(general).map { it.second })
        assertEquals(listOf(6L, 6L, 6L), h.room()!!.let { listOf(it.readLocal, it.readSent, it.read) })
        h.http.verify()
    }

    @Test
    fun `a failed report goes again at the end of a later run, within the gap`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        val reads = ReadRoute(this, h, general)
        reads.fail = true
        h.sync.reads.mark(general, 6)
        runCurrent()
        reads.fail = false
        // A run within the gap leaves the report for a timer at the end of it.
        h.feedPages(feed(next = "cursor2"))
        h.sync.now()
        assertEquals(emptyList<Pair<Long, Long>>(), reads.posts.getValue(general).toList())
        advanceTimeBy(5_001)
        assertEquals(listOf(5_000L to 6L), reads.posts.getValue(general).toList())
        assertEquals(6L, h.room()!!.readSent)
    }

    @Test
    fun `a stopped workspace keeps its read positions on the phone`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        val reads = ReadRoute(this, h, general)
        h.store.tx { updateWs(ws, mapOf("state" to "quarantined")) }
        h.sync.reads.mark(general, 5)
        advanceTimeBy(10_000)
        assertEquals(0, reads.attempts)
        assertEquals(5L, h.room()!!.readLocal)
    }

    @Test
    fun `mute and drafts outlast a restart and the feed`() = runTest {
        val h = SyncHarness(this, db).start()
        h.withRoom()
        h.store.tx {
            setRoomFields(ws, general, mapOf("muted" to true))
            putDraft(ws, general, null, Draft("main draft"))
            putDraft(ws, general, Ids.event(3), Draft("thread draft", listOf(Mention(Ids.OLGA, 0, 6))))
        }
        h.restart()
        h.feedPages(feed(room(head = 11, unread = 10, mentions = 2), next = "cursor2"))
        h.sync.now()
        assertTrue(h.room()!!.muted)
        h.store.read {
            assertEquals("main draft", getDraft(ws, general, null)!!.text)
            assertEquals(listOf(Mention(Ids.OLGA, 0, 6)), getDraft(ws, general, Ids.event(3))!!.mentions)
        }
    }
}
