package nl.bvdm.rukoo.mcp.tools

import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import java.util.Collections
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.AgentSettings
import nl.bvdm.rukoo.agents.ToolIdentity
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.ApprovalChoice
import nl.bvdm.rukoo.agents.model.ApprovalField
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.ChatFile
import nl.bvdm.rukoo.agents.model.ChoiceKind
import nl.bvdm.rukoo.agents.model.ComputerProgram
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.Origin
import nl.bvdm.rukoo.agents.model.PlanTask
import nl.bvdm.rukoo.agents.model.SourceRef
import nl.bvdm.rukoo.agents.model.TaskStatus
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.core.UriComponent
import nl.bvdm.rukoo.core.Unsafe
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.ViewKind
import nl.bvdm.rukoo.mcp.McpBackend
import nl.bvdm.rukoo.mcp.McpCaller
import nl.bvdm.rukoo.mcp.McpHandler
import nl.bvdm.rukoo.ui.ComposerController
import nl.bvdm.rukoo.ui.ScreenState

/** Reads a file the user attached to a chat (desktop hub.files.read). Throws when it is gone. */
fun interface ChatFileReader {
    fun read(conversation: Conversation, file: ChatFile): ByteArray
}

/** Opens a sender's unsubscribe page for mail_action; false when Android didn't let Rukoo show it. */
fun interface UnsubscribeOpener {
    fun openPage(url: String): Boolean
}

/** Everything the tools read and change. [hubContext] is where hub and composer calls run (the main thread in the app). */
class ToolDeps(
    val mail: MailEngine,
    val hub: AgentHub,
    val screen: ScreenState,
    val composer: ComposerController,
    val agentSettings: () -> AgentSettings,
    val skills: SkillSource,
    val scope: CoroutineScope,
    val hubContext: CoroutineContext = EmptyCoroutineContext,
    val defaultAccountId: () -> String? = { null },
    val chatFiles: ChatFileReader = ChatFileReader { _, f -> File(f.file).readBytes() },
    val opener: UnsubscribeOpener = UnsubscribeOpener { false },
    val texts: DraftTexts = DraftTexts.English,
    val zone: () -> ZoneId = { ZoneId.systemDefault() },
    val clock: Clock = Clock.System,
    /** How long mail_action waits for actions that run without asking: clients give up on a call after 120 s. */
    val mailWaitMs: Long = 90_000,
    /** How long write_draft waits for the email it answers, as desktop gives its composer (20 s). */
    val draftWaitMs: Long = 20_000,
)

/** One tool call: who, the CLI's `_meta`, and the chat it belongs to (set once a tool makes one). */
class ToolCall(val identity: ToolIdentity, val meta: JsonObject, var conversation: Conversation?) {
    val agent: String get() = identity.agent
}

/**
 * Desktop ensureConversation, for tools that put something on screen: the call's chat (fresh from the hub), else
 * the hub's choice of the agent's recent external chat or a new external one about the open email (revealed).
 */
internal suspend fun ensureConversation(d: ToolDeps, lookup: MailLookup, call: ToolCall): Conversation {
    call.conversation?.let { return d.hub.get(it.id) ?: it }
    val c = d.hub.ensureConversation(call.identity, null, lookup.live(d.screen.current.openMessageId))
    call.conversation = c
    return c
}

/**
 * Rukoo's tools on the phone (desktop tools.js): the same twelve tools, with the same arguments, validation,
 * tagging, results and error texts. Only the behavior adapts: the composer and screen are the phone's, and every
 * caller is remote, so nothing gets a local path.
 */
class McpTools(private val d: ToolDeps) : McpBackend {
    private val lookup = MailLookup(d.mail)
    private val drafts = DraftWriter(d, lookup)
    private val mailActions = MailActions(d, lookup)

    override fun listTools(): JsonArray = ToolList.list { d.skills.list() }

    override fun skillInstructions(room: Int): String = SkillText.instructions(d.skills.list(), room)

    override fun owns(identity: ToolIdentity, conversationId: String): Boolean = d.hub.owns(identity, conversationId)

    override fun idleSeconds(): Long? = d.screen.idleSeconds()

    /**
     * Clark and OpenClaw are themselves. A paired computer forwards a phone chat's call and names that chat in
     * `_meta["rukoo/conversation"]` (spec 3 §7.9): the call belongs to it, never to what the arguments say.
     */
    override fun identity(caller: McpCaller, meta: JsonObject?): ToolIdentity = when (caller) {
        McpCaller.Clark -> ToolIdentity(AgentIds.CLARK, null, remote = true)
        McpCaller.OpenClaw -> ToolIdentity(AgentIds.OPENCLAW, null, remote = true)
        is McpCaller.Computer -> {
            val cid = meta?.str(McpHandler.META_CONVERSATION)?.takeIf { it.isNotEmpty() }
            val own = cid?.let { d.hub.get(it) }?.agent?.takeIf { AgentIds.parseComputer(it)?.first == caller.pairingId }
            val program = meta?.str(McpHandler.META_AGENT)?.let { p -> ComputerProgram.entries.firstOrNull { it.wire == p } }
            val agent = own ?: AgentIds.computer(caller.pairingId, program ?: ComputerProgram.CLAUDE)
            ToolIdentity(agent, cid, remote = true, computer = caller.pairingId)
        }
    }

    override suspend fun callTool(identity: ToolIdentity, name: String, args: JsonObject, meta: JsonObject): JsonObject =
        withContext(d.hubContext) { call(identity, name, args, meta) }

    private suspend fun call(identity: ToolIdentity, name: String, args: JsonObject, meta: JsonObject): JsonObject {
        // Turning an agent off also closes Rukoo to it. A tool error rather than a 401, so the agent keeps the
        // server and can tell the user why.
        if (!d.hub.agentEnabled(identity.agent)) {
            return McpHandler.errorResult("${d.hub.agentName(identity.agent)} is turned off in Rukoo, so Rukoo's tools are not available. The user can turn it on in Settings > Agents.")
        }
        val tool = ToolList.byName(ToolList.bareName(name))
            ?: return McpHandler.errorResult("Unknown tool \"$name\". Rukoo's tools are: ${ToolList.NAMES.joinToString(", ")}.")
        val clean = try {
            Validator.validate(tool.inputSchema, args, "arguments") as JsonObject
        } catch (e: ToolError) {
            return McpHandler.errorResult("${e.message} Check the ${tool.name} input schema and try again.")
        }
        val conversation = d.hub.conversationForTool(identity, clean.str("conversation_id"), meta)
        // A tool call during a turn shows the agent got that turn's input.
        if (conversation != null) d.hub.toolCalled(conversation.id)
        val call = ToolCall(identity, meta, conversation)
        return try {
            toResult(run(tool.name, clean, call))
        } catch (e: ToolError) {
            McpHandler.errorResult(e.message.orEmpty())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            McpHandler.errorResult("Rukoo could not complete ${tool.name}: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    private suspend fun run(name: String, args: JsonObject, call: ToolCall): ToolOut = when (name) {
        "get_context" -> ToolOut.Data(getContext(call))
        "search_mail" -> ToolOut.Data(searchMail(args))
        "read_message" -> ToolOut.Data(readMessage(args))
        "read_attachment" -> readAttachment(args)
        "read_chat_file" -> readChatFile(args, call)
        "write_draft" -> ToolOut.Data(drafts.write(args, call))
        "get_draft" -> ToolOut.Data(drafts.current())
        "show_plan" -> ToolOut.Data(showPlan(args, call))
        "show_sources" -> ToolOut.Data(showSources(args, call))
        "propose_action" -> ToolOut.Data(proposeAction(args, call))
        "mail_action" -> ToolOut.Data(mailActions.request(args, call))
        "read_skill" -> ToolOut.Data(readSkill(args))
        else -> throw ToolError("Unknown tool \"$name\".")
    }

    /**
     * A mail approval card the hub kept from before the app restarted, answered now (desktop onMailDecision): the
     * watcher that mail_action started is gone with the old process, so the hub hands the decision over here.
     */
    fun mailDecision(conversationId: String, item: Item.Approval, approved: Boolean) = mailActions.decided(conversationId, item, approved)

    private suspend fun ensureConversation(call: ToolCall): Conversation = ensureConversation(d, lookup, call)

    private suspend fun getContext(call: ToolCall): JsonObject {
        val view = d.screen.current
        val c = call.conversation
        val openId = lookup.live(view.openMessageId)
        val boundId = c?.message?.let { lookup.locate(it) }
        val open = openId?.let { lookup.loadMessage(it) }
        val bound = if (boundId != null && boundId != openId) lookup.loadMessage(boundId) else null
        val focus = bound ?: open
        val composer = d.composer.current()?.let(drafts::view)
        val today = LocalDate.now(d.zone())
        return buildJsonObject {
            put("conversation_id", c?.id)
            put("agent", agentWire(call.agent))
            put("today", today.toString())
            put("time_zone", runCatching { d.zone().id }.getOrNull())
            put(
                "user",
                buildJsonObject {
                    put(
                        "accounts",
                        buildJsonArray {
                            for (a in lookup.accounts()) {
                                add(
                                    buildJsonObject {
                                        put("id", a.id)
                                        put("email", a.email)
                                        put("name", a.name)
                                        put(
                                            "identities",
                                            buildJsonArray {
                                                for (i in d.mail.identities(a.id)) {
                                                    add(
                                                        buildJsonObject {
                                                            put("address", i.address)
                                                            put("name", i.name)
                                                        },
                                                    )
                                                }
                                            },
                                        )
                                        put(
                                            "folders",
                                            buildJsonArray {
                                                for (f in lookup.publicFolders(a.id)) {
                                                    add(
                                                        buildJsonObject {
                                                            put("path", f.path)
                                                            put("role", f.role)
                                                        },
                                                    )
                                                }
                                            },
                                        )
                                    },
                                )
                            }
                        },
                    )
                },
            )
            put("open_message", open?.let { lookup.fullView(it) } ?: JsonNull)
            put("chat_message", bound?.let { lookup.fullView(it) } ?: JsonNull)
            // The chat is about an email Rukoo cannot find right now (moved to an unsynced folder, or deleted).
            if (c?.message != null && boundId == null) {
                put("chat_message_missing", true)
                put("chat_message_subject", Unsafe.value(c.message.subject))
            }
            put("thread", JsonArray(focus?.let { lookup.threadOf(it) } ?: emptyList()))
            put("selection", JsonArray(view.selectedIds.take(20).mapNotNull { lookup.summaryById(it) }))
            put("composer", composer ?: JsonNull)
            put(
                "view",
                buildJsonObject {
                    put("scope", view.view.accountId ?: "all")
                    put("view", RukooJson.encodeToJsonElement(ViewKind.serializer(), view.view.kind))
                    put("folder", view.view.folder)
                },
            )
        }
    }

    /** The agent as desktop names it in get_context: a computer's Claude Code is `claude` there too. */
    private fun agentWire(agent: String): String = AgentIds.parseComputer(agent)?.second?.wire ?: agent

    private suspend fun searchMail(args: JsonObject): JsonObject {
        val acc = args.str("account")?.let(lookup::findAccount)
        val unloaded = Collections.synchronizedList(mutableListOf<JsonObject>())
        val folderArg = args.str("folder")
        val list = if (folderArg != null) {
            val targets = acc?.let(::listOf) ?: lookup.accounts()
            val paths = targets.mapNotNull { a -> lookup.resolveFolder(a, folderArg)?.let { a to it } }
            if (paths.isEmpty()) throw ToolError("No folder ${Unsafe.value(folderArg)}. Folders: ${lookup.folderList(targets)}.")
            // User folders are only cached after they were opened once. When opening fails (offline, signed out), a
            // folder with an earlier copy is searched in that copy; one without has nothing to search, and the agent
            // must not tell the user there is no such mail.
            coroutineScope {
                paths.map { (a, p) ->
                    async {
                        try {
                            d.mail.openFolder(a.id, p)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            if (d.mail.listMessages(MailView.folder(a.id, p)).isEmpty()) {
                                unloaded += buildJsonObject {
                                    put("account", a.email)
                                    put("folder", p)
                                    put("error", e.message ?: e.javaClass.simpleName)
                                }
                            }
                        }
                    }
                }.awaitAll()
            }
            if (unloaded.size == paths.size) {
                val where = unloaded.joinToString(", ") { "\"${it.str("folder")}\" in ${it.str("account")} (${it.str("error")})" }
                throw ToolError("Rukoo could not load $where, so it could not search there. Tell the user; this does not mean there is no such mail.")
            }
            paths.flatMap { (a, p) -> d.mail.listMessages(MailView.folder(a.id, p)) }
        } else {
            d.mail.listMessages(MailView(ViewKind.EVERYTHING, acc?.id))
        }
        val words = tokens(args.str("query"))
        val from = MailLookup.fold(args.str("from")).trim()
        val unread = args.bool("unread")
        fun person(a: nl.bvdm.rukoo.mail.model.Address?) = "${a?.name.orEmpty()} ${a?.address.orEmpty()}"
        val hits = list.filter { m ->
            if (unread != null && m.unread != unread) return@filter false
            if (from.isNotEmpty() && !MailLookup.fold(person(m.from)).contains(from)) return@filter false
            if (words.isEmpty()) return@filter true
            val hay = MailLookup.fold((listOf(m.subject, m.preview, person(m.from)) + m.to.map(::person) + m.cc.map(::person)).joinToString(" "))
            words.all { hay.contains(it) }
        }.sortedByDescending { it.date }
        val limit = args.long("limit")?.toInt() ?: 15
        return buildJsonObject {
            put("results", JsonArray(hits.take(limit).map(lookup::summary)))
            put("total", hits.size)
            if (unloaded.isNotEmpty()) put("unloaded_folders", JsonArray(unloaded.toList()))
        }
    }

    private fun tokens(query: String?): List<String> = MailLookup.fold(query)
        .split(SPACES)
        .map { it.replace(TOKEN_EDGES, "") }
        .filter { it.isNotEmpty() }

    private suspend fun readMessage(args: JsonObject): JsonObject {
        val id = lookup.resolveId(args.str("message_id"))
        val m = d.mail.fullMessage(id)
        return lookup.fullView(m, args.long("max_chars")?.toInt() ?: MailLookup.TEXT_MAX)
    }

    private suspend fun readAttachment(args: JsonObject): ToolOut {
        val id = lookup.resolveId(args.str("message_id"))
        val index = args.long("index")!!.toInt()
        val full = d.mail.fullMessage(id)
        val meta = full.attachments.firstOrNull { it.index == index }
        if (meta == null) {
            val have = full.attachments.joinToString(", ") { "${it.index}: ${Unsafe.value(it.filename)}" }.ifEmpty { "none" }
            throw ToolError("That email has no attachment with index $index. Attachments: $have.")
        }
        val a = d.mail.attachment(id, index)
        val name = FileResults.safeName(a.filename)
        val declared = a.contentType.ifEmpty { meta.contentType }.ifEmpty { "application/octet-stream" }.lowercase()
        // What Rukoo goes by and hands to the client as mimeType; the sender's own words only show, tagged.
        val type = FileResults.mimeType(declared)
        val bytes = a.bytes.size
        val info = buildJsonObject {
            put("message_id", id)
            put("index", index)
            put("filename", Unsafe.value(name))
            put("content_type", Unsafe.value(declared))
            put("size", bytes)
        }
        if (FileResults.RISKY.containsMatchIn(name)) {
            return ToolOut.Data(info.plus("blocked" to true, "note" to "Rukoo does not hand out programs or scripts from email. Tell the user what it is instead."))
        }
        if (bytes > FileResults.ATTACHMENT_MAX) {
            throw ToolError("${Unsafe.value(name)} is ${FileResults.sizeText(bytes.toLong())}; Rukoo hands out attachments up to 10 MB.")
        }
        val charset = a.charset ?: FileResults.charsetOf(meta.contentType) ?: "utf-8"
        return FileResults.result(
            info, name, type, a.bytes,
            uri = "rukoo://attachment/${UriComponent.encode(id)}/$index",
            source = "attachment",
            decode = { FileResults.decodeCharset(it, charset) },
        )
    }

    // The files the user attached to messages in this chat. Their names are the user's file names, which anyone can
    // have chosen, so they are tagged like an email's attachment names.
    private suspend fun readChatFile(args: JsonObject, call: ToolCall): ToolOut {
        val c = call.conversation?.let { d.hub.get(it.id) ?: it }
            ?: throw ToolError("Rukoo does not know which chat this is. Pass the conversation_id from the message.")
        val list = c.files
        val wanted = args.str("file_id")
        if (wanted.isNullOrEmpty()) {
            return ToolOut.Data(
                buildJsonObject {
                    put("conversation_id", c.id)
                    put(
                        "files",
                        buildJsonArray {
                            for (f in list) {
                                add(
                                    buildJsonObject {
                                        put("file_id", f.id)
                                        put("filename", Unsafe.value(f.name))
                                        put("content_type", f.type)
                                        put("size", f.size)
                                    },
                                )
                            }
                        },
                    )
                },
            )
        }
        val want = wanted.trim()
        val f = list.firstOrNull { it.id == want } ?: run {
            val have = list.joinToString(", ") { "${it.id}: ${Unsafe.value(it.name)}" }.ifEmpty { "none" }
            throw ToolError("This chat has no file with file_id ${Unsafe.value(want)}. Its files: $have.")
        }
        val content = try {
            withContext(kotlinx.coroutines.Dispatchers.IO) { d.chatFiles.read(c, f) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            throw ToolError("Rukoo no longer has ${Unsafe.value(f.name)}. Ask the user to attach it again.")
        }
        val info = buildJsonObject {
            put("conversation_id", c.id)
            put("file_id", f.id)
            put("filename", Unsafe.value(f.name))
            put("content_type", f.type)
            put("size", content.size)
        }
        return FileResults.result(
            info, f.name, f.type, content,
            // Hermes names the copy it saves after the last part.
            uri = "rukoo://chat-file/${UriComponent.encode(c.id)}/${f.id}/${UriComponent.encode(f.name)}",
            source = "file",
            decode = FileResults::decodeText,
        )
    }

    private suspend fun showPlan(args: JsonObject, call: ToolCall): JsonObject {
        val tasks = args.list("tasks").orEmpty().map { it as JsonObject }
        // With no conversation to update, every task is new: checked before one is made, so a bad call from outside
        // a chat leaves nothing behind.
        val untitled = tasks.firstOrNull { it.str("title").isNullOrEmpty() }
        if (untitled != null && call.conversation == null && externalFor(call.agent) == null) {
            throw ToolError("Task ${untitled.str("id")?.ifEmpty { null } ?: "(no id)"} is new and needs a title. Pass conversation_id to update a plan you showed earlier.")
        }
        val c = ensureConversation(call)
        val plans = c.items.filterIsInstance<Item.Plan>()
        val planId = args.str("plan_id")?.ifEmpty { null }
        var item: Item.Plan? = planId?.let { p -> plans.firstOrNull { it.planId == p } }
        if (item == null && planId == null) {
            val latest = plans.lastOrNull()
            if (latest != null && tasks.all { t -> t.str("id")?.ifEmpty { null }?.let { id -> latest.tasks.any { it.id == id } } == true }) item = latest
        }
        val isNew = item == null
        // Check before changing anything, so a bad call leaves the plan on screen as it was.
        for (t in tasks) {
            val id = t.str("id")?.ifEmpty { null }
            val known = item != null && id != null && item.tasks.any { it.id == id }
            if (!known && t.str("title").isNullOrEmpty()) throw ToolError("Task ${id ?: "(no id)"} is new and needs a title.")
        }
        var plan = item ?: run {
            var n = plans.size + 1
            while (plans.any { it.planId == "p$n" }) n++
            Item.Plan("", 0, planId ?: "p$n", args.str("title").orEmpty(), emptyList())
        }
        if (!isNew && args.has("title")) plan = plan.copy(title = args.str("title").orEmpty())
        val list = plan.tasks.toMutableList()
        for (t in tasks) {
            val id = t.str("id")?.ifEmpty { null }
            val at = if (id != null) list.indexOfFirst { it.id == id } else -1
            var task = if (at >= 0) list[at] else PlanTask(id ?: nextTaskId(list))
            t.str("title")?.let { task = task.copy(title = it) }
            t.str("detail")?.let { task = task.copy(detail = it) }
            t.str("system")?.let { task = task.copy(system = it) }
            t.str("status")?.let { s -> TaskStatus.entries.firstOrNull { it.name.lowercase() == s }?.let { task = task.copy(status = it) } }
            t.str("owner")?.let { task = task.copy(owner = it) }
            t.str("due")?.let { task = task.copy(due = it) }
            if (t.has("url")) task = task.copy(url = safeUrl(t.str("url")))
            if (at >= 0) list[at] = task else list += task
        }
        plan = plan.copy(tasks = list)
        plan = if (isNew) d.hub.addItem(c.id, plan) as Item.Plan else plan.also { d.hub.updateItem(c.id, it) }
        return buildJsonObject {
            put("conversation_id", c.id)
            put("plan_id", plan.planId)
            put(
                "tasks",
                buildJsonArray {
                    for (t in plan.tasks) {
                        add(
                            buildJsonObject {
                                put("id", t.id)
                                put("title", t.title)
                                put("status", RukooJson.encodeToJsonElement(TaskStatus.serializer(), t.status))
                            },
                        )
                    }
                },
            )
        }
    }

    private fun nextTaskId(tasks: List<PlanTask>): String {
        var n = tasks.size + 1
        while (tasks.any { it.id == "t$n" }) n++
        return "t$n"
    }

    /** desktop externalFor (hub.js:2015-2033): the agent's recent external chat about the open email, or about none. */
    private suspend fun externalFor(agent: String): Conversation? {
        val open = lookup.live(d.screen.current.openMessageId)
        val m = open?.let { d.mail.summary(it) }
        val since = d.clock.now() - EXTERNAL_REUSE_MS
        val account = open?.let(MessageIds::accountOf) ?: m?.accountId
        return d.hub.conversations.value
            .filter { it.origin == Origin.EXTERNAL && it.agent == agent && it.updatedAt >= since }
            .mapNotNull { d.hub.get(it.id) }
            .filter { c ->
                val ref = c.message
                if (m == null || ref == null) return@filter m == null && ref == null
                val own = ref.accountId ?: MessageIds.accountOf(ref.id)
                if (account != null && own != null && own != account) return@filter false
                if (!m.messageId.isNullOrEmpty() && !ref.messageId.isNullOrEmpty()) MailLookup.normId(m.messageId) == MailLookup.normId(ref.messageId) else ref.id == open
            }
            .maxByOrNull { it.updatedAt }
    }

    private suspend fun showSources(args: JsonObject, call: ToolCall): JsonObject {
        val c = ensureConversation(call)
        val sources = mutableListOf<SourceRef>()
        for (s in args.list("sources").orEmpty().map { it as JsonObject }) {
            val messageId = s.str("message_id")?.ifEmpty { null }?.let { runCatching { lookup.resolveId(it) }.getOrNull() }
            // Rukoo ids change when mail moves; the Message-ID header and the account let the card find the email again.
            val known = messageId?.let { d.mail.summary(it) }
            sources += SourceRef(
                title = s.str("title").orEmpty(),
                source = s.str("source")?.ifEmpty { null } ?: if (messageId != null) "Email" else "",
                snippet = s.str("snippet").orEmpty(),
                url = safeUrl(s.str("url")),
                messageId = messageId,
                messageHeader = known?.messageId?.take(1000),
                accountId = messageId?.let { MessageIds.accountOf(it) ?: known?.accountId },
            )
        }
        d.hub.addItem(c.id, Item.Sources("", 0, args.str("title").orEmpty(), sources))
        return buildJsonObject {
            put("ok", true)
            put("conversation_id", c.id)
            put("shown", sources.size)
        }
    }

    private suspend fun proposeAction(args: JsonObject, call: ToolCall): JsonObject {
        val c = ensureConversation(call)
        val ticket = d.hub.requestApproval(
            c.id,
            ApprovalRequest(
                title = args.str("title").orEmpty(),
                detail = args.str("detail").orEmpty(),
                fields = args.list("fields").orEmpty().map { (it as JsonObject).let { f -> ApprovalField(f.str("label").orEmpty(), f.str("value").orEmpty()) } },
                choices = listOf(
                    ApprovalChoice("approve", args.str("confirm_label")?.ifEmpty { null } ?: "Approve", ChoiceKind.PRIMARY),
                    ApprovalChoice("decline", "Decline", ChoiceKind.DEFAULT),
                ),
                source = call.agent,
                kind = ApprovalKind.PROPOSAL,
            ),
        )
        return buildJsonObject {
            put("conversation_id", c.id)
            put("proposal_id", ticket.itemId)
            put("status", "waiting_for_user")
            put("note", "Stop here and wait. When the user approves, you receive a new message that says so; then carry it out. If they decline, you will be told.")
        }
    }

    // Skills come from Rukoo's skills and the user's, never from an email, so nothing here is tagged.
    private fun readSkill(args: JsonObject): JsonObject {
        val name = args.str("name").orEmpty()
        val file = args.str("file").orEmpty()
        if (file.isNotEmpty() && name.isEmpty()) throw ToolError("Pass the name of the skill the file belongs to.")
        return d.skills.read(name, file)
    }

    companion object {
        private const val EXTERNAL_REUSE_MS = 4 * 60 * 60 * 1000L
        private val SPACES = Regex("[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")
        private val TOKEN_EDGES = Regex("^[\"'(\\[]+|[\"')\\].,;:!?]+$")
        private val SAFE_URL = Regex("^(https?://|mailto:|obsidian://)", RegexOption.IGNORE_CASE)

        fun safeUrl(u: String?): String? = u?.trim()?.takeIf { it.isNotEmpty() && SAFE_URL.containsMatchIn(it) }

        fun toResult(out: ToolOut): JsonObject = when (out) {
            is ToolOut.Data -> buildJsonObject {
                put("content", JsonArray(listOf(FileResults.textBlock(out.value))))
                put("structuredContent", out.value)
            }
            is ToolOut.Raw -> buildJsonObject {
                put("content", out.content)
                out.structured?.let { put("structuredContent", it) }
            }
        }
    }
}
