package nl.bvdm.rukoo.agents

import nl.bvdm.rukoo.core.Unsafe

/** Tool chip labels and details, ported from hub.js (toolLabel, chipDetail) and tools.js (bareName, isRukooTool). */
object ToolLabels {
    /** Rukoo's twenty tools, in desktop's order. */
    val RUKOO_TOOLS = listOf(
        "get_context", "search_mail", "read_message", "read_attachment", "read_chat_file", "write_draft",
        "get_draft", "show_plan", "show_sources", "propose_action", "mail_action", "read_skill",
        "list_events", "find_free_time", "create_event", "get_booking_link",
        "read_meeting_transcript", "search_meetings", "read_meeting_notes", "get_meeting_frame",
    )

    private val RUKOO_LABELS = mapOf(
        "get_context" to "Read the email",
        "read_message" to "Read the email",
        "search_mail" to "Searched mail",
        "write_draft" to "Wrote the draft",
        "get_draft" to "Checked the draft",
        "show_plan" to "Showed a plan",
        "show_sources" to "Showed sources",
        "propose_action" to "Asked for approval",
        "mail_action" to "Proposed a mail action",
        "read_attachment" to "Read an attachment",
        "read_chat_file" to "Read an attached file",
        "read_skill" to "Read a skill",
        "list_events" to "Checked the calendar",
        "find_free_time" to "Looked for free time",
        "create_event" to "Proposed an event",
        "get_booking_link" to "Got the booking link",
        "read_meeting_transcript" to "Read the meeting",
        "search_meetings" to "Searched meetings",
        "read_meeting_notes" to "Read the meeting notes",
        "get_meeting_frame" to "Looked at the screen",
    )

    private val COMMANDS = Regex("^(bash|terminal|shell|powershell|command|commandexecution|exec(_command)?|run_command|local_shell|execute_code)$", RegexOption.IGNORE_CASE)
    private val BUILTINS = listOf(
        Regex("^(websearch|web_search|websearchtool|search_web)$", RegexOption.IGNORE_CASE) to "Searched the web",
        Regex("^(webfetch|web_fetch|web_extract|fetch_url|browser.*)$", RegexOption.IGNORE_CASE) to "Opened a web page",
        Regex("^(read|read_file|view|cat)$", RegexOption.IGNORE_CASE) to "Read a file",
        Regex("^(write|edit|multiedit|filechange|apply_patch|write_file|patch)$", RegexOption.IGNORE_CASE) to "Changed files",
        Regex("^(task|agent|delegate_task|subagent.*|collabagenttoolcall)$", RegexOption.IGNORE_CASE) to "Ran a subagent",
        Regex("^(glob|grep|ls|search_files)$", RegexOption.IGNORE_CASE) to "Looked through files",
        Regex("^(todowrite|todo)$", RegexOption.IGNORE_CASE) to "Updated its to-do list",
        Regex("^toolsearch$", RegexOption.IGNORE_CASE) to "Looked up tools",
        Regex("^memory$", RegexOption.IGNORE_CASE) to "Checked its memory",
    )
    private val MCP_DOUBLE = Regex("^mcp__([^_].*?)__(.+)$")
    private val MCP_SINGLE = Regex("^mcp_([a-z0-9-]+)_(.+)$", RegexOption.IGNORE_CASE)
    private val PREFIX = Regex("^mcp__rukoo__|^mcp_rukoo_|^rukoo[.:/]")
    private val RUKOO_PREFIX = Regex("^mcp__rukoo__|^mcp_rukoo_")

    // A dangling piece of a tag at the end of a clipped preview, with signs of a cut (hub.js TAG_TAIL).
    private val TAG_TAIL = Regex(
        "</?(u(?:n(?:s(?:a(?:f(?:e(?:_(?:c(?:o(?:n(?:t(?:e(?:n(?:t)?)?)?)?)?)?)?)?)?)?)?)?)?)?" +
            "(?:\\s(?:\"[^\"]*(?:\"|\\z)|[^\"<>])*)?(…|\\.\\.\\.)?\\z",
        RegexOption.IGNORE_CASE,
    )

    /** Accepts bare names and the prefixed forms agents report (mcp__rukoo__x, mcp_rukoo_x). */
    fun bareName(name: String?): String = (name ?: "").replaceFirst(PREFIX, "")

    fun isRukooTool(name: String?): Boolean {
        val n = name ?: ""
        return n == "rukoo" || RUKOO_PREFIX.containsMatchIn(n) || n in RUKOO_TOOLS
    }

    /** A short English label for a tool chip; the UI translates Rukoo's own by name. */
    fun label(name: String?): String {
        val n = name ?: ""
        val bare = bareName(n)
        if (isRukooTool(n)) RUKOO_LABELS[bare]?.let { return it }
        if (COMMANDS.matches(n)) return "Ran a command"
        val mcp = MCP_DOUBLE.find(n) ?: MCP_SINGLE.find(n)
        if (mcp != null) return "${mcp.groupValues[1]} · ${mcp.groupValues[2]}"
        for ((re, label) in BUILTINS) if (re.containsMatchIn(n)) return label
        return n
    }

    fun oneLine(v: String?): String = jsOneLine(v)

    /**
     * A tool chip's detail: the agent's arguments without their tags, one line, at most 200 characters. A
     * half tag Hermes' server-side clipping left at the end goes too, only when it looks cut.
     */
    fun chipDetail(v: String?): String {
        var text = Unsafe.untag(v)
        val tail = TAG_TAIL.find(text)
        if (tail != null && (tail.groups[2] != null || (tail.groups[1]?.value?.length ?: 0) >= 3)) text = text.substring(0, tail.range.first)
        return oneLine(text).take(200)
    }
}
