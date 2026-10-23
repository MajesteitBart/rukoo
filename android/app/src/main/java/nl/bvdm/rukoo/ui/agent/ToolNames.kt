package nl.bvdm.rukoo.ui.agent

import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.ToolStatus

/** What a tool call is, which picks its chip icon (bui.js KIND_ICONS). */
enum class ToolChipKind(val icon: String) {
    MAIL("mail"),
    SEARCH("search"),
    DRAFT("pen"),
    PLAN("list-check"),
    SOURCES("layers"),
    APPROVAL("shield"),
    COMMAND("terminal"),
    WEB("globe"),
    FILE("file"),
    TOOL("wrench"),
}

/**
 * What a tool chip says, before translation. While a tool runs its chip says what it is doing
 * ("Searching your mail..."), afterwards what it did. [Literal] is text that isn't ours to translate: an
 * MCP tool as "server: tool", or the adapter's own label.
 */
sealed interface ToolLabel {
    data class Rukoo(val tool: String, val running: Boolean) : ToolLabel

    data class Generic(val key: String, val running: Boolean) : ToolLabel

    data class Literal(val text: String) : ToolLabel

    data class Unknown(val running: Boolean) : ToolLabel
}

/** Desktop panel.js's tool naming (RUKOO_TOOLS, GENERIC_TOOLS, mcpLabel, toolKind, toolProps). */
object ToolNames {
    private val RUKOO_PREFIX = Regex("^(mcp__rukoo__|mcp_rukoo_|rukoo[._:])", RegexOption.IGNORE_CASE)

    /** Rukoo's own tools: their kind picks the chip icon and their label is ours to translate. */
    val RUKOO_TOOLS: Map<String, ToolChipKind> = mapOf(
        "get_context" to ToolChipKind.MAIL,
        "read_message" to ToolChipKind.MAIL,
        "search_mail" to ToolChipKind.SEARCH,
        "write_draft" to ToolChipKind.DRAFT,
        "get_draft" to ToolChipKind.DRAFT,
        "show_plan" to ToolChipKind.PLAN,
        "show_sources" to ToolChipKind.SOURCES,
        "propose_action" to ToolChipKind.APPROVAL,
        "mail_action" to ToolChipKind.APPROVAL,
        "read_attachment" to ToolChipKind.FILE,
        "read_chat_file" to ToolChipKind.FILE,
        "read_skill" to ToolChipKind.FILE,
    )

    // These put their own card in the transcript, so once they succeed a chip saying the same is noise.
    private val CARD_TOOLS = setOf("write_draft", "show_plan", "show_sources", "propose_action", "mail_action")

    private fun re(pattern: String) = Regex(pattern, RegexOption.IGNORE_CASE)

    /** The agents' own common tools across Claude Code, Codex and Hermes, matched in this order. */
    val GENERIC: List<Pair<Regex, String>> = listOf(
        re("^(bash|terminal|shell|powershell|command|commandexecution|exec(_command)?|run_command|local_shell)$") to "command",
        re("^(execute_code|code_execution)$") to "code",
        re("^(websearch|web_search|websearchtool|search_web|x_search)$") to "webSearch",
        re("^(webfetch|web_fetch|web_extract|fetch_url)$") to "webPage",
        re("^browser") to "browser",
        re("^(read|read_file|view|cat|notebookread)$") to "readFile",
        re("^(write|edit|multiedit|filechange|apply_patch|write_file|patch|notebookedit)$") to "changeFiles",
        re("^(task|agent|delegate_task|subagent.*|collabagenttoolcall)$") to "subagent",
        re("^(glob|grep|ls|search_files)$") to "findFiles",
        re("^(todowrite|todo)$") to "todo",
        re("^(toolsearch|tool_describe|tools_list)$") to "lookupTools",
        re("^(memory|honcho_.+|mem0_.+)$") to "memory",
        re("^(skill|skill_view|skills_list|skill_manage)$") to "skill",
        re("^session_search$") to "pastChats",
        re("^cronjob$") to "schedule",
        re("^send_message$") to "sendMessage",
        re("^(image_generate|imagegeneration)$") to "image",
        re("^(vision_analyze|imageview)$") to "vision",
    )

    private val MCP_LONG = Regex("^mcp__([^_].*?)__(.+)$")
    private val MCP_SHORT = Regex("^mcp_([a-z0-9-]+)_(.+)$", RegexOption.IGNORE_CASE)
    private val COMMAND_NAME = Regex("bash|shell|powershell|terminal|command|exec")
    private val WEB_NAME = Regex("web|fetch|browse|url")
    private val FILE_NAME = Regex("read|write|edit|file|glob|grep|patch")

    /** The bare name of a Rukoo tool, whatever prefix the agent's MCP client gave it. */
    fun rukooTool(name: String): String = RUKOO_PREFIX.replaceFirst(name, "")

    /** Whether the call is to one of Rukoo's tools: the hub says so, or the name carries Rukoo's prefix. */
    fun isRukoo(item: Item.Tool): Boolean {
        val tool = rukooTool(item.name)
        return tool in RUKOO_TOOLS && (item.rukoo || tool != item.name)
    }

    /** A successful write_draft, show_plan, show_sources, propose_action or mail_action: its card says it all. */
    fun cardToolDone(item: Item.Tool): Boolean {
        val tool = rukooTool(item.name)
        return item.status == ToolStatus.DONE && tool in CARD_TOOLS && (item.rukoo || tool != item.name)
    }

    /** "mcp__strap__strap_search" reads as "strap: search", "mcp__todoist__add_task" as "todoist: add task". */
    fun mcpLabel(name: String): String? {
        val m = MCP_LONG.find(name) ?: MCP_SHORT.find(name) ?: return null
        val server = m.groupValues[1]
        var tool = m.groupValues[2]
        if (tool.lowercase().startsWith("${server.lowercase()}_")) tool = tool.substring(server.length + 1)
        return "${server.replace('_', ' ')}: ${tool.replace('_', ' ')}"
    }

    fun kind(item: Item.Tool): ToolChipKind {
        RUKOO_TOOLS[rukooTool(item.name)]?.let { return it }
        val n = item.name.lowercase()
        return when {
            COMMAND_NAME.containsMatchIn(n) || item.label.startsWith("ran a command", ignoreCase = true) -> ToolChipKind.COMMAND
            WEB_NAME.containsMatchIn(n) -> ToolChipKind.WEB
            FILE_NAME.containsMatchIn(n) -> ToolChipKind.FILE
            "mail" in n -> ToolChipKind.MAIL
            "search" in n -> ToolChipKind.SEARCH
            else -> ToolChipKind.TOOL
        }
    }

    fun label(item: Item.Tool): ToolLabel {
        val running = item.status == ToolStatus.RUNNING
        if (isRukoo(item)) return ToolLabel.Rukoo(rukooTool(item.name), running)
        GENERIC.firstOrNull { it.first.containsMatchIn(item.name) }?.let { return ToolLabel.Generic(it.second, running) }
        mcpLabel(item.name)?.let { return ToolLabel.Literal(it) }
        val own = if (item.label.isNotEmpty() && item.label != item.name) item.label else item.name.replace('_', ' ').trim()
        return if (own.isNotEmpty()) ToolLabel.Literal(own) else ToolLabel.Unknown(running)
    }
}
