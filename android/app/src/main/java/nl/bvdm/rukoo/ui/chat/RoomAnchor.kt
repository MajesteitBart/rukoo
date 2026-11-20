package nl.bvdm.rukoo.ui.chat

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

    private var load = Load.NONE
    private var reachedOldest: Long? = null

    /** The opening's first timeline, as the pane appears: a saved position whose row it lacks waits for it. */
    fun start(keys: List<String>) {
        val s = saved ?: return
        if (!s.atBottom && s.key != null && s.key !in keys) wait(s)
    }

    /**
     * The list shows [now], with [keys] the timeline's row keys as they are: whether to save it. The saved row going
     * from the timeline while the list kept its index and offset is the cache being cut under it, not the person
     * scrolling: that position waits for its row instead.
     */
    fun onScrolled(now: TimelineScroll, keys: List<String>): Boolean {
        if (waiting != null) return false
        val s = saved
        if (s != null && !s.atBottom && s.key != null && s.key != now.key && s.key !in keys && s.index == now.index && s.offset == now.offset) {
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

    /** The person scrolled: what they chose now stands, and a position still waiting is dropped. */
    fun cancel() {
        if (waiting != null) giveUp()
    }

    // The row isn't coming back, or the person moved on: the list's position stands, and the next one it takes is saved.
    private fun giveUp() {
        done()
        saved = null
    }

    private fun wait(s: TimelineScroll) {
        waiting = s
        load = Load.NONE
        reachedOldest = null
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

    /** The room's read position is [read]: true when it moved back, which starts the reports over. */
    fun follow(read: Long): Boolean {
        val back = this.read >= 0 && read < this.read
        this.read = read
        if (back) reported = 0L
        return back
    }

    /** The newest message fully in view is [seq] while the room's read position is [read]: the seq to report, or null. */
    fun next(seq: Long, read: Long): Long? {
        follow(read)
        if (seq <= reported || seq <= read) return null
        reported = seq
        return seq
    }
}
