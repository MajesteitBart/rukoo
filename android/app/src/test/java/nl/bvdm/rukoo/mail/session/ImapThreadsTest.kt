package nl.bvdm.rukoo.mail.session

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** IMAP commands run where a recursive BODYSTRUCTURE parse of a crafted message still has room. */
class ImapThreadsTest {
    private fun depth(n: Int): Int = if (n == 0) 0 else 1 + depth(n - 1)

    @Test
    fun recursionThatOverflowsASmallStackFitsOnTheImapThreads() {
        // The same recursion overflows a 256 KB stack, about what an ordinary thread gets on a phone.
        var overflowed = false
        val small = Thread(null, { try { depth(DEEP) } catch (_: StackOverflowError) { overflowed = true } }, "small", 256 * 1024)
        small.start()
        small.join()
        assertTrue(overflowed)

        val result = runBlocking { withContext(ImapThreads.dispatcher) { depth(DEEP) } }
        assertEquals(DEEP, result)
    }

    private companion object {
        const val DEEP = 100_000
    }
}
