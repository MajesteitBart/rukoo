package nl.bvdm.rukoo.mcp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class McpStatusTest {
    // Turning the tools off and on again must not lose who may connect: the service notification lists them.
    @Test
    fun turningToolsOffKeepsWhoMayConnect() {
        val listening = McpStatus(running = true, address = "100.64.0.3", port = 47800, agents = listOf("Clark"), computers = listOf("office-pc"), advertised = "10.0.2.2:47801")
        val off = listening.disabled()
        assertEquals(McpStatus.ERROR_DISABLED, off.error)
        assertNull(off.url)
        assertNull(off.address)
        assertEquals(listOf("Clark"), off.agents)
        assertEquals(listOf("office-pc"), off.computers)
    }
}
