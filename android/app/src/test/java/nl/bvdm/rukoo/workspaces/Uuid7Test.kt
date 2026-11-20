package nl.bvdm.rukoo.workspaces

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Operation IDs with the layout of contract §3.8, on the shared vectors. */
class Uuid7Test {
    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun `every vector gives its ID`() {
        val cases = ChatVectors.all.uuidv7
        assertTrue("at least 3 UUID cases", cases.size >= 3)
        for (c in cases) {
            assertEquals(c.name, c.id, Uuid7.format(c.ms, hex(c.random)))
            assertTrue(c.name, Uuid7.isValid(c.id))
            assertEquals(c.name, c.ms, Uuid7.timeOf(c.id))
        }
    }

    @Test
    fun `next writes the time, the version and the variant, in lowercase`() {
        val ms = 1_763_550_000_000L
        val id = Uuid7.next(ms)
        assertTrue(id, Uuid7.isValid(id))
        assertEquals(ms, Uuid7.timeOf(id))
        assertEquals(id.lowercase(), id)
        assertNotEquals(id, Uuid7.next(ms))
    }

    @Test
    fun `a time outside 48 bits is refused`() {
        for (ms in listOf(-1L, Uuid7.MAX_MS + 1)) {
            try {
                Uuid7.next(ms)
                fail("$ms should be refused")
            } catch (_: IllegalArgumentException) {
            }
        }
    }
}
