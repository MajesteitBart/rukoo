package nl.bvdm.rukoo.core

import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class IdsTest {
    @Test
    fun conversationIdsHaveDesktopsShape() {
        val id = Ids.conversationId { 1761130000000 }
        // (1761130000000).toString(36) in Node.
        assertTrue(id, Regex("^c_mh1vbwxs_[a-z0-9]{6}$").matches(id))
    }

    @Test
    fun itemAndTurnIds() {
        assertTrue(Regex("^i_[a-z0-9]{10}$").matches(Ids.itemId()))
        assertTrue(Regex("^t_[a-z0-9]{10}$").matches(Ids.turnId()))
        assertEquals(1000, List(1000) { Ids.itemId() }.toSet().size)
    }

    @Test
    fun uuidsAndTokens() {
        UUID.fromString(Ids.uuid())
        val token = Ids.token()
        assertEquals(43, token.length)
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(token))
    }

    @Test
    fun uriComponentMatchesJavaScript() {
        assertEquals("Re%3A%20%C3%A4%2F%C3%B6", UriComponent.encode("Re: ä/ö"))
        assertEquals("!'()*~-_.", UriComponent.encode("!'()*~-_."))
        assertEquals("%F0%9F%98%80", UriComponent.encode("😀"))
        assertEquals("Re: ä/ö", UriComponent.decode("Re%3A%20%C3%A4%2F%C3%B6"))
        assertEquals("a+b", UriComponent.decode("a+b"))
        assertEquals(null, UriComponent.decode("%"))
        assertEquals(null, UriComponent.decode("%C3"))
    }
}
