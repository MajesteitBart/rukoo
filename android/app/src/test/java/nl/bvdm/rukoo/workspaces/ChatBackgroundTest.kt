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

    private val ChatBackground.DefaultNetwork<String>.usable: Boolean get() = state.value.usable

    @Test
    fun `nothing is usable until the callback reports a default network with internet, unblocked`() {
        val net = network()
        assertFalse("before any callback", net.usable)
        net.available("wifi")
        assertFalse("onAvailable alone waits for the capabilities", net.usable)
        assertTrue(net.state.value.pending)
        net.capabilities("wifi", ok = false)
        assertFalse("no internet, or suspended", net.usable)
        net.capabilities("wifi", ok = true)
        assertFalse("and waits for the blocked status", net.usable)
        net.blocked("wifi", blocked = false)
        assertTrue(net.usable)
        assertFalse(net.state.value.pending)
    }

    @Test
    fun `a network that can't be watched is never usable`() {
        val net = network()
        net.usableOn("wifi")
        net.unwatched()
        assertFalse(net.usable)
        net.usableOn("cell")
        assertFalse("nothing after that changes it", net.usable)
    }

    @Test
    fun `a blocked default network isn't usable until Android unblocks it`() {
        val net = network()
        net.available("wifi")
        net.capabilities("wifi", ok = true)
        assertFalse(net.blocked("wifi", blocked = true))
        assertFalse(net.usable)
        assertFalse("unblocking the same network is no handoff", net.blocked("wifi", blocked = false))
        assertTrue(net.usable)
    }

    @Test
    fun `a move from one usable network to another is a handoff once the new one reported both, and the old one's loss is ignored`() {
        val net = network()
        net.usableOn("wifi")
        net.available("cell")
        assertFalse("not usable on the old network's word", net.usable)
        assertFalse("its capabilities alone are no handoff", net.capabilities("cell", ok = true))
        assertTrue("the new default confirmed: a handoff", net.blocked("cell", blocked = false))
        assertEquals("a handoff is no loss", 0, net.state.value.losses)
        net.lost("wifi")
        assertTrue(net.usable)
        assertFalse("the same network's new capabilities are no handoff", net.capabilities("cell", ok = true))
        net.lost("cell")
        assertFalse("losing the current one", net.usable)
        assertEquals(1, net.state.value.losses)
    }

    @Test
    fun `a network after a gap opens the window again instead of counting as a handoff`() {
        val net = network()
        net.usableOn("wifi")
        net.lost("wifi")
        assertFalse(net.usable)
        net.available("cell")
        assertFalse(net.capabilities("cell", ok = true))
        assertFalse(net.blocked("cell", blocked = false))
        assertTrue(net.usable)
    }

    @Test
    fun `the window opens once Phone tools and the network have held for the settle time, and closes at once`() = runTest {
        val tools = MutableStateFlow(true)
        val net = network()
        val seen = CopyOnWriteArrayList<Boolean>()
        backgroundScope.launch { ChatBackground.windowWanted(tools, net.state, 5_000).collect { seen += it } }
        runCurrent()
        assertEquals(listOf(false), seen.toList())

        net.usableOn("wifi")
        advanceTimeBy(4_900)
        assertEquals("not before the network settled", listOf(false), seen.toList())
        advanceTimeBy(200)
        assertEquals(listOf(false, true), seen.toList())

        net.lost("wifi")
        runCurrent()
        assertEquals("closes at once", listOf(false, true, false), seen.toList())

        // A network that comes and goes within the settle time doesn't open it.
        repeat(10) {
            net.usableOn("wifi")
            advanceTimeBy(1_000)
            net.lost("wifi")
            advanceTimeBy(1_000)
        }
        assertEquals(listOf(false, true, false), seen.toList())

        net.usableOn("wifi")
        advanceTimeBy(5_100)
        tools.value = false
        runCurrent()
        assertEquals("Phone tools stopping closes it", listOf(false, true, false, true, false), seen.toList())
    }

    private fun ChatBackground.DefaultNetwork<String>.usableOn(network: String) {
        available(network)
        capabilities(network, ok = true)
        blocked(network, blocked = false)
    }

    @Test
    fun `a new default that has only said onAvailable isn't usable on the old network's word`() {
        val net = network()
        net.usableOn("wifi")
        assertTrue(net.usable)
        net.available("cell")
        assertFalse("nothing is known about the new default yet", net.usable)
        assertTrue(net.state.value.pending)
    }

    @Test
    fun `a blocked new default is no handoff and isn't usable`() {
        val net = network()
        net.usableOn("wifi")
        net.available("cell")
        assertFalse("its capabilities alone are no handoff", net.capabilities("cell", ok = true))
        assertFalse("nor do they make it usable", net.usable)
        assertFalse("blocked: no handoff", net.blocked("cell", blocked = true))
        assertFalse(net.usable)
    }

    @Test
    fun `a loss and recovery the collector never saw still closes the window and waits the settle time again`() = runTest {
        val net = network()
        val seen = CopyOnWriteArrayList<Boolean>()
        backgroundScope.launch { ChatBackground.windowWanted(MutableStateFlow(true), net.state, 5_000).collect { seen += it } }
        runCurrent()
        net.usableOn("wifi")
        advanceTimeBy(5_100)
        assertEquals(listOf(false, true), seen.toList())

        // Lost and back before the collector runs: the flow keeps only the last value.
        net.lost("wifi")
        net.usableOn("wifi")
        runCurrent()
        assertEquals("the loss closes it", listOf(false, true, false), seen.toList())
        advanceTimeBy(4_900)
        assertEquals(listOf(false, true, false), seen.toList())
        advanceTimeBy(200)
        assertEquals("and it opens after the settle time", listOf(false, true, false, true), seen.toList())
    }

    @Test
    fun `the window stays open through a handoff, and closes when a new default never reports itself`() = runTest {
        val net = network()
        val seen = CopyOnWriteArrayList<Boolean>()
        backgroundScope.launch { ChatBackground.windowWanted(MutableStateFlow(true), net.state, 5_000).collect { seen += it } }
        runCurrent()
        net.usableOn("wifi")
        advanceTimeBy(5_100)

        net.usableOn("cell")
        advanceTimeBy(10_000)
        assertEquals("a handoff keeps it open", listOf(false, true), seen.toList())

        net.available("other")
        advanceTimeBy(4_900)
        assertEquals("open while the new default may still report", listOf(false, true), seen.toList())
        advanceTimeBy(200)
        assertEquals("closed once it didn't", listOf(false, true, false), seen.toList())
    }

    @Test
    fun `foreground runs come a minute apart, give or take ten seconds`() {
        val t = ChatTiming()
        assertEquals(50_000L, ChatBackground.catchUpDelay(t, 0.0))
        assertEquals(70_000L, ChatBackground.catchUpDelay(t, 1.0))
    }
}
