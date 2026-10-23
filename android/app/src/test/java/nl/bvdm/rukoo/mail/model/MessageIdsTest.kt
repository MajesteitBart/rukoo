package nl.bvdm.rukoo.mail.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageIdsTest {
    // Vectors from desktop: [accountId, folder, uid].map(encodeURIComponent).join(':') run in Node.
    private val vectors = listOf(
        Triple("demo", "INBOX", 12L) to "demo:INBOX:12",
        Triple("acc-1", "[Gmail]/All Mail", 5L) to "acc-1:%5BGmail%5D%2FAll%20Mail:5",
        Triple("a", "Re: ä/ö", 1L) to "a:Re%3A%20%C3%A4%2F%C3%B6:1",
        Triple("x@y", "f!'()*~ :", 3L) to "x%40y:f!'()*~%20%3A:3",
    )

    @Test
    fun encodesLikeDesktop() {
        for ((parts, id) in vectors) assertEquals(id, MessageIds.encode(parts.first, parts.second, parts.third))
    }

    @Test
    fun decodesWhatItEncodes() {
        for ((parts, id) in vectors) assertEquals(MessageKey(parts.first, parts.second, parts.third), MessageIds.decode(id))
    }

    @Test
    fun idsNeverContainAnAtSign() {
        // The agent tools treat a value with @ as a Message-ID header.
        val id = MessageIds.encode("me@example.com", "Clients/a@b", 7)
        assertFalse('@' in id)
        assertEquals(2, id.count { it == ':' })
    }

    @Test
    fun rejectsMalformedIds() {
        assertNull(MessageIds.decode("demo:INBOX"))
        assertNull(MessageIds.decode("demo:INBOX:12:3"))
        assertNull(MessageIds.decode("demo:INBOX:twelve"))
        assertNull(MessageIds.decode("demo:%E0%A4%A:12"))
        assertNull(MessageIds.decode("demo:%ZZ:12"))
        assertNull(MessageIds.decode(":INBOX:12"))
        assertNull(MessageIds.decode("saved:0b6c3c1e"))
        assertNull(MessageIds.decode("<abc@example.com>"))
    }

    @Test
    fun readsTheAccountOfAnId() {
        assertEquals("x@y", MessageIds.accountOf("x%40y:f:3"))
        assertEquals("demo", MessageIds.accountOf("demo:INBOX:12"))
        assertNull(MessageIds.accountOf("saved:abc"))
        assertTrue(MessageIds.isSaved("saved:abc"))
    }

    @Test
    fun headerKeysCompareMessageIds() {
        assertEquals("abc@example.com", MessageIds.headerKey(" <ABC@example.com> "))
        assertEquals(MessageIds.headerKey("<a@b>"), MessageIds.headerKey("a@b"))
        assertEquals("", MessageIds.headerKey(null))
    }
}
