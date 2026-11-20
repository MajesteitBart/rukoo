package nl.bvdm.rukoo.ui.chat

import java.time.ZoneId
import nl.bvdm.rukoo.workspaces.Event
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A room's saved scroll position across folding and the background (android.md "Folding"), when the loader cut the
 * cached range above the row it showed; and the read reports of an opening whose read position a restore moved back.
 */
class RoomAnchorTest {
    private val zoe = "u_" + "zoe".padEnd(22, 'x')
    private val utc = ZoneId.of("UTC")

    private fun msg(seq: Long) = Event(seq, "e_$seq", "message.posted", zoe, 1_760_000_000_000 + seq * 60_000, null, "m$seq", emptyList(), false)

    private fun events(range: LongRange) = range.map { msg(it) }

    /** The row keys RoomPane's list holds, bottom up. */
    private fun keys(events: List<Event>) = items(events).map { it.key }

    private fun items(events: List<Event>) = ChatTimeline.rows(events, emptyList(), null, hasOlder = true, zone = utc).asReversed()

    @Test
    fun `a folded room whose saved row the cache lost loads back to it and only then scrolls there`() {
        // Saved in the opening: message 2, 10 px into it. Folding cut the cache to 4..6.
        val saved = TimelineScroll(opening = 1, key = "e_2", index = 5, offset = 10, seq = 2)
        val anchor = ScrollAnchor(saved)
        val trimmed = events(4L..6L)
        anchor.start(keys(trimmed))
        assertEquals(saved, anchor.waiting)

        assertEquals(ScrollAnchor.Step.Reach(2), anchor.onTimeline(keys(trimmed), trimmed, loading = true))
        // The reopen ended before the load back did: the position isn't given up.
        assertEquals(ScrollAnchor.Step.Wait, anchor.onTimeline(keys(trimmed), trimmed, loading = false))
        // The list showed another row at the saved index meanwhile: that isn't saved over the anchor.
        assertFalse(anchor.onScrolled(TimelineScroll(1, "e_4", 5, 10, 4), keys(trimmed), scrolling = false))

        anchor.reached(oldest = 1)
        assertEquals("the timeline is a build behind the load", ScrollAnchor.Step.Wait, anchor.onTimeline(keys(trimmed), trimmed, loading = false))
        val loaded = events(1L..6L)
        val back = keys(loaded)
        assertEquals(ScrollAnchor.Step.ScrollTo(back.indexOf("e_2"), 10), anchor.onTimeline(back, loaded, loading = false))
        assertNull(anchor.waiting)
        assertTrue("from then on the list's position is saved", anchor.onScrolled(TimelineScroll(1, "e_2", back.indexOf("e_2"), 10, 2), back, scrolling = false))
    }

    @Test
    fun `a row the cache lost under a list that stayed composed waits for its load too`() {
        val anchor = ScrollAnchor(null)
        val all = events(1L..6L)
        val before = keys(all)
        val shown = TimelineScroll(1, "e_2", before.indexOf("e_2"), 10, 2)
        assertTrue(anchor.onScrolled(shown, before, scrolling = true))
        // The app went to the background: the loader dropped the range, and the shorter list clamped its index.
        val trimmed = events(4L..6L)
        val after = keys(trimmed)
        assertFalse(anchor.onScrolled(TimelineScroll(1, after.last(), after.lastIndex, 0, 4), after, scrolling = false))
        assertEquals(shown, anchor.waiting)
        assertEquals(ScrollAnchor.Step.Reach(2), anchor.onTimeline(after, trimmed, loading = false))
    }

    @Test
    fun `the person's own scroll is saved even when the row it left went`() {
        val anchor = ScrollAnchor(TimelineScroll(1, "e_2", 5, 10, 2))
        val trimmed = events(4L..6L)
        anchor.start(keys(events(1L..6L)))
        assertNull(anchor.waiting)
        assertTrue(anchor.onScrolled(TimelineScroll(1, "e_5", 1, 0, 5), keys(trimmed), scrolling = true))
    }

    @Test
    fun `a row gone for good leaves the list where it is once the load back ended`() {
        val anchor = ScrollAnchor(TimelineScroll(1, "e_2", 5, 10, 2))
        // Retention took 1..3 meanwhile.
        val left = events(4L..6L)
        anchor.start(keys(left))
        assertEquals(ScrollAnchor.Step.Reach(2), anchor.onTimeline(keys(left), left, loading = false))
        anchor.reached(oldest = 4)
        assertEquals(ScrollAnchor.Step.None, anchor.onTimeline(keys(left), left, loading = false))
        assertNull(anchor.waiting)
        assertTrue(anchor.onScrolled(TimelineScroll(1, "e_4", 5, 10, 4), keys(left), scrolling = false))
    }

    @Test
    fun `scrolling while the row loads drops the wait`() {
        val anchor = ScrollAnchor(TimelineScroll(1, "e_2", 5, 10, 2))
        val trimmed = events(4L..6L)
        anchor.start(keys(trimmed))
        anchor.onTimeline(keys(trimmed), trimmed, loading = false)
        anchor.cancel()
        assertNull(anchor.waiting)
        anchor.reached(oldest = 1)
        val loaded = events(1L..6L)
        assertEquals("the late load doesn't pull the list back", ScrollAnchor.Step.None, anchor.onTimeline(keys(loaded), loaded, loading = false))
    }

    @Test
    fun `a saved row's seq is the nearest row at or above it that has one`() {
        // Bottom up: e_3, e_2, the New divider, e_1, the day divider.
        val list = ChatTimeline.rows(events(1L..3L), emptyList(), null, readAtOpen = 1, hasOlder = true, zone = utc).asReversed()
        assertEquals(listOf("e_3", "e_2", "new", "e_1"), list.take(4).map { it.key })
        assertEquals("the New divider loads with the message above it", 1L, TimelineScroll.seqNear(list, list.indexOfFirst { it.key == "new" }))
        assertEquals("nothing above the day divider: the message below it", 1L, TimelineScroll.seqNear(list, list.indexOfFirst { it is ChatTimeline.Day }))
        assertEquals(3L, TimelineScroll.seqNear(list, 0))
        assertNull(TimelineScroll.seqNear(emptyList(), 0))
    }

    @Test
    fun `a read position a restore moved back starts the opening's read reports over`() {
        val reports = ReadReports()
        reports.follow(5)
        assertEquals(10L, reports.next(10, 5))
        assertNull("nothing new above the last report", reports.next(8, 5))
        // The pass that installed the restore took read position 5 from the restored feed: 10 was the old generation.
        assertTrue(reports.follow(0))
        reports.follow(5)
        assertEquals("message 7 of the restored room is reported", 7L, reports.next(7, 5))
        assertNull(reports.next(5, 5))
    }

    @Test
    fun `a position waiting for its row counts nothing the list shows meanwhile as seen or read`() {
        // Scrolled back to message 50 with 97 read; the background cut the cache to 400..474 and the shorter list
        // clamped its index onto the newest page.
        val anchor = ScrollAnchor(null)
        val reports = ReadReports()
        reports.follow(97)
        val all = events(1L..474L)
        val before = keys(all)
        assertTrue(anchor.onScrolled(TimelineScroll(1, "e_50", before.indexOf("e_50"), 0, 50), before, scrolling = true))
        assertFalse(anchor.holding)
        val trimmed = events(400L..474L)
        val after = keys(trimmed)
        assertFalse(anchor.onScrolled(TimelineScroll(1, after.last(), after.lastIndex, 0, 400), after, scrolling = false))
        assertTrue(anchor.holding)

        // Message 437 is fully in view on the clamped page while the load back runs: no seen, no report.
        assertEquals(97L, RoomReading.seen(97, 437, anchor))
        assertEquals(ScrollAnchor.Step.Reach(50), anchor.onTimeline(after, trimmed, loading = false))
        assertEquals(97L, RoomReading.seen(97, 437, anchor))
        assertNull(RoomReading.report(437, 97, anchor, reports))
        assertEquals("nothing went out", 0L, reports.reported)

        anchor.reached(oldest = 1)
        val step = anchor.onTimeline(before, all, loading = false)
        assertEquals(ScrollAnchor.Step.ScrollTo(before.indexOf("e_50"), 0), step)
        assertTrue("until the list scrolled to the row, it still shows the clamped page", anchor.holding)
        assertNull(RoomReading.report(437, 97, anchor, reports))

        anchor.scrolled()
        assertFalse(anchor.holding)
        // Back at message 50, above the read position: nothing new is seen, nothing reported.
        assertEquals(97L, RoomReading.seen(97, 50, anchor))
        assertNull(RoomReading.report(50, 97, anchor, reports))
        // The person scrolls down to 120 themselves.
        assertEquals(120L, RoomReading.seen(97, 120, anchor))
        assertEquals(120L, RoomReading.report(120, 97, anchor, reports))
    }

    @Test
    fun `the holding flag is Compose state, so the reading effect restarts when it changes`() {
        val anchor = ScrollAnchor(TimelineScroll(1, "e_2", 5, 10, 2))
        val reads = mutableListOf<Any>()
        androidx.compose.runtime.snapshots.Snapshot.observe(readObserver = { reads += it }) { anchor.holding }
        assertTrue("reading holding is a state read", reads.isNotEmpty())
        anchor.start(keys(events(4L..6L)))
        assertTrue(anchor.holding)
        anchor.cancel()
        assertFalse("the person's own scroll ends the hold", anchor.holding)
    }

    @Test
    fun `a row gone for good ends the hold once the load back ended`() {
        val anchor = ScrollAnchor(TimelineScroll(1, "e_2", 5, 10, 2))
        val left = events(4L..6L)
        anchor.start(keys(left))
        anchor.onTimeline(keys(left), left, loading = false)
        anchor.reached(oldest = 4)
        assertTrue(anchor.holding)
        assertEquals(ScrollAnchor.Step.None, anchor.onTimeline(keys(left), left, loading = false))
        assertFalse(anchor.holding)
    }

    @Test
    fun `a read position captured before an ack raised it doesn't start the reports over`() {
        val reports = ReadReports()
        reports.follow(5)
        assertEquals(10L, reports.next(10, 5))
        // The ack raised the read position to 10; the pane's effect followed it.
        assertFalse(reports.follow(10))
        // A reading step that still holds read 5 asks about 8: already reported, so nothing goes out again.
        assertNull(reports.next(8, 5))
        assertEquals(10L, reports.reported)
    }

    @Test
    fun `read positions that only go up keep what was reported`() {
        val reports = ReadReports()
        assertFalse(reports.follow(5))
        assertEquals(10L, reports.next(10, 5))
        assertFalse(reports.follow(10))
        assertNull(reports.next(9, 10))
        assertEquals(12L, reports.next(12, 10))
    }
}
