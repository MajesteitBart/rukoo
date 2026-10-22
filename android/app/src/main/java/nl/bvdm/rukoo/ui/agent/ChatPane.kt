package nl.bvdm.rukoo.ui.agent

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.QuickActions
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.ConversationStatus
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.OwnSkills
import nl.bvdm.rukoo.agents.model.RelatedChat
import nl.bvdm.rukoo.agents.model.Unread
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.ui.ComposerState
import nl.bvdm.rukoo.ui.components.DotTone
import nl.bvdm.rukoo.ui.components.LocalRkToast
import nl.bvdm.rukoo.ui.components.Monogram
import nl.bvdm.rukoo.ui.components.NewsTone
import nl.bvdm.rukoo.ui.components.OfferRow
import nl.bvdm.rukoo.ui.components.PanelCard
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkIconButtonSize
import nl.bvdm.rukoo.ui.components.StatusDot
import nl.bvdm.rukoo.ui.components.SuggestionChip
import nl.bvdm.rukoo.ui.components.popIn
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.Pane
import nl.bvdm.rukoo.ui.root.TwoPaneMinWidth
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.lineHeight
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.panel
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular

/**
 * Saves the pane's state across fold and unfold and process death. When it is saved because the chat closed, the
 * email lookup starts over: reopening the chat from an email finds that email's chat again, while New chat keeps
 * its new chat through a fold.
 */
private fun localStateSaver(chatOpen: () -> Boolean) = Saver<MutableState<ChatLocal>, String>(
    save = {
        val value = if (chatOpen()) it.value else it.value.copy(lookedUpFor = null, keepFor = null)
        RukooJson.encodeToString(ChatLocal.serializer(), value)
    },
    restore = { mutableStateOf(runCatching { RukooJson.decodeFromString(ChatLocal.serializer(), it) }.getOrDefault(ChatLocal())) },
)

/** The email a chat is about, as the hub wants it: from the cache, then with its References and unsubscribe header. */
internal suspend fun loadRef(mail: MailEngine, id: String, full: Boolean): MessageRef? {
    val s = try {
        mail.summary(id)
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    } ?: return null
    val ref = MessageRef(s.id, s.messageId, s.accountId, s.subject, s.from, s.date.takeIf { it > 0 }, inReplyTo = s.inReplyTo)
    if (!full) return ref
    val message = try {
        mail.fullMessage(id)
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    } ?: return ref
    return ref.copy(unsubscribe = message.unsubscribe != null, references = message.references.takeLast(50).ifEmpty { null })
}

/**
 * The agent chat (desktop panel.js): a header with the agent and the chat's title, the transcript or the empty
 * chat, and the input. [conversationId] is the chat on screen, null for a new one; [emailId] is the email a new
 * chat is about. On the cover screen it is a full-screen route with a back arrow; on the inner screen it sits
 * beside the reader with a close button.
 */
@Composable
fun ChatPane(app: AppViewModel, conversationId: String?, emailId: String?, modifier: Modifier = Modifier) {
    val services = app.services
    val hub = services.agents
    val c = Rk.colors
    val nav by app.state.collectAsStateWithLifecycle()
    val flow = remember(conversationId) { conversationId?.let { hub.conversation(it) } ?: flowOf(null) }
    // Whether the chat has answered yet: a chat that takes a moment shows the loader instead of the empty chat.
    val loadedState = produceState<Pair<Boolean, Conversation?>>(false to null, flow) { flow.collect { value = true to it } }
    val (loaded, conversation) = loadedState.value
    val agents by hub.agents.collectAsStateWithLifecycle()
    val rows by hub.conversations.collectAsStateWithLifecycle()
    val agentSettings by services.agentSettings.settings.collectAsStateWithLifecycle()
    val composer by services.composer.state.collectAsStateWithLifecycle()

    val saver = remember(app) { localStateSaver { app.state.value.chatOpen } }
    val local = rememberSaveable(saver = saver) { mutableStateOf(ChatLocal()) }
    val input = rememberSaveable(stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue()) }
    val email by produceState<MessageRef?>(null, emailId) {
        value = null
        if (emailId == null) return@produceState
        value = loadRef(services.mail, emailId, full = false)
        loadRef(services.mail, emailId, full = true)?.let { value = it }
    }

    val defaultAgent = agentSettings.defaultAgent.takeIf { id -> agents.any { it.id == id } }
        ?: agents.firstOrNull { it.enabled }?.id ?: agentSettings.defaultAgent
    val agentId = conversation?.agent ?: local.value.agent?.takeIf { id -> agents.any { it.id == id } } ?: defaultAgent
    val descriptor = agents.firstOrNull { it.id == agentId }
    val agentName = descriptor?.name ?: hub.agentName(agentId)
    val agentState = descriptor?.effectiveState() ?: AgentState.UNKNOWN
    val blocked = AgentText.blocked(agentState)
    val nameOf: (String?) -> String = { id -> agents.firstOrNull { it.id == id }?.name ?: id?.let(hub::agentName) ?: agentName }

    var modelsTick by remember { mutableIntStateOf(0) }
    val models by produceState<Pair<String, ModelOptions?>>("" to null, agentId, modelsTick, blocked) {
        value = agentId to null
        if (blocked) return@produceState
        value = agentId to quietly { hub.models(agentId, refresh = modelsTick > 0) }
    }
    var skillsTick by remember { mutableIntStateOf(0) }
    val ownSkills by produceState<Pair<String, OwnSkills?>>("" to null, agentId, skillsTick, blocked) {
        if (value.first != agentId) value = agentId to null
        if (blocked) return@produceState
        value = agentId to quietly { hub.ownSkills(agentId, refresh = skillsTick > 0) }
    }
    val modelList = models.second?.takeIf { models.first == agentId }
    val skillList = ownSkills.second?.takeIf { ownSkills.first == agentId }

    val related by produceState<RelatedChat?>(null, conversationId, email) {
        val ref = email
        value = if (conversationId == null && ref != null) quietly { hub.relatedFor(ref) } else null
    }

    val scope = rememberCoroutineScope()
    val toast = LocalRkToast.current
    val context = LocalContext.current
    val uri = LocalUriHandler.current
    val controller = remember(app) {
        ChatController(app, scope, toast, { context.resources }, local, input) { url -> runCatching { uri.openUri(url) } }
    }
    controller.snapshot = ChatSnapshot(
        conversation = conversation,
        emailId = emailId,
        email = email,
        agent = agentId,
        agentName = agentName,
        blocked = blocked,
        models = modelList,
        openMessageId = nav.openMessageId,
    )

    // An email that has its own chat opens that chat (desktop sync()); New chat and agent switches mark the email
    // as looked up so they stay on a new chat.
    LaunchedEffect(conversationId, emailId, email?.id) {
        val ref = email ?: return@LaunchedEffect
        if (conversationId != null || ref.id != emailId || local.value.lookedUpFor == emailId) return@LaunchedEffect
        local.value = local.value.copy(lookedUpFor = emailId)
        val found = quietly { hub.findFor(ref) }
        if (found != null && app.state.value.chatOpen && app.state.value.chatConversationId == null) app.openChat(found.id, emailId)
    }

    // "Add to chat": the emails go with the message being written. Taken after the composition that shows the chat
    // they were added for, so the chat's own email (the first, for a new chat) isn't added again.
    val offered by app.chatEmails.collectAsStateWithLifecycle()
    LaunchedEffect(offered) {
        if (offered.isEmpty()) return@LaunchedEffect
        val ids = app.takeChatEmails()
        // Added to a started chat, the emails go to that chat: the reader showing the first of them is no reason to
        // follow it to another chat (below).
        if (conversationId != null && ids.firstOrNull() == app.state.value.openMessageId) local.value = local.value.copy(keepFor = ids.first())
        controller.addEmails(ids)
    }
    // An added email the chat on screen has itself (its own, or one it continued from) goes with it already.
    LaunchedEffect(conversation?.id, conversation?.continued?.size, emailId, email?.id) {
        controller.dropEmailsInChat()
    }

    // Two panes: the chat follows the email in the reader beside it, unless the chat opened that email itself.
    val openId = nav.openMessageId
    val seenOpen = remember { mutableStateOf(openId) }
    LaunchedEffect(openId) {
        val before = seenOpen.value
        seenOpen.value = openId
        if (!app.twoPane || openId == null || openId == before) return@LaunchedEffect
        val keep = local.value.keepFor
        if (openId == keep) return@LaunchedEffect
        if (keep != null) local.value = local.value.copy(keepFor = null)
        val current = controller.snapshot.conversation
        val own = current?.message?.id ?: emailId
        if (openId == own || current?.continued?.any { it.id == openId } == true) return@LaunchedEffect
        val ref = loadRef(services.mail, openId, full = false) ?: return@LaunchedEffect
        val found = quietly { hub.findFor(ref) }
        local.value = local.value.copy(lookedUpFor = openId, detachedFor = null, model = null, effort = null)
        app.openChat(found?.id, openId)
    }

    // From the window itself, as RukooRoot decides the layout: the view model hears about a fold a frame later.
    val density = LocalDensity.current
    val twoPane = with(density) { LocalWindowInfo.current.containerSize.width.toDp() } >= TwoPaneMinWidth
    val news = agentNews(rows, conversationId)
    val subtitle = when {
        conversation != null -> conversation.title.ifBlank { stringResource(R.string.agentui_panel_new_chat) }
        else -> AgentText.status(agentState).text()
    }
    var follow by remember { mutableIntStateOf(0) }
    controller.onSent = { follow++ }

    Column(modifier.fillMaxSize().background(c.bg)) {
        ChatHeader(
            agentName = agentName,
            state = agentState,
            subtitle = subtitle,
            twoPane = twoPane,
            showList = twoPane && nav.chatOpen && nav.twoPanes().left == Pane.READER,
            news = news.count,
            newsTone = news.tone,
            onBack = { app.back() },
            onClose = app::closeChat,
            onNew = controller::newChat,
            onBell = app::openChatList,
            onShowList = app::showList,
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            var showLoader by remember(conversationId) { mutableStateOf(false) }
            LaunchedEffect(conversationId) {
                delay(150)
                showLoader = true
            }
            when {
                conversationId != null && !loaded -> if (showLoader) {
                    LoadingState(stringResource(R.string.agentui_panel_loading), Modifier.align(Alignment.Center))
                }
                conversation == null -> EmptyChat(
                    controller = controller,
                    agentName = agentName,
                    blocked = blocked,
                    email = controller.contextEmail(),
                    leftOut = controller.detached() && email != null,
                    related = related,
                    relatedName = related?.let { nameOf(it.agent) },
                    onEditShortcuts = app::openSettings,
                )
                else -> key(conversation.id) {
                    Transcript(conversation, controller, nameOf, composer, skillList?.skills.orEmpty(), follow)
                }
            }
        }
        val contextChip: ContextChip? = when {
            conversation != null -> conversation.message?.let { ContextChip.Email(it, removable = false) }
            controller.detached() && email != null -> ContextChip.Add
            else -> email?.let { ContextChip.Email(it, removable = true) }
        }
        // A chat continued from a newer email in its thread shows that email next to its own while it is open.
        val newer = conversation?.let { conv ->
            val open = openId ?: return@let null
            if (conv.message?.id == open) return@let null
            conv.continued.firstOrNull { it.id == open }?.let { NewerChip(it.ref(), it.pending) }
        }
        ChatInput(
            controller = controller,
            model = InputModel(
                agentName = agentName,
                agentId = agentId,
                agents = agents,
                computers = agentSettings.computers.associate { it.pairingId to it.name },
                context = contextChip,
                newer = newer,
                emails = local.value.emails,
                running = conversation?.status == ConversationStatus.RUNNING,
                blockedNote = AgentText.setup(agentState, agentName),
                models = modelList,
                modelsLoading = !blocked && modelList == null,
                model = if (conversation != null) conversation.model else local.value.model,
                effort = if (conversation != null) conversation.effort else local.value.effort,
                ownSkills = skillList,
                ownSkillsLoading = !blocked && skillList == null,
            ),
            actions = InputActions(
                onSetUp = app::openSettings,
                onModelsOpened = { modelsTick++ },
                onOwnSkillsOpened = { skillsTick++ },
                onFocus = { focused -> app.chatFocused = focused },
            ),
            placeholder = stringResource(
                if (controller.contextEmail() != null) R.string.agentui_panel_placeholder_email else R.string.agentui_panel_placeholder,
                agentName,
            ),
        )
    }
}

/** A suspend call whose failure the chat can live without (a list that didn't load, a lookup that failed). */
private suspend fun <T> quietly(block: suspend () -> T): T? = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    null
}

// ---------- header ----------

/** The chat header dot: ready `ok`, offline or refused `danger`, starting grey and pulsing, anything else grey. */
private fun headerTone(state: AgentState): DotTone = when (state) {
    AgentState.READY -> DotTone.OK
    AgentState.OFFLINE, AgentState.UNAUTHORIZED -> DotTone.DANGER
    else -> DotTone.MUTED
}

@Composable
private fun ChatHeader(
    agentName: String,
    state: AgentState,
    subtitle: String,
    twoPane: Boolean,
    showList: Boolean,
    news: Int,
    newsTone: NewsTone?,
    onBack: () -> Unit,
    onClose: () -> Unit,
    onNew: () -> Unit,
    onBell: () -> Unit,
    onShowList: () -> Unit,
) {
    val c = Rk.colors
    val status = AgentText.status(state).text()
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = if (twoPane) 14.dp else 4.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!twoPane) RkIconButton(RukooIcons.Back, stringResource(R.string.common_actions_back), onBack)
        Monogram(agentName.firstOrNull()?.toString() ?: "?", size = 24.dp, agent = true)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(agentName, style = Rk.type.text13.semibold, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Spacer(Modifier.width(6.dp))
                StatusDot(headerTone(state), Modifier.semantics { contentDescription = status }, pulsing = state == AgentState.CHECKING)
            }
            Text(subtitle, style = Rk.type.text12, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (showList) RkIconButton(RukooIcons.Inbox, stringResource(R.string.agentui_panel_show_list), onShowList, size = RkIconButtonSize.SMALL)
        BellButton(news, newsTone, onBell)
        RkIconButton(RukooIcons.Plus, stringResource(R.string.agentui_panel_new_chat), onNew, size = RkIconButtonSize.SMALL)
        if (twoPane) RkIconButton(RukooIcons.Close, stringResource(R.string.agentui_panel_close), onClose, size = RkIconButtonSize.SMALL)
    }
}

/** The bell: the chat list. With news it widens into a pill with the count, blue for answers, orange when a chat waits. */
@Composable
internal fun BellButton(count: Int, tone: NewsTone?, onClick: () -> Unit) {
    val c = Rk.colors
    val label = if (count > 0) stringResource(R.string.agentui_panel_history_news, count) else stringResource(R.string.agentui_panel_history)
    if (count == 0 || tone == null) {
        RkIconButton(RukooIcons.Bell, label, onClick, size = RkIconButtonSize.SMALL)
        return
    }
    val (background, content) = if (tone == NewsTone.WAITING) c.orangeTint to c.orange else c.accentTint to c.accentInk
    Box(Modifier.minimumInteractiveComponentSize(), contentAlignment = Alignment.Center) {
        Row(
            Modifier
                .popIn(140)
                .heightIn(min = 28.dp)
                .background(background, Rk.shapes.pill)
                .rkClickable(Rk.shapes.pill, onClick = onClick)
                .clearAndSetSemantics { contentDescription = label }
                .padding(start = 6.dp, end = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RkIcon(RukooIcons.Bell, null, size = 16.dp, tint = content)
            Text(if (count > 99) "99+" else count.toString(), style = Rk.type.text12.medium.tabular, color = content, maxLines = 1)
        }
    }
}

// ---------- transcript ----------

@Composable
private fun Transcript(
    conversation: Conversation,
    controller: ChatController,
    nameOf: (String?) -> String,
    composer: ComposerState?,
    skills: List<nl.bvdm.rukoo.agents.model.OwnSkill>,
    sent: Int,
) {
    val running = conversation.status == ConversationStatus.RUNNING
    val rows = remember(conversation.items, running) { TranscriptModel.rows(conversation.items, running) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    // Follows new text unless the user scrolled up to read; then a small arrow takes them back down.
    var follow by rememberSaveable { mutableStateOf(true) }
    // Items that come in while the chat is on screen play their entry once; the rest are already there.
    val openedAt = remember { System.currentTimeMillis() - 500 }
    val last = rows.size
    val agentName = nameOf(conversation.agent)

    LaunchedEffect(Unit) { if (follow) listState.scrollToItem(last) }
    LaunchedEffect(listState.isScrollInProgress) {
        if (!listState.isScrollInProgress) follow = !listState.canScrollForward
    }
    LaunchedEffect(sent) {
        if (sent > 0) {
            follow = true
            listState.animateScrollToItem(rows.size)
        }
    }
    LaunchedEffect(listState) {
        snapshotFlow { listState.canScrollForward }.collect { more ->
            if (more && follow && !listState.isScrollInProgress) listState.scrollToItem(listState.layoutInfo.totalItemsCount - 1)
        }
    }
    LaunchedEffect(rows.size) { if (follow) listState.scrollToItem(rows.size) }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(Rk.spacing.transcriptGap),
            modifier = Modifier.fillMaxSize(),
        ) {
            items(rows, key = { it.key }, contentType = { it::class }) { row ->
                TranscriptRowView(row, conversation, controller, nameOf, agentName, composer, skills, openedAt)
            }
            item(key = "bottom") { Spacer(Modifier.height(1.dp)) }
        }
        if (!follow && listState.canScrollForward) {
            JumpButton(
                {
                    follow = true
                    scope.launch { listState.animateScrollToItem(rows.size) }
                },
                Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp),
            )
        }
    }
}

@Composable
private fun TranscriptRowView(
    row: TranscriptRow,
    conversation: Conversation,
    controller: ChatController,
    nameOf: (String?) -> String,
    agentName: String,
    composer: ComposerState?,
    skills: List<nl.bvdm.rukoo.agents.model.OwnSkill>,
    openedAt: Long,
) {
    when (row) {
        is TranscriptRow.Working -> WorkingLabel(agentName, row.since)
        is TranscriptRow.Tools -> {
            val first = conversation.items.firstOrNull { "tools:${it.id}" == row.key }
            ToolRow(row, animate = (first?.at ?: 0) >= openedAt)
        }
        is TranscriptRow.Single -> {
            val item = row.item
            val animate = item.at >= openedAt
            when (item) {
                is Item.User -> UserMessage(item, if (item.action == "skill") emptyList() else skills, animate)
                is Item.Assistant -> AssistantMessage(item, controller::openLink)
                is Item.Thinking -> ThinkingBlock(item)
                is Item.Approval -> ApprovalCard(
                    item,
                    nameOf(item.source.takeIf { it != "rukoo" } ?: conversation.agent),
                    onChoose = { choice, failed -> controller.decide(item.id, choice, failed) },
                    animate = animate,
                )
                is Item.Notice -> NoticeLine(item, agentName, if (item.undo != null) ({ failed -> controller.undoNotice(item.id, failed) }) else null, animate)
                is Item.Draft -> DraftCard(
                    item,
                    canUndo = DraftCards.canUndo(item, composer),
                    onShow = { controller.showDraft(item) },
                    onUndo = { controller.undoDraft(item) },
                    animate = animate,
                )
                is Item.Plan -> PlanBlock(item, controller::openLink, animate)
                is Item.Sources -> SourcesBlock(item, controller::openSource, animate)
                is Item.Tool -> Unit
            }
        }
    }
}

// ---------- empty chat ----------

/**
 * A chat that hasn't started (panel.js renderEmpty): a card with what the agent can do for this email, the
 * quick actions as chips (with a round chip to edit them), and an offer to continue the chat about an earlier
 * email in the thread. When the agent can't take a message, the card says how to set it up and no chips show.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EmptyChat(
    controller: ChatController,
    agentName: String,
    blocked: Boolean,
    email: MessageRef?,
    leftOut: Boolean,
    related: RelatedChat?,
    relatedName: String?,
    onEditShortcuts: () -> Unit,
) {
    val c = Rk.colors
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        PanelCard {
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                RkIcon(PanelIcons.Sparkle, null, size = 11.dp, tint = c.ink3)
                Text(agentName, style = Rk.type.text11.medium.panel, color = c.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.height(6.dp))
            val title = when {
                blocked -> stringResource(R.string.agentui_empty_setup_title, agentName)
                email != null -> stringResource(R.string.agentui_empty_title, agentName)
                else -> stringResource(R.string.agentui_empty_title_no_email, agentName)
            }
            Text(title, style = Rk.type.text14.medium.panel.lineHeight(1.4f), color = c.ink)
            val body = when {
                blocked -> stringResource(R.string.agentui_empty_setup_body, agentName)
                email != null -> stringResource(R.string.agentui_empty_body)
                leftOut -> stringResource(R.string.agentui_empty_body_left_out)
                else -> stringResource(R.string.agentui_empty_body_no_email)
            }
            Spacer(Modifier.height(4.dp))
            Text(body, style = Rk.type.panelProse, color = c.ink2)
        }
        if (!blocked) {
            val actions = QuickActions.chips(controller.quickActions(), emailOpen = email != null, unsubscribe = email?.unsubscribe == true)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                actions.forEachIndexed { i, action ->
                    SuggestionChip(
                        AgentText.actionLabel(action).text(),
                        onClick = { controller.runAction(action) },
                        icon = PanelIcons.named(action.icon),
                        delayMs = i * 40,
                    )
                }
                EditShortcutsChip(onEditShortcuts, actions.size * 40)
            }
        }
        if (related != null && relatedName != null) {
            val locale = LocalConfiguration.current.locales[0]
            OfferRow(
                stringResource(R.string.agentui_panel_continue_chat),
                onClick = { controller.continueChat(related) },
                sub = "$relatedName · ${ChatFormat.listTime(related.updatedAt, System.currentTimeMillis(), locale)}",
                leading = { Monogram(relatedName.firstOrNull()?.toString() ?: "?", size = 20.dp, agent = true) },
            )
        }
    }
}

/** The quiet round chip after the quick actions that leads to Settings, where they are set up. */
@Composable
private fun EditShortcutsChip(onClick: () -> Unit, delayMs: Int) {
    val c = Rk.colors
    val label = stringResource(R.string.agentui_panel_edit_shortcuts)
    Box(
        Modifier
            .popIn(200, delayMs)
            .size(32.dp)
            .border(1.dp, c.line, CircleShape)
            .rkClickable(CircleShape, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        RkIcon(PanelIcons.Sliders, null, size = 13.dp, tint = c.ink3)
    }
}
