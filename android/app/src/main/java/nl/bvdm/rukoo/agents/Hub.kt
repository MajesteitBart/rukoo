package nl.bvdm.rukoo.agents

import java.io.File
import java.io.IOException
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.KSerializer
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import nl.bvdm.rukoo.agents.model.AdapterEvent
import nl.bvdm.rukoo.agents.model.AgentDescriptor
import nl.bvdm.rukoo.agents.model.AgentErrorInfo
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.AgentKind
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.ApprovalStatus
import nl.bvdm.rukoo.agents.model.AssistantStatus
import nl.bvdm.rukoo.agents.model.AttachedEmail
import nl.bvdm.rukoo.agents.model.ComputerProgram
import nl.bvdm.rukoo.agents.model.ContinuedRef
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.ConversationRow
import nl.bvdm.rukoo.agents.model.ConversationStatus
import nl.bvdm.rukoo.agents.model.ConversationsFile
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MailApproval
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.ModelOption
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.NoticeMail
import nl.bvdm.rukoo.agents.model.NoticeParams
import nl.bvdm.rukoo.agents.model.Origin
import nl.bvdm.rukoo.agents.model.OwnSkills
import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.agents.model.RelatedChat
import nl.bvdm.rukoo.agents.model.RukooSkill
import nl.bvdm.rukoo.agents.model.ThinkingStatus
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.agents.model.ToolStatus
import nl.bvdm.rukoo.agents.model.TurnStatus
import nl.bvdm.rukoo.agents.model.Unread
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.Change
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.Ids
import nl.bvdm.rukoo.core.JsonFiles
import nl.bvdm.rukoo.core.Unsafe
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.UnsubscribeResult
import nl.bvdm.rukoo.mail.model.ViewKind
import nl.bvdm.rukoo.ui.ScreenState

/**
 * The phone's agent hub, a port of desktop's src/main/agents/hub.js (spec 1, spec 3 §3). It owns the
 * conversations, runs turns through the adapters, turns adapter events into transcript items, holds the
 * approval cards and the notes the agent gets with its next turn, and answers the MCP tools.
 *
 * All state sits behind one lock and changes in short sections without suspending; the UI reads
 * snapshots from the flows. Turns run in [scope], so they carry on when the UI goes away. Stopping a turn
 * cancels the adapter's coroutine; an adapter that doesn't end within 12 s is closed by the hub.
 */
class Hub(
    private val scope: CoroutineScope,
    private val mail: MailEngine,
    private val screen: ScreenState,
    private val settings: AgentSettingsStore,
    private val factory: AdapterFactory,
    dataDir: File,
    private val rukooSkills: RukooSkills = RukooSkills(null, null),
    private val alerts: AgentAlerts = AgentAlerts.None,
    private val strings: HubStrings = HubStrings.English,
    /** The phone's MCP endpoint while it serves Rukoo's tools, for turns on a paired computer. */
    private val mcpUrl: () -> String? = { null },
    /** Opens the unsubscribe page in the browser, or the unsubscribe email in the composer. */
    openUnsubscribe: suspend (UnsubscribeResult) -> Boolean = { false },
    private val clock: Clock = Clock.System,
    /** Lists the debug builds' scripted agent. */
    private val includeFake: Boolean = false,
    private val zone: () -> ZoneId = { ZoneId.systemDefault() },
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : AgentHub {
    private val file = File(dataDir, ConversationStore.FILE_NAME)
    private val mailActions = MailActions(mail, openUnsubscribe)

    private val lock = Any()
    private var depth = 0
    private var dirty = false
    private val convs = LinkedHashMap<String, Conversation>()
    private val turns = HashMap<String, Turn>()
    private val approvals = LinkedHashMap<String, Waiter>()
    private val followUps = HashMap<String, ArrayDeque<FollowUp>>()
    private val threads = HashMap<String, String>()
    private val mailChains = HashMap<String, Job>()
    private var watching: String? = null
    private var deltaJob: Job? = null
    private var saveJob: Job? = null
    private val saveMutex = Mutex()

    // Set when conversations.json exists but couldn't be read or kept aside: then it must not be written over.
    @Volatile private var keepFile = false
    private val loaded = CompletableDeferred<Unit>()

    private val modelLists = HashMap<String, Cached<ModelOptions>>()
    private val skillLists = HashMap<String, Cached<OwnSkills>>()
    private val statuses = HashMap<String, AgentStatus>()
    private val statusRound = HashMap<String, Int>()

    private val _store = MutableStateFlow<Map<String, Conversation>>(emptyMap())
    private val _rows = MutableStateFlow<List<ConversationRow>>(emptyList())
    private val _agents = MutableStateFlow(descriptors(settings.current()))
    private val _events = MutableSharedFlow<HubEvent>(extraBufferCapacity = 64)

    override val agents: StateFlow<List<AgentDescriptor>> = _agents.asStateFlow()
    override val conversations: StateFlow<List<ConversationRow>> = _rows.asStateFlow()
    override val events: SharedFlow<HubEvent> = _events

    private class Waiter(val cid: String, val choice: CompletableDeferred<String>, val key: String?, val turnId: String?)

    private class FollowUp(val text: String, val display: String)

    private class Cached<T>(val at: Long, val value: T?, val pending: Deferred<T>?)

    /** One turn (hub.js send()): what it owns in the transcript and how far it got. */
    private class Turn(
        val id: String,
        val cid: String,
        val userItem: String,
        val model: String?,
        val effort: String?,
        val emails: List<AttachedEmail>,
    ) {
        val items = HashSet<String>()
        val tools = HashMap<String, String>()
        var assistantId: String? = null
        val assistantText = StringBuilder()
        var thinkingId: String? = null
        val thinkingText = StringBuilder()
        var textDirty = false
        @Volatile var closed = false

        @Volatile var aborted = false
        var errorShown = false
        var lastError: AgentErrorInfo? = null

        /** The agent showed it got the input: it streamed, called a tool, asked for approval or accepted. */
        @Volatile var reached = false
        var adapterStarted = false
        var adapterJob: Job? = null
        val outcome = CompletableDeferred<TurnResult>()
        var stopTimer: Job? = null
        var approvalDisplay: String? = null
        var notes: List<String> = emptyList()
        var newer: List<NewerEmail> = emptyList()
        var givenBack = false
        @Volatile var startedOver = false
    }

    init {
        scope.launch(io) {
            try {
                load()
            } finally {
                // Even a store that failed to load must not leave the chat waiting forever.
                loaded.complete(Unit)
            }
            refreshStatus()
        }
        // A new URL, key or computer: the agents and their lists are as new.
        scope.launch(dispatcher) {
            settings.settings.drop(1).distinctUntilChanged().collect { configChanged() }
        }
        scope.launch(dispatcher) {
            var first = true
            screen.state.map { it.foreground }.distinctUntilChanged().collectLatest { foreground ->
                val wasFirst = first
                first = false
                if (foreground) {
                    onForeground()
                    // Back on screen, and then every few minutes while it stays there, the picker's dots are fresh.
                    if (!wasFirst) refreshStatus()
                    while (true) {
                        delay(STATUS_EVERY_MS)
                        refreshStatus()
                    }
                } else if (!wasFirst) {
                    // Android may end the process any time after this; keep the transcript.
                    flushSave()
                }
            }
        }
    }

    /** Waits until conversations.json was read. */
    suspend fun ready() = loaded.await()

    // ---------- state ----------

    private inline fun <T> locked(block: () -> T): T = synchronized(lock) {
        depth++
        try {
            block()
        } finally {
            depth--
            if (depth == 0 && dirty) {
                dirty = false
                publishLocked()
            }
        }
    }

    // Streaming text lives in the turn's builders; the item gets it whenever anything is published.
    private fun materializeLocked(turn: Turn) {
        if (!turn.textDirty) return
        turn.textDirty = false
        val c = convs[turn.cid] ?: return
        var items = c.items
        turn.assistantId?.let { id ->
            items = items.replaced(id) { (it as? Item.Assistant)?.copy(text = turn.assistantText.toString()) ?: it }
        }
        turn.thinkingId?.let { id ->
            items = items.replaced(id) { (it as? Item.Thinking)?.copy(text = turn.thinkingText.toString()) ?: it }
        }
        convs[c.id] = c.copy(items = items, updatedAt = clock.now())
    }

    // Rows of chats that didn't change are reused: streaming publishes every 50 ms.
    private val rowCache = HashMap<String, Pair<Conversation, ConversationRow>>()

    private fun publishLocked() {
        for (t in turns.values) materializeLocked(t)
        val snapshot = HashMap(convs)
        _store.value = snapshot
        rowCache.keys.retainAll(snapshot.keys)
        _rows.value = snapshot.values.map { c ->
            rowCache[c.id]?.takeIf { it.first === c }?.second ?: row(c, lastMessageAt(c)).also { rowCache[c.id] = c to it }
        }.sortedByDescending { it.lastAt }
    }

    // Adapters come from another track's factory; one that fails to build counts as missing, never as a crash.
    private fun adapterFor(agent: String): AgentAdapter? = try {
        factory.create(agent)
    } catch (e: Exception) {
        AppLog.w(TAG, "no adapter for an agent", e)
        null
    }

    // Notifications are posted off the lock; a failing one costs the notification, not the app.
    private fun alert(block: AgentAlerts.() -> Unit) {
        scope.launch(dispatcher) {
            try {
                alerts.block()
            } catch (e: Exception) {
                AppLog.w(TAG, "an agent notification failed", e)
            }
        }
    }

    private fun List<Item>.replaced(id: String, transform: (Item) -> Item): List<Item> {
        val i = indexOfFirst { it.id == id }
        if (i < 0) return this
        val out = toMutableList()
        out[i] = transform(out[i])
        return out
    }

    private fun touchLocked(cid: String) {
        val c = convs[cid] ?: return
        convs[cid] = c.copy(updatedAt = clock.now())
        dirty = true
        scheduleSaveLocked()
    }

    private fun editLocked(cid: String, touch: Boolean = true, transform: (Conversation) -> Conversation) {
        val c = convs[cid] ?: return
        convs[cid] = transform(c)
        dirty = true
        if (touch) touchLocked(cid) else scheduleSaveLocked()
    }

    private fun clipItem(item: Item): Item = when (item) {
        is Item.User -> item.copy(text = item.text.take(MAX_TEXT))
        is Item.Assistant -> item.copy(text = item.text.take(MAX_TEXT))
        is Item.Thinking -> item.copy(text = item.text.take(MAX_TEXT))
        is Item.Tool -> item.copy(detail = item.detail.take(MAX_TEXT))
        is Item.Approval -> item.copy(detail = item.detail.take(MAX_TEXT))
        is Item.Notice -> item.copy(text = item.text.take(MAX_TEXT), detail = item.detail?.take(MAX_TEXT))
        is Item.Draft -> item.copy(summary = item.summary.take(MAX_TEXT))
        else -> item
    }

    private fun addItemLocked(cid: String, raw: Item): Item {
        val c = convs[cid] ?: throw AgentException(ErrorCodes.INVALID, "unknown conversation")
        val item = clipItem(raw)
        val items = c.items.toMutableList()
        items += item
        trimItemsLocked(items, item.id)
        convs[cid] = c.copy(items = items)
        touchLocked(cid)
        return item
    }

    // Drops the oldest items past 400. An approval that still waits stays, so nobody waits on a card that is
    // gone; only when nothing else is left does the oldest one expire and go.
    private fun trimItemsLocked(items: MutableList<Item>, keep: String) {
        while (items.size > MAX_ITEMS) {
            var i = items.indexOfFirst { it.id != keep && !(it is Item.Approval && it.status == ApprovalStatus.PENDING) }
            if (i < 0) {
                i = 0
                approvals.remove(items[0].id)?.choice?.complete(CANCEL)
            }
            items.removeAt(i)
        }
    }

    private fun updateItemLocked(cid: String, item: Item) {
        val c = convs[cid] ?: return
        convs[cid] = c.copy(items = c.items.replaced(item.id) { item })
        touchLocked(cid)
    }

    private fun itemLocked(cid: String, id: String): Item? = convs[cid]?.items?.firstOrNull { it.id == id }

    private fun setStatusLocked(cid: String, status: ConversationStatus) = editLocked(cid) { it.copy(status = status) }

    private fun markUnreadLocked(cid: String, unread: Unread) {
        val c = convs[cid] ?: return
        if (c.unread == unread) return
        editLocked(cid, touch = false) { it.copy(unread = unread) }
    }

    private fun mustGetLocked(id: String): Conversation = convs[id] ?: throw AgentException(ErrorCodes.INVALID, "unknown conversation")

    private fun onScreen(cid: String) = watching == cid && screen.current.foreground

    // ---------- persistence ----------

    private fun load() {
        val text = try {
            if (!file.exists()) null else file.readText(Charsets.UTF_8)
        } catch (e: IOException) {
            // There but unreadable: saving now would write over what may still be recovered.
            AppLog.w(TAG, "could not read conversations; nothing is saved until the next start", e)
            keepFile = true
            null
        }
        val decoded = text?.let(ConversationStore::decode) ?: ConversationStore.Decoded(emptyList())
        // A file Rukoo can't read, or can read only in part, is kept aside instead of being overwritten.
        if (text != null && (decoded.unreadable || decoded.partial) && !keepAside(move = decoded.unreadable)) keepFile = true
        locked {
            for (c in decoded.conversations) {
                convs[c.id] = c
                c.provider["threadId"]?.let { threads[it] = c.id }
            }
            dirty = true
        }
    }

    // Whether the file is safe aside. If not, nothing is saved this run, so the original stays as it is.
    private fun keepAside(move: Boolean): Boolean {
        val bad = File(file.parentFile, "${file.name}.bad-${clock.now()}")
        return try {
            if (!move) {
                file.copyTo(bad, overwrite = true)
            } else if (!file.renameTo(bad)) {
                file.copyTo(bad, overwrite = true)
                file.delete()
            }
            true
        } catch (e: IOException) {
            AppLog.w(TAG, "could not keep the conversations file aside; nothing is saved until the next start", e)
            false
        }
    }

    private fun scheduleSaveLocked() {
        if (saveJob?.isActive == true) return
        val wait = if (turns.isEmpty()) SAVE_MS else SAVE_RUNNING_MS
        saveJob = scope.launch(io) {
            delay(wait)
            // From here a change schedules the next save, as desktop's timer does once it fired.
            locked { saveJob = null }
            save()
        }
    }

    private suspend fun save() = saveMutex.withLock {
        if (keepFile) return@withLock
        val snapshot = locked {
            for (t in turns.values) materializeLocked(t)
            convs.values.toList()
        }
        try {
            withContext(io) { JsonFiles.write(file, ConversationsFileWriter, snapshot) }
        } catch (e: IOException) {
            AppLog.w(TAG, "saving conversations failed", e)
        }
    }

    /** Saves now, as desktop does when it quits. */
    fun flushSave() {
        locked {
            saveJob?.cancel()
            saveJob = null
        }
        scope.launch(io) { save() }
    }

    // ---------- conversations (UI) ----------

    override fun conversation(id: String): Flow<Conversation?> = _store.map { it[id] }.distinctUntilChanged()

    override fun get(id: String): Conversation? = locked {
        turns[id]?.let {
            if (it.textDirty) dirty = true
            materializeLocked(it)
        }
        convs[id]
    }

    override fun watch(conversationId: String?) {
        val seen = locked {
            val c = conversationId?.let { convs[it] }
            watching = c?.id
            if (c != null && c.unread != Unread.NONE && screen.current.foreground) markUnreadLocked(c.id, Unread.NONE)
            c?.id
        }
        if (seen != null) alert { seen(seen) }
    }

    // Back on screen with a chat open: its answer is read now.
    private fun onForeground() {
        val seen = locked {
            val id = watching ?: return@locked null
            if (convs[id]?.unread != Unread.NONE) markUnreadLocked(id, Unread.NONE)
            id
        }
        if (seen != null) alert { seen(seen) }
    }

    override suspend fun create(agent: String, message: MessageRef?, model: String?, effort: String?): Conversation {
        loaded.await()
        val id = if (AgentIds.isKnown(agent)) agent else settings.current().defaultAgent
        if (!agentEnabled(id)) throw AgentException(ErrorCodes.DISABLED, "$id is turned off")
        val ref = messageRef(message)
        return locked {
            // Picked before the chat started; checked first, so a refused choice leaves no chat behind.
            val draft = Conversation(id = "", agent = id)
            val chosen = applyChoice(draft, Change(model), Change(effort))
            val c = createLocked(id, ref, Origin.PANEL, "").copy(model = chosen.model, effort = chosen.effort)
            convs[c.id] = c
            c
        }
    }

    private fun createLocked(agent: String, ref: MessageRef?, origin: Origin, title: String): Conversation {
        val now = clock.now()
        val c = Conversation(
            id = Ids.conversationId(clock),
            agent = agent,
            title = (ref?.subject?.takeIf { it.isNotEmpty() } ?: title).take(80),
            message = ref,
            origin = origin,
            createdAt = now,
            updatedAt = now,
        )
        convs[c.id] = c
        enforceLimitLocked(c)
        dirty = true
        scheduleSaveLocked()
        return c
    }

    // At most 150 panel chats and 20 external ones, each counted on its own, so an agent calling in from
    // outside can never push out the user's own chats. The oldest idle ones go first.
    private fun enforceLimitLocked(keep: Conversation) {
        val external = keep.origin == Origin.EXTERNAL
        val max = if (external) MAX_EXTERNAL else MAX_CONVERSATIONS
        val same = convs.values.filter { (it.origin == Origin.EXTERNAL) == external }
        val idle = same.filter { it.id != keep.id && !turns.containsKey(it.id) }.sortedBy { it.updatedAt }.toMutableList()
        var n = same.size
        while (n > max && idle.isNotEmpty()) {
            dropLocked(idle.removeAt(0))
            n--
        }
    }

    override suspend fun remove(conversationId: String) {
        loaded.await()
        locked {
            val c = convs[conversationId] ?: return@locked
            dropLocked(c)
            scheduleSaveLocked()
        }
    }

    private fun dropLocked(c: Conversation) {
        turns[c.id]?.let { turn ->
            turn.aborted = true
            turn.adapterJob?.cancel()
            finishTurnLocked(turn, TurnResult.STOPPED)
        }
        for ((itemId, w) in approvals.entries.toList()) {
            if (w.cid != c.id) continue
            approvals.remove(itemId)
            w.choice.complete(CANCEL)
        }
        followUps.remove(c.id)
        threads.entries.removeAll { it.value == c.id }
        convs.remove(c.id)
        mailChains.remove(c.id)
        if (watching == c.id) watching = null
        dirty = true
        // The adapter drops what it keeps for the chat (a computer forgets its session).
        scope.launch(dispatcher) {
            try {
                adapterFor(c.agent)?.forget(c.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                AppLog.w(TAG, "forgetting a chat failed", e)
            }
            alert { seen(c.id) }
        }
    }

    private fun normId(v: String?): String = (v ?: "").trim().removePrefix("<").removeSuffix(">").lowercase()

    private fun accountOfId(id: String?): String? = id?.let { MessageIds.decode(it)?.accountId }

    /** The email reference the UI sends, clipped and with its gaps filled from the mail cache (hub.js messageRef()). */
    private suspend fun messageRef(input: MessageRef?): MessageRef? {
        if (input == null || input.id.isEmpty()) return null
        val id = input.id.take(2000)
        var ref = MessageRef(
            id = id,
            messageId = input.messageId?.takeIf { it.isNotEmpty() }?.take(1000),
            accountId = input.accountId?.takeIf { it.isNotEmpty() }?.take(200),
            subject = input.subject.take(1000),
            from = input.from?.let { Address(it.name.take(200), it.address.take(320)) },
            date = input.date?.takeIf { it != 0L },
            // Keeps the /unsubscribe command for the chat once the email is no longer on screen.
            unsubscribe = input.unsubscribe,
        )
        val cached = summaryOf(id)
        if (cached != null) {
            ref = ref.copy(
                messageId = ref.messageId ?: cached.messageId?.takeIf { it.isNotEmpty() },
                subject = ref.subject.ifEmpty { cached.subject },
                from = ref.from ?: Address(cached.from.name, cached.from.address),
                date = ref.date ?: cached.date.takeIf { it != 0L },
                // Kept for the thread check, from Rukoo's own cache.
                inReplyTo = cached.inReplyTo?.takeIf { it.isNotEmpty() }?.take(1000),
                accountId = ref.accountId ?: MessageIds.accountOf(id) ?: cached.accountId,
            )
        }
        return ref
    }

    private suspend fun summaryOf(id: String) = try {
        mail.summary(id)
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    override suspend fun setChoice(conversationId: String, model: Change<String?>?, effort: Change<String?>?): Conversation = locked {
        val c = mustGetLocked(conversationId)
        convs[c.id] = applyChoice(c, model, effort)
        touchLocked(c.id)
        convs.getValue(c.id)
    }

    // A model and effort picked in the chat; null follows the agent's default. An effort the model doesn't offer
    // goes back to the default. A turn that runs now keeps what it started with.
    private fun applyChoice(c: Conversation, model: Change<String?>?, effort: Change<String?>?): Conversation {
        val m = if (model != null) cleanModel(model.value, strict = true) else c.model
        var e = if (effort != null) effort.value?.takeIf { it.isNotEmpty() } else c.effort
        if (e != null && e !in ModelOptions.EFFORTS) throw AgentException(ErrorCodes.INVALID, "effort must be one of ${ModelOptions.EFFORTS.joinToString(", ")}")
        val offered = if (e != null) effortsFor(c.agent, m) else null
        if (offered != null && e !in offered) e = null
        return c.copy(model = m, effort = e)
    }

    // The efforts the agent's list offers for a model (null: its default model), or null without a list to go by.
    private fun effortsFor(agent: String, model: String?): List<String>? {
        val list = modelLists[agent]?.value ?: return null
        if (list.error != null) return null
        if (model == null) return list.efforts
        return list.models.firstOrNull { it.id == model }?.efforts ?: list.custom
    }

    private fun turnEffort(c: Conversation): String? {
        val offered = if (c.effort != null) effortsFor(c.agent, c.model) else null
        return if (offered != null && c.effort !in offered) null else c.effort
    }

    // ---------- finding chats for an email ----------

    override suspend fun findFor(ref: MessageRef): Conversation? {
        loaded.await()
        return locked {
            val want = normId(ref.messageId)
            val id = ref.id
            // The same email can arrive in two accounts; each copy has its own chats.
            val account = ref.accountId ?: accountOfId(id)
            fun about(mId: String, mMessageId: String?, mAccount: String?): Boolean {
                val own = mAccount ?: accountOfId(mId)
                return if (want.isNotEmpty() && !mMessageId.isNullOrEmpty()) {
                    normId(mMessageId) == want && !(account != null && own != null && own != account)
                } else {
                    id.isNotEmpty() && mId == id
                }
            }
            convs.values.filter { c ->
                val m = c.message
                (m != null && about(m.id, m.messageId, m.accountId)) || c.continued.any { about(it.id, it.messageId, it.accountId) }
            }.maxByOrNull { it.updatedAt }
        }
    }

    /** An email's headers as the thread check uses them (tools.js threadIds/linked). */
    private data class ThreadEmail(val messageId: String?, val inReplyTo: String?, val references: List<String>, val date: Long)

    private fun threadIds(m: ThreadEmail): Set<String> = (listOf(m.messageId, m.inReplyTo) + m.references).map { normId(it) }.filter { it.isNotEmpty() }.toSet()

    private fun linked(ids: Set<String>, r: ThreadEmail): Boolean {
        val mid = normId(r.messageId)
        if ((mid.isNotEmpty() && mid in ids) || (!r.inReplyTo.isNullOrEmpty() && normId(r.inReplyTo) in ids)) return true
        return r.references.any { normId(it) in ids }
    }

    // The Message-IDs of earlier mail in an email's thread within one account, by headers only (tools.js
    // earlierInThread): what it names, and older mail in the cache or among known that is linked to those.
    private suspend fun earlierInThread(m: ThreadEmail, accountId: String, known: List<ThreadEmail>): Set<String> {
        val self = normId(m.messageId)
        val named = threadIds(m).filter { it != self }.toSet()
        val out = named.toMutableSet()
        val date = m.date
        // An email that answers nothing starts its thread: most mail stops here.
        if (named.isEmpty() || date == 0L) return out
        fun older(r: ThreadEmail) {
            val mid = normId(r.messageId)
            if (mid.isNotEmpty() && mid != self && r.date < date && linked(named, r)) out += mid
        }
        val cached = try {
            mail.listMessages(MailView(ViewKind.EVERYTHING, accountId))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
        for (r in cached) older(ThreadEmail(r.messageId, r.inReplyTo, emptyList(), r.date))
        for (r in known) older(r)
        return out
    }

    // A chat's emails in this account: its own and the ones it was continued from, with the headers it kept.
    private fun chatEmails(c: Conversation, account: String): List<ThreadEmail> {
        val m = c.message ?: return emptyList()
        val own = if (!m.messageId.isNullOrEmpty() && (m.accountId ?: accountOfId(m.id)) == account) {
            listOf(ThreadEmail(m.messageId, m.inReplyTo, m.references.orEmpty(), m.date ?: 0))
        } else {
            emptyList()
        }
        return own + c.continued.filter { !it.messageId.isNullOrEmpty() && (it.accountId ?: accountOfId(it.id)) == account }
            .map { ThreadEmail(it.messageId, it.inReplyTo, it.references.orEmpty(), it.date ?: 0) }
    }

    private fun inThread(c: Conversation, earlier: Set<String>, account: String) = chatEmails(c, account).any { normId(it.messageId) in earlier }

    override suspend fun relatedFor(ref: MessageRef): RelatedChat? {
        loaded.await()
        val id = ref.id
        val cached = if (id.isNotEmpty()) summaryOf(id) else null
        val account = accountOfId(id) ?: cached?.accountId ?: ref.accountId ?: return null
        val email = ThreadEmail(
            messageId = ref.messageId ?: cached?.messageId,
            inReplyTo = ref.inReplyTo ?: cached?.inReplyTo,
            references = ref.references.orEmpty(),
            date = ref.date?.takeIf { it != 0L } ?: cached?.date ?: 0,
        )
        val chats = locked { convs.values.toList() }
        val earlier = earlierInThread(email, account, chats.flatMap { chatEmails(it, account) })
        if (earlier.isEmpty()) return null
        val best = chats.filter { inThread(it, earlier, account) }.maxByOrNull { it.updatedAt } ?: return null
        val m = best.message ?: return null
        return RelatedChat(best.id, best.agent, best.title, best.updatedAt, m.subject, m.from, m.date)
    }

    private data class Known(val account: String, val full: FullMessage?, val email: ThreadEmail)

    // What Rukoo itself knows of an email that is here: its account and its headers, never the UI's.
    private suspend fun threadEmail(id: String): Known? {
        val cached = summaryOf(id) ?: return null
        val account = accountOfId(id) ?: return null
        val full = fullOf(id)
        return Known(
            account, full,
            ThreadEmail(full?.messageId ?: cached.messageId, full?.inReplyTo ?: cached.inReplyTo, full?.references.orEmpty(), full?.date ?: cached.date),
        )
    }

    private suspend fun fullOf(id: String): FullMessage? = try {
        mail.fullMessage(id)
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    private fun sameEmail(aId: String, aMessageId: String?, b: MessageRef): Boolean =
        if (!aMessageId.isNullOrEmpty() && !b.messageId.isNullOrEmpty()) normId(aMessageId) == normId(b.messageId) else aId == b.id

    override suspend fun continueFrom(conversationId: String, emailId: String): Conversation {
        loaded.await()
        locked { mustGetLocked(conversationId) }
        val ref = messageRef(MessageRef(emailId))
        val known = ref?.let { threadEmail(it.id) } ?: throw AgentException(ErrorCodes.INVALID, "no such email to continue from")
        val c = locked { mustGetLocked(conversationId) }
        c.message?.let { if (sameEmail(it.id, it.messageId, ref)) return c }
        val earlier = earlierInThread(known.email, known.account, chatEmails(c, known.account))
        if (!inThread(c, earlier, known.account)) throw AgentException(ErrorCodes.INVALID, "that email is not a newer one in this chat's thread")
        var entry = ContinuedRef.of(ref.copy(messageId = known.email.messageId ?: ref.messageId), clock.now(), pending = true)
        known.full?.let { full ->
            val (inReplyTo, references) = threadHeaders(full)
            entry = entry.copy(inReplyTo = inReplyTo, references = references)
        }
        return locked {
            editLocked(conversationId) { now ->
                now.copy(continued = pruneContinued(now.continued.filterNot { sameEmail(it.id, it.messageId, ref) } + entry))
            }
            mustGetLocked(conversationId)
        }
    }

    // Past 20 the oldest emails the agent has had go; one it hasn't had yet stays until a message takes it.
    private fun pruneContinued(list: List<ContinuedRef>): List<ContinuedRef> {
        val out = list.toMutableList()
        var i = 0
        while (out.size > MAX_CONTINUED && i < out.size) {
            if (out[i].pending) i++ else out.removeAt(i)
        }
        return out
    }

    private fun threadHeaders(full: FullMessage): Pair<String?, List<String>> =
        full.inReplyTo?.takeIf { it.isNotEmpty() }?.take(1000) to full.references.takeLast(MAX_REFERENCES).map { it.take(1000) }.filter { it.isNotEmpty() }

    // ---------- quick actions, skills, models ----------

    override fun quickActions(): List<QuickAction> = QuickActions.list(settings.current().shortcuts)

    override fun skills(): List<RukooSkill> = rukooSkills.models()

    override fun readSkill(name: String?, file: String?): JsonObject = rukooSkills.read(name, file)

    override suspend fun models(agent: String, refresh: Boolean): ModelOptions {
        if (!AgentIds.isKnown(agent)) throw AgentException(ErrorCodes.INVALID, "unknown agent")
        return cachedList(modelLists, agent, refresh, MODELS_TTL_MS, MODELS_RETRY_MS, { it.error != null }) { loadModels(agent) }
    }

    override suspend fun ownSkills(agent: String, refresh: Boolean): OwnSkills {
        if (!AgentIds.isKnown(agent)) throw AgentException(ErrorCodes.INVALID, "unknown agent")
        return cachedList(skillLists, agent, refresh, OWN_SKILLS_TTL_MS, OWN_SKILLS_RETRY_MS, { it.error != null }) { loadOwnSkills(agent) }
    }

    // A list stays good for its TTL; asked with refresh (a menu opened), or after a failure, it is loaded again
    // sooner. One load at a time per agent; a settings change meanwhile drops the result.
    private suspend fun <T> cachedList(
        lists: HashMap<String, Cached<T>>,
        agent: String,
        refresh: Boolean,
        ttl: Long,
        retry: Long,
        failed: (T) -> Boolean,
        load: suspend () -> T,
    ): T {
        var fresh: T? = null
        val pending = locked {
            val entry = lists[agent]
            entry?.pending?.let { return@locked it }
            val value = entry?.value
            if (value != null && clock.now() - entry.at < (if (refresh || failed(value)) retry else ttl)) {
                fresh = value
                return@locked null
            }
            val job = scope.async(dispatcher, start = CoroutineStart.LAZY) { load() }
            // The list before stays in use (effortsFor) until the new one is in.
            lists[agent] = Cached(entry?.at ?: 0, value, job)
            job
        }
        if (pending == null) {
            @Suppress("UNCHECKED_CAST")
            return fresh as T
        }
        pending.start()
        val value = pending.await()
        locked {
            if (lists[agent]?.pending === pending) lists[agent] = Cached(clock.now(), value, null)
        }
        return value
    }

    private suspend fun <T> timed(ms: Long, block: suspend CoroutineScope.() -> T): T = try {
        withTimeout(ms, block)
    } catch (e: TimeoutCancellationException) {
        throw AgentException(ErrorCodes.TIMEOUT, "no answer after $ms ms")
    }

    private fun adapterOrThrow(agent: String, what: String): AgentAdapter =
        adapterFor(agent) ?: if (!configured(agent)) {
            throw AgentException(ErrorCodes.NOT_CONFIGURED, "$agent is not set up")
        } else {
            throw AgentException(ErrorCodes.UNKNOWN, "$agent cannot list its $what")
        }

    private suspend fun loadModels(agent: String): ModelOptions {
        val settingsModel = settingsModel(agent).trim()
        var res: ModelOptions? = null
        var error: AgentErrorInfo? = null
        try {
            val adapter = adapterOrThrow(agent, "models")
            res = timed(MODELS_TIMEOUT_MS) { adapter.models() }
        } catch (e: AgentException) {
            error = toError(e)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = toError(e)
        }
        val models = mutableListOf<ModelOption>()
        for (m in res?.models.orEmpty()) {
            if (models.size >= MAX_MODELS) break
            val id = cleanModel(m.id, strict = false) ?: continue
            if (models.any { it.id == id }) continue
            models += ModelOption(
                id = id,
                label = m.label.ifEmpty { id }.take(120),
                group = m.group?.takeIf { it.isNotEmpty() }?.take(80),
                tag = m.tag?.takeIf { it.isNotEmpty() }?.take(120),
                route = m.route,
                isDefault = m.isDefault,
                efforts = cleanEfforts(m.efforts),
                defaultEffort = m.defaultEffort.takeIf { it in ModelOptions.EFFORTS }.orEmpty(),
            )
        }
        val custom = cleanEfforts(res?.custom.orEmpty())
        // A model in Settings that the agent doesn't list is still the default.
        if (settingsModel.isNotEmpty() && models.none { it.id == settingsModel }) models.add(0, ModelOption(settingsModel, settingsModel, efforts = custom))
        val own = if (settingsModel.isNotEmpty()) models.firstOrNull { it.id == settingsModel } else null
        return ModelOptions(
            agent = agent,
            models = models,
            efforts = own?.efforts ?: cleanEfforts(res?.efforts.orEmpty()),
            custom = custom,
            // A computer's list comes with the default model its own Settings name.
            defaultModel = settingsModel.ifEmpty { res?.defaultModel.orEmpty() },
            error = error,
        )
    }

    private suspend fun loadOwnSkills(agent: String): OwnSkills = try {
        if (!agentEnabled(agent)) throw AgentException(ErrorCodes.DISABLED, "$agent is turned off")
        val adapter = adapterOrThrow(agent, "skills")
        OwnSkills(agent, OwnSkillMentions.cleanList(timed(OWN_SKILLS_TIMEOUT_MS) { adapter.skills() }), null)
    } catch (e: AgentException) {
        OwnSkills(agent, emptyList(), toError(e))
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        OwnSkills(agent, emptyList(), toError(e))
    }

    // The agent's own skills the user's text names as $name. Only what the user wrote counts, never what Rukoo
    // adds around it; without a list nothing counts as a skill.
    private suspend fun mentionedSkills(agent: String, text: String, action: String?): List<String> {
        if (action in NO_MENTIONS || !OwnSkillMentions.mayMention(text)) return emptyList()
        val list = withTimeoutOrNull(MENTION_TIMEOUT_MS) { ownSkills(agent) } ?: return emptyList()
        return OwnSkillMentions.mentionsIn(text, list.skills.map { it.name }.toSet()).distinct()
    }

    // ---------- agents ----------

    override fun agentEnabled(agent: String): Boolean {
        val s = settings.current()
        if (agent == AgentIds.CLARK) return s.clark.enabled
        if (agent == AgentIds.OPENCLAW) return s.openclaw.enabled
        if (agent == AgentIds.FAKE) return includeFake
        val (pairing, program) = AgentIds.parseComputer(agent) ?: return false
        val computer = s.computer(pairing) ?: return false
        return if (program == ComputerProgram.CLAUDE) computer.claudeEnabled else computer.codexEnabled
    }

    private fun configured(agent: String): Boolean {
        val s = settings.current()
        return when (agent) {
            AgentIds.CLARK -> s.clark.configured
            AgentIds.OPENCLAW -> s.openclaw.configured
            AgentIds.FAKE -> includeFake
            else -> AgentIds.parseComputer(agent)?.let { s.computer(it.first) } != null
        }
    }

    private fun settingsModel(agent: String): String {
        val s = settings.current()
        return when (agent) {
            AgentIds.CLARK -> s.clark.model
            AgentIds.OPENCLAW -> s.openclaw.model
            else -> ""
        }
    }

    override fun agentName(agent: String): String {
        if (agent == AgentIds.CLARK) return settings.current().clark.name.ifEmpty { "Hermes" }
        if (agent == AgentIds.OPENCLAW) return "OpenClaw"
        if (agent == AgentIds.FAKE) return strings.fakeName
        return when (AgentIds.parseComputer(agent)?.second) {
            ComputerProgram.CLAUDE -> "Claude"
            ComputerProgram.CODEX -> "Codex"
            null -> agent
        }
    }

    private fun agentIds(s: AgentSettings): List<String> = buildList {
        add(AgentIds.CLARK)
        add(AgentIds.OPENCLAW)
        for (c in s.computers) {
            add(AgentIds.computer(c.pairingId, ComputerProgram.CLAUDE))
            add(AgentIds.computer(c.pairingId, ComputerProgram.CODEX))
        }
        if (includeFake) add(AgentIds.FAKE)
    }

    private fun descriptors(s: AgentSettings): List<AgentDescriptor> = agentIds(s).map { id ->
        val enabled = agentEnabled(id)
        val status = if (!enabled) AgentStatus(AgentState.DISABLED) else statuses[id] ?: AgentStatus(AgentState.CHECKING)
        val computer = AgentIds.parseComputer(id)
        when {
            id == AgentIds.CLARK -> AgentDescriptor(id, AgentKind.HERMES, agentName(id), "", enabled, status)
            id == AgentIds.OPENCLAW -> AgentDescriptor(id, AgentKind.OPENCLAW, "OpenClaw", "", enabled, status)
            id == AgentIds.FAKE -> AgentDescriptor(id, AgentKind.FAKE, strings.fakeName, "", enabled, status)
            else -> {
                val name = s.computer(computer!!.first)?.name.orEmpty()
                val claude = computer.second == ComputerProgram.CLAUDE
                AgentDescriptor(id, if (claude) AgentKind.CLAUDE else AgentKind.CODEX, if (claude) "Claude Code" else "Codex", strings.onComputer(name), enabled, status)
            }
        }
    }

    private fun publishAgents() {
        _agents.value = synchronized(lock) { descriptors(settings.current()) }
    }

    private fun configChanged() {
        locked {
            modelLists.clear()
            skillLists.clear()
        }
        publishAgents()
        scope.launch(dispatcher) { refreshStatus(force = true) }
    }

    private suspend fun agentStatus(id: String, force: Boolean): AgentStatus {
        if (!agentEnabled(id)) return AgentStatus(AgentState.DISABLED)
        val a = adapterFor(id) ?: return if (!configured(id)) unconfigured(id) else AgentStatus(AgentState.UNKNOWN, "adapter not available")
        return try {
            val s = timed(STATUS_TIMEOUT_MS) { a.status(force) }
            AgentStatus(if (s.state == AgentState.CHECKING) AgentState.UNKNOWN else s.state, s.detail.take(300))
        } catch (e: AgentException) {
            AgentStatus(AgentState.UNKNOWN, e.detail.take(300))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            AgentStatus(AgentState.UNKNOWN, toError(e).detail.take(300))
        }
    }

    private fun unconfigured(id: String): AgentStatus {
        val s = settings.current()
        val detail = when (id) {
            AgentIds.CLARK -> if (s.clark.url.isBlank()) "No server URL" else "No API key"
            AgentIds.OPENCLAW -> if (s.openclaw.url.isBlank()) "No gateway URL" else "No gateway token"
            else -> ""
        }
        return AgentStatus(AgentState.UNCONFIGURED, detail)
    }

    // A forced probe asks with the settings as they are now, so an older probe answering after it is dropped.
    private suspend fun probeStatus(id: String, force: Boolean): Boolean {
        val round = locked {
            if (force) statusRound[id] = (statusRound[id] ?: 0) + 1
            statusRound[id] ?: 0
        }
        val s = agentStatus(id, force)
        val changed = locked {
            if ((statusRound[id] ?: 0) != round) return@locked false
            val before = statuses[id]
            statuses[id] = s
            before != s
        }
        if (changed) publishAgents()
        return changed
    }

    private suspend fun refreshStatus(force: Boolean = false) {
        coroutineScope { agentIds(settings.current()).map { async { probeStatus(it, force) } }.awaitAll() }
    }

    override fun refreshAgents() {
        scope.launch(dispatcher) { refreshStatus() }
    }

    override suspend fun test(agent: String): AgentStatus {
        probeStatus(agent, force = true)
        return locked { statuses[agent] } ?: AgentStatus()
    }

    // ---------- turns ----------

    override suspend fun send(conversationId: String, request: SendRequest): SendResult {
        loaded.await()
        val c0 = locked {
            val c = mustGetLocked(conversationId)
            if (turns.containsKey(conversationId)) throw AgentException(ErrorCodes.BUSY, "a turn is running")
            c
        }
        if (!agentEnabled(c0.agent)) throw AgentException(ErrorCodes.DISABLED, "${c0.agent} is turned off")
        var text = request.text
        var action = request.action
        var display = request.display
        if (request.skill != null) {
            val s = withContext(io) { rukooSkills.get(request.skill) } ?: throw AgentException("skill-missing", "no skill named ${request.skill.take(80)}")
            text = TurnContext.skillTurn(s.toModel())
            action = "skill"
            display = "/${s.name}"
        }
        val body = text.take(MAX_MESSAGE)
        val mails = attachEmails(c0, request.emails)
        if (body.isBlank() && mails.isEmpty()) throw AgentException(ErrorCodes.INVALID, "empty message")
        return locked { startTurnLocked(conversationId, body, action, display, mails) }
    }

    // The part of send() that needs nothing loaded: checks, the user item, and the turn. An approved proposal's
    // follow-up starts here directly, as desktop's does, so two approvals can't race to the same idle chat.
    private fun startTurnLocked(cid: String, body: String, action: String?, display: String?, mails: List<AttachedEmail>): SendResult {
        val c = mustGetLocked(cid)
        if (turns.containsKey(c.id)) throw AgentException(ErrorCodes.BUSY, "a turn is running")
        if (!agentEnabled(c.agent)) throw AgentException(ErrorCodes.DISABLED, "${c.agent} is turned off")
        val firstTurn = !c.delivered
        // The agent's new session hasn't had the chat yet: the email and a recap go along again.
        val recap = !firstTurn && c.needsRecap
        val shown = display?.take(MAX_MESSAGE) ?: body
        // display can be an approved proposal's title: the agent gets its tags, the user's line shows the text.
        val line = if (display != null) Unsafe.untag(shown) else shown
        if (c.title.isEmpty()) {
            val named = if (line.isNotBlank()) line else mails.joinToString(", ") { it.subject }
            editLocked(c.id, touch = false) { it.copy(title = jsOneLine(named).take(80)) }
        }
        val user = addItemLocked(c.id, Item.User(Ids.itemId(), clock.now(), line, action, emails = mails.takeIf { it.isNotEmpty() }))
        val turn = Turn(Ids.turnId(), c.id, user.id, c.model, turnEffort(c), mails)
        // Kept from the start, so a stop before the turn gets going still keeps the approval.
        if (action == "approved") turn.approvalDisplay = shown.ifEmpty { body }
        turns[c.id] = turn
        setStatusLocked(c.id, ConversationStatus.RUNNING)
        scope.launch(dispatcher) { runTurn(c.id, turn, body, action, firstTurn, recap) }
        return SendResult(c.id, user.id)
    }

    // Emails the user added to a message, by Rukoo id. Only an email Rukoo has counts, and its subject and
    // sender come from Rukoo's cache. The chat's own email and ones it was continued from are there already.
    private suspend fun attachEmails(c: Conversation, ids: List<String>): List<AttachedEmail> {
        if (ids.size > MAX_EMAILS) throw AgentException(ErrorCodes.INVALID, "at most $MAX_EMAILS emails per message")
        val out = mutableListOf<AttachedEmail>()
        val gone = mutableListOf<String>()
        val seen = mutableListOf<String>()
        fun same(a: String?, b: String?) = !a.isNullOrEmpty() && !b.isNullOrEmpty() && normId(a) == normId(b)
        for (raw in ids) {
            val id = raw.take(4000)
            if (id.isEmpty() || out.any { it.id == id } || id in gone || c.message?.id == id) continue
            val m = summaryOf(id)
            if (m == null) {
                gone += id
                continue
            }
            if (seen.any { same(it, m.messageId) } || same(c.message?.messageId, m.messageId)) continue
            if (c.continued.any { it.id == id || same(it.messageId, m.messageId) }) continue
            m.messageId?.let { seen += it }
            out += AttachedEmail(id, m.subject.take(300), Address(m.from.name.take(200), m.from.address.take(320)))
        }
        // Named as JSON, so the UI drops exactly those and keeps the rest.
        if (gone.isNotEmpty()) throw AgentException("email-missing", JsonArray(gone.map { JsonPrimitive(it) }).toString())
        return out
    }

    // Stopped while it waited: stop() closed the turn already, or does now. Gives back what the turn took.
    private fun stoppedEarly(turn: Turn): Boolean = locked {
        if (!turn.closed && !turn.aborted) return@locked false
        if (convs[turn.cid] != null) giveBackLocked(turn.cid, turn)
        finishTurnLocked(turn, TurnResult.STOPPED)
        true
    }

    private suspend fun runTurn(cid: String, turn: Turn, text: String, action: String?, firstTurn: Boolean, recap: Boolean) {
        var result: TurnResult
        try {
            val agent = locked { convs[cid]?.agent } ?: return
            val adapter = adapterFor(agent)
                ?: throw if (!configured(agent)) AgentException(ErrorCodes.NOT_CONFIGURED, "$agent is not set up") else AgentException(ErrorCodes.UNKNOWN, "$agent adapter not available")
            // Mail work that still runs reports into the notes this turn takes: wait for all of it first.
            awaitMail(cid)
            if (stoppedEarly(turn)) return
            val chatEmail = locked { convs[cid]?.message }
            var message: LoadedEmail? = null
            if ((firstTurn || recap) && chatEmail != null) {
                message = loadEmail(cid, null).email
                if (stoppedEarly(turn)) return
            }
            // Newer emails the chat was continued from go along once; a new session gets the newest one again.
            var newer = emptyList<NewerEmail>()
            if (locked { convs[cid]?.continued?.isNotEmpty() == true }) {
                newer = loadNewer(cid, again = recap)
                if (stoppedEarly(turn)) return
            }
            turn.newer = newer
            val named = mentionedSkills(agent, text, action)
            if (stoppedEarly(turn)) return
            val open = if (firstTurn) null else openLine(cid, newer)
            val handle = locked {
                if (turn.closed || turn.aborted) return@locked null
                val c = convs[cid] ?: return@locked null
                val notes = c.notes
                convs[cid] = c.copy(notes = emptyList())
                touchLocked(cid)
                turn.notes = notes
                val input = TurnContext.turnText(
                    conversationId = c.id, chatEmail = c.message, text = text, firstTurn = firstTurn, notes = notes, message = message,
                    openMessage = open, newer = newer, earlier = if (recap) earlierLocked(c, turn) else null, emails = turn.emails,
                    now = clock.now(), zone = zone(),
                )
                val handle = Handle(
                    turn, c, input, text, action, named, firstTurn, turn.model, turn.effort, turn.emails.map { it.id }, grantFor(c),
                    ready = firstTurn || recap,
                )
                turn.adapterStarted = true
                val job = scope.launch(dispatcher, start = CoroutineStart.LAZY) {
                    val r = try {
                        adapter.runTurn(handle)
                    } catch (e: CancellationException) {
                        TurnResult.STOPPED
                    } catch (e: Throwable) {
                        TurnResult(TurnStatus.ERROR, toError(e))
                    }
                    turn.outcome.complete(r)
                }
                // Never start the agent for a turn that was stopped already.
                job.invokeOnCompletion { turn.outcome.complete(TurnResult.STOPPED) }
                turn.adapterJob = job
                handle
            }
            if (handle == null) {
                stoppedEarly(turn)
                return
            }
            turn.adapterJob?.start()
            result = turn.outcome.await()
        } catch (e: AgentException) {
            result = TurnResult(TurnStatus.ERROR, toError(e))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            result = TurnResult(TurnStatus.ERROR, toError(e))
        }
        locked {
            val c = convs[cid]
            // A turn that never reached the agent uses up nothing: the next message is still a first turn.
            if (c != null) {
                if (turn.reached || result.status == TurnStatus.DONE) {
                    if (!c.delivered || c.needsRecap) editLocked(cid) { it.copy(delivered = true, needsRecap = false) }
                    // The agent has the newer emails this turn carried; any it didn't carry still wait.
                    val told = turn.newer.filter { it.ref.pending }.map { it.ref.id }.toSet()
                    if (told.isNotEmpty()) {
                        editLocked(cid) { now -> now.copy(continued = pruneContinued(now.continued.map { if (it.id in told) it.copy(pending = false) else it })) }
                    }
                } else {
                    giveBackLocked(cid, turn)
                }
            }
            finishTurnLocked(turn, result)
        }
    }

    // A computer turn gets the phone's MCP endpoint and the token the phone made for that computer.
    private fun grantFor(c: Conversation): McpGrant {
        val (pairing, _) = AgentIds.parseComputer(c.agent) ?: return McpGrant()
        val computer = settings.current().computer(pairing) ?: return McpGrant()
        val url = mcpUrl() ?: return McpGrant()
        return McpGrant(url, computer.mcpToken)
    }

    private suspend fun awaitMail(cid: String) {
        var job = locked { mailChains[cid] }
        while (job != null) {
            job.join()
            val next = locked { mailChains[cid] }
            job = if (next === job) null else next
        }
    }

    private data class Located(val id: String?, val email: LoadedEmail?)

    // The chat's own email ([continuedId] null) or one it was continued from, in full, found again if it moved.
    private suspend fun loadEmail(cid: String, continuedId: String?): Located {
        val ref = locked {
            val c = convs[cid] ?: return@locked null
            if (continuedId == null) c.message else c.continued.firstOrNull { it.id == continuedId }?.ref()
        } ?: return Located(null, null)
        val live = locate(ref.id, ref.messageId, ref.accountId)
        if (live != null && live != ref.id) {
            locked { editLocked(cid) { c -> updateRef(c, ref.id, continuedId == null) { it.copy(id = live) } } }
        }
        val full = live?.let { fullOf(it) } ?: return Located(live ?: ref.id, null)
        // Chats saved before Rukoo kept these get them here, with their first message after an update.
        val (inReplyTo, references) = threadHeaders(full)
        if (ref.inReplyTo != inReplyTo || ref.references.orEmpty() != references) {
            locked { editLocked(cid) { c -> updateRef(c, live, continuedId == null) { it.copy(inReplyTo = inReplyTo, references = references) } } }
        }
        val account = mail.accounts.value.firstOrNull { it.id == full.accountId }?.email.orEmpty()
        return Located(live, LoadedEmail(full, account, full.folder))
    }

    private fun updateRef(c: Conversation, id: String, own: Boolean, transform: (MessageRef) -> MessageRef): Conversation =
        if (own) {
            c.message?.let { c.copy(message = transform(it)) } ?: c
        } else {
            c.copy(continued = c.continued.map { e -> if (e.id == id) ContinuedRef.of(transform(e.ref()), e.at, e.pending) else e })
        }

    // The current id of an email a chat keeps (hub.js locate()): the stored id while it still holds that email,
    // else the same Message-ID in the same account: the copy in the folder the id named, where Rukoo moved it,
    // or the one live copy. Several and none of these: not clear which, so none.
    private suspend fun locate(id: String, header: String?, accountId: String?): String? {
        val cached = if (id.isNotEmpty()) summaryOf(id) else null
        if (cached != null && (header.isNullOrEmpty() || cached.messageId.isNullOrEmpty() || normId(cached.messageId) == normId(header))) return id
        if (header.isNullOrEmpty()) return null
        val account = accountId ?: accountOfId(id)
        val folder = MessageIds.decode(id)?.folder
        val copies = try {
            mail.findByMessageId(header, account)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }.filter { account == null || it.accountId == account }
        val live = copies.filter { it.role != FolderRole.ALL }
        val same = live.filter { it.folder == folder }
        if (same.size == 1) return same[0].id
        if (account != null) {
            try {
                mail.findMoved(account, header, folder)?.let { return it }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                AppLog.w(TAG, "finding a moved email failed", e)
            }
        }
        if (live.size > 1) return null
        return (live.firstOrNull() ?: copies.firstOrNull())?.id
    }

    // The newer emails the agent hasn't had yet, oldest first by date, the newest three of them. With again and
    // none waiting, the newest one it had: a new session has had nothing.
    private suspend fun loadNewer(cid: String, again: Boolean): List<NewerEmail> {
        val all = locked { convs[cid]?.continued.orEmpty() }
        var refs = all.filter { it.pending }.sortedBy { it.date ?: 0 }.takeLast(MAX_NEWER)
        if (refs.isEmpty() && again) refs = all.sortedBy { it.date ?: 0 }.takeLast(1)
        val out = mutableListOf<NewerEmail>()
        for (ref in refs) {
            val located = try {
                loadEmail(cid, ref.id)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                Located(ref.id, null)
            }
            val now = locked { convs[cid]?.continued?.firstOrNull { it.id == (located.id ?: ref.id) } } ?: ref
            out += NewerEmail(now, located.email?.full, located.email?.account.orEmpty(), located.email?.folder.orEmpty())
        }
        // After the loads: finding a moved email gave it its current id.
        val open = openMessageId()
        return out.map { it.copy(open = open != null && open == it.ref.id) }
    }

    private suspend fun openMessageId(): String? = screen.current.openMessageId?.takeIf { summaryOf(it) != null }

    // The email the user looks at now when it isn't the chat's own, nor the one newer email this turn carries.
    private suspend fun openLine(cid: String, newer: List<NewerEmail>): OpenEmail? {
        val openId = openMessageId() ?: return null
        val own = locked { convs[cid]?.message?.id }
        if (openId == own || (newer.size == 1 && newer[0].open)) return null
        return OpenEmail(openId, summaryOf(openId)?.subject.orEmpty())
    }

    // The transcript before this turn's own message.
    private fun earlierLocked(c: Conversation, turn: Turn): List<Item> {
        val at = c.items.indexOfFirst { it.id == turn.userItem }
        return if (at < 0) c.items.toList() else c.items.subList(0, at).toList()
    }

    // The agent lost the chat's session; before the adapter sends anything, input becomes a first turn with the
    // chat's email and a recap. A turn that has the email already stays as it is. Never throws.
    private suspend fun startOver(turn: Turn, handle: Handle): String {
        if (handle.ready || turn.startedOver) return handle.input
        turn.startedOver = true
        // Kept until a turn reaches the new session, so a turn that fails on the way doesn't lose the email.
        locked { editLocked(turn.cid) { it.copy(needsRecap = true) } }
        val message = try {
            if (locked { convs[turn.cid]?.message } != null) loadEmail(turn.cid, null).email else null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            AppLog.w(TAG, "loading the email for a new session failed", e)
            null
        }
        // The new session hasn't had a newer email either, even if the old one did.
        val newer = turn.newer.ifEmpty { if (locked { convs[turn.cid]?.continued?.isNotEmpty() == true }) loadNewer(turn.cid, again = true) else emptyList() }
        if (turn.closed || turn.aborted) return handle.input
        turn.newer = newer
        val open = openLine(turn.cid, newer)
        return locked {
            val c = convs[turn.cid] ?: return@locked handle.input
            handle.input = TurnContext.turnText(
                conversationId = c.id, chatEmail = c.message, text = handle.text, firstTurn = true, notes = turn.notes, message = message,
                openMessage = open, newer = newer, earlier = earlierLocked(c, turn), emails = turn.emails, now = clock.now(), zone = zone(),
            )
            handle.input
        }
    }

    /** The turn as the adapter sees it (hub.js:1312-1346). */
    private inner class Handle(
        val turn: Turn,
        override val conversation: Conversation,
        input: String,
        override val text: String,
        override val action: String?,
        override val skills: List<String>,
        override val firstTurn: Boolean,
        override val model: String?,
        override val effort: String?,
        override val emails: List<String>,
        override val mcp: McpGrant,
        val ready: Boolean,
    ) : TurnHandle {
        override val id: String = turn.id

        @Volatile
        override var input: String = input

        override val instructions: String = TurnContext.instructions()
        override val files: List<TurnFile> = emptyList()

        override fun emit(event: AdapterEvent) = onAdapterEvent(turn, event)

        override suspend fun approve(request: ApprovalRequest): String =
            requestApprovalNow(conversation.id, request.copy(source = conversation.agent, kind = ApprovalKind.RUNTIME)).choice.await()

        override fun expireApproval(itemOrKey: String) {
            locked { expireApprovalLocked(conversation.id, itemOrKey) }
        }

        override fun setProvider(patch: Map<String, String>) {
            locked {
                editLocked(conversation.id) { it.copy(provider = it.provider + patch) }
                val thread = patch["threadId"]
                if (thread != null && convs.containsKey(conversation.id)) threads[thread] = conversation.id
            }
        }

        override fun accepted() {
            locked { turn.reached = true }
        }

        override suspend fun startOver(): String = this@Hub.startOver(turn, this)
    }

    private fun onAdapterEvent(turn: Turn, event: AdapterEvent): Unit = locked {
        if (turn.closed) return@locked
        val cid = turn.cid
        if (convs[cid] == null) return@locked
        if (event is AdapterEvent.Text || event is AdapterEvent.Commentary || event is AdapterEvent.Thinking || event is AdapterEvent.ToolStart) turn.reached = true
        val now = clock.now()
        fun own(item: Item): Item = addItemLocked(cid, item).also { turn.items += it.id }
        // Text after any other item starts a new bubble; anything that isn't thinking ends the thinking.
        fun endThinking() {
            val id = turn.thinkingId ?: return
            val item = itemLocked(cid, id) as? Item.Thinking
            if (item != null && item.status == ThinkingStatus.RUNNING) {
                updateItemLocked(cid, item.copy(text = turn.thinkingText.toString(), status = ThinkingStatus.DONE, endedAt = now))
            }
            turn.thinkingId = null
            turn.thinkingText.setLength(0)
        }
        fun endText() {
            val id = turn.assistantId ?: return
            val item = itemLocked(cid, id) as? Item.Assistant
            if (item != null && item.status == AssistantStatus.STREAMING) {
                updateItemLocked(cid, item.copy(text = turn.assistantText.toString(), status = AssistantStatus.DONE))
            }
            turn.assistantId = null
            turn.assistantText.setLength(0)
        }
        when (event) {
            is AdapterEvent.Text -> {
                val delta = event.delta
                if (delta.isEmpty()) return@locked
                endThinking()
                if (turn.assistantId == null) {
                    val piece = delta.take(MAX_TEXT)
                    turn.assistantId = own(Item.Assistant(Ids.itemId(), now, piece, AssistantStatus.STREAMING, interim = false)).id
                    turn.assistantText.setLength(0)
                    turn.assistantText.append(piece)
                    return@locked
                }
                val room = MAX_TEXT - turn.assistantText.length
                if (room <= 0) return@locked
                turn.assistantText.append(delta.take(room))
                // No save per delta: the next item, the end of the turn or a background save keeps the text.
                queueDeltaLocked(turn)
            }
            is AdapterEvent.Commentary -> {
                val text = jsTrim(event.text)
                if (text.isEmpty()) return@locked
                endThinking()
                endText()
                own(Item.Assistant(Ids.itemId(), now, text, AssistantStatus.DONE, interim = true))
            }
            is AdapterEvent.Thinking -> {
                val delta = event.delta
                endText()
                if (turn.thinkingId == null) {
                    val piece = delta.take(MAX_TEXT)
                    turn.thinkingId = own(Item.Thinking(Ids.itemId(), now, piece, ThinkingStatus.RUNNING, now, null)).id
                    turn.thinkingText.setLength(0)
                    turn.thinkingText.append(piece)
                    return@locked
                }
                if (delta.isEmpty()) return@locked
                val piece = delta.take(maxOf(0, MAX_TEXT - turn.thinkingText.length))
                if (piece.isEmpty()) return@locked
                turn.thinkingText.append(piece)
                queueDeltaLocked(turn)
            }
            AdapterEvent.ThinkingDone -> endThinking()
            is AdapterEvent.ToolStart -> {
                endThinking()
                endText()
                val name = event.name.ifEmpty { "tool" }.take(200)
                val key = event.key.ifEmpty { "$name#${turn.tools.size}" }
                val item = own(
                    Item.Tool(
                        Ids.itemId(), now, name, ToolLabels.label(name), ToolLabels.chipDetail(event.detail), ToolStatus.RUNNING, now, null,
                        rukoo = ToolLabels.isRukooTool(name),
                    ),
                )
                turn.tools[key] = item.id
            }
            is AdapterEvent.ToolEnd -> {
                val id = turn.tools[event.key] ?: return@locked
                val item = itemLocked(cid, id) as? Item.Tool ?: return@locked
                if (item.status != ToolStatus.RUNNING) return@locked
                updateItemLocked(
                    cid,
                    item.copy(
                        status = if (event.error) ToolStatus.ERROR else ToolStatus.DONE,
                        endedAt = now,
                        detail = if (!event.detail.isNullOrEmpty()) ToolLabels.chipDetail(event.detail) else item.detail,
                    ),
                )
            }
            is AdapterEvent.Error -> {
                endThinking()
                endText()
                val err = toError(AgentErrorInfo(event.code, event.detail))
                turn.errorShown = true
                turn.lastError = err
                own(Item.Notice(Ids.itemId(), now, ErrorCodes.TEXT.getValue(err.code), err.detail, Tone.ERROR, err.code))
            }
            is AdapterEvent.Notice -> {
                // Informational lines from an adapter, e.g. "Hermes started a new session".
                val text = ToolLabels.oneLine(event.text).take(500)
                if (text.isEmpty()) return@locked
                endThinking()
                endText()
                own(Item.Notice(Ids.itemId(), now, text, tone = event.tone, code = event.code))
            }
            // Token counts and anything newer: ignored.
            AdapterEvent.Usage -> Unit
        }
    }

    // Streaming text reaches the UI at most every 50 ms; any other change publishes it at once.
    private fun queueDeltaLocked(turn: Turn) {
        turn.textDirty = true
        if (deltaJob?.isActive == true) return
        deltaJob = scope.launch(dispatcher) {
            delay(DELTA_MS)
            locked {
                deltaJob = null
                if (turns.values.any { it.textDirty }) dirty = true
            }
        }
    }

    override suspend fun stop(conversationId: String) {
        locked {
            val turn = turns[conversationId] ?: return@locked
            turn.aborted = true
            turn.adapterJob?.cancel()
            expireTurnApprovalsLocked(turn)
            // Still loading the email: no adapter runs yet, so there's nothing to wait for. What the message
            // brought goes back now, before another message can be sent.
            if (!turn.adapterStarted) {
                if (!turn.reached) giveBackLocked(conversationId, turn)
                finishTurnLocked(turn, TurnResult.STOPPED)
                return@locked
            }
            if (turn.stopTimer == null) {
                turn.stopTimer = scope.launch(dispatcher) {
                    delay(STOP_GRACE_MS)
                    turn.outcome.complete(TurnResult.STOPPED)
                }
            }
        }
    }

    private fun expireTurnApprovalsLocked(turn: Turn) {
        for ((itemId, w) in approvals.entries.toList()) if (w.turnId == turn.id) expireApprovalLocked(w.cid, itemId)
    }

    private fun finishTurnLocked(turn: Turn, result: TurnResult) {
        if (turn.closed) return
        materializeLocked(turn)
        turn.closed = true
        turn.stopTimer?.cancel()
        if (turns[turn.cid] === turn) turns.remove(turn.cid)
        val cid = turn.cid
        expireTurnApprovalsLocked(turn)
        val c = convs[cid] ?: return
        val now = clock.now()
        val status = result.status
        for (item in c.items) {
            if (item.id !in turn.items) continue
            val changed = when {
                item is Item.Assistant && item.status == AssistantStatus.STREAMING ->
                    item.copy(status = if (status == TurnStatus.STOPPED) AssistantStatus.STOPPED else AssistantStatus.DONE)
                item is Item.Thinking && item.status == ThinkingStatus.RUNNING -> item.copy(status = ThinkingStatus.DONE, endedAt = now)
                item is Item.Tool && item.status == ToolStatus.RUNNING -> item.copy(status = ToolStatus.DONE, endedAt = now)
                else -> null
            }
            if (changed != null) updateItemLocked(cid, changed)
        }
        turn.assistantId = null
        turn.thinkingId = null
        var error: AgentErrorInfo? = null
        if (status == TurnStatus.ERROR) {
            error = result.error?.let(::toError) ?: turn.lastError ?: AgentErrorInfo(ErrorCodes.UNKNOWN, "")
            if (!turn.errorShown) addItemLocked(cid, Item.Notice(Ids.itemId(), now, ErrorCodes.TEXT.getValue(error.code), error.detail, Tone.ERROR, error.code))
        }
        setStatusLocked(cid, if (status == TurnStatus.ERROR) ConversationStatus.ERROR else ConversationStatus.IDLE)
        // An answer or an error in a chat that isn't on screen waits in the chat list. Stop was the user's own doing.
        val unread = status != TurnStatus.STOPPED && !onScreen(cid)
        if (unread) markUnreadLocked(cid, if (status == TurnStatus.ERROR) Unread.ERROR else Unread.REPLY)
        if (error != null && error.code in REFRESH_ON) scope.launch(dispatcher) { probeStatus(c.agent, force = false) }
        // An approval decided while this turn ran goes now (desktop's setImmediate after finishTurn).
        if (followUps[cid]?.isNotEmpty() == true) scope.launch(dispatcher) { locked { drainFollowUpsLocked(cid) } }
        _events.tryEmit(HubEvent.TurnFinished(cid, status, unread))
        if (unread) {
            val finished = convs.getValue(cid)
            alert { replyReady(finished, status) }
        }
    }

    // Starts the next queued approval follow-up while the chat has no turn. One that can't start (the agent was
    // turned off) is kept for the next message, and the one after it gets its chance.
    private fun drainFollowUpsLocked(cid: String) {
        while (convs[cid] != null && !turns.containsKey(cid)) {
            val queue = followUps[cid] ?: return
            val next = queue.removeFirstOrNull()
            if (queue.isEmpty()) followUps.remove(cid)
            if (next == null) return
            try {
                startTurnLocked(cid, next.text.take(MAX_MESSAGE), "approved", next.display, emptyList())
            } catch (e: AgentException) {
                val err = toError(e)
                addItemLocked(cid, Item.Notice(Ids.itemId(), clock.now(), ErrorCodes.TEXT[err.code] ?: ErrorCodes.TEXT.getValue(ErrorCodes.UNKNOWN), err.detail, Tone.ERROR, err.code))
                keepApprovalLocked(cid, next.display)
            }
        }
    }

    // A turn that never reached the agent uses up nothing: the notes it took go back, an approved follow-up's
    // approval is kept, and the next message says what the user attached. Once per turn.
    private fun giveBackLocked(cid: String, turn: Turn) {
        if (turn.givenBack) return
        turn.givenBack = true
        if (turn.notes.isNotEmpty()) editLocked(cid) { it.copy(notes = turn.notes + it.notes) }
        turn.approvalDisplay?.let { keepApprovalLocked(cid, it) }
        if (turn.emails.isNotEmpty()) {
            val names = turn.emails.map { "the email ${Unsafe.inline(it.subject, "email subject", 100)} (id ${it.id})" }
            addNoteLocked(cid, "The user attached ${names.joinToString(", ")} to a message that did not reach you. read_chat_file and read_message return them.")
        }
    }

    // An approval whose follow-up turn couldn't reach the agent: it hears about it with the next message, and
    // the card's "Approved" doesn't pretend it was carried out.
    private fun keepApprovalLocked(cid: String, display: String) {
        addNoteLocked(cid, "The user approved: $display. You were not told until now, so it has not been done; check with the user before you carry it out.")
        val title = Unsafe.untag(display)
        val name = convs[cid]?.agent?.let(::agentName).orEmpty()
        addItemLocked(
            cid,
            Item.Notice(
                Ids.itemId(), clock.now(), "Not done yet: $title. $name hears about your approval with your next message.",
                tone = Tone.INFO, code = "kept-approval", params = NoticeParams(title.take(200)),
            ),
        )
    }

    private fun addNoteLocked(cid: String, note: String) = editLocked(cid) { it.copy(notes = it.notes + note) }

    // ---------- approvals ----------

    override suspend fun requestApproval(conversationId: String, request: ApprovalRequest): ApprovalTicket = requestApprovalNow(conversationId, request)

    private fun requestApprovalNow(cid: String, request: ApprovalRequest): ApprovalTicket {
        var waiting: Pair<Conversation, Item.Approval>? = null
        val ticket = locked {
            mustGetLocked(cid)
            val card = ApprovalCards.card(request.title, request.detail, request.fields, request.choices, request.tool)
            val refusal = card.refusal
            val item = addItemLocked(
                cid,
                Item.Approval(
                    Ids.itemId(), clock.now(), card.title, card.detail, card.fields, card.tool, card.choices,
                    status = if (refusal != null) ApprovalStatus.DENIED else ApprovalStatus.PENDING,
                    decision = refusal?.id,
                    // Rukoo's decision, not the user's; a recap of the chat says so.
                    declinedBy = if (refusal != null) "rukoo" else null,
                    source = request.source, kind = request.kind, mail = request.mail,
                ),
            ) as Item.Approval
            val turn = if (request.kind == ApprovalKind.RUNTIME) turns[cid] else null
            if (turn != null) {
                turn.items += item.id
                turn.reached = true
            }
            if (refusal != null) {
                val shown = Unsafe.untag(item.title)
                addItemLocked(
                    cid,
                    Item.Notice(
                        Ids.itemId(), clock.now(), "Declined without asking: $shown. Its input is too long to show here in full.",
                        tone = Tone.INFO, code = "approval-too-long", params = NoticeParams(shown),
                    ),
                )
                // A runtime request gets the denial as its answer; a proposal or mail action hears it with the next message.
                if (request.kind != ApprovalKind.RUNTIME) {
                    val what = if (request.kind == ApprovalKind.MAIL) Unsafe.inline(item.title, "mail action") else "\"${ToolLabels.oneLine(item.title)}\""
                    addNoteLocked(cid, "Rukoo declined $what without asking the user: its input was too long to show in full. Ask again with shorter input.")
                }
                return@locked ApprovalTicket(item.id, CompletableDeferred(refusal.id))
            }
            val choice = CompletableDeferred<String>()
            approvals[item.id] = Waiter(cid, choice, request.key, turn?.id)
            // A runtime approval outside a running turn has nobody to answer it.
            if (request.kind == ApprovalKind.RUNTIME && turn == null) {
                expireApprovalLocked(cid, item.id)
            } else {
                _events.tryEmit(HubEvent.ApprovalWaiting(cid, item.id))
                waiting = convs.getValue(cid) to item
            }
            ApprovalTicket(item.id, choice)
        }
        waiting?.let { (c, item) -> if (!onScreen(c.id)) alert { approvalWaiting(c, item) } }
        return ticket
    }

    // itemOrKey: the item id, or the key the adapter passed with the request (Hermes' request_id).
    private fun expireApprovalLocked(cid: String, itemOrKey: String): Boolean {
        for ((itemId, w) in approvals.entries.toList()) {
            if (w.cid != cid || (itemId != itemOrKey && (w.key == null || w.key != itemOrKey))) continue
            approvals.remove(itemId)
            val item = itemLocked(cid, itemId) as? Item.Approval
            if (item != null && item.status == ApprovalStatus.PENDING) updateItemLocked(cid, item.copy(status = ApprovalStatus.EXPIRED))
            w.choice.complete(CANCEL)
            return true
        }
        return false
    }

    override suspend fun decide(conversationId: String, itemId: String, choiceId: String): Item.Approval = locked {
        val c = mustGetLocked(conversationId)
        val item = c.items.firstOrNull { it.id == itemId } as? Item.Approval ?: throw AgentException(ErrorCodes.INVALID, "unknown approval")
        if (item.status != ApprovalStatus.PENDING) return@locked item
        val choice = item.choices.firstOrNull { it.id == choiceId } ?: throw AgentException(ErrorCodes.INVALID, "unknown choice")
        val denied = ApprovalCards.denies(choice)
        val decided = item.copy(status = if (denied) ApprovalStatus.DENIED else ApprovalStatus.APPROVED, decision = choice.id)
        updateItemLocked(c.id, decided)
        approvals.remove(itemId)?.choice?.complete(choice.id)
        when (item.kind) {
            ApprovalKind.PROPOSAL -> onProposalLocked(c.id, decided, !denied)
            // A decline is only a note, so it is there when decide() returns; the mail work itself runs off the caller's thread.
            ApprovalKind.MAIL -> settleMailLocked(c.id, immediate = denied) { onMailDecision(c.id, decided, !denied) }
            ApprovalKind.RUNTIME -> Unit
        }
        decided
    }

    // A proposal is the agent's text as it wrote it: quoted email keeps its tags for the agent, the user's line shows none.
    private fun onProposalLocked(cid: String, item: Item.Approval, approved: Boolean) {
        if (!approved) {
            addNoteLocked(cid, "The user declined: ${item.title}.")
            addItemLocked(cid, Item.User(Ids.itemId(), clock.now(), Unsafe.untag(item.title), "declined"))
            return
        }
        // The agent may not remember the proposal (another channel, a new session), so repeat what was approved.
        val lines = mutableListOf("Approved: ${item.title}. Go ahead and do it now, then report back briefly.")
        if (item.detail.isNotEmpty()) lines += "Details you proposed: ${item.detail}"
        for (f in item.fields) lines += "${f.label}: ${f.value}"
        followUps.getOrPut(cid) { ArrayDeque() }.addLast(FollowUp(lines.joinToString("\n"), item.title))
        // With no turn running it starts now; otherwise when that turn ends.
        drainFollowUpsLocked(cid)
    }

    // Mail work whose outcome goes into the notes of the agent's next message, one chain per chat in order;
    // runTurn() waits for it. [immediate] work that has nothing queued before it runs right here.
    private fun settleMailLocked(cid: String, immediate: Boolean = false, work: suspend () -> Unit): Job {
        val before = mailChains[cid]?.takeIf { it.isActive }
        val job = scope.launch(dispatcher, start = if (before == null && immediate) CoroutineStart.UNDISPATCHED else CoroutineStart.DEFAULT) {
            before?.join()
            try {
                work()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val err = toError(e)
                locked {
                    if (convs[cid] != null) addItemLocked(cid, Item.Notice(Ids.itemId(), clock.now(), ErrorCodes.TEXT.getValue(err.code), err.detail, Tone.ERROR, err.code))
                }
            }
        }
        mailChains[cid] = job
        job.invokeOnCompletion {
            locked {
                if (mailChains[cid] === job) mailChains.remove(cid)
                Unit
            }
        }
        return job
    }

    // Mail titles and results hold sender names and subjects from the email: tagged as unsafe content.
    private suspend fun onMailDecision(cid: String, item: Item.Approval, approved: Boolean) {
        if (!approved) {
            locked { addNoteLocked(cid, "The user declined: ${Unsafe.inline(item.title, "mail action")}.") }
            return
        }
        val result = executeMail(cid, item.mail ?: MailApproval("", emptyList()))
        locked { addNoteLocked(cid, "The user approved: ${Unsafe.inline(item.title, "mail action")}. Rukoo: ${Unsafe.inline(result.text, "mail result")}.") }
    }

    // Runs a mail action and puts its outcome in the chat (tools.js executeMail).
    private suspend fun executeMail(cid: String, spec: MailApproval): MailOutcome {
        val result = mailActions.execute(spec)
        locked {
            if (convs[cid] != null) {
                addItemLocked(
                    cid,
                    Item.Notice(
                        Ids.itemId(), clock.now(), result.text, tone = if (result.done.isNotEmpty()) Tone.SUCCESS else Tone.ERROR,
                        undo = mailActions.undoOf(result), mail = result.mail,
                    ),
                )
            }
        }
        return result
    }

    override suspend fun runMailAction(conversationId: String, mail: MailApproval, title: String, waitMs: Long): MailOutcome? {
        val gate = Any()
        var answered = false
        val answer = CompletableDeferred<Result<MailOutcome>>()
        locked {
            mustGetLocked(conversationId)
            settleMailLocked(conversationId) {
                val r = try {
                    Result.success(executeMail(conversationId, mail))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Result.failure(e)
                }
                val inTime = synchronized(gate) {
                    val first = !answered
                    answered = true
                    first
                }
                if (inTime) {
                    answer.complete(r)
                } else {
                    // The call answered that the work goes on, so the outcome goes with the agent's next message.
                    val action = Unsafe.inline(title, "mail action")
                    val note = r.fold(
                        { "Rukoo finished $action: ${Unsafe.inline(it.text, "mail result")}." },
                        { "Rukoo could not finish $action: ${Unsafe.inline(it.message ?: it.toString(), "mail result")}. Part of it may be done; check the mail before you try again." },
                    )
                    locked {
                        if (convs[conversationId] != null) addNoteLocked(conversationId, note)
                        Unit
                    }
                    r.exceptionOrNull()?.let { throw it }
                }
            }
        }
        val got = withTimeoutOrNull(waitMs) { answer.await() }
        if (got == null) {
            val late = synchronized(gate) {
                val first = !answered
                answered = true
                first
            }
            if (late) return null
        }
        return (got ?: answer.await()).getOrThrow()
    }

    override suspend fun undo(conversationId: String, itemId: String) {
        val job = locked {
            val item = itemLocked(conversationId, itemId) as? Item.Notice
            val undo = item?.undo
            if (item == null || undo == null || undo.kind != "move") throw AgentException(ErrorCodes.INVALID, "nothing to undo")
            updateItemLocked(conversationId, item.copy(undo = null))
            // On the mail chain like any other mail work, so the agent hears about the undo first.
            settleMailLocked(conversationId) {
                var restored = 0
                val failed = mutableListOf<String>()
                for (id in undo.ids) {
                    try {
                        val r = mail.undoMove(listOf(id))
                        if (r.failed.isNotEmpty()) failed += r.failed[0].error else restored++
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        failed += e.message ?: e.javaClass.simpleName
                    }
                }
                val n = undo.ids.size
                val text = if (failed.isNotEmpty()) "Restored $restored of $n email${if (n == 1) "" else "s"}. ${failed[0]}" else "Restored $restored email${if (restored == 1) "" else "s"}"
                locked {
                    if (convs[conversationId] == null) return@locked
                    addItemLocked(
                        conversationId,
                        Item.Notice(
                            Ids.itemId(), clock.now(), text, tone = if (failed.isNotEmpty() && restored == 0) Tone.ERROR else Tone.INFO,
                            mail = NoticeMail("undo", restored, failed.size, null),
                        ),
                    )
                    addNoteLocked(conversationId, "The user undid ${Unsafe.inline(item.text, "mail result")}. $text.")
                }
            }
        }
        job.join()
    }

    override suspend fun patchDraft(conversationId: String, itemId: String, undone: Boolean) {
        locked {
            val item = itemLocked(conversationId, itemId) as? Item.Draft ?: throw AgentException(ErrorCodes.INVALID, "unknown draft")
            updateItemLocked(conversationId, item.copy(undone = undone))
        }
    }

    // ---------- tool calls ----------

    override fun conversationForTool(identity: ToolIdentity, conversationIdArg: String?, meta: JsonObject?): Conversation? = locked {
        fun own(id: String?) = id?.takeIf { it.isNotEmpty() }?.let { convs[it] }?.takeIf { it.agent == identity.agent }
        // A paired computer forwards a phone chat's call with the chat in _meta; never from the arguments,
        // and never into a chat of another computer.
        if (identity.computer != null) {
            val id = identity.conversationId ?: metaString(meta, "rukoo/conversation") ?: return@locked null
            val c = convs[id] ?: return@locked null
            val (pairing, program) = AgentIds.parseComputer(c.agent) ?: return@locked null
            if (pairing != identity.computer || (identity.agent != c.agent && identity.agent != program.wire)) return@locked null
            return@locked c
        }
        // A per-chat token speaks for its own chat only: a stale or forged conversation_id must not move its calls.
        if (identity.conversationId != null) return@locked own(identity.conversationId)
        own(conversationIdArg)?.let { return@locked it }
        val codex = (meta?.get("x-codex-turn-metadata") as? JsonObject)?.let { metaString(it, "thread_id") }
        val threadId = metaString(meta, "threadId") ?: codex
        threadId?.let { threads[it] }?.let(::own)?.let { return@locked it }
        turns.keys.mapNotNull { convs[it] }.filter { it.agent == identity.agent }.singleOrNull()
    }

    private fun metaString(meta: JsonObject?, key: String): String? =
        (meta?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }

    override fun ensureConversation(identity: ToolIdentity, resolved: Conversation?, openMessageId: String?): Conversation {
        if (resolved != null) return resolved
        // A computer forwards calls of the phone chat it runs; when that chat is gone the call must not land in
        // another one (spec 3 §7.9), and an agent the phone doesn't know gets no chat of its own.
        if (identity.computer != null || !AgentIds.isKnown(identity.agent)) throw AgentException(ErrorCodes.INVALID, "unknown conversation")
        // The open email's headers come from the mail cache; tools call this from their own threads.
        val open = openMessageId?.let { id -> runBlocking { withTimeoutOrNull(MAIL_LOOKUP_MS) { summaryOf(id) } } }
        return locked {
            externalForLocked(identity.agent, open?.id, open?.messageId, open?.accountId)?.let { return@locked it }
            val ref = open?.let { MessageRef(it.id, it.messageId, it.accountId, it.subject, it.from, it.date.takeIf { d -> d != 0L }, inReplyTo = it.inReplyTo) }
            val c = createLocked(identity.agent, ref, Origin.EXTERNAL, agentName(identity.agent))
            _events.tryEmit(HubEvent.Reveal(c.id))
            c
        }
    }

    // The agent's recent external chat about the email open now (or about no email), if any.
    private fun externalForLocked(agent: String, open: String?, openHeader: String?, openAccount: String?): Conversation? {
        val since = clock.now() - EXTERNAL_REUSE_MS
        val account = accountOfId(open) ?: openAccount
        fun about(c: Conversation): Boolean {
            val m = c.message
            if (open == null || m == null) return open == null && m == null
            val own = m.accountId ?: accountOfId(m.id)
            if (account != null && own != null && own != account) return false
            if (!openHeader.isNullOrEmpty() && !m.messageId.isNullOrEmpty()) return normId(openHeader) == normId(m.messageId)
            return m.id == open
        }
        return convs.values.filter { it.origin == Origin.EXTERNAL && it.agent == agent && it.updatedAt >= since && about(it) }.maxByOrNull { it.updatedAt }
    }

    override fun owns(identity: ToolIdentity, conversationId: String): Boolean = locked {
        val c = convs[conversationId] ?: return@locked false
        if (c.agent == identity.agent) return@locked true
        val (pairing, program) = AgentIds.parseComputer(c.agent) ?: return@locked false
        identity.computer == pairing && identity.agent == program.wire
    }

    override fun toolCalled(conversationId: String) {
        locked { turns[conversationId]?.reached = true }
    }

    override fun addItem(conversationId: String, item: Item): Item {
        var draft: Pair<Conversation, Item.Draft>? = null
        val added = locked {
            mustGetLocked(conversationId)
            val stored = addItemLocked(conversationId, item.stamped(Ids.itemId(), clock.now()))
            if (stored is Item.Draft) {
                _events.tryEmit(HubEvent.DraftWritten(conversationId, stored.id))
                draft = convs.getValue(conversationId) to stored
            }
            stored
        }
        draft?.let { (c, d) -> if (!screen.current.foreground) alert { draftWritten(c, d) } }
        return added
    }

    override fun updateItem(conversationId: String, item: Item) {
        locked {
            if (itemLocked(conversationId, item.id) != null) updateItemLocked(conversationId, clipItem(item))
            Unit
        }
    }

    override fun addNote(conversationId: String, note: String) {
        locked {
            mustGetLocked(conversationId)
            addNoteLocked(conversationId, note)
        }
    }

    // ---------- rows ----------

    // When the chat's last message came: what the user wrote, what the agent said, an approval card.
    private fun lastMessageAt(c: Conversation): Long {
        for (i in c.items.indices.reversed()) {
            val item = c.items[i]
            if ((item is Item.User || item is Item.Assistant || item is Item.Approval) && item.at != 0L) return item.at
        }
        return c.createdAt.takeIf { it != 0L } ?: c.updatedAt
    }

    private fun row(c: Conversation, lastAt: Long): ConversationRow {
        val last = c.items.lastOrNull { (it is Item.Assistant && !it.interim) || it is Item.User }
        // A message with only attachments reads as their names.
        val text = when (last) {
            is Item.Assistant -> last.text
            is Item.User -> last.text.ifEmpty { (last.files.orEmpty().map { it.name } + last.emails.orEmpty().map { it.subject }).joinToString(", ") }
            else -> ""
        }
        return ConversationRow(
            c.id, c.agent, c.title, c.message, c.origin, c.updatedAt, lastAt, c.status, c.unread,
            waiting = c.items.any { it is Item.Approval && it.status == ApprovalStatus.PENDING },
            preview = jsOneLine(text).take(140),
        )
    }

    companion object {
        private const val TAG = "Hub"
        const val MAX_CONVERSATIONS = 150
        const val MAX_EXTERNAL = 20
        const val EXTERNAL_REUSE_MS = 4 * 60 * 60 * 1000L
        const val MAX_ITEMS = 400
        const val MAX_TEXT = 40000
        const val MAX_CONTINUED = 20
        const val MAX_NEWER = 3
        const val MAX_REFERENCES = 50
        const val MAX_MESSAGE = 20000
        const val MAX_EMAILS = 10
        const val SAVE_MS = 400L
        const val SAVE_RUNNING_MS = 2000L
        const val DELTA_MS = 50L
        const val STOP_GRACE_MS = 12000L
        const val MODELS_TTL_MS = 10 * 60 * 1000L
        const val MODELS_RETRY_MS = 30 * 1000L
        const val MODELS_TIMEOUT_MS = 20000L
        const val MAX_MODELS = 300
        const val OWN_SKILLS_TTL_MS = 60 * 1000L
        const val OWN_SKILLS_RETRY_MS = 10 * 1000L
        const val OWN_SKILLS_TIMEOUT_MS = 20000L
        const val MENTION_TIMEOUT_MS = 10000L
        const val STATUS_TIMEOUT_MS = 12000L

        /** How often the picker's status dots are checked again while the app is on screen. */
        const val STATUS_EVERY_MS = 3 * 60 * 1000L
        private const val MAIL_LOOKUP_MS = 3000L
        private const val CANCEL = "cancel"

        // Actions whose text Rukoo wrote (an approval) or that are a whole skill already: no $name counts.
        private val NO_MENTIONS = setOf("approved", "declined", "skill")
        private val REFRESH_ON = setOf(ErrorCodes.OFFLINE, ErrorCodes.UNAUTHORIZED, ErrorCodes.NOT_CONFIGURED, ErrorCodes.NOT_INSTALLED, ErrorCodes.SPAWN_FAILED)
        private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")

        /** Anything thrown or reported as {code, detail} with a code the UI knows (hub.js toError()). */
        fun toError(e: Throwable): AgentErrorInfo = when (e) {
            is AgentException -> toError(AgentErrorInfo(e.code, e.detail))
            else -> AgentErrorInfo(ErrorCodes.UNKNOWN, listOfNotNull(e.javaClass.simpleName, e.message).joinToString(": ").take(500))
        }

        fun toError(info: AgentErrorInfo): AgentErrorInfo {
            val known = info.code in ErrorCodes.TEXT
            val detail = info.detail.ifEmpty { if (known) "" else info.code }
            return AgentErrorInfo(if (known) info.code else ErrorCodes.UNKNOWN, detail.take(500))
        }

        /** A model name as the agent takes it, or null for the default; [strict] throws on anything else. */
        fun cleanModel(v: String?, strict: Boolean): String? {
            if (v.isNullOrEmpty()) return null
            val s = v.trim()
            if (s.isNotEmpty() && s.length <= 200 && !CONTROL.containsMatchIn(s)) return s
            if (strict) throw AgentException(ErrorCodes.INVALID, "model must be a model name of at most 200 characters")
            return null
        }

        /** Known effort levels only, lowest first. */
        fun cleanEfforts(list: List<String>): List<String> = ModelOptions.EFFORTS.filter { it in list }
    }
}

/** Writes conversations.json newest first, as desktop does. */
private object ConversationsFileWriter : KSerializer<List<Conversation>> {
    private val inner = ConversationsFile.serializer()
    override val descriptor = inner.descriptor

    override fun serialize(encoder: Encoder, value: List<Conversation>) =
        inner.serialize(encoder, ConversationsFile(1, value.sortedByDescending { it.updatedAt }))

    override fun deserialize(decoder: Decoder): List<Conversation> = inner.deserialize(decoder).conversations
}
