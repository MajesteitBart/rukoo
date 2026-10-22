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
import nl.bvdm.rukoo.agents.ApprovalTicket
import nl.bvdm.rukoo.agents.HubEvent
import nl.bvdm.rukoo.agents.SendRequest
import nl.bvdm.rukoo.agents.SendResult
import nl.bvdm.rukoo.agents.ToolIdentity
import nl.bvdm.rukoo.agents.model.AgentDescriptor
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.ApprovalChoice
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.ConversationRow
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.Origin
import nl.bvdm.rukoo.agents.model.OwnSkills
import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.agents.model.RelatedChat
import nl.bvdm.rukoo.agents.model.RukooSkill
import nl.bvdm.rukoo.core.Change

/** An AgentHub that keeps chats in memory and records what the tools did, for tool tests. */
class FakeHub(private val now: () -> Long = { 1_000_000L }) : AgentHub {
    private val chats = MutableStateFlow<Map<String, Conversation>>(emptyMap())
    val notes = mutableListOf<Pair<String, String>>()
    val reveals = mutableListOf<String>()
    val approvals = mutableMapOf<String, CompletableDeferred<String>>()
    var disabled = setOf<String>()
    var skillList = listOf<RukooSkill>()
    var toolCalls = mutableListOf<String>()
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

    override suspend fun decide(conversationId: String, itemId: String, choiceId: String): Item.Approval {
        val item = items(conversationId).first { it.id == itemId } as Item.Approval
        approvals.remove(itemId)?.complete(choiceId)
        return item
    }

    override suspend fun setChoice(conversationId: String, model: Change<String?>?, effort: Change<String?>?): Conversation = error("not used")
    override fun watch(conversationId: String?) = Unit
    override suspend fun findFor(ref: MessageRef): Conversation? = null
    override suspend fun relatedFor(ref: MessageRef): RelatedChat? = null
    override suspend fun continueFrom(conversationId: String, emailId: String): Conversation = error("not used")
    override fun quickActions(): List<QuickAction> = emptyList()
    override fun skills(): List<RukooSkill> = skillList
    override suspend fun models(agent: String, refresh: Boolean): ModelOptions = ModelOptions(agent)
    override suspend fun ownSkills(agent: String, refresh: Boolean): OwnSkills = OwnSkills(agent)
    override suspend fun test(agent: String): AgentStatus = AgentStatus()
    override suspend fun undo(conversationId: String, itemId: String) = Unit
    override suspend fun patchDraft(conversationId: String, itemId: String, undone: Boolean) = Unit
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

    override fun ensureConversation(identity: ToolIdentity, resolved: Conversation?, openMessageId: String?): Conversation {
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

    val settled = mutableListOf<Pair<String, String>>()

    override suspend fun settleMail(conversationId: String, label: String, work: suspend () -> Unit) {
        settled += conversationId to label
        work()
    }

    init {
        (conversations as MutableStateFlow).value = emptyList()
    }

    /** Rows as the real hub lists them, for externalFor. */
    fun refreshRows() {
        (conversations as MutableStateFlow).value = rows
    }
}
