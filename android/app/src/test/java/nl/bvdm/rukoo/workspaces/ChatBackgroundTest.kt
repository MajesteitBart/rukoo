package nl.bvdm.rukoo.workspaces

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** ChatBackground's choices: when team chat stays connected in Phone tools' window, and the network it follows. */
class ChatBackgroundTest {
    @Test
    fun `team chat stays connected only while Phone tools runs with a network`() {
        assertTrue(ChatBackground.stayConnected(phoneTools = true, online = true))
        assertFalse(ChatBackground.stayConnected(phoneTools = true, online = false))
        assertFalse(ChatBackground.stayConnected(phoneTools = false, online = true))
        assertFalse(ChatBackground.stayConnected(phoneTools = false, online = false))
    }

    @Test
    fun `a new default network before the old one's loss keeps the phone online`() {
        val net = ChatBackground.DefaultNetwork<String>()
        assertTrue(net.available("wifi"))
        assertTrue(net.available("cell"))
        assertTrue("losing the old one after the switch", net.lost("wifi"))
        assertFalse("losing the current one", net.lost("cell"))
    }

    @Test
    fun `the old network's loss before the new one comes is offline until it does`() {
        val net = ChatBackground.DefaultNetwork<String>()
        net.available("wifi")
        assertFalse(net.lost("wifi"))
        assertTrue(net.available("cell"))
        assertFalse("a loss it never saw as current", ChatBackground.DefaultNetwork<String>().lost("wifi"))
    }

    @Test
    fun `foreground runs come a minute apart, give or take ten seconds`() {
        val t = ChatTiming()
        assertEquals(50_000L, ChatBackground.catchUpDelay(t, 0.0))
        assertEquals(70_000L, ChatBackground.catchUpDelay(t, 1.0))
    }
}
