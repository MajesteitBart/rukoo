package nl.bvdm.rukoo.agents

import kotlinx.coroutines.Deferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import nl.bvdm.rukoo.agents.model.AgentDescriptor
import nl.bvdm.rukoo.agents.model.MailApproval
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.ConversationRow
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.OwnSkills
import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.agents.model.RelatedChat
import nl.bvdm.rukoo.agents.model.RukooSkill
import nl.bvdm.rukoo.agents.model.TurnStatus
import nl.bvdm.rukoo.core.Change

/**
 * A message from the user (desktop send(), spec 1 §2.1). [display] replaces [text] on screen (a quick
 * action's label); [skill] starts a Rukoo skill by name; [emails] are Rukoo ids of attached emails.
 */
data class SendRequest(
    val text: String = "",
    val action: String? = null,
    val display: String? = null,
    val skill: String? = null,
    val emails: List<String> = emptyList(),
)

data class SendResult(val conversationId: String, val itemId: String)

/**
 * Who is calling Rukoo's tools (desktop identity, spec 2 §3.1). [computer] is the pairing id when a
 * paired computer forwards a Claude Code or Codex call; [conversationId] is then the phone chat it named.
 */
data class ToolIdentity(
    val agent: String,
    val conversationId: String? = null,
    val remote: Boolean = true,
    val computer: String? = null,
)

/** A shown approval card: its item id, and the user's choice id once made (`cancel` when it expired). */
data class ApprovalTicket(val itemId: String, val choice: Deferred<String>)

/** Things the UI or notifications react to beyond the state flows. */
sealed interface HubEvent {
    /** A tool call created an external chat; show it (desktop `reveal`). */
    data class Reveal(val conversationId: String) : HubEvent

    /** An approval card is waiting; notify when its chat isn't on screen. */
    data class ApprovalWaiting(val conversationId: String, val itemId: String) : HubEvent

    /** A turn ended; [unread] tells whether it ended off screen (notify). */
    data class TurnFinished(val conversationId: String, val status: TurnStatus, val unread: Boolean) : HubEvent

    /** write_draft put a draft in the composer. */
    data class DraftWritten(val conversationId: String, val itemId: String) : HubEvent
}

/** A failure with desktop's error code (`busy`, `disabled`, `invalid` ...) and an English detail for logs. */
class AgentException(val code: String, val detail: String = "") : Exception("$code: $detail")

/**
 * The phone's port of desktop's AgentHub (spec 1, spec 3 §3). It owns conversations and turns; the UI
 * reads the flows and calls the suspend functions; the MCP tools use the calls in the second half.
 */
interface AgentHub {
    /** Every agent the user can pick, enabled or not, with its status. */
    val agents: StateFlow<List<AgentDescriptor>>

    /** Chat-list rows, most recent first. */
    val conversations: StateFlow<List<ConversationRow>>

    val events: SharedFlow<HubEvent>

    fun conversation(id: String): Flow<Conversation?>

    fun get(id: String): Conversation?

    /** A new chat, created when the user sends the first message. [message] is the email it is about. */
    suspend fun create(agent: String, message: MessageRef?, model: String? = null, effort: String? = null): Conversation

    /** Adds the user item and starts the turn; throws [AgentException] `busy` while one runs. */
    suspend fun send(conversationId: String, request: SendRequest): SendResult

    suspend fun stop(conversationId: String)

    /** Answers an approval card with one of its choices; an answered card comes back unchanged. */
    suspend fun decide(conversationId: String, itemId: String, choiceId: String): Item.Approval

    suspend fun setChoice(conversationId: String, model: Change<String?>? = null, effort: Change<String?>? = null): Conversation

    /** The chat on screen, or null: clears its unread mark, and decides whether a finished turn marks unread. */
    fun watch(conversationId: String?)

    /** The chat about this email (or continued from it), most recent first. */
    suspend fun findFor(ref: MessageRef): Conversation?

    /** An earlier chat in the same thread the user can continue from this email. */
    suspend fun relatedFor(ref: MessageRef): RelatedChat?

    /** Continues [conversationId] from the newer email [emailId] in the same thread. */
    suspend fun continueFrom(conversationId: String, emailId: String): Conversation

    /** Rukoo's actions and the user's shortcuts, in menu order; the UI filters with [QuickAction.applies]. */
    fun quickActions(): List<QuickAction>

    /** Rukoo's skills for `/name`. */
    fun skills(): List<RukooSkill>

    suspend fun models(agent: String, refresh: Boolean = false): ModelOptions

    suspend fun ownSkills(agent: String, refresh: Boolean = false): OwnSkills

    /** A forced status check (Settings' Test button). */
    suspend fun test(agent: String): AgentStatus

    /** The undo of a notice: moves the messages back. */
    suspend fun undo(conversationId: String, itemId: String)

    /** Marks a draft card undone or not (the one field the UI may change). */
    suspend fun patchDraft(conversationId: String, itemId: String, undone: Boolean)

    suspend fun remove(conversationId: String)

    // Called by the MCP tools.

    fun agentEnabled(agent: String): Boolean

    /** Display name for messages: the configured Hermes name, `OpenClaw`, `Claude`, `Codex`. */
    fun agentName(agent: String): String

    /** Desktop resolveConversation (spec 2 §3.5): the chat a tool call belongs to, or null. */
    fun conversationForTool(identity: ToolIdentity, conversationIdArg: String?, meta: JsonObject? = null): Conversation?

    /**
     * Desktop ensureConversation: [resolved], else the agent's recent external chat, else a new external one (emits
     * Reveal). Suspends while the stored chats load and while the open email is looked up; never blocks a thread.
     */
    suspend fun ensureConversation(identity: ToolIdentity, resolved: Conversation?, openMessageId: String?): Conversation

    /** Whether this Rukoo has [conversationId] for that agent (`rukoo/hello` owns). */
    fun owns(identity: ToolIdentity, conversationId: String): Boolean

    /** A tool call arrived for the chat's running turn: it reached the agent. */
    fun toolCalled(conversationId: String)

    /** Adds an item built by a tool; the hub gives it an id and time and returns the stored item. */
    fun addItem(conversationId: String, item: Item): Item

    /** Replaces an item by id (show_plan updating a plan). */
    fun updateItem(conversationId: String, item: Item)

    /** Shows an approval card. Proposals and mail cards answer later; runtime cards belong to the running turn. */
    suspend fun requestApproval(conversationId: String, request: ApprovalRequest): ApprovalTicket

    /** Queues a line for the agent's next turn ("Since your last turn: ..."). */
    fun addNote(conversationId: String, note: String)

    // Added by the hub track (all with defaults, so other implementations keep compiling).

    /**
     * Waits until the stored chats are loaded. Tool calls wait for it first: before that, a chat they name looks
     * unknown, and a new external chat would be saved over the ones still loading.
     */
    suspend fun ready() {}

    /** Checks every agent's status again, in the background (the picker opened). */
    fun refreshAgents() {}

    /**
     * read_skill (skills.js read()): without a name the list, with [file] that file, otherwise SKILL.md and the
     * text files next to it, as the desktop's JSON. Throws [SkillException] with the desktop's texts.
     */
    fun readSkill(name: String? = null, file: String? = null): JsonObject {
        if (!name.isNullOrEmpty()) throw SkillException("There is no skill named \"$name\".")
        return buildJsonObject {
            putJsonArray("skills") {
                for (s in skills()) addJsonObject { put("name", s.name); put("description", s.description); put("source", s.source) }
            }
        }
    }

    /** The skills part of Rukoo's MCP instructions in at most [room] characters, or "" (skills.js instructions()). */
    fun skillInstructions(room: Int): String = RukooSkills.instructions(skills(), room)

    /** read_skill's tool description with the skill list (skills.js toolDescription()). */
    fun skillToolDescription(): String = RukooSkills.toolDescription(skills())

    /**
     * mail_action without a card (autoMailActions): runs on the chat's mail chain, after its earlier mail work, and
     * adds the result notice; the chat's next turn waits for it. Returns the outcome within [waitMs], or null when it
     * still runs; its outcome then becomes a note for the agent's next message (tools.js mailAction()).
     *
     * A mail card ([requestApproval] with kind mail) needs nothing else: [decide] runs it on the same chain, as
     * desktop's hub does. The hub is the only place mail actions run.
     */
    suspend fun runMailAction(conversationId: String, mail: MailApproval, title: String, waitMs: Long = 90_000): MailOutcome? =
        throw AgentException("unknown", "mail actions are not available")
}
