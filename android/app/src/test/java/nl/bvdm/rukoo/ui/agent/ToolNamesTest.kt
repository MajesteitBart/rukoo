package nl.bvdm.rukoo.ui.agent

import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.ToolStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolNamesTest {
    private fun tool(name: String, status: ToolStatus = ToolStatus.DONE, rukoo: Boolean = false, label: String = name) =
        Item.Tool("i_1", 1, name, label, status = status, rukoo = rukoo)

    @Test
    fun rukooToolsLoseTheirClientPrefix() {
        assertEquals("search_mail", ToolNames.rukooTool("mcp__rukoo__search_mail"))
        assertEquals("search_mail", ToolNames.rukooTool("mcp_rukoo_search_mail"))
        assertEquals("write_draft", ToolNames.rukooTool("rukoo.write_draft"))
        assertEquals("write_draft", ToolNames.rukooTool("Rukoo:write_draft"))
        assertEquals("Bash", ToolNames.rukooTool("Bash"))
    }

    @Test
    fun aBareNameIsRukoosOnlyWhenTheHubSaysSo() {
        assertTrue(ToolNames.isRukoo(tool("search_mail", rukoo = true)))
        assertTrue(ToolNames.isRukoo(tool("mcp__rukoo__search_mail")))
        assertFalse(ToolNames.isRukoo(tool("search_mail")))
    }

    @Test
    fun aSuccessfulCardToolHasNoChip() {
        assertTrue(ToolNames.cardToolDone(tool("mcp__rukoo__write_draft")))
        assertTrue(ToolNames.cardToolDone(tool("show_plan", rukoo = true)))
        assertFalse(ToolNames.cardToolDone(tool("mcp__rukoo__write_draft", ToolStatus.RUNNING)))
        assertFalse(ToolNames.cardToolDone(tool("mcp__rukoo__write_draft", ToolStatus.ERROR)))
        assertFalse(ToolNames.cardToolDone(tool("mcp__rukoo__search_mail")))
    }

    @Test
    fun mcpToolsReadAsServerAndTool() {
        assertEquals("strap: search", ToolNames.mcpLabel("mcp__strap__strap_search"))
        assertEquals("todoist: add task", ToolNames.mcpLabel("mcp__todoist__add_task"))
        assertEquals("linear: get issue", ToolNames.mcpLabel("mcp_linear_get_issue"))
        assertNull(ToolNames.mcpLabel("web_search"))
    }

    @Test
    fun kindsPickTheIcon() {
        assertEquals(ToolChipKind.SEARCH, ToolNames.kind(tool("mcp__rukoo__search_mail")))
        assertEquals(ToolChipKind.DRAFT, ToolNames.kind(tool("write_draft")))
        assertEquals(ToolChipKind.COMMAND, ToolNames.kind(tool("Bash")))
        assertEquals(ToolChipKind.COMMAND, ToolNames.kind(tool("something", label = "Ran a command")))
        assertEquals(ToolChipKind.WEB, ToolNames.kind(tool("WebFetch")))
        assertEquals(ToolChipKind.FILE, ToolNames.kind(tool("Read")))
        assertEquals(ToolChipKind.MAIL, ToolNames.kind(tool("gmail_send")))
        assertEquals(ToolChipKind.TOOL, ToolNames.kind(tool("calendar")))
    }

    @Test
    fun labelsSayWhatATookDidOrIsDoing() {
        assertEquals(ToolLabel.Rukoo("search_mail", running = true), ToolNames.label(tool("mcp__rukoo__search_mail", ToolStatus.RUNNING)))
        assertEquals(ToolLabel.Rukoo("search_mail", running = false), ToolNames.label(tool("search_mail", rukoo = true)))
        assertEquals(ToolLabel.Generic("command", running = false), ToolNames.label(tool("Bash")))
        assertEquals(ToolLabel.Generic("webSearch", running = true), ToolNames.label(tool("web_search", ToolStatus.RUNNING)))
        assertEquals(ToolLabel.Generic("memory", running = false), ToolNames.label(tool("honcho_search")))
        assertEquals(ToolLabel.Literal("strap: search"), ToolNames.label(tool("mcp__strap__strap_search")))
        // The adapter's own label, when it has one; else the name with spaces.
        assertEquals(ToolLabel.Literal("Checked the weather"), ToolNames.label(tool("weather_now", label = "Checked the weather")))
        assertEquals(ToolLabel.Literal("weather now"), ToolNames.label(tool("weather_now")))
        assertEquals(ToolLabel.Unknown(running = false), ToolNames.label(tool("")))
        // A Rukoo tool name without the hub's flag or a prefix is someone else's.
        assertEquals(ToolLabel.Literal("search mail"), ToolNames.label(tool("search_mail")))
    }
}
