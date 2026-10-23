package nl.bvdm.rukoo.mcp

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import nl.bvdm.rukoo.agents.AgentException
import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.ApprovalCards
import nl.bvdm.rukoo.agents.ApprovalTicket
import nl.bvdm.rukoo.agents.HubEvent
import nl.bvdm.rukoo.agents.MailActions
import nl.bvdm.rukoo.agents.MailOutcome
import nl.bvdm.rukoo.agents.RukooSkills
import nl.bvdm.rukoo.agents.SendRequest
import nl.bvdm.rukoo.agents.SendResult
import nl.bvdm.rukoo.agents.ToolIdentity
import nl.bvdm.rukoo.agents.model.AgentDescriptor
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.ApprovalChoice
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.ApprovalStatus
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.ConversationRow
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MailApproval
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.Origin
import nl.bvdm.rukoo.agents.model.OwnSkills
import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.agents.model.RelatedChat
import nl.bvdm.rukoo.agents.model.RukooSkill
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.core.Change
import nl.bvdm.rukoo.core.Unsafe

/**
 * An AgentHub that keeps chats in memory and records what the tools did, for tool tests. Like the real hub it runs a
 * mail card when it is decided, and an automatic mail action when asked, through the hub's own executor [mail]:
 * the tools only ask, so a tool that also ran an action would show up as a second notice. HubToolsSeamTest runs
 * the tools against the real Hub.
 */
class FakeHub(private val now: () -> Long = { 1_000_000L }) : AgentHub {
    private val chats = MutableStateFlow<Map<String, Conversation>>(emptyMap())
    val notes = mutableListOf<Pair<String, String>>()
    val reveals = mutableListOf<String>()
    val approvals = mutableMapOf<String, CompletableDeferred<String>>()
    var disabled = setOf<String>()
    var rukooSkills: RukooSkills = RukooSkills(null, null)
    var toolCalls = mutableListOf<String>()

    /** The hub's mail executor; tests that decide mail cards or run them at once set it. */
    var mail: MailActions? = null
    private var n = 0

    fun add(c: Conversation) = chats.value.let { chats.value = it + (c.id to c) }

    fun items(id: String) = chats.value[id]?.items.orEmpty()

    override val agents: StateFlow<List<AgentDescriptor>> = MutableStateFlow(emptyList())
    override val conversations: StateFlow<List<ConversationRow>> = MutableStateFlow(emptyList())
    private val rows get() = chats.value.values.map {
        ConversationRow(it.id, it.agent, it.title, it.message, it.origin, it.updatedAt, it.updatedAt, it.status, it.unread, false, "")
    }
    override val events: SharedFlow<HubEvent> = MutableSharedFlow()

    override fun conversation(id: String): Flow<Conversation?> = chats.map { it[id] }

    override fun get(id: String): Conversation? = chats.value[id]

    override suspend fun create(agent: String, message: MessageRef?, model: String?, effort: String?): Conversation = error("not used")
    override suspend fun send(conversationId: String, request: SendRequest): SendResult = error("not used")
    override suspend fun stop(conversationId: String) = Unit

    // As Hub.decide: the card changes, its ticket answers, and a mail card runs (or is declined) as a note.
    override suspend fun decide(conversationId: String, itemId: String, choiceId: String): Item.Approval {
        val item = items(conversationId).first { it.id == itemId } as Item.Approval
        if (item.status != ApprovalStatus.PENDING) return item
        val choice = item.choices.first { it.id == choiceId }
        val denied = ApprovalCards.denies(choice)
        val decided = item.copy(status = if (denied) ApprovalStatus.DENIED else ApprovalStatus.APPROVED, decision = choiceId)
        updateItem(conversationId, decided)
        approvals.remove(itemId)?.complete(choiceId)
        if (item.kind == ApprovalKind.MAIL) {
            val title = Unsafe.inline(item.title, "mail action")
            if (denied) {
                addNote(conversationId, "The user declined: $title.")
            } else {
                val r = executeMail(conversationId, item.mail!!)
                addNote(conversationId, "The user approved: $title. Rukoo: ${Unsafe.inline(r.text, "mail result")}.")
            }
        }
        return decided
    }

    private suspend fun executeMail(cid: String, spec: MailApproval): MailOutcome {
        val actions = mail ?: error("set FakeHub.mail to run mail actions")
        val r = actions.execute(spec)
        addItem(cid, Item.Notice("", 0, r.text, tone = if (r.done.isNotEmpty()) Tone.SUCCESS else Tone.ERROR, undo = actions.undoOf(r), mail = r.mail))
        return r
    }

    val ranAtOnce = mutableListOf<Pair<String, String>>()

    override suspend fun runMailAction(conversationId: String, mail: MailApproval, title: String, waitMs: Long): MailOutcome? {
        ranAtOnce += conversationId to title
        return executeMail(conversationId, mail)
    }

    override suspend fun setChoice(conversationId: String, model: Change<String?>?, effort: Change<String?>?): Conversation = error("not used")
    override fun watch(conversationId: String?) = Unit
    override suspend fun findFor(ref: MessageRef): Conversation? = null
    override suspend fun relatedFor(ref: MessageRef): RelatedChat? = null
    override suspend fun continueFrom(conversationId: String, emailId: String): Conversation = error("not used")
    override fun quickActions(): List<QuickAction> = emptyList()
    override fun skills(): List<RukooSkill> = rukooSkills.models()
    override fun readSkill(name: String?, file: String?): JsonObject = rukooSkills.read(name, file)
    override suspend fun models(agent: String, refresh: Boolean): ModelOptions = ModelOptions(agent)
    override suspend fun ownSkills(agent: String, refresh: Boolean): OwnSkills = OwnSkills(agent)
    override suspend fun test(agent: String): AgentStatus = AgentStatus()
    override suspend fun undo(conversationId: String, itemId: String) = Unit
    override suspend fun patchDraft(conversationId: String, itemId: String, undone: Boolean) {
        val d = items(conversationId).first { it.id == itemId } as Item.Draft
        updateItem(conversationId, d.copy(undone = undone))
    }
    override suspend fun remove(conversationId: String) {
        chats.value = chats.value - conversationId
    }

    override fun agentEnabled(agent: String): Boolean = agent !in disabled

    override fun agentName(agent: String): String = when (agent) {
        "clark" -> "Clark"
        "openclaw" -> "OpenClaw"
        else -> if (agent.endsWith(":codex")) "Codex" else "Claude"
    }

    // Desktop resolveConversation: a computer's call names its chat; the others go by conversation_id.
    override fun conversationForTool(identity: ToolIdentity, conversationIdArg: String?, meta: JsonObject?): Conversation? {
        fun own(id: String?) = id?.let { chats.value[it] }?.takeIf { it.agent == identity.agent }
        if (identity.conversationId != null) return own(identity.conversationId)
        return own(conversationIdArg)
    }

    override suspend fun ensureConversation(identity: ToolIdentity, resolved: Conversation?, openMessageId: String?): Conversation {
        if (resolved != null) return resolved
        val c = Conversation(
            id = "c_ext${++n}", agent = identity.agent, title = agentName(identity.agent),
            message = openMessageId?.let { MessageRef(it) }, origin = Origin.EXTERNAL, createdAt = now(), updatedAt = now(),
        )
        add(c)
        reveals += c.id
        return c
    }

    override fun owns(identity: ToolIdentity, conversationId: String): Boolean = chats.value[conversationId]?.agent == identity.agent

    override fun toolCalled(conversationId: String) {
        toolCalls += conversationId
    }

    override fun addItem(conversationId: String, item: Item): Item {
        val stamped = item.stamped("i_${++n}", now())
        val c = chats.value[conversationId] ?: throw AgentException("invalid", "unknown conversation")
        add(c.copy(items = c.items + stamped))
        return stamped
    }

    override fun updateItem(conversationId: String, item: Item) {
        val c = chats.value[conversationId] ?: return
        add(c.copy(items = c.items.map { if (it.id == item.id) item else it }))
    }

    override suspend fun requestApproval(conversationId: String, request: ApprovalRequest): ApprovalTicket {
        val item = addItem(
            conversationId,
            Item.Approval(
                "", 0, request.title, request.detail, request.fields, request.tool,
                request.choices.ifEmpty { listOf(ApprovalChoice("approve", "Approve")) }, source = request.source, kind = request.kind, mail = request.mail,
            ),
        )
        val deferred = CompletableDeferred<String>()
        approvals[item.id] = deferred
        return ApprovalTicket(item.id, deferred)
    }

    override fun addNote(conversationId: String, note: String) {
        notes += conversationId to note
    }

    init {
        (conversations as MutableStateFlow).value = emptyList()
    }

    /** Rows as the real hub lists them, for externalFor. */
    fun refreshRows() {
        (conversations as MutableStateFlow).value = rows
    }
}
