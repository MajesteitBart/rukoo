package nl.bvdm.rukoo.ui.chat

import java.time.ZoneId
import nl.bvdm.rukoo.ui.chat.ChatTimeline.Message
import nl.bvdm.rukoo.ui.root.RoomOpening
import nl.bvdm.rukoo.workspaces.Event
import nl.bvdm.rukoo.workspaces.Pending
import nl.bvdm.rukoo.workspaces.PendingState
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind
import nl.bvdm.rukoo.workspaces.RoomTimeline
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A room opened from a notification (contract §3.7 "Opening at a seq"): which row it shows, and when the timeline on
 * screen holds what the open loaded.
 */
class RoomOpeningTest {
    private val me = "u_" + "me".padEnd(22, 'x')
    private val zoe = "u_" + "zoe".padEnd(22, 'x')
    private val utc = ZoneId.of("UTC")

    private fun msg(seq: Long, redacted: Boolean = false) =
        Event(seq, "e_$seq", "message.posted", zoe, 1_760_000_000_000 + seq * 60_000, null, if (redacted) null else "m$seq", emptyList(), redacted)

    private fun events(range: LongRange) = range.map { msg(it) }

    /** The rows RoomPane draws, bottom up as its list holds them. */
    private fun items(events: List<Event>, pending: List<Pending> = emptyList(), hasOlder: Boolean = true) =
        ChatTimeline.rows(events, pending, me, readAtOpen = events.maxOfOrNull { it.seq }, hasOlder = hasOlder, zone = utc).asReversed()

    private fun seqAt(items: List<ChatTimeline.Row>, index: Int?) = (items[index!!] as Message).seq

    @Test
    fun `the timeline on screen holds the open's pages once it reaches as far back`() {
        // The open loaded back to seq 61; a build from before its last page starts at 111.
        assertFalse(ChatTimeline.holds(events(111L..160L), 61))
        assertFalse("the empty cache before the first page", ChatTimeline.holds(emptyList(), 61))
        assertTrue(ChatTimeline.holds(events(61L..160L), 61))
        assertTrue("the room's range only grows while it is open", ChatTimeline.holds(events(20L..160L), 61))
        // Nothing was cached after the open (it failed, or the room is empty): nothing to wait for.
        assertTrue(ChatTimeline.holds(emptyList(), null))
    }

    @Test
    fun `it shows the oldest message at or after the seq`() {
        val items = items(events(61L..160L))
        assertEquals(100L, seqAt(items, ChatTimeline.openingTarget(items, 100, complete = true)))
        // The alerted message was removed since: its row still marks the place.
        val removed = items(events(61L..99L) + msg(100, redacted = true) + events(101L..160L))
        assertEquals(100L, seqAt(removed, ChatTimeline.openingTarget(removed, 100, complete = true)))
        // A seq without a message row of its own (a system event) shows the next message.
        val gap = items(events(61L..99L) + events(101L..160L))
        assertEquals(101L, seqAt(gap, ChatTimeline.openingTarget(gap, 100, complete = true)))
    }

    @Test
    fun `a backfill that stopped short shows the oldest loaded message, a failed open the newest`() {
        // Ten pages didn't reach seq 5: the oldest loaded message, with complete false.
        val short = items(events(1_006L..2_060L))
        assertEquals(1_006L, seqAt(short, ChatTimeline.openingTarget(short, 5, complete = false)))
        // Offline right after the alert: every cached message is older than the seq. Up to 2,000 of them, so the
        // oldest is the wrong place; the timeline stays at the newest.
        val stale = items(events(1L..80L))
        assertNull(ChatTimeline.openingTarget(stale, 120, complete = true))
        // Only the intro row: nothing to show.
        val empty = items(emptyList(), hasOlder = false)
        assertNull(ChatTimeline.openingTarget(empty, 3, complete = true))
        assertNull(ChatTimeline.openingTarget(empty, 3, complete = false))
    }

    @Test
    fun `a send on its way is never the place`() {
        val waiting = Pending("l1", "w_1", "c_1", null, "on its way", emptyList(), PendingState.QUEUED, null, nextAt = 0, createdAt = 1_760_000_000_000 + 999 * 60_000)
        val items = items(events(10L..20L), listOf(waiting))
        assertEquals(10L, seqAt(items, ChatTimeline.openingTarget(items, 50, complete = false)))
        assertNull(ChatTimeline.openingTarget(items, 50, complete = true))
    }

    @Test
    fun `the opening carries how far back the open loaded and whether it got there`() {
        val room = Room(
            id = "c_1", kind = RoomKind.CHANNEL, name = "plans", visibility = "workspace", archived = false, closedReason = null,
            participants = null, startedBy = null, role = "member", members = 2, head = 160, floor = 1, lastAt = null, read = 50,
            unread = 0, mentions = 0, attention = 0, muted = false, hasCache = true,
        )
        val opening = RoomOpening("w_1", "c_1", count = 3, at = 70, reached = false)
        val loaded = RoomTimeline(room, events(61L..160L).shuffled(), emptyList(), emptyMap(), readAtOpen = 50, hasOlder = true, complete = false, loading = false, draft = null)
        assertEquals(opening.copy(reached = true, oldest = 61, complete = false), opening.reachedWith(loaded))
        assertEquals(opening.copy(reached = true, oldest = null, complete = true), opening.reachedWith(null))
        assertEquals(opening.copy(reached = true, oldest = null, complete = true), opening.reachedWith(loaded.copy(events = emptyList(), complete = true)))
    }
}
