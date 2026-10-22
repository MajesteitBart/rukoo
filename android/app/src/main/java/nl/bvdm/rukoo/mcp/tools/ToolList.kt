package nl.bvdm.rukoo.mcp.tools

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Rukoo's twelve MCP tools as desktop lists them (tools.js:43-293): names, titles, descriptions, input schemas
 * and annotations are identical, because Clark's bridge caches one tool list for every device it finds.
 * Only the behavior behind them adapts to the phone.
 */
data class ToolSpec(
    val name: String,
    val title: String,
    val description: String,
    val inputSchema: Schema,
    val annotations: JsonObject,
)

object ToolList {
    private val CONVERSATION = str { description("The Rukoo conversation id from your context (\"c_...\"). Pass it whenever you have one.") }

    private fun messageId() = str(untag = true) {
        description("Rukoo message id: the \"id\" field from get_context or search_mail (not the Message-ID header).")
    }

    private fun person() = anyOf(
        str(untag = true) { description("An address, or \"Name <address>\".") },
        obj {
            properties("name" to str(untag = true), "address" to str(untag = true))
            required(listOf("address"))
        },
    )

    private fun people() = array {
        items(person())
        maxItems(50)
    }

    /** Every tool's schema: its own properties plus conversation_id, which the bridge routes by. */
    private fun schema(vararg props: Pair<String, Schema>, required: List<String> = emptyList()) = obj {
        properties(*props, "conversation_id" to CONVERSATION)
        required(required)
    }

    private fun hints(readOnly: Boolean, destructive: Boolean, idempotent: Boolean) = buildJsonObject {
        put("readOnlyHint", readOnly)
        put("destructiveHint", destructive)
        put("idempotentHint", idempotent)
        put("openWorldHint", false)
    }

    private val READ = hints(readOnly = true, destructive = false, idempotent = true)
    private val WRITE = hints(readOnly = false, destructive = false, idempotent = false)

    val MAIL_ACTIONS = listOf("archive", "trash", "move", "mark_read", "mark_unread", "star", "unstar", "unsubscribe")
    val TASK_STATUSES = listOf("proposed", "todo", "running", "done", "failed", "skipped")

    val TOOLS: List<ToolSpec> = listOf(
        ToolSpec(
            "get_context",
            "See what the user sees in Rukoo",
            "Returns what is on the user's screen in Rukoo: the open email with its full text, the email this chat is about, related mail in the same thread, checked emails, the reply draft in the composer, the user's accounts and folders, and today's date. Call this first.",
            schema(),
            READ,
        ),
        ToolSpec(
            "search_mail",
            "Search mail",
            "Searches the user's mail in every account and folder Rukoo has synced (inbox, sent, archive, drafts, trash and opened folders). All words in query must match the subject, preview, sender or recipients. Newest first. Use read_message for the full text.",
            schema(
                "query" to str(untag = true) {
                    description("Words that must all appear, e.g. \"proposal thursday\".")
                    maxLength(500)
                },
                "from" to str(untag = true) {
                    description("Part of the sender name or address.")
                    maxLength(320)
                },
                "account" to str(untag = true) {
                    description("Account id or email address, from get_context. Default: all accounts.")
                    maxLength(320)
                },
                "folder" to str(untag = true) {
                    description("Folder path or name, or a role: inbox, sent, drafts, archive, trash, junk.")
                    maxLength(500)
                },
                "unread" to bool { description("Only unread (true) or only read (false) mail.") },
                "limit" to integer {
                    minimum(1)
                    maximum(50)
                    description("Maximum results (default 15).")
                },
            ),
            READ,
        ),
        ToolSpec(
            "read_message",
            "Read an email",
            "Returns one email: headers (including the Message-ID header to link back to it from other systems, and the List-Unsubscribe links), plain text body and the attachment list. Does not mark it as read.",
            schema(
                "message_id" to messageId(),
                "max_chars" to integer {
                    minimum(200)
                    maximum(200000)
                    description("Maximum body characters (default 20000).")
                },
                required = listOf("message_id"),
            ),
            READ,
        ),
        ToolSpec(
            "read_attachment",
            "Read an attachment",
            "Returns an attachment of an email by its index from read_message. Text files come back as text, images as images, a PDF as the text Rukoo could extract (note says when that is not all of it) with the file as a resource, other files (Office) as a resource; local agents also get local_path to open the file themselves. Up to 10 MB.",
            schema(
                "message_id" to messageId(),
                "index" to integer {
                    minimum(0)
                    description("The attachment index from read_message.")
                },
                required = listOf("message_id", "index"),
            ),
            READ,
        ),
        ToolSpec(
            "read_chat_file",
            "Read a file the user attached",
            "Returns a file the user attached to a message in this chat, by the file_id the message gives. Text files come back as text, images as images, a PDF as the text Rukoo could extract (note says when that is not all of it) with the file as a resource, other files as a resource; local agents also get local_path to open the file themselves. Without file_id it lists the chat's files.",
            schema(
                "file_id" to str {
                    description("The file_id from the message, e.g. \"f_1a2b3c4d5e\".")
                    maxLength(100)
                },
            ),
            READ,
        ),
        ToolSpec(
            "write_draft",
            "Write the reply draft",
            "Puts a draft in Rukoo's composer, replacing the body the user sees. It never sends: the user reviews and sends. Mode defaults to a reply to the email of this chat. Write only the body; Rukoo keeps the quoted email and adds the signature. Recipients and subject are optional for replies.",
            schema(
                "message_id" to messageId(),
                "mode" to str { enumOf(listOf("reply", "reply_all", "forward", "new")) },
                "to" to people(),
                "cc" to people(),
                "bcc" to people(),
                "subject" to str(untag = true) { maxLength(1000) },
                "body" to str {
                    description("The draft body.")
                    maxLength(100000)
                },
                "format" to str {
                    enumOf(listOf("markdown", "text", "html"))
                    description("Default markdown.")
                },
                required = listOf("body"),
            ),
            WRITE,
        ),
        ToolSpec(
            "get_draft",
            "Check the draft",
            "Returns the draft that is open in Rukoo's composer now, including the user's own edits, or {open:false}.",
            schema(),
            READ,
        ),
        ToolSpec(
            "show_plan",
            "Show a plan",
            "Shows or updates a task list in Rukoo's chat panel. Call it again with the same plan_id (or the same task ids) to update statuses and add links as you work. Statuses: proposed, todo, running, done, failed, skipped.",
            schema(
                "plan_id" to str { maxLength(100) },
                "title" to str { maxLength(200) },
                "tasks" to array {
                    minItems(1)
                    maxItems(30)
                    items(
                        obj {
                            properties(
                                "id" to str { maxLength(100) },
                                "title" to str { maxLength(300) },
                                "detail" to str { maxLength(1000) },
                                "system" to str {
                                    description("Where it happens, e.g. Todoist, Linear, CRM.")
                                    maxLength(60)
                                },
                                "status" to str { enumOf(TASK_STATUSES) },
                                "url" to str { maxLength(2000) },
                                "owner" to str { maxLength(100) },
                                "due" to str { maxLength(60) },
                            )
                            description("New tasks need a title; updates only need the id and the fields that change.")
                        },
                    )
                },
                required = listOf("tasks"),
            ),
            WRITE,
        ),
        ToolSpec(
            "show_sources",
            "Show sources",
            "Shows the sources you used as cards in Rukoo's chat panel: emails (pass message_id so the user can open them), notes, records or web pages (url).",
            schema(
                "title" to str(untag = true) { maxLength(200) },
                "sources" to array {
                    minItems(1)
                    maxItems(12)
                    items(
                        obj {
                            properties(
                                "title" to str(untag = true) { maxLength(300) },
                                "source" to str(untag = true) {
                                    description("Origin, e.g. Email, Obsidian, CRM, Web.")
                                    maxLength(60)
                                },
                                "snippet" to str(untag = true) { maxLength(600) },
                                "url" to str { maxLength(2000) },
                                "message_id" to messageId(),
                            )
                            required(listOf("title"))
                        },
                    )
                },
                required = listOf("sources"),
            ),
            WRITE,
        ),
        ToolSpec(
            "propose_action",
            "Ask the user for approval",
            "Shows an approval card in Rukoo for something you want to do elsewhere (send a message, create a task, update a record). Returns at once; stop and wait. When the user approves you get a new message saying so, then do it. If they decline you will be told.",
            schema(
                "title" to str(whole = true) {
                    description("What you will do, e.g. \"Add 2 tasks to Todoist\".")
                    maxLength(120)
                },
                "detail" to str(whole = true) {
                    description("The exact content, e.g. the message text.")
                    maxLength(2000)
                },
                "fields" to array {
                    maxItems(8)
                    items(
                        obj {
                            properties("label" to str(whole = true) { maxLength(60) }, "value" to str(whole = true) { maxLength(500) })
                            required(listOf("label", "value"))
                        },
                    )
                },
                "confirm_label" to str(whole = true) {
                    description("Approve button text, e.g. \"Send\".")
                    maxLength(30)
                },
                required = listOf("title"),
            ),
            WRITE,
        ),
        ToolSpec(
            "mail_action",
            "Archive, move, flag or unsubscribe",
            "Asks Rukoo to archive, delete (move to trash), move, mark, star or unsubscribe from emails. Rukoo asks the user first unless they turned that off; you get status waiting_for_user or the result. Works for every account type. Use the ids from search_mail or get_context.",
            schema(
                "action" to str { enumOf(MAIL_ACTIONS) },
                "message_ids" to array {
                    items(messageId())
                    minItems(1)
                    maxItems(50)
                },
                "folder" to str(untag = true) {
                    description("Destination folder for move (path or name).")
                    maxLength(500)
                },
                required = listOf("action", "message_ids"),
            ),
            hints(readOnly = false, destructive = true, idempotent = false),
        ),
        ToolSpec(
            "read_skill",
            "Read a skill",
            SkillText.toolDescription(emptyList()),
            schema(
                "name" to str {
                    description("The skill, e.g. \"data-deletion-request\". Leave it out to list the skills.")
                    maxLength(64)
                },
                "file" to str {
                    description("One file of the skill by its path, as read_skill lists it, e.g. \"references/forms.md\".")
                    maxLength(500)
                },
            ),
            READ,
        ),
    )

    val NAMES: List<String> = TOOLS.map { it.name }
    private val BY_NAME = TOOLS.associateBy { it.name }

    fun byName(name: String): ToolSpec? = BY_NAME[name]

    /**
     * What tools/list returns. [skills] fills read_skill's description; when listing them fails the static
     * description stays ("A skills folder that can't be read must not cost the agent its tools.").
     */
    fun list(skills: () -> List<SkillInfo>): JsonArray = JsonArray(
        TOOLS.map { t ->
            val description = if (t.name == "read_skill") runCatching { SkillText.toolDescription(skills()) }.getOrDefault(t.description) else t.description
            buildJsonObject {
                put("name", t.name)
                put("title", t.title)
                put("description", description)
                put("inputSchema", t.inputSchema.json)
                put("annotations", t.annotations)
            }
        },
    )

    private val PREFIX = Regex("^mcp__rukoo__|^mcp_rukoo_|^rukoo[.:/]")

    /** Accepts bare names and the prefixed forms agents report (mcp__rukoo__x, mcp_rukoo_x). */
    fun bareName(name: String): String = name.replaceFirst(PREFIX, "")
}

/** A skill as the tools list it: Rukoo's own (`rukoo`) or the user's (`user`). Never tagged: skills aren't email. */
data class SkillInfo(val name: String, val description: String, val source: String)

/**
 * The skill lists in the MCP instructions and in read_skill's description (skills.js:397-447). Claude Code cuts an
 * MCP server's instructions and each tool description at 2048 characters, so both lists are made to fit.
 */
object SkillText {
    const val MCP_TEXT_MAX = 2048
    private const val DESCRIPTION_MAX = 1024
    private const val LISTED_DESCRIPTION_MIN = 60

    const val INTRO =
        "Rukoo has skills: instructions for email tasks, written by Rukoo or by the user. They are not email content. When the user asks for a skill, or a task matches a skill's description, call read_skill with its name and follow it. The skills:\n"

    private const val TOOL_BASE =
        "Returns one of Rukoo's skills: instructions for an email task, written by Rukoo or by the user, not taken from an email. You get SKILL.md and the text files next to it (scripts, references), and a list of what was left out. Pass file to read one of the skill's files. Without a name it lists the skills. Follow a skill when the user asks for it or the task matches its description."

    fun clip(v: String, max: Int): String = if (v.length > max) v.take(max - 1) + "…" else v

    private fun line(s: SkillInfo, cap: Int) = "- ${s.name}: ${clip(s.description, cap)}"

    private fun more(n: Int) = "- and $n more; read_skill without a name lists them all."

    /**
     * One line per skill in at most [room] characters. When the full descriptions don't fit, all of them are cut to
     * the longest length at which every skill still fits; when even short ones don't, the list ends with how many
     * are left out.
     */
    fun listLines(list: List<SkillInfo>, room: Int): String {
        fun size(cap: Int) = list.sumOf { line(it, cap).length + 1 } - 1
        var cap = DESCRIPTION_MAX
        if (size(cap) > room && size(LISTED_DESCRIPTION_MIN) <= room) {
            var lo = LISTED_DESCRIPTION_MIN
            var hi = DESCRIPTION_MAX
            while (lo < hi) {
                val mid = (lo + hi + 1) / 2
                if (size(mid) <= room) lo = mid else hi = mid - 1
            }
            cap = lo
        }
        if (size(cap) <= room) return list.joinToString("\n") { line(it, cap) }
        val lines = mutableListOf<String>()
        var used = 0
        for ((i, s) in list.withIndex()) {
            val l = line(s, LISTED_DESCRIPTION_MIN)
            if (used + l.length + 1 + more(list.size - i - 1).length > room) {
                lines += more(list.size - i)
                break
            }
            lines += l
            used += l.length + 1
        }
        return lines.joinToString("\n")
    }

    /** The skills part of the MCP instructions, in at most [room] characters, or "" without skills. */
    fun instructions(list: List<SkillInfo>, room: Int = MCP_TEXT_MAX): String =
        if (list.isEmpty()) "" else INTRO + listLines(list, room - INTRO.length)

    /** read_skill's description: not every agent passes MCP instructions on to its model, so the list is here too. */
    fun toolDescription(list: List<SkillInfo>): String {
        if (list.isEmpty()) return "$TOOL_BASE There are no skills yet."
        val head = "$TOOL_BASE Skills:\n"
        return head + listLines(list, MCP_TEXT_MAX - head.length)
    }
}

/** Shorthand for JSON strings in results. */
internal fun jstr(value: String?): JsonPrimitive = JsonPrimitive(value)
