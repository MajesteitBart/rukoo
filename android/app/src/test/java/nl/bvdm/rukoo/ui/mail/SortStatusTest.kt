package nl.bvdm.rukoo.ui.mail

import nl.bvdm.rukoo.categories.SortActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** What the drawer's sorting line says, and when it says nothing (desktop's sort-activity.js status()). */
class SortStatusTest {
    private val now = 100_000L

    @Test
    fun `a sort someone asked for shows at once, and Sorted for a few seconds after`() {
        val running = SortActivity(running = true, user = true, total = 10, done = 4, startedAt = now)
        assertEquals(SortStatus.SORTING, sortStatus(running, enabled = true, now = now))
        val done = running.copy(running = false, finishedAt = now)
        assertEquals(SortStatus.DONE, sortStatus(done, enabled = true, now = now + 5_000))
        assertNull(sortStatus(done, enabled = true, now = now + 7_000))
        assertNull("categories off say nothing", sortStatus(running, enabled = false, now = now))
    }

    @Test
    fun `a sort of new mail shows only once it takes a while, and never says Sorted`() {
        val quiet = SortActivity(running = true, user = false, total = 2, startedAt = now)
        assertNull(sortStatus(quiet, enabled = true, now = now + 500))
        assertEquals(SortStatus.SORTING, sortStatus(quiet, enabled = true, now = now + 2_000))
        assertNull(sortStatus(quiet.copy(running = false, finishedAt = now + 600), enabled = true, now = now + 700))
    }

    @Test
    fun `a refused key always shows, a busy TypeSafe while mail waits`() {
        assertEquals(SortStatus.KEY, sortStatus(SortActivity(jev = true, error = "key"), enabled = true, now = now))
        assertEquals(SortStatus.WAITING, sortStatus(SortActivity(jev = true, error = "busy", waiting = 3), enabled = true, now = now))
        assertNull(sortStatus(SortActivity(jev = true, error = "busy", waiting = 0), enabled = true, now = now))
    }
}
