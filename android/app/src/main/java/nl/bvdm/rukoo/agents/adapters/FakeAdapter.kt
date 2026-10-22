package nl.bvdm.rukoo.agents.adapters

// A deterministic stand-in for the agents, for debug builds, tests and screenshots: a port of desktop's
// src/main/agents/fake.js. It streams text, thinks, shows tool rows, asks for approval, shows a plan and sources,
// proposes actions and fails on request, so every chat state can be seen without a network. Its words are English
// sample data, like the demo mailbox.

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import nl.bvdm.rukoo.agents.AgentAdapter
import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.ToolIdentity
import nl.bvdm.rukoo.agents.TurnFile
import nl.bvdm.rukoo.agents.TurnHandle
import nl.bvdm.rukoo.agents.TurnResult
import nl.bvdm.rukoo.agents.model.AdapterEvent
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.ApprovalChoice
import nl.bvdm.rukoo.agents.model.ApprovalField
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.ApprovalTool
import nl.bvdm.rukoo.agents.model.ChoiceKind
import nl.bvdm.rukoo.agents.model.ComputerProgram
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.ModelOption
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.agents.model.ToolKind
import nl.bvdm.rukoo.core.Unsafe

/** What one turn handed the fake agent, so tests can check the exact text, model and effort. */
data class FakeReceived(
    val conversationId: String,
    val input: String,
    val text: String,
    val action: String?,
    val skills: List<String>,
    val instructions: String,
    val model: String?,
    val effort: String?,
    val files: List<TurnFile>,
    val emails: List<String>,
)

class FakeAdapter internal constructor(
    override val id: String = AgentIds.FAKE,
    private val tools: FakeTools,
    /** For the agent's display name in notices. */
    private val hub: () -> AgentHub? = { null },
    /** Multiplies every delay; tests pass a small value to run the same scripts quickly. */
    private val scale: Double = 1.0,
) : AgentAdapter {
    /** Which agent's model menu and skills the fake shows. The `fake` agent uses Hermes', which has every kind of row. */
    private val flavor: String = when {
        id == AgentIds.CLARK || id == AgentIds.FAKE -> "clark"
        id == AgentIds.OPENCLAW -> "openclaw"
        AgentIds.parseComputer(id)?.second == ComputerProgram.CODEX -> "codex"
        else -> "claude"
    }

    private val receivedTurns = ArrayDeque<FakeReceived>()

    /** The last 20 turns, newest last. */
    val received: List<FakeReceived> get() = synchronized(receivedTurns) { receivedTurns.toList() }

    override suspend fun status(force: Boolean) = AgentStatus(AgentState.READY, "Fake agent")

    override suspend fun models(): ModelOptions = (MODELS[flavor] ?: MODELS.getValue("claude")).copy(agent = id)

    override suspend fun skills(): List<OwnSkill> = SKILLS[flavor] ?: SKILLS.getValue("claude")

    override suspend fun runTurn(turn: TurnHandle): TurnResult {
        synchronized(receivedTurns) {
            receivedTurns.addLast(
                FakeReceived(turn.conversation.id, turn.input, turn.text, turn.action, turn.skills, turn.instructions, turn.model, turn.effort, turn.files, turn.emails),
            )
            if (receivedTurns.size > 20) receivedTurns.removeFirst()
        }
        return try {
            FakeRun(turn).play() ?: TurnResult.DONE
        } catch (e: CancellationException) {
            throw e
        } catch (e: Stopped) {
            TurnResult.STOPPED
        } catch (e: Exception) {
            TurnResult.error(ErrorCodes.UNKNOWN, e.message ?: e.javaClass.simpleName)
        }
    }

    private class Stopped : Exception()

    private inner class FakeRun(val turn: TurnHandle) {
        val cid = turn.conversation.id
        var toolCount = 0

        suspend fun sleep(ms: Long) = delay((ms * scale).toLong().coerceAtLeast(0))

        suspend fun think(summary: String, ms: Long) {
            turn.emit(AdapterEvent.Thinking(summary))
            sleep(ms)
            turn.emit(AdapterEvent.ThinkingDone)
        }

        suspend fun say(text: String): TurnResult? {
            var i = 0
            while (i < text.length) {
                turn.emit(AdapterEvent.Text(text.substring(i, minOf(text.length, i + STEP_CHARS))))
                sleep(STEP_MS)
                i += STEP_CHARS
            }
            return null
        }

        /** Runs one of Rukoo's tools with tool-start/tool-end around it, like a real agent's MCP call. */
        suspend fun tool(name: String, a: JsonObject = JsonObject(emptyMap())): Pair<JsonObject, String?> {
            val key = "fake-${++toolCount}"
            val detail = listOf("query", "title", "action").firstNotNullOfOrNull { a.str(it)?.takeIf { v -> v.isNotEmpty() } }.orEmpty()
            turn.emit(AdapterEvent.ToolStart(key, "mcp__rukoo__$name", detail))
            val identity = ToolIdentity(agent = id, conversationId = cid, remote = false)
            val res = tools.call(identity, name, JsonObject(mapOf("conversation_id" to JsonPrimitive(cid)) + a))
            val isError = res.bool("isError") == true
            turn.emit(AdapterEvent.ToolEnd(key, error = isError))
            if (isError) {
                val text = ((res["content"] as? JsonArray)?.firstOrNull() as? JsonObject)?.str("text") ?: "tool failed"
                return JsonObject(emptyMap()) to text
            }
            return (res["structuredContent"] as? JsonObject ?: JsonObject(emptyMap())) to null
        }

        fun email(ctx: JsonObject): JsonObject? = (ctx["chat_message"] ?: ctx["open_message"]) as? JsonObject

        /** Names and subjects in tool results are tagged as email; like a real agent, the fake reads through the tags. */
        fun firstName(m: JsonObject?): String {
            val from = m?.get("from") as? JsonObject
            val name = Unsafe.untag(from?.str("name")?.takeIf { it.isNotEmpty() } ?: from?.str("address")).ifEmpty { "them" }
            return name.split(Regex("[\\s@]"))[0]
        }

        suspend fun play(): TurnResult? {
            val action = turn.action
            val text = turn.text
            val lower = text.lowercase()
            if (action == "approved" || text.startsWith("approved:", ignoreCase = true)) return followUp()
            when (action) {
                "reply" -> return reply()
                "brief" -> return brief()
                "tasks" -> return tasks()
                "team" -> return team()
                "unsubscribe" -> return unsubscribe()
                "triage" -> return triage()
                "summary" -> return summary()
                "update" -> return update()
                "skill" -> return skill(text)
            }
            if (turn.skills.isNotEmpty()) return say("Started ${turn.skills.joinToString(" and ") { "$$it" }}.")
            if (turn.files.isNotEmpty() || turn.emails.isNotEmpty()) return attachments()
            return when {
                Regex("\\blost session\\b").containsMatchIn(lower) -> lostSession()
                Regex("\\bwhich model\\b").containsMatchIn(lower) -> say("Model: ${turn.model ?: "default"}. Effort: ${turn.effort ?: "default"}.")
                Regex("\\blong command\\b").containsMatchIn(lower) -> approval(LONG_COMMAND)
                Regex("\\bmarkdown\\b").containsMatchIn(lower) -> markdown()
                Regex("\\bapproval\\b").containsMatchIn(lower) -> approval()
                Regex("\\berror\\b").containsMatchIn(lower) -> error()
                lower.contains("reply") -> reply()
                else -> echo(text)
            }
        }

        suspend fun reply(): TurnResult? {
            think("Reading the thread and checking what we agreed earlier.", 600)
            val (ctx) = tool("get_context")
            val name = firstName(email(ctx))
            tool("search_mail", args("query" to if (name == "them") "" else name, "limit" to 5))
            say("I checked your earlier mail with $name and kept the reply short. ")
            val (_, error) = tool("write_draft", args("body" to "Hi $name,\n\nThursday at 10:00 works for me. I'll call you then.\n\nBest,\nDemo"))
            if (error != null) return say("I could not put the draft in the composer: $error")
            return say("Done. The draft is in the composer.")
        }

        suspend fun brief(): TurnResult? {
            val (ctx) = tool("get_context")
            val m = email(ctx)
            val name = firstName(m)
            val (found) = tool("search_mail", args("query" to if (name == "them") "" else name, "limit" to 5))
            val results = (found["results"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            val other = results.firstOrNull { m == null || it.str("id") != m.str("id") } ?: results.firstOrNull()
            val sources = mutableListOf<JsonObject>()
            if (other != null) sources.add(args("title" to (other.str("subject") ?: "(no subject)"), "source" to "Email", "snippet" to other.str("preview"), "message_id" to other.str("id")))
            sources.add(args("title" to "$name (CRM)", "source" to "CRM", "snippet" to "Prospect since March. Proposal v3 went out last week.", "url" to "https://crm.example.com/contacts/sanne"))
            sources.add(args("title" to "Call notes", "source" to "Obsidian", "snippet" to "Wants a decision on the proposal before the end of the month.", "url" to "obsidian://open?vault=Personal&file=Call%20notes"))
            tool("show_sources", args("title" to "What I used", "sources" to sources))
            return say(
                "$name wants a call on Thursday at 10:00 about the proposal. You already said yes to that time in your earlier reply. " +
                    "Open question: whether version 3 of the proposal is final. Decide that before the call.",
            )
        }

        suspend fun tasks(): TurnResult? {
            tool(
                "show_plan",
                args(
                    "title" to "Follow-ups",
                    "tasks" to listOf(
                        args("id" to "t1", "title" to "Confirm the call on Thursday at 10:00", "system" to "Email", "status" to "done", "url" to "https://example.com/calendar/thursday"),
                        args("id" to "t2", "title" to "Review Proposal-v3.pdf", "system" to "Todoist", "owner" to "You", "due" to "Wednesday", "status" to "proposed"),
                        args("id" to "t3", "title" to "Send notes to Joris after the call", "system" to "Todoist", "owner" to "You", "due" to "Friday", "status" to "proposed"),
                    ),
                ),
            )
            say("Two of these belong in Todoist. ")
            tool(
                "propose_action",
                args(
                    "title" to "Add 2 tasks to Todoist",
                    "detail" to "Review Proposal-v3.pdf (due Wednesday) and send notes to Joris after the call (due Friday).",
                    "fields" to listOf(
                        args("label" to "Task", "value" to "Review Proposal-v3.pdf, due Wednesday"),
                        args("label" to "Task", "value" to "Send notes to Joris after the call, due Friday"),
                    ),
                    "confirm_label" to "Add tasks",
                ),
            )
            return say("I'll add them once you approve.")
        }

        suspend fun update(): TurnResult? {
            tool(
                "show_plan",
                args(
                    "title" to "Updates",
                    "tasks" to listOf(
                        args("id" to "u1", "title" to "Log the call request on the contact", "system" to "CRM", "status" to "proposed"),
                        args("id" to "u2", "title" to "Add a note with the proposal status", "system" to "Obsidian", "status" to "proposed"),
                    ),
                ),
            )
            tool("propose_action", args("title" to "Update 2 systems", "detail" to "CRM contact and the Obsidian note for this email.", "confirm_label" to "Update"))
            return say("I'll make these updates once you approve.")
        }

        suspend fun team(): TurnResult? {
            val (ctx) = tool("get_context")
            val m = email(ctx)
            tool(
                "propose_action",
                args(
                    "title" to "Send a Slack message to #sales",
                    "detail" to "${firstName(m)} asks for a call on Thursday at 10:00 about proposal v3. Message-ID ${m?.str("message_id_header") ?: "unknown"}.",
                    "fields" to listOf(args("label" to "Channel", "value" to "#sales")),
                    "confirm_label" to "Send",
                ),
            )
            return say("I'll post it once you approve.")
        }

        suspend fun unsubscribe(): TurnResult? {
            // A chat about an email never falls back to another open email, like write_draft.
            val messageId = turn.conversation.message?.id ?: return say("Open the newsletter first, then ask again.")
            val (_, error) = tool("mail_action", args("action" to "unsubscribe", "message_ids" to listOf(messageId)))
            if (error != null) return say("That did not work: $error")
            return say("Rukoo will ask you before it unsubscribes.")
        }

        suspend fun triage(): TurnResult? {
            val (found) = tool("search_mail", args("folder" to "inbox", "unread" to true, "limit" to 4))
            val results = (found["results"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            if (results.isNotEmpty()) {
                tool(
                    "show_sources",
                    args(
                        "title" to "Needs you today",
                        "sources" to results.map { r -> args("title" to (r.str("subject") ?: "(no subject)"), "source" to "Email", "snippet" to r.str("preview"), "message_id" to r.str("id")) },
                    ),
                )
            }
            val lines = results.mapIndexed { i, r ->
                val from = r["from"] as? JsonObject
                "${i + 1}. ${Unsafe.untag(r.str("subject"))} (${Unsafe.untag(from?.str("name")?.takeIf { it.isNotEmpty() } ?: from?.str("address"))})"
            }
            return say(if (lines.isNotEmpty()) "Most urgent first:\n${lines.joinToString("\n")}" else "Nothing in your inbox needs you today.")
        }

        /** A skill the user started: read it like a real agent would, then say which one and how it starts. */
        suspend fun skill(text: String): TurnResult? {
            val name = Regex("^\\[The user started the skill \"([a-z0-9-]+)\"").find(text)?.groupValues?.get(1) ?: return say("I did not get a skill name.")
            val (res, error) = tool("read_skill", args("name" to name))
            if (error != null) return say("I could not read the skill: $error")
            val first = res.str("skill_md").orEmpty().split("---").drop(2).joinToString("---").trim().lineSequence().firstOrNull().orEmpty()
            return say("Following the skill $name. It starts with: $first")
        }

        /** Files and emails the user attached: read each one with Rukoo's tools, like a real agent, and say what is in it. */
        suspend fun attachments(): TurnResult? {
            val lines = mutableListOf<String>()
            for (f in turn.files) {
                val (res, error) = tool("read_chat_file", args("file_id" to f.id))
                lines.add(
                    when {
                        error != null -> "I could not read ${f.name}: $error"
                        f.kind == "image" -> "I looked at ${f.name}."
                        else -> Unsafe.untag(res.str("text")).trim().lineSequence().firstOrNull()?.takeIf { it.isNotEmpty() }?.let { "${f.name} starts with: $it" } ?: "${f.name} has no text I can read."
                    },
                )
            }
            for (emailId in turn.emails) {
                val (res, error) = tool("read_message", args("message_id" to emailId))
                val from = res["from"] as? JsonObject
                lines.add(
                    if (error != null) "I could not read an email: $error"
                    else "The email \"${Unsafe.untag(res.str("subject"))}\" is from ${Unsafe.untag(from?.str("name")?.takeIf { it.isNotEmpty() } ?: from?.str("address"))}.",
                )
            }
            return say(lines.joinToString("\n"))
        }

        suspend fun summary(): TurnResult? {
            think("Reading the email.", 300)
            return say("- Sanne asks for a call on Thursday at 10:00.\n- She attached Proposal-v3.pdf.\n- Joris is in cc.\n\nIt needs a short reply from you, today.")
        }

        /** A Claude-style Bash approval. The card gets the full command, however long. */
        suspend fun approval(command: String = "td add \"Send proposal\" --due friday"): TurnResult? {
            val key = "fake-${++toolCount}"
            turn.emit(AdapterEvent.ToolStart(key, "Bash", command))
            val choice = turn.approve(
                ApprovalRequest(
                    title = "Run a command",
                    fields = listOf(ApprovalField(label = "Command", value = command, key = "command")),
                    tool = ApprovalTool("Bash", ToolKind.COMMAND),
                    choices = listOf(ApprovalChoice("allow", "Allow", ChoiceKind.PRIMARY), ApprovalChoice("deny", "Deny", ChoiceKind.DANGER)),
                    source = id,
                ),
            )
            turn.emit(AdapterEvent.ToolEnd(key, error = choice != "allow"))
            if (choice == "allow") return say("Added \"Send proposal\" to Todoist, due Friday.")
            if (choice == "cancel") throw Stopped()
            return say("OK, I did not run it.")
        }

        suspend fun markdown(): TurnResult? {
            think("Putting the plan in order.", 200)
            return say(MARKDOWN_REPLY)
        }

        /**
         * "lost session": the agent no longer has the chat's session, like Claude Code after it deleted an old
         * transcript. Rukoo sends the email and a recap again; the answer says which of the two came along.
         */
        suspend fun lostSession(): TurnResult? {
            val name = hub()?.agentName(id) ?: "Fake agent"
            turn.emit(AdapterEvent.Notice("$name started a new session", Tone.INFO, "new-session"))
            val input = turn.startOver()
            val got = mutableListOf<String>()
            if (input.contains("<unsafe_content source=\"email\"")) got.add("the email")
            if (input.contains("<unsafe_content source=\"earlier chat\">")) got.add("a recap of our chat")
            return say(if (got.isNotEmpty()) "I started a new session. Rukoo sent me ${got.joinToString(" and ")}." else "I started a new session.")
        }

        fun error(): TurnResult {
            turn.emit(AdapterEvent.Error(ErrorCodes.OFFLINE, "connect ECONNREFUSED 100.91.52.84:8642"))
            return TurnResult.error(ErrorCodes.OFFLINE, "connect ECONNREFUSED 100.91.52.84:8642")
        }

        suspend fun followUp(): TurnResult? {
            val plan = turn.conversation.items.filterIsInstance<Item.Plan>().lastOrNull()
            val open = plan?.tasks?.filter { it.status != nl.bvdm.rukoo.agents.model.TaskStatus.DONE }.orEmpty()
            if (plan != null && open.isNotEmpty()) {
                tool(
                    "show_plan",
                    args(
                        "plan_id" to plan.planId,
                        "tasks" to open.mapIndexed { i, t -> args("id" to t.id, "status" to "done", "url" to "https://todoist.com/showTask?id=fake${i + 1}") },
                    ),
                )
            }
            return say(
                if (open.isNotEmpty()) "Done. I added ${if (open.size == 1) "the task" else "${open.size} tasks"} and linked them in the plan." else "Done.",
            )
        }

        suspend fun echo(text: String): TurnResult? {
            think("Thinking about your question.", 400)
            val asked = text.replace(Regex("\\s+"), " ").trim().take(120)
            return say("You asked: \"$asked\". $ECHO_TAIL")
        }
    }

    companion object {
        private const val STEP_CHARS = 6
        private const val STEP_MS = 30L

        private const val ECHO_TAIL =
            "This is the fake agent. It answers every message with a short, fixed reply so tests and screenshots " +
                "have something real to show. It streams six characters every thirty milliseconds, the way a model " +
                "would, and it stops as soon as you press stop."

        /** "long command": a 900-character command, so tests can check that approval cards never clip it. */
        const val LONG_COMMAND_TAIL = "\" --priority 1 --end-of-command"
        val LONG_COMMAND: String = (
            "td add \"Send proposal\" --due friday --project Sales --label follow-up --note \"" +
                "Call Sanne on Thursday at 10:00 about proposal v3 and confirm the pricing table with Joris. ".repeat(12)
            ).take(900 - LONG_COMMAND_TAIL.length) + LONG_COMMAND_TAIL

        /** "markdown": bold, italic, a list, a code span, a link and a bare URL. */
        const val MARKDOWN_REPLY =
            "Here is the **plan** for *Thursday*:\n\n" +
                "- Confirm the call at `10:00`\n" +
                "- Review [the proposal](https://example.com/proposal-v3)\n" +
                "- Send notes to Joris\n\n" +
                "The agenda is at https://example.com/agenda."

        private val LEVELS = listOf("low", "medium", "high", "xhigh", "max")

        // What each agent's model menu offers, in the shape the real adapters return: Claude's aliases, two Codex
        // models whose efforts differ, and Hermes models of two providers plus a route alias.
        private val MODELS = mapOf(
            "claude" to ModelOptions(
                agent = "claude",
                models = listOf(ModelOption("fable", "Fable", efforts = LEVELS), ModelOption("opus", "Opus", efforts = LEVELS), ModelOption("sonnet", "Sonnet", efforts = LEVELS)),
                efforts = LEVELS,
                custom = LEVELS,
            ),
            "codex" to ModelOptions(
                agent = "codex",
                models = listOf(
                    ModelOption("gpt-6-astra", "GPT-6-Astra", efforts = LEVELS + "ultra", defaultEffort = "medium"),
                    ModelOption("gpt-6-luna", "GPT-6-Luna", efforts = listOf("low", "medium", "high"), defaultEffort = "low"),
                ),
                efforts = listOf("low", "medium", "high"),
            ),
            "clark" to ModelOptions(
                agent = "clark",
                models = listOf(
                    ModelOption("anthropic::claude-opus-5-5", "claude-opus-5-5", group = "Anthropic", efforts = LEVELS, isDefault = true),
                    ModelOption("openrouter::openai/gpt-6-astra", "openai/gpt-6-astra", group = "OpenRouter", efforts = LEVELS),
                    ModelOption("openrouter::mistral/small-4", "mistral/small-4", group = "OpenRouter", efforts = emptyList()),
                    ModelOption("quick", "quick", tag = "mistral/small-4", route = true, efforts = LEVELS),
                ),
                efforts = LEVELS,
                custom = LEVELS,
            ),
            // OpenClaw's gateway lists agents, not models, and takes no effort: Default and the model in Settings.
            "openclaw" to ModelOptions(agent = "openclaw"),
        )

        // Each agent's own skills for the $ menu: Hermes skills with a category, Claude Code's with a plugin skill, Codex's.
        private val SKILLS = mapOf(
            "clark" to listOf(
                OwnSkill("meeting-prep", "Prepare for a meeting: who is coming, what was said before and what to decide.", "productivity"),
                OwnSkill("invoice-check", "Check an invoice against the quote and the contract before it is paid.", "finance"),
                OwnSkill("crm-update", "Record a contact, deal or note in the CRM.", "sales"),
            ),
            "claude" to listOf(
                OwnSkill("humanizer", "Remove signs of AI-generated writing and make text read naturally.", "user"),
                OwnSkill("pdf", "Read, create and edit PDF files.", "user"),
                OwnSkill("codex:rescue", "Hand a stuck task to Codex.", "plugin"),
            ),
            "codex" to listOf(
                OwnSkill("gh-fix-ci", "Debug failing GitHub Actions checks on a pull request.", "user"),
                OwnSkill("openai-docs", "Look things up in the OpenAI developer docs.", "system"),
            ),
            // The gateway has no endpoint that lists skills.
            "openclaw" to emptyList(),
        )
    }
}

private fun JsonArray?.orEmpty(): List<kotlinx.serialization.json.JsonElement> = this ?: emptyList()
