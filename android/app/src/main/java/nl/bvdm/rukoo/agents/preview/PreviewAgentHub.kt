package nl.bvdm.rukoo.agents.preview

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import nl.bvdm.rukoo.agents.AgentException
import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.ApprovalTicket
import nl.bvdm.rukoo.agents.HubEvent
import nl.bvdm.rukoo.agents.SendRequest
import nl.bvdm.rukoo.agents.SendResult
import nl.bvdm.rukoo.agents.ToolIdentity
import nl.bvdm.rukoo.agents.model.AgentDescriptor
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.AgentKind
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.ApprovalChoice
import nl.bvdm.rukoo.agents.model.ApprovalField
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.ApprovalStatus
import nl.bvdm.rukoo.agents.model.ApprovalTool
import nl.bvdm.rukoo.agents.model.AssistantStatus
import nl.bvdm.rukoo.agents.model.ChoiceKind
import nl.bvdm.rukoo.agents.model.ComputerProgram
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.ConversationRow
import nl.bvdm.rukoo.agents.model.ConversationStatus
import nl.bvdm.rukoo.agents.model.DraftMode
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MailApproval
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.ModelOption
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.NoticeMail
import nl.bvdm.rukoo.agents.model.NoticeUndo
import nl.bvdm.rukoo.agents.model.Origin
import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.OwnSkills
import nl.bvdm.rukoo.agents.model.PlanTask
import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.agents.model.RelatedChat
import nl.bvdm.rukoo.agents.model.RukooSkill
import nl.bvdm.rukoo.agents.model.SourceRef
import nl.bvdm.rukoo.agents.model.TaskStatus
import nl.bvdm.rukoo.agents.model.ThinkingStatus
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.agents.model.ToolKind
import nl.bvdm.rukoo.agents.model.ToolStatus
import nl.bvdm.rukoo.agents.model.TurnStatus
import nl.bvdm.rukoo.agents.model.Unread
import nl.bvdm.rukoo.core.Change
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.Ids
import nl.bvdm.rukoo.mail.demo.PreviewData
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.MessageIds

/**
 * An in-memory [AgentHub] with sample chats whose items cover every item type and state, so the chat
 * UI can be built and reviewed before the real hub lands. Sending streams a canned answer. Agent
 * output here is sample data in English, like the demo mailbox.
 */
class PreviewAgentHub(private val scope: CoroutineScope, private val clock: Clock = Clock.System) : AgentHub {
    private val pairing = PAIRING
    private val state = MutableStateFlow(sample(clock.now()))
    private var watching: String? = null
    private val turns = mutableMapOf<String, Job>()
    private val waiters = mutableMapOf<String, CompletableDeferred<String>>()

    override val agents: StateFlow<List<AgentDescriptor>> = MutableStateFlow(
        listOf(
            AgentDescriptor(AgentIds.CLARK, AgentKind.HERMES, "Clark", status = AgentStatus(AgentState.READY)),
            AgentDescriptor(AgentIds.OPENCLAW, AgentKind.OPENCLAW, "OpenClaw", status = AgentStatus(AgentState.UNCONFIGURED)),
            AgentDescriptor(
                AgentIds.computer(pairing, ComputerProgram.CLAUDE), AgentKind.CLAUDE, "Claude Code", "on desktop-zolder",
                status = AgentStatus(AgentState.READY),
            ),
            AgentDescriptor(
                AgentIds.computer(pairing, ComputerProgram.CODEX), AgentKind.CODEX, "Codex", "on desktop-zolder",
                status = AgentStatus(AgentState.OFFLINE, "Could not reach desktop-zolder"),
            ),
        ),
    ).asStateFlow()

    override val conversations: StateFlow<List<ConversationRow>> =
        state.map { list -> list.map(::row).sortedByDescending { it.lastAt } }
            .stateIn(scope, SharingStarted.Eagerly, state.value.map(::row).sortedByDescending { it.lastAt })

    private val _events = MutableSharedFlow<HubEvent>(extraBufferCapacity = 16)
    override val events: SharedFlow<HubEvent> = _events

    override fun conversation(id: String): Flow<Conversation?> = state.map { list -> list.firstOrNull { it.id == id } }.distinctUntilChanged()

    override fun get(id: String): Conversation? = state.value.firstOrNull { it.id == id }

    private fun edit(id: String, transform: (Conversation) -> Conversation) {
        state.update { list -> list.map { if (it.id == id) transform(it) else it } }
    }

    private fun appendItem(id: String, item: Item) = edit(id) { it.copy(items = it.items + item, updatedAt = clock.now()) }

    private fun replaceItem(id: String, item: Item) = edit(id) { c -> c.copy(items = c.items.map { if (it.id == item.id) item else it }) }

    override suspend fun create(agent: String, message: MessageRef?, model: String?, effort: String?): Conversation {
        val now = clock.now()
        val c = Conversation(
            id = Ids.conversationId(clock), agent = agent, title = message?.subject.orEmpty().take(80), message = message,
            createdAt = now, updatedAt = now, model = model, effort = effort,
        )
        state.update { listOf(c) + it }
        return c
    }

    override suspend fun send(conversationId: String, request: SendRequest): SendResult {
        val c = get(conversationId) ?: throw AgentException(ErrorCodes.INVALID, "unknown conversation")
        if (c.status == ConversationStatus.RUNNING) throw AgentException(ErrorCodes.BUSY, "a turn is running")
        val text = request.skill?.let { "/$it" } ?: request.display ?: request.text
        if (text.isBlank()) throw AgentException(ErrorCodes.INVALID, "empty message")
        val user = Item.User(Ids.itemId(), clock.now(), text, request.action ?: request.skill?.let { "skill" })
        edit(conversationId) { it.copy(items = it.items + user, status = ConversationStatus.RUNNING, title = it.title.ifEmpty { text.take(80) }) }
        turns[conversationId] = scope.launch { stream(conversationId) }
        return SendResult(conversationId, user.id)
    }

    // A canned answer, streamed a few words at a time like a real agent.
    private suspend fun stream(id: String) {
        val tool = Item.Tool(Ids.itemId(), clock.now(), "search_mail", "Searched mail", "from:sanne@example.com", rukoo = true)
        appendItem(id, tool)
        delay(600)
        replaceItem(id, tool.copy(status = ToolStatus.DONE, endedAt = clock.now()))
        val words = "This is the preview agent. The real hub sends your message to the agent you picked and shows its answer here as it streams in."
            .split(' ')
        var item = Item.Assistant(Ids.itemId(), clock.now(), "", AssistantStatus.STREAMING)
        appendItem(id, item)
        for (w in words) {
            delay(60)
            item = item.copy(text = if (item.text.isEmpty()) w else "${item.text} $w")
            replaceItem(id, item)
        }
        replaceItem(id, item.copy(status = AssistantStatus.DONE))
        finish(id, TurnStatus.DONE)
    }

    private fun finish(id: String, status: TurnStatus) {
        val offScreen = watching != id && status != TurnStatus.STOPPED
        edit(id) { c ->
            c.copy(
                status = if (status == TurnStatus.ERROR) ConversationStatus.ERROR else ConversationStatus.IDLE,
                unread = if (offScreen) (if (status == TurnStatus.ERROR) Unread.ERROR else Unread.REPLY) else c.unread,
                delivered = true,
                items = c.items.map {
                    when {
                        it is Item.Assistant && it.status == AssistantStatus.STREAMING ->
                            it.copy(status = if (status == TurnStatus.STOPPED) AssistantStatus.STOPPED else AssistantStatus.DONE)
                        it is Item.Thinking && it.status == ThinkingStatus.RUNNING -> it.copy(status = ThinkingStatus.DONE, endedAt = clock.now())
                        it is Item.Tool && it.status == ToolStatus.RUNNING -> it.copy(status = ToolStatus.DONE, endedAt = clock.now())
                        it is Item.Approval && it.status == ApprovalStatus.PENDING && it.kind == ApprovalKind.RUNTIME -> it.copy(status = ApprovalStatus.EXPIRED)
                        else -> it
                    }
                },
            )
        }
        turns.remove(id)
        _events.tryEmit(HubEvent.TurnFinished(id, status, offScreen))
    }

    override suspend fun stop(conversationId: String) {
        turns.remove(conversationId)?.cancel()
        if (get(conversationId)?.status == ConversationStatus.RUNNING) finish(conversationId, TurnStatus.STOPPED)
    }

    override suspend fun decide(conversationId: String, itemId: String, choiceId: String): Item.Approval {
        val c = get(conversationId) ?: throw AgentException(ErrorCodes.INVALID, "unknown conversation")
        val item = c.items.firstOrNull { it.id == itemId } as? Item.Approval ?: throw AgentException(ErrorCodes.INVALID, "unknown item")
        if (item.status != ApprovalStatus.PENDING) return item
        val choice = item.choices.firstOrNull { it.id == choiceId } ?: throw AgentException(ErrorCodes.INVALID, "unknown choice")
        val denied = choice.kind == ChoiceKind.DANGER || choice.id in setOf("deny", "decline", "cancel")
        val decided = item.copy(status = if (denied) ApprovalStatus.DENIED else ApprovalStatus.APPROVED, decision = choice.id)
        replaceItem(conversationId, decided)
        waiters.remove(itemId)?.complete(choice.id)
        if (item.kind == ApprovalKind.PROPOSAL) {
            appendItem(conversationId, Item.User(Ids.itemId(), clock.now(), item.title, if (denied) "declined" else "approved"))
        }
        return decided
    }

    override suspend fun setChoice(conversationId: String, model: Change<String?>?, effort: Change<String?>?): Conversation {
        edit(conversationId) { c -> c.copy(model = if (model != null) model.value else c.model, effort = if (effort != null) effort.value else c.effort) }
        return get(conversationId) ?: throw AgentException(ErrorCodes.INVALID, "unknown conversation")
    }

    override fun watch(conversationId: String?) {
        watching = conversationId
        if (conversationId != null) edit(conversationId) { it.copy(unread = Unread.NONE) }
    }

    override suspend fun findFor(ref: MessageRef): Conversation? = state.value
        .filter { c ->
            val m = c.message ?: return@filter false
            m.id == ref.id || (ref.messageId != null && MessageIds.headerKey(m.messageId) == MessageIds.headerKey(ref.messageId))
        }
        .maxByOrNull { it.updatedAt }

    override suspend fun relatedFor(ref: MessageRef): RelatedChat? = null

    override suspend fun continueFrom(conversationId: String, emailId: String): Conversation =
        get(conversationId) ?: throw AgentException(ErrorCodes.INVALID, "unknown conversation")

    override fun quickActions(): List<QuickAction> = QuickAction.BUILT_IN

    override fun skills(): List<RukooSkill> = listOf(
        RukooSkill("unsubscribe-via-browser", "Unsubscribe through the sender's web page when one-click unsubscribe isn't offered.", "rukoo", ""),
        RukooSkill("data-deletion-request", "Ask a company to delete the personal data it holds about you.", "rukoo", ""),
    )

    override suspend fun models(agent: String, refresh: Boolean): ModelOptions = ModelOptions(
        agent = agent,
        models = listOf(
            ModelOption("gpt-5.5", "GPT-5.5", efforts = listOf("low", "medium", "high", "xhigh"), defaultEffort = "medium", isDefault = true),
            ModelOption("claude-opus-5-5", "Claude Opus 5.5", efforts = listOf("low", "medium", "high", "max")),
        ),
        efforts = listOf("low", "medium", "high", "xhigh"),
        defaultModel = "gpt-5.5",
    )

    override suspend fun ownSkills(agent: String, refresh: Boolean): OwnSkills = OwnSkills(
        agent,
        listOf(OwnSkill("todoist", "Add and update tasks in Todoist", "productivity"), OwnSkill("obsidian", "Search and write notes in the vault", "notes")),
    )

    override suspend fun test(agent: String): AgentStatus = agents.value.firstOrNull { it.id == agent }?.status ?: AgentStatus()

    override suspend fun undo(conversationId: String, itemId: String) {
        val notice = get(conversationId)?.items?.firstOrNull { it.id == itemId } as? Item.Notice ?: return
        replaceItem(conversationId, notice.copy(undo = null))
        appendItem(conversationId, Item.Notice(Ids.itemId(), clock.now(), "Restored 1 email", tone = Tone.SUCCESS, mail = NoticeMail("undo", count = 1)))
    }

    override suspend fun patchDraft(conversationId: String, itemId: String, undone: Boolean) {
        val draft = get(conversationId)?.items?.firstOrNull { it.id == itemId } as? Item.Draft ?: return
        replaceItem(conversationId, draft.copy(undone = undone))
    }

    override suspend fun remove(conversationId: String) {
        turns.remove(conversationId)?.cancel()
        state.update { list -> list.filterNot { it.id == conversationId } }
    }

    override fun agentEnabled(agent: String): Boolean = agents.value.any { it.id == agent && it.enabled }

    override fun agentName(agent: String): String = agents.value.firstOrNull { it.id == agent }?.name ?: agent

    override fun conversationForTool(identity: ToolIdentity, conversationIdArg: String?, meta: JsonObject?): Conversation? {
        val id = identity.conversationId ?: conversationIdArg ?: return null
        return get(id)?.takeIf { it.agent == identity.agent }
    }

    override suspend fun ensureConversation(identity: ToolIdentity, resolved: Conversation?, openMessageId: String?): Conversation {
        if (resolved != null) return resolved
        val now = clock.now()
        val c = Conversation(
            Ids.conversationId(clock), identity.agent, agentName(identity.agent), openMessageId?.let { MessageRef(it) },
            Origin.EXTERNAL, now, now,
        )
        state.update { listOf(c) + it }
        _events.tryEmit(HubEvent.Reveal(c.id))
        return c
    }

    override fun owns(identity: ToolIdentity, conversationId: String): Boolean = get(conversationId)?.agent == identity.agent

    override fun toolCalled(conversationId: String) = Unit

    override fun addItem(conversationId: String, item: Item): Item {
        val stamped = item.stamped(Ids.itemId(), clock.now())
        appendItem(conversationId, stamped)
        if (stamped is Item.Draft) _events.tryEmit(HubEvent.DraftWritten(conversationId, stamped.id))
        return stamped
    }

    override fun updateItem(conversationId: String, item: Item) = replaceItem(conversationId, item)

    override suspend fun requestApproval(conversationId: String, request: ApprovalRequest): ApprovalTicket {
        val item = Item.Approval(
            Ids.itemId(), clock.now(), request.title, request.detail, request.fields, request.tool,
            request.choices.ifEmpty { listOf(ApprovalChoice("allow", "Allow", ChoiceKind.PRIMARY), ApprovalChoice("deny", "Deny", ChoiceKind.DANGER)) },
            source = request.source, kind = request.kind, mail = request.mail,
        )
        appendItem(conversationId, item)
        val deferred = CompletableDeferred<String>()
        waiters[item.id] = deferred
        _events.tryEmit(HubEvent.ApprovalWaiting(conversationId, item.id))
        return ApprovalTicket(item.id, deferred)
    }

    override fun addNote(conversationId: String, note: String) = edit(conversationId) { it.copy(notes = it.notes + note) }

    private fun row(c: Conversation): ConversationRow {
        val last = c.items.lastOrNull { it is Item.User || it is Item.Assistant || it is Item.Approval }?.at ?: c.createdAt
        val preview = c.items.lastOrNull { (it is Item.Assistant && !it.interim) || it is Item.User }?.let {
            when (it) {
                is Item.Assistant -> it.text
                is Item.User -> it.text
                else -> ""
            }
        }.orEmpty().replace(Regex("\\s+"), " ").take(140)
        return ConversationRow(
            c.id, c.agent, c.title, c.message, c.origin, c.updatedAt, last, c.status, c.unread,
            waiting = c.items.any { it is Item.Approval && it.status == ApprovalStatus.PENDING },
            preview = preview,
        )
    }

    private fun sample(now: Long): List<Conversation> {
        val sanne = Address("Sanne de Vries", "sanne@example.com")
        val callRef = MessageRef(
            id = MessageIds.encode(PreviewData.ACCOUNT_ID, "INBOX", 12), messageId = "<demo-13@example.com>",
            accountId = PreviewData.ACCOUNT_ID, subject = "Call on Thursday", from = sanne, date = now - 86_400_000L,
        )
        var t = now - 40 * 60_000L
        fun at(): Long {
            t += 20_000
            return t
        }
        fun id() = Ids.itemId()
        val first = Conversation(
            id = "c_preview_call01", agent = AgentIds.CLARK, title = "Call on Thursday", message = callRef,
            createdAt = t, updatedAt = now - 5 * 60_000L, delivered = true, provider = mapOf("sessionId" to "preview-session"),
            items = listOf(
                Item.User(id(), at(), "Draft a reply", "reply"),
                at().let { Item.Thinking(id(), it, "Sanne wants a call on Thursday at 10:00 about the proposal.", ThinkingStatus.DONE, it, it + 4_000) },
                at().let { Item.Tool(id(), it, "search_mail", "Searched mail", "from:sanne@example.com", ToolStatus.DONE, it, it + 1_200, rukoo = true) },
                at().let { Item.Tool(id(), it, "read_message", "Read the email", "", ToolStatus.DONE, it, it + 800, rukoo = true) },
                at().let { Item.Tool(id(), it, "web_search", "Searched the web", "Proposal-v3 pricing", ToolStatus.ERROR, it, it + 9_000) },
                Item.Sources(
                    id(), at(), "What I used",
                    listOf(
                        SourceRef("Call on Thursday", "Email", "Shall we have a call on Thursday at 10:00 to discuss the proposal?", messageId = callRef.id, messageHeader = callRef.messageId, accountId = PreviewData.ACCOUNT_ID),
                        SourceRef("Proposal notes", "Obsidian", "Scope, timeline and the open pricing question.", url = "obsidian://open?vault=Personal&file=Proposal"),
                        SourceRef("Rukoo Mail", "Web", "The public repository.", url = "https://github.com/MajesteitBart/rukoo"),
                    ),
                ),
                Item.Plan(
                    id(), at(), "p1", "Follow-ups",
                    listOf(
                        PlanTask("t1", "Reply to Sanne", "Confirm Thursday 10:00", "Rukoo", TaskStatus.DONE),
                        PlanTask("t2", "Add the call to the calendar", "", "Google Calendar", TaskStatus.RUNNING),
                        PlanTask("t3", "Read Proposal-v3.pdf", "", "", TaskStatus.TODO, owner = "Demo User", due = "Wednesday"),
                        PlanTask("t4", "Tell Joris", "He is on Cc", "Slack", TaskStatus.PROPOSED),
                        PlanTask("t5", "Update the CRM deal", "", "HubSpot", TaskStatus.FAILED, url = "https://example.com/crm"),
                        PlanTask("t6", "Book a room", "It is a call", "", TaskStatus.SKIPPED),
                    ),
                ),
                Item.Draft(
                    id(), at(), DraftMode.REPLY, listOf(sanne), "Re: Call on Thursday",
                    "Hi Sanne, Thursday at 10:00 works for me. I will read the proposal before we talk.", callRef.id, "composer-preview",
                ),
                Item.Assistant(
                    id(), at(),
                    "I put a reply in the composer. I assumed **Thursday 10:00** works; check your calendar before you send it.\n\n- Joris is on Cc\n- The proposal is attached as `Proposal-v3.pdf`",
                ),
                Item.Approval(
                    id(), at(), "Add the call to your calendar", "Thursday 10:00-10:30 with Sanne de Vries",
                    listOf(ApprovalField("Calendar", "Work"), ApprovalField("Guests", "sanne@example.com")),
                    choices = listOf(ApprovalChoice("approve", "Approve", ChoiceKind.PRIMARY), ApprovalChoice("decline", "Decline")),
                    status = ApprovalStatus.APPROVED, decision = "approve", source = AgentIds.CLARK, kind = ApprovalKind.PROPOSAL,
                ),
                Item.User(id(), at(), "Add the call to your calendar", "approved"),
                Item.Notice(
                    id(), at(), "Archived 1 email", tone = Tone.SUCCESS,
                    undo = NoticeUndo(ids = listOf(MessageIds.encode(PreviewData.ACCOUNT_ID, "INBOX", 13))),
                    mail = NoticeMail("archive", count = 1, folder = "Archive"),
                ),
                Item.Approval(
                    id(), at(), "Post in #sales on Slack", "A short update for the team about Thursday's call.",
                    listOf(
                        ApprovalField("Channel", "#sales"),
                        ApprovalField("Message", "Sanne (Acme) and I talk about Proposal v3 on Thursday at 10:00. Message-ID <demo-13@example.com>."),
                    ),
                    choices = listOf(ApprovalChoice("approve", "Post it", ChoiceKind.PRIMARY), ApprovalChoice("decline", "Decline")),
                    source = AgentIds.CLARK, kind = ApprovalKind.PROPOSAL,
                ),
                Item.Approval(
                    id(), at(), "Archive 2 emails", "",
                    listOf(ApprovalField("Vandebron", "Here is another copy of your contract"), ApprovalField("Vandebron", "Here is another copy of your contract")),
                    choices = listOf(ApprovalChoice("approve", "Archive", ChoiceKind.PRIMARY), ApprovalChoice("decline", "Cancel")),
                    source = "rukoo", kind = ApprovalKind.MAIL,
                    mail = MailApproval("archive", listOf(MessageIds.encode(PreviewData.ACCOUNT_ID, "INBOX", 3), MessageIds.encode(PreviewData.ACCOUNT_ID, "INBOX", 4))),
                ),
            ),
        )
        t = now - 3 * 60_000L
        val claude = AgentIds.computer(pairing, ComputerProgram.CLAUDE)
        val second = Conversation(
            id = "c_preview_today1", agent = claude, title = "What needs me today?",
            createdAt = t, updatedAt = now, status = ConversationStatus.RUNNING, model = "opus", effort = "high",
            items = listOf(
                Item.User(id(), at(), "What needs me today?", "triage"),
                at().let { Item.Thinking(id(), it, "Seven unread emails in the inbox. Two are newsletters.", ThinkingStatus.DONE, it, it + 2_000) },
                at().let { Item.Tool(id(), it, "mcp__rukoo__search_mail", "Searched mail", "is:unread", ToolStatus.DONE, it, it + 700, rukoo = true) },
                Item.Assistant(id(), at(), "Checking your calendar first.", AssistantStatus.DONE, interim = true),
                at().let { Item.Tool(id(), it, "Bash", "Ran a command", "gcalcli agenda today", ToolStatus.RUNNING, it) },
                Item.Approval(
                    id(), at(), "Run a command", "",
                    listOf(ApprovalField("Command", "gcalcli agenda today tomorrow", key = "command")),
                    ApprovalTool("Bash", ToolKind.COMMAND),
                    listOf(
                        ApprovalChoice("allow", "Allow once", ChoiceKind.PRIMARY),
                        ApprovalChoice("always", "Always allow"),
                        ApprovalChoice("deny", "Deny", ChoiceKind.DANGER),
                    ),
                    source = claude, kind = ApprovalKind.RUNTIME,
                ),
                Item.Assistant(id(), at(), "Three emails need you today:\n\n1. **Sanne de Vries**: the call on Thursday", AssistantStatus.STREAMING),
            ),
        )
        t = now - 2 * 3_600_000L
        val third = Conversation(
            id = "c_preview_parcel", agent = AgentIds.OPENCLAW, title = "Your parcel is on its way",
            message = MessageRef(MessageIds.encode(PreviewData.ACCOUNT_ID, "INBOX", 14), "<demo-15@example.com>", PreviewData.ACCOUNT_ID, "Your parcel is on its way", Address("bol", "service@bol.com")),
            createdAt = t, updatedAt = t + 60_000, status = ConversationStatus.ERROR, unread = Unread.ERROR,
            items = listOf(
                Item.User(id(), at(), "When does it arrive?"),
                Item.Notice(id(), at(), "Could not reach the agent.", "connect timed out", Tone.ERROR, ErrorCodes.OFFLINE),
            ),
        )
        return listOf(second, first, third)
    }

    companion object {
        /** The sample computer the preview's Claude Code and Codex run on. */
        const val PAIRING = "ph_preview01"
    }
}
