package nl.bvdm.rukoo.workspaces

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** ChatBackground's choices: when Phone tools' window opens, and the default network it follows. */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatBackgroundTest {
    private fun network() = ChatBackground.DefaultNetwork<String>()

    @Test
    fun `nothing is usable until the callback reports a default network with internet`() {
        val net = network()
        assertFalse("before any callback", net.usable.value)
        net.available("wifi")
        assertFalse("onAvailable alone waits for the capabilities", net.usable.value)
        net.capabilities("wifi", ok = false)
        assertFalse("no internet, or suspended", net.usable.value)
        net.capabilities("wifi", ok = true)
        assertTrue(net.usable.value)
    }

    @Test
    fun `a network that can't be watched is never usable`() {
        val net = network()
        net.available("wifi")
        net.capabilities("wifi", ok = true)
        net.unwatched()
        assertFalse(net.usable.value)
        net.available("cell")
        net.capabilities("cell", ok = true)
        assertFalse("nothing after that changes it", net.usable.value)
    }

    @Test
    fun `a blocked default network isn't usable until Android unblocks it`() {
        val net = network()
        net.available("wifi")
        net.capabilities("wifi", ok = true)
        assertFalse(net.blocked("wifi", blocked = true))
        assertFalse(net.usable.value)
        assertFalse("unblocking the same network is no handoff", net.blocked("wifi", blocked = false))
        assertTrue(net.usable.value)
    }

    @Test
    fun `a move from one usable network to another is a handoff, and the old one's loss is ignored`() {
        val net = network()
        net.available("wifi")
        assertFalse(net.capabilities("wifi", ok = true))
        net.available("cell")
        assertTrue("still usable while the new one's capabilities come", net.usable.value)
        assertTrue("the new default confirmed: a handoff", net.capabilities("cell", ok = true))
        assertFalse(net.blocked("cell", blocked = false))
        net.lost("wifi")
        assertTrue(net.usable.value)
        assertFalse("the same network's new capabilities are no handoff", net.capabilities("cell", ok = true))
        net.lost("cell")
        assertFalse("losing the current one", net.usable.value)
    }

    @Test
    fun `a network after a gap opens the window again instead of counting as a handoff`() {
        val net = network()
        net.available("wifi")
        net.capabilities("wifi", ok = true)
        net.lost("wifi")
        assertFalse(net.usable.value)
        net.available("cell")
        assertFalse(net.capabilities("cell", ok = true))
        assertTrue(net.usable.value)
    }

    @Test
    fun `the window opens once Phone tools and the network have held for the settle time, and closes at once`() = runTest {
        val tools = MutableStateFlow(true)
        val usable = MutableStateFlow(false)
        val seen = CopyOnWriteArrayList<Boolean>()
        backgroundScope.launch { ChatBackground.windowWanted(tools, usable, 5_000).collect { seen += it } }
        runCurrent()
        assertEquals(listOf(false), seen.toList())

        usable.value = true
        advanceTimeBy(4_900)
        assertEquals("not before the network settled", listOf(false), seen.toList())
        advanceTimeBy(200)
        assertEquals(listOf(false, true), seen.toList())

        usable.value = false
        runCurrent()
        assertEquals("closes at once", listOf(false, true, false), seen.toList())

        // A network that comes and goes within the settle time doesn't open it.
        repeat(10) {
            usable.value = true
            advanceTimeBy(1_000)
            usable.value = false
            advanceTimeBy(1_000)
        }
        assertEquals(listOf(false, true, false), seen.toList())

        usable.value = true
        advanceTimeBy(5_100)
        tools.value = false
        runCurrent()
        assertEquals("Phone tools stopping closes it", listOf(false, true, false, true, false), seen.toList())
    }

    @Test
    fun `foreground runs come a minute apart, give or take ten seconds`() {
        val t = ChatTiming()
        assertEquals(50_000L, ChatBackground.catchUpDelay(t, 0.0))
        assertEquals(70_000L, ChatBackground.catchUpDelay(t, 1.0))
    }
}
