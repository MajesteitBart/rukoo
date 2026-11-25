package nl.bvdm.rukoo.workspaces

import kotlinx.coroutines.delay
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Alerts for conversations this phone has never synced (contract §3.10): a DM and a group DM someone starts with me
 * and writes in, and a channel someone adds me to and mentions me in, each first heard of in a later run. In a process
 * the system started for ChatSyncWorker, through the worker's catch-up, and with the app open in Mail, through the
 * catch-up every minute. Desktop's test/chat-notify-new.test.js checks the same against the real server.
 */
class ChatNewConversationTest {
    private val db = TestDb()

    @After
    fun tearDown() = db.close()

    private val ws = Ids.WS
    private val group = Ids.id("c", 41)
    private val design = Ids.id("c", 42)

    private fun dmStarted(seq: Long, members: List<String>, room: Int) = WireEvent(
        seq = seq, id = Ids.event(seq, room), kind = "dm.started", actor = Ids.OLGA, at = 1_000L + seq, members = members,
    )

    // A workspace this phone synced before any of the new conversations existed, and the routes that answer for it.
    // The feed lists nothing new until [arrived] says the conversations came.
    private suspend fun WorkspaceServiceTest.Harness.newConversations(arrived: () -> Boolean) {
        seed("mine") {
            insertWs(
                WsRow(
                    id = ws, name = "Team", role = "member", me = Ids.ME, myName = "Me", generation = Ids.GEN, keyId = Ids.KEY,
                    cursor = "c0", passing = false, fresh = false, membersStale = false, channelsStale = false, blocksStale = false,
                ),
            )
            replaceMembers(
                ws,
                listOf(
                    Member(Ids.ME, name = "Me", role = "member", state = "active"),
                    Member(Ids.OLGA, name = "Olga", role = "member", state = "active"),
                    Member(Ids.SAM, name = "Sam", role = "member", state = "active"),
                ),
            )
        }
        list(ws)
        http.on("GET", route(ws)) { ok(WorkspaceDetails.serializer(), details()) }
        var pages = 0
        http.on("GET", route(ws, "/changes")) {
            pages += 1
            val rooms = if (!arrived()) emptyArray() else arrayOf(
                // The DM: dm.started at 1, which counts as read, and Olga's first message at 2.
                room(Ids.DM, dm = true, head = 2, read = 1, unread = 1),
                room(group, dm = true, head = 2, read = 1, unread = 1).copy(participants = listOf(Ids.ME, Ids.OLGA, Ids.SAM)),
                // The channel: I joined at 7, Olga mentioned me at 8.
                room(design, name = "design", head = 8, read = 7, unread = 1, mentions = 1),
            )
            ok(FeedPage.serializer(), feed(*rooms, next = "c$pages"))
        }
        http.on("GET", route(ws, "/conversations/${Ids.DM}/events")) {
            ok(EventPage.serializer(), EventPage(listOf(dmStarted(1, listOf(Ids.ME, Ids.OLGA), 4), msg(2, text = "Hoi, nieuw gesprek", room = 4)), head = 2, floor = 1))
        }
        http.on("GET", route(ws, "/conversations/$group/events")) {
            ok(EventPage.serializer(), EventPage(listOf(dmStarted(1, listOf(Ids.ME, Ids.OLGA, Ids.SAM), 5), msg(2, text = "Met z'n drieën", room = 5)), head = 2, floor = 1))
        }
        http.on("GET", route(ws, "/conversations/$design/events")) {
            ok(EventPage.serializer(), EventPage(listOf(joined(7, Ids.ME, 6), msg(8, text = "Me kijk je mee?", mentions = listOf(mention(bytes = 2)), room = 6)), head = 8, floor = 1))
        }
    }

    private fun WorkspaceServiceTest.Harness.expectAlerts() {
        val byRoom = sink.shown.associateBy { it.room }
        assertEquals(setOf(Ids.DM, group, design), byRoom.keys)
        assertEquals("Olga", byRoom.getValue(Ids.DM).title)
        assertEquals("Olga: Hoi, nieuw gesprek", byRoom.getValue(Ids.DM).body)
        assertEquals("Olga and Sam", byRoom.getValue(group).title)
        assertEquals("#design", byRoom.getValue(design).title)
        assertEquals("Olga: @Me kijk je mee?", byRoom.getValue(design).body)
        http.verify()
    }

    @Test
    fun `conversations this phone never saw alert their first message at the background catch-up`() = runTest {
        val h = WorkspaceServiceTest.Harness(this, db)
        var arrived = false
        h.newConversations { arrived }
        h.account.signIn("mine")
        // A process the system started for ChatSyncWorker: nothing runs until the worker's window opens.
        val s = h.start(foreground = false)
        assertTrue(s.awaitReady())
        arrived = true
        assertEquals(1, s.backgroundCatchUp(60_000))
        h.expectAlerts()

        assertEquals(1, s.backgroundCatchUp(60_000))
        assertEquals("each alerts once", 3, h.sink.shown.size)
    }

    @Test
    fun `with the app open in Mail, the minute's catch-up alerts conversations this phone never saw`() = runTest {
        val h = WorkspaceServiceTest.Harness(this, db)
        var arrived = false
        h.newConversations { arrived }
        h.account.signIn("mine")
        val s = h.start()
        h.screen.setForeground(true)
        assertTrue(s.awaitReady())
        advanceTimeBy(5_000)
        assertTrue(h.sink.shown.isEmpty())

        arrived = true
        // ChatBackground's catch-up, as every 60 s ± 10 s while the app is in the foreground.
        s.catchUp()
        withTimeout(10_000) { while (h.sink.shown.size < 3) delay(100) }
        h.expectAlerts()
        s.paused()
    }
}
