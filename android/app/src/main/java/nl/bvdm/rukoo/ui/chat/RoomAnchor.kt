package nl.bvdm.rukoo.ui.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import nl.bvdm.rukoo.workspaces.Event

/**
 * Keeps a room's saved scroll position while the row it showed is missing from the timeline. The service's loader cuts
 * the room's cached range back to `ROOM_CACHE_MAX` when the room leaves the screen (folded behind the list, the app in
 * the background), and opening it again loads only the newest events, so a row older than that comes back only with a
 * load back to its seq ([Step.Reach]). Until that load ended and the timeline holds what it loaded, the saved position
 * isn't replaced by the row that took its place; then the row comes back where it was ([Step.ScrollTo]), or, when it is
 * gone for good, the position stands as the list shows it.
 *
 * RoomPane keeps one per opening, starting from the position the view model kept ([start]), and tells it each position
 * the list takes ([onScrolled]) and each timeline it shows ([onTimeline]).
 */
internal class ScrollAnchor(private var saved: TimelineScroll?) {
    sealed interface Step {
        /** Nothing waits. */
        data object None : Step

        /** The row isn't back yet: keep the position unsaved. */
        data object Wait : Step

        /** Load the room back to [seq]; call [reached] when that load ended. */
        data class Reach(val seq: Long) : Step

        /** The row is back at [index]: scroll there with [offset]. */
        data class ScrollTo(val index: Int, val offset: Int) : Step
    }

    private enum class Load { NONE, RUNNING, DONE }

    /** The saved position waiting for its row, or null. While one waits, nothing is saved. */
    var waiting: TimelineScroll? = null
        private set

    /**
     * Whether the list shows rows the person didn't choose: from the moment a saved position starts waiting until its
     * row is back on screen ([scrolled]) or the wait ends without it. Meanwhile the list sits at a clamped index on the
     * newest page, and nothing it shows counts as seen or read ([RoomReading]). Compose state, so the reading effect
     * restarts when it changes.
     */
    var holding by mutableStateOf(false)
        private set

    private var load = Load.NONE
    private var reachedOldest: Long? = null

    /** The opening's first timeline, as the pane appears: a saved position whose row it lacks waits for it. */
    fun start(keys: List<String>) {
        val s = saved ?: return
        if (!s.atBottom && s.key != null && s.key !in keys) wait(s)
    }

    /**
     * The list shows [now], with [keys] the timeline's row keys as they are, [scrolling] while a scroll moves it:
     * whether to save it. The saved row going from the timeline while nothing scrolled is the cache being cut under the
     * list, which then shows another row at the same or a clamped index: that position waits for its row instead.
     */
    fun onScrolled(now: TimelineScroll, keys: List<String>, scrolling: Boolean): Boolean {
        if (waiting != null) return false
        val s = saved
        if (!scrolling && s != null && !s.atBottom && s.key != null && s.key != now.key && s.key !in keys) {
            wait(s)
            return false
        }
        saved = now
        return true
    }

    /** What to do now that the timeline holds [keys] (bottom up) built from [events]; [loading] while a load runs. */
    fun onTimeline(keys: List<String>, events: List<Event>, loading: Boolean): Step {
        val w = waiting ?: return Step.None
        val i = w.key?.let { keys.indexOf(it) } ?: -1
        if (i >= 0) {
            done()
            saved = w
            return Step.ScrollTo(i, w.offset)
        }
        return when (load) {
            Load.NONE -> {
                val seq = w.seq
                if (seq == null) {
                    giveUp()
                    Step.None
                } else {
                    load = Load.RUNNING
                    Step.Reach(seq)
                }
            }
            Load.RUNNING -> Step.Wait
            Load.DONE -> if (!loading && ChatTimeline.holds(events, reachedOldest)) {
                giveUp()
                Step.None
            } else {
                Step.Wait
            }
        }
    }

    /** The load back to the row's seq ended; [oldest] is the oldest cached seq right after it (null when unknown). */
    fun reached(oldest: Long?) {
        if (load != Load.RUNNING) return
        load = Load.DONE
        reachedOldest = oldest
    }

    /** The list scrolled to the row a [Step.ScrollTo] named: what it shows from now on is the person's. */
    fun scrolled() {
        if (waiting == null) holding = false
    }

    /** The person scrolled: what they chose now stands, and a position still waiting is dropped. */
    fun cancel() {
        if (waiting != null) giveUp()
        holding = false
    }

    // The row isn't coming back, or the person moved on: the list's position stands, and the next one it takes is saved.
    private fun giveUp() {
        done()
        saved = null
        holding = false
    }

    private fun wait(s: TimelineScroll) {
        waiting = s
        load = Load.NONE
        reachedOldest = null
        holding = true
    }

    private fun done() {
        waiting = null
        load = Load.NONE
        reachedOldest = null
    }
}

/**
 * The highest seq a room's timeline reported read in this opening (§3.9), so it reports only a higher one. A read
 * position that moves back starts it over: the pass that installed a restore took read positions from the restored
 * feed (§3.6 "Restore"), and seqs the old generation reported say nothing of the new one's.
 */
internal class ReadReports {
    /** The highest seq reported since the read position last moved back. */
    var reported = 0L
        private set

    private var read = -1L

    /**
     * The room's read position is [read]: true when it moved back, which starts the reports over. Only the pane's
     * effect on the read position calls this, so a read that a longer-lived caller captured earlier isn't taken for a
     * move back.
     */
    fun follow(read: Long): Boolean {
        val back = this.read >= 0 && read < this.read
        this.read = read
        if (back) reported = 0L
        return back
    }

    /** The newest message fully in view is [seq] while the room's read position is [read]: the seq to report, or null. */
    fun next(seq: Long, read: Long): Long? {
        if (seq <= reported || seq <= read) return null
        reported = seq
        return seq
    }
}

/**
 * The reading effect's two steps for [seq], the newest message fully in view (§3.9). While [ScrollAnchor.holding], the
 * list shows rows at a clamped index that the person didn't scroll to: they count neither as seen for the Latest pill
 * nor as read.
 */
internal object RoomReading {
    /** The opening's newest seen seq once [seq] is in view. */
    fun seen(seen: Long, seq: Long, anchor: ScrollAnchor): Long = if (anchor.holding || seq <= seen) seen else seq

    /** After the report delay: the seq to report for a room whose read position is [read], or null. */
    fun report(seq: Long, read: Long, anchor: ScrollAnchor, reports: ReadReports): Long? =
        if (anchor.holding) null else reports.next(seq, read)
}
