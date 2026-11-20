package nl.bvdm.rukoo.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.Avatar
import nl.bvdm.rukoo.ui.components.EmptyState
import nl.bvdm.rukoo.ui.components.Hairline
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkButtonSize
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkLinkButton
import nl.bvdm.rukoo.ui.components.RkTopBar
import nl.bvdm.rukoo.ui.components.Spinner
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.mail.MailDates
import nl.bvdm.rukoo.ui.mail.rememberMailDates
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.ChatPane
import nl.bvdm.rukoo.ui.root.ChatSheet
import nl.bvdm.rukoo.ui.root.RoomOpening
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.lineHeight
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.rkShadow
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular
import nl.bvdm.rukoo.ui.theme.title
import nl.bvdm.rukoo.workspaces.Channel
import nl.bvdm.rukoo.workspaces.Connection
import nl.bvdm.rukoo.workspaces.Event
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.PendingState
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind
import nl.bvdm.rukoo.workspaces.RoomTimeline
import nl.bvdm.rukoo.workspaces.WorkspaceStatus

/** How loading older messages went, for the row at the top of the timeline. */
private enum class Older { IDLE, LOADING, FAILED }

/**
 * A conversation (android.md "Conversation", contract §3.9, §3.13, §3.18, §7.4): the room's title and members over its
 * timeline, newest at the bottom, and the composer under it. Reply rows open their thread, a top-level message's
 * summary too, and a long press opens a message's menu. The timeline reports the newest message fully in view as read
 * while nothing covers it, loads older messages near the top, and offers a pill to the latest message and one up to
 * the first unread. Opened from a notification it shows that message. Where nothing can be sent, a bar takes the
 * composer's place: a channel not joined yet (with Join), an archived channel, a closed DM (with Start a new
 * conversation and Remove from list) and a stopped workspace, whose banner has Start over. [twoPane] hides Back, as
 * the list stays beside it.
 */
@Composable
fun RoomPane(app: AppViewModel, ws: String, room: String, modifier: Modifier = Modifier, twoPane: Boolean = app.twoPane) {
    val c = Rk.colors
    val workspaces = app.services.workspaces ?: return
    val nav by app.state.collectAsStateWithLifecycle()
    val chat by app.chatState.collectAsStateWithLifecycle()
    val screen by app.services.screen.state.collectAsStateWithLifecycle()
    val viewNow by app.chatView.collectAsStateWithLifecycle()
    val openingNow by app.roomOpening.collectAsStateWithLifecycle()
    val view = viewNow?.takeIf { it.ws.id == ws }
    val flow = remember(ws, room) { workspaces.timeline(ws, room).catch { } }
    // The collected value outlives a change of room for a frame; only this room's timeline counts.
    val timelineNow by flow.collectAsStateWithLifecycle(initialValue = null)
    val timeline = timelineNow?.takeIf { it.room.id == room }
    // Which opening of the room this is (§3.18). It comes with the view model's open(), and the pane keeps it while it
    // slides away after Back, when the view model's has already ended.
    val memo = remember(ws, room) { OpeningMemo() }
    val opening = openingNow?.takeIf { it.ws == ws && it.room == room }?.also { memo.opening = it } ?: memo.opening
    val summary = chat.workspaces.firstOrNull { it.id == ws }
    val roomModel = timeline?.room ?: view?.rooms?.firstOrNull { it.id == room }
    // A channel opened before joining it (from Browse): no history to read, and Join where the composer goes.
    val notJoined = if (roomModel == null) view?.channels?.firstOrNull { it.id == room && !it.joined } else null
    val members = remember(view) { view?.members.orEmpty().associateBy { it.id } }
    val me = view?.me?.id
    val blocked = remember(view) { view?.blocks.orEmpty().mapTo(HashSet()) { it.member } }
    val names = rememberChatNames()
    val title = roomModel?.let { if (it.kind == RoomKind.DM) names.title(it, members, me) else "#${it.name.orEmpty()}" }
        ?: notJoined?.let { "#${it.name}" }.orEmpty()
    val paused = summary?.status == WorkspaceStatus.QUARANTINED
    val upgrade = summary?.status == WorkspaceStatus.UPGRADE
    // The newest message fully in view counts as read while the room is on screen in the resumed app and nothing
    // covers it (§3.9).
    val canRead = screen.foreground && nav.chat.sheet == null && !nav.drawerOpen && nav.overlay == null && !app.chatUi.covered
    var actionsFor by remember(ws, room) { mutableStateOf<ChatTimeline.Message?>(null) }

    Column(modifier.background(c.panel)) {
        RkTopBar(
            title = title,
            subtitle = roomModel?.let { roomSubtitle(it, chat.host) } ?: notJoined?.let { channelSubtitle(it.members, it.visibility) },
            // Who hosts a DM and can read it, or who is in a channel: read, so text2 (desktop .ch-meta).
            subtitleColor = c.text2,
            navigation = if (twoPane) null else {
                { RkIconButton(RukooIcons.Back, stringResource(R.string.common_actions_back), onClick = { app.back() }) }
            },
            actions = {
                if (roomModel != null) {
                    // A channel's members are one tap away, as desktop's header has them (desktop-ui 5.2).
                    if (roomModel.kind == RoomKind.CHANNEL) {
                        RkIconButton(RukooIcons.People, stringResource(R.string.chat_head_members_button), onClick = { app.openChatSheet(ChatSheet.MEMBERS, room) })
                    }
                    RkIconButton(RukooIcons.Info, stringResource(R.string.chat_room_details), onClick = { app.openChatSheet(ChatSheet.DETAILS, room) })
                }
            },
        )
        if (paused) PausedBanner(summary.name, busy = app.chatUi.isBusy("reload:$ws")) { app.chatUi.reload(ws) }
        else if (upgrade) UpgradeBanner(chat.host)
        else if (chat.connection == Connection.OFFLINE) OfflineBanner(chat.host, busy = app.chatUi.isBusy("refresh:$ws")) { app.chatUi.refresh(ws) }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            val t = timeline
            when {
                notJoined != null -> NotJoinedNote(notJoined)
                roomModel == null && view != null -> EmptyState(stringResource(R.string.chat_errors_gone_conversation), icon = ChatIcons.Bubble)
                t == null || opening == null || (t.loading && t.events.isEmpty() && t.pending.isEmpty()) ->
                    ChatLoading(stringResource(R.string.chat_empty_loading), Modifier.fillMaxSize())
                else -> RoomLog(
                    app = app,
                    ws = ws,
                    room = room,
                    opening = opening,
                    t = t,
                    members = members,
                    blocked = blocked,
                    me = me,
                    names = names,
                    workspace = summary?.name.orEmpty(),
                    host = chat.host,
                    hostName = chat.operator?.name ?: chat.host,
                    retentionDays = chat.retention?.contentDays,
                    canRead = canRead,
                    writable = !upgrade,
                    onLongPress = { row -> if (MessageRules.hasActions(row, me, t.room, inThread = false, view?.me?.role, members[row.actor], blocked, writable = !upgrade)) actionsFor = row },
                )
            }
        }
        val slot = ComposerSlots.of(roomModel, notJoined, paused, upgrade = upgrade)
        val t = timeline
        when {
            slot != ComposerSlot.Composer -> ComposerBar(app, ws, slot, roomModel, me, summary?.name.orEmpty(), inThread = false)
            roomModel != null && t != null -> ChatComposer(
                app = app,
                ws = ws,
                room = roomModel,
                root = null,
                draft = t.draft,
                members = members,
                me = me,
                recent = remember(t.events, me) { ComposerSlots.recentAuthors(t.events, me) },
                placeholder = if (roomModel.kind == RoomKind.DM) {
                    stringResource(R.string.chat_input_placeholder_direct, title)
                } else {
                    stringResource(R.string.chat_input_placeholder_channel, roomModel.name.orEmpty())
                },
                pane = ChatPane.ROOM,
            )
        }
        val target = actionsFor
        if (target != null && roomModel != null) {
            MessageActionsSheet(
                app = app,
                ws = ws,
                room = roomModel,
                message = target,
                me = me,
                myRole = view?.me?.role,
                blocked = blocked,
                inThread = false,
                where = title,
                author = members[target.actor],
                names = names,
                onDismiss = { actionsFor = null },
                writable = !upgrade,
            )
        }
    }
}

/** The last opening of one room a pane saw. */
private class OpeningMemo {
    var opening: RoomOpening? = null
}

/**
 * Where a channel not joined yet keeps its history: its name, and that joining shows its messages. The history is only
 * withheld, so "This is the start of" stays for joined channels.
 */
@Composable
private fun NotJoinedNote(channel: Channel) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        EmptyState(
            stringResource(R.string.chat_channel_preview_title, channel.name),
            hint = stringResource(R.string.chat_channel_preview_body, channel.name),
            icon = if (channel.visibility == "private") ChatIcons.Lock else ChatIcons.Hash,
        )
    }
}

/**
 * Where a room's timeline was in [opening]: the first visible row's [key], and its bottom-up [index] and [offset]. The
 * view model keeps it for the opening (folding, the background and a thread over the room keep it), so another opening
 * starts at the bottom, from where the New divider is placed again (§3.18).
 */
data class TimelineScroll(val opening: Long, val key: String?, val index: Int, val offset: Int) {
    /** Whether the timeline was at the bottom, following new messages. */
    val atBottom: Boolean get() = index == 0 && offset < STICK_PX

    /**
     * The index and offset to show in [keys], the timeline's row keys bottom up as they are now. At the bottom it stays
     * there, with what came meanwhile. Elsewhere the row it showed comes back at its current index, as rows that came
     * meanwhile (a message, a pending row, a day divider) moved every index; when that row is gone, the saved index.
     */
    fun restoreIn(keys: List<String>): Pair<Int, Int> {
        if (atBottom) return 0 to offset
        val i = key?.let { keys.indexOf(it) } ?: -1
        return (if (i >= 0) i else index) to offset
    }
}

@Composable
private fun roomSubtitle(room: Room, host: String): String =
    if (room.kind == RoomKind.DM) stringResource(R.string.chat_head_direct, host) else channelSubtitle(room.members, room.visibility)

@Composable
private fun channelSubtitle(members: Int, visibility: String): String {
    val count = pluralStringResource(R.plurals.chat_head_members, members, members)
    return if (visibility == "private") "$count · ${stringResource(R.string.chat_head_private)}" else count
}

/**
 * The chat server is out of reach (desktop chat.banner.offline): it names the server, as mail may still work, and Try
 * now runs the feed at once, as the desktop's banner does with chatSync.
 */
@Composable
internal fun OfflineBanner(host: String, busy: Boolean, onTryNow: () -> Unit) {
    val c = Rk.colors
    Row(
        Modifier.fillMaxWidth().background(c.field).padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(R.string.chat_banner_offline, host),
            style = Rk.type.text12_5,
            color = c.text2,
            modifier = Modifier.weight(1f).padding(vertical = 4.dp),
        )
        RkLinkButton(stringResource(R.string.chat_banner_try_now), onClick = onTryNow, enabled = !busy)
    }
}

/** What a timeline row needs to draw itself. */
internal class RowContext(
    val members: Map<String, Member>,
    val me: String?,
    val names: ChatNames,
    val dates: MailDates,
    val days: ChatDays,
    val now: Long,
    val room: Room,
    val workspace: String,
    val host: String,
    val retentionDays: Int,
    val events: List<Event>,
    val onOpenThread: ((String) -> Unit)?,
    val onOpenUrl: (String) -> Unit,
    val reasonText: (String?) -> String,
    /** A long press on a sent message: its menu. */
    val onLongPress: ((ChatTimeline.Message) -> Unit)? = null,
    /** An action under an unsent message. */
    val onPending: ((ChatTimeline.Message, PendingAction) -> Unit)? = null,
    val isBusy: (String) -> Boolean = { false },
    /** Who hosts the workspace as people know it: the operator's name, else the host name. */
    val hostName: String = host,
    /** False while the server asks for an update (426): unsent rows offer only Copy text and Discard. */
    val writable: Boolean = true,
)

@Composable
private fun RoomLog(
    app: AppViewModel,
    ws: String,
    room: String,
    opening: RoomOpening,
    t: RoomTimeline,
    members: Map<String, Member>,
    blocked: Set<String>,
    me: String?,
    names: ChatNames,
    workspace: String,
    host: String,
    hostName: String,
    retentionDays: Int?,
    canRead: Boolean,
    writable: Boolean,
    onLongPress: (ChatTimeline.Message) -> Unit,
) {
    val workspaces = app.services.workspaces ?: return
    val context = LocalContext.current
    // The opening a notification asked for: the message at [at], once its history reached it.
    val at = opening.at
    val reached = opening.reached
    // The read position this opening placed its New divider from, which stays while the service's loader closes and
    // opens again behind it (the app in the background, the room folded behind the list), until the sync replaces the
    // room's cached range.
    val readAt = opening.readPosition(t)
    val rows = remember(t, me, blocked, readAt) {
        ChatTimeline.rows(t.events, t.pending, me, readAt, floor = t.room.floor, hasOlder = t.hasOlder, blocked = blocked, replies = t.replies)
    }
    // Bottom up: the newest row is item 0.
    val items = remember(rows) { rows.asReversed() }
    // Both belong to this opening: a new one starts at the bottom with the New divider still to place. The view model
    // keeps them for the opening, as this pane leaves the composition while the room is folded behind the list.
    val count = opening.count
    val keys = remember(items) { items.map { it.key } }
    val restored = remember(count) { app.roomScroll(count) }
    val listState = remember(count) {
        val (index, offset) = restored?.restoreIn(keys) ?: (0 to 0)
        LazyListState(index, offset)
    }
    // The row the saved position showed may come with a later page: the position is final once it did, or once the
    // load ended without it, and is saved from then on.
    var anchored by remember(count) { mutableStateOf(restored == null || restored.atBottom || restored.key in keys) }
    var placed by remember(count) { mutableStateOf(if (opening.readAt != null) count else null) }
    val positioned = placed == count
    val scope = rememberCoroutineScope()
    var older by remember(ws, room) { mutableStateOf(Older.IDLE) }
    var lastReported by remember(ws, room) { mutableLongStateOf(0L) }
    // The newest message seen in this opening, for the Latest pill's count; kept with the opening across folding.
    var seen by rememberSaveable(count) { mutableLongStateOf(readAt) }
    // At the bottom, following new messages; a scroll position kept across a fold may be elsewhere.
    var pinned by remember(listState) { mutableStateOf(listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset < STICK_PX) }
    var viewport by remember(listState) { mutableStateOf(0) }
    val locale = LocalConfiguration.current.locales[0]
    val dates = rememberMailDates()
    val today = stringResource(R.string.common_dates_today)
    val yesterday = stringResource(R.string.common_dates_yesterday)
    val days = remember(locale, today, yesterday) { ChatDays(locale, today, yesterday) }
    val now = remember(rows) { System.currentTimeMillis() }
    val ctx = RowContext(
        members = members,
        me = me,
        names = names,
        dates = dates,
        days = days,
        now = now,
        room = t.room,
        workspace = workspace,
        host = host,
        hostName = hostName,
        retentionDays = retentionDays ?: DEFAULT_RETENTION_DAYS,
        events = t.events,
        onOpenThread = { root -> app.openThread(root) },
        onOpenUrl = app::openUrl,
        reasonText = { app.chatUi.reasonText(it, app.chatUi.context(ws)) },
        onLongPress = onLongPress,
        onPending = { row, action ->
            row.local?.let { local ->
                app.chatUi.pendingAction(ws, room, PendingRow(local, row.root, row.text.orEmpty(), row.mentions), action) { copyText(context, app, it) }
            }
        },
        isBusy = app.chatUi::isBusy,
        writable = writable,
    )

    fun loadOlder() {
        if (older == Older.LOADING) return
        older = Older.LOADING
        scope.launch {
            older = try {
                workspaces.loadOlder(ws, room)
                Older.IDLE
            } catch (e: kotlin.coroutines.cancellation.CancellationException) {
                throw e
            } catch (_: Exception) {
                Older.FAILED
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            reverseLayout = true,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(top = 8.dp, bottom = 12.dp),
        ) {
            items(items, key = { it.key }, contentType = { it::class }) { row -> TimelineRowView(row, ctx) }
            if (t.hasOlder && older != Older.IDLE) {
                item(key = "older") { OlderRow(older == Older.FAILED, onRetry = ::loadOlder) }
            }
        }
        val newIndex = items.indexOfFirst { it is ChatTimeline.New }
        val lastVisible by remember { derivedStateOf { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 } }
        if (newIndex > 0 && newIndex > lastVisible) {
            val unread = items.subList(0, newIndex).count { it is ChatTimeline.Message && it.pending == null && it.actor != me }
            JumpPill(
                pluralStringResource(R.plurals.chat_log_jump_unread, unread, unread),
                up = true,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp),
            ) { scope.launch { showDivider(listState, newIndex, viewport) } }
        }
        if (!pinned) {
            val fresh = ChatTimeline.newSince(rows, seen, me)
            JumpPill(
                if (fresh > 0) pluralStringResource(R.plurals.chat_log_latest_count, fresh, fresh) else stringResource(R.string.chat_log_latest),
                up = false,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp),
            ) {
                scope.launch {
                    listState.animateScrollToItem(0)
                    pinned = true
                }
            }
        }
    }

    // The viewport's height, for placing the New divider a third of the way down.
    LaunchedEffect(listState) { snapshotFlow { listState.layoutInfo.viewportSize.height }.collect { viewport = it } }

    // Opening a room with unread messages places the New divider a third of the way down, once per opening. Opened
    // from a notification, the message it showed takes that place once its history reached it, or the oldest loaded
    // message when the backfill stopped short (§3.7 "Opening at a seq"); when the open failed it stays at the newest.
    // The open ending isn't enough: this timeline is rebuilt after each page on its own time, so it waits until it
    // holds what the open loaded. Reading waits for it, so nothing counts as read from a position the opening didn't
    // choose.
    LaunchedEffect(rows, viewport, listState, reached) {
        if (placed == count || viewport == 0 || rows.isEmpty()) return@LaunchedEffect
        if (at != null) {
            if (!reached || !ChatTimeline.holds(t.events, opening.oldest)) return@LaunchedEffect
            val target = ChatTimeline.openingTarget(items, at, opening.complete)
            if (target != null && target > 0) {
                showDivider(listState, target, viewport, animate = false)
                pinned = false
            }
            placed = count
            app.roomPlaced(count, readAt, t.resets)
            return@LaunchedEffect
        }
        val i = items.indexOfFirst { it is ChatTimeline.New }
        if (i > 0 && i > (listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0)) showDivider(listState, i, viewport, animate = false)
        placed = count
        app.roomPlaced(count, readAt, t.resets)
    }

    // The sync replaced the room's cached range after the divider was placed (§3.18): it follows the new read position,
    // which stays from then on.
    LaunchedEffect(t.resets, positioned) {
        if (positioned && opening.readAt != null && opening.resets != t.resets) app.roomPlaced(count, t.readAtOpen, t.resets)
    }

    // A position kept from earlier in the opening, put back at the row it showed once that row is loaded.
    LaunchedEffect(keys, t.loading) {
        val r = restored ?: return@LaunchedEffect
        if (anchored) return@LaunchedEffect
        val i = r.key?.let { keys.indexOf(it) } ?: -1
        if (i >= 0) listState.scrollToItem(i, r.offset)
        if (i >= 0 || !t.loading) anchored = true
    }

    // Where the timeline is, for the view model to bring back later in this opening.
    LaunchedEffect(listState, anchored) {
        if (!anchored) return@LaunchedEffect
        snapshotFlow {
            val index = listState.firstVisibleItemIndex
            val key = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.index == index }?.key as? String
            TimelineScroll(count, key, index, listState.firstVisibleItemScrollOffset)
        }.distinctUntilChanged().collect { app.roomScrolled(it) }
    }

    // Follow the user's own scrolling: near the bottom the timeline sticks to new messages, else the Latest pill shows.
    LaunchedEffect(listState) {
        snapshotFlow { Triple(listState.firstVisibleItemIndex, listState.firstVisibleItemScrollOffset, listState.isScrollInProgress) }
            .collect { (index, offset, scrolling) -> if (scrolling) pinned = index == 0 && offset < STICK_PX }
    }
    // A new row at the bottom: stay with it while pinned, and always for your own send. The row that was at the bottom
    // when the pane appeared is no news.
    val bottom = items.firstOrNull()
    var lastBottom by remember(ws, room) { mutableStateOf(bottom?.key) }
    LaunchedEffect(bottom?.key) {
        if (bottom?.key == lastBottom) return@LaunchedEffect
        lastBottom = bottom?.key
        val own = bottom is ChatTimeline.Message && bottom.pending != null
        if (pinned || own) {
            listState.scrollToItem(0)
            pinned = true
        }
    }

    // Older messages load when the top comes within 10 rows (android.md "Conversation"), again after each page while
    // the top is still that close: [older] back to IDLE restarts this, also after a page that added no rows (only
    // removals or kinds without a row).
    LaunchedEffect(listState, t.hasOlder, items.size, older) {
        if (!t.hasOlder) return@LaunchedEffect
        snapshotFlow { (listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) >= listState.layoutInfo.totalItemsCount - OLDER_AHEAD }
            .distinctUntilChanged()
            .collect { near -> if (near && older == Older.IDLE) loadOlder() }
    }

    // Reading (§3.9): the newest message fully in view, 1 second after the last change, when higher than the last
    // report, while the room may report and once this opening placed its New divider.
    LaunchedEffect(listState, rows, canRead, positioned) {
        if (!canRead || !positioned) return@LaunchedEffect
        snapshotFlow {
            val info = listState.layoutInfo
            info.visibleItemsInfo
                .filter { it.offset >= info.viewportStartOffset && it.offset + it.size <= info.viewportEndOffset }
                .mapNotNull { it.key as? String }
        }.collectLatest { keys ->
            val seq = ChatTimeline.readableSeq(rows, keys) ?: return@collectLatest
            if (seq > seen) seen = seq
            delay(READ_REPORT_DELAY_MS)
            if (seq > lastReported && seq > t.room.read) {
                lastReported = seq
                workspaces.markRead(ws, room, seq)
            }
        }
    }
}

/** Puts row [index] a third of the way down the viewport. Bottom up, scrolling back moves towards newer rows. */
private suspend fun showDivider(state: LazyListState, index: Int, viewport: Int, animate: Boolean = true) {
    state.scrollToItem(index)
    val back = -(viewport * 0.66f)
    if (animate) state.animateScrollBy(back) else state.scrollBy(back)
}

/** A 28dp pill over the timeline: up to the first unread message, or down to the latest. */
@Composable
private fun JumpPill(label: String, up: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val c = Rk.colors
    val shape = Rk.shapes.pill
    Row(
        modifier
            .rkShadow(Rk.elevation.shadow, shape)
            .background(c.raised, shape)
            .rkClickable(shape, onClick = onClick)
            .heightIn(min = 32.dp)
            .padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RkIcon(if (up) RukooIcons.Up else RukooIcons.Down, null, size = 14.dp, tint = c.text2)
        Text(label, style = Rk.type.text12_5.medium, color = c.text, maxLines = 1)
    }
}

/** The top row while older messages load, or when that failed, with Retry. */
@Composable
private fun OlderRow(failed: Boolean, onRetry: () -> Unit) {
    val c = Rk.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 40.dp).padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (failed) {
            Text(stringResource(R.string.chat_log_older_failed), style = Rk.type.text12_5, color = c.text3)
            RkButton(stringResource(R.string.common_actions_retry), onRetry, kind = RkButtonKind.SECONDARY, size = RkButtonSize.SMALL)
        } else {
            Spinner(size = 14.dp)
            Text(stringResource(R.string.chat_log_loading_older), style = Rk.type.text12_5, color = c.text3)
        }
    }
}

/** One row of a timeline: a divider, a system line, the intro or retention note, or a message. */
@Composable
internal fun TimelineRowView(row: ChatTimeline.Row, ctx: RowContext) {
    when (row) {
        ChatTimeline.Intro -> IntroRow(ctx)
        ChatTimeline.Floor -> CenterNote(pluralStringResource(R.plurals.chat_log_retention_floor, ctx.retentionDays, ctx.retentionDays))
        ChatTimeline.New -> NewDivider()
        is ChatTimeline.Day -> DayDivider(ctx.days.label(row.date, ctx.now))
        is ChatTimeline.Count -> DayDivider(pluralStringResource(R.plurals.chat_log_replies, row.count, row.count))
        is ChatTimeline.Sys -> CenterNote(sysText(row, ctx))
        is ChatTimeline.Message -> MessageRow(row, ctx)
    }
}

@Composable
private fun CenterNote(text: String) {
    Text(
        text,
        style = Rk.type.text12_5,
        color = Rk.colors.text3,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 6.dp),
    )
}

@Composable
private fun DayDivider(label: String) {
    val c = Rk.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Hairline(Modifier.weight(1f))
        Text(label, style = Rk.type.text11_5.semibold, color = c.text3, maxLines = 1, modifier = Modifier.padding(horizontal = 10.dp))
        Hairline(Modifier.weight(1f))
    }
}

/** A 1dp accent line with "New" at its right end, before the first unread message (§3.18). */
@Composable
private fun NewDivider() {
    val c = Rk.colors
    val label = stringResource(R.string.chat_log_new_label)
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp).clearAndSetSemantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Hairline(Modifier.weight(1f), color = c.accent)
        Text(stringResource(R.string.chat_log_new), style = Rk.type.text11_5.semibold, color = c.accent, modifier = Modifier.padding(start = 8.dp))
    }
}

@Composable
private fun sysText(row: ChatTimeline.Sys, ctx: RowContext): String {
    val actor = ctx.names.display(ctx.members[row.actor])
    val member = row.member?.let { ctx.names.display(ctx.members[it]) }.orEmpty()
    return when (row.kind) {
        ChatTimeline.SysKind.CREATED -> stringResource(R.string.chat_sys_created, actor, row.name.orEmpty())
        ChatTimeline.SysKind.RENAMED -> stringResource(R.string.chat_sys_renamed, actor, row.name.orEmpty())
        ChatTimeline.SysKind.ARCHIVED -> stringResource(R.string.chat_sys_archived, actor)
        ChatTimeline.SysKind.JOINED -> stringResource(R.string.chat_sys_joined, actor)
        ChatTimeline.SysKind.ADDED -> stringResource(R.string.chat_sys_added, actor, member)
        ChatTimeline.SysKind.LEFT -> stringResource(R.string.chat_sys_left, actor)
        ChatTimeline.SysKind.REMOVED_BY -> stringResource(R.string.chat_sys_removed_by, actor, member)
        ChatTimeline.SysKind.DM_STARTED -> stringResource(R.string.chat_sys_dm_started, actor)
    }
}

/** The start of a conversation: what it is, who made it, who can see it, and for a DM who hosts it. */
@Composable
private fun IntroRow(ctx: RowContext) {
    val c = Rk.colors
    val room = ctx.room
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (room.kind == RoomKind.DM) {
            val others = room.participants.orEmpty().distinct().filter { it != ctx.me }
            Row(horizontalArrangement = Arrangement.spacedBy((-8).dp)) {
                for (id in others.take(3)) Avatar(ctx.members[id]?.name, id, size = 40.dp)
            }
            Text(
                stringResource(R.string.chat_log_start_direct, ctx.names.dmTitle(room.participants, ctx.members, ctx.me)),
                style = Rk.type.text16.title,
                color = c.text,
            )
            Text(stringResource(R.string.chat_log_host_note, ctx.host), style = Rk.type.text12_5, color = c.text2)
        } else {
            Box(Modifier.size(40.dp).background(c.field, Rk.shapes.card), contentAlignment = Alignment.Center) {
                RkIcon(if (room.visibility == "private") ChatIcons.Lock else ChatIcons.Hash, null, size = 20.dp, tint = c.text2)
            }
            Text(stringResource(R.string.chat_log_start_channel, room.name.orEmpty()), style = Rk.type.text16.title, color = c.text)
            ctx.events.firstOrNull { it.kind == "channel.created" }?.let { made ->
                Text(
                    stringResource(R.string.chat_log_start_channel_by, ctx.names.display(ctx.members[made.actor]), ctx.days.date(made.at)),
                    style = Rk.type.text12_5,
                    color = c.text2,
                )
            }
            // The host can read every room, private channels included, so their intro names it.
            Text(
                if (room.visibility == "private") stringResource(R.string.chat_log_start_private, ctx.hostName) else stringResource(R.string.chat_log_start_public, ctx.workspace),
                style = Rk.type.text12_5,
                color = c.text2,
            )
        }
    }
}

/**
 * A message (desktop-ui 5.3): the avatar, name, tag and time on the first of a group, the text with its mentions and
 * links, "Message removed" once removed, the thread's summary under a top-level message, and for a reply row the line
 * about the message it answers. A send on its way says how it is doing. A message that mentions you has an accent bar.
 */
@Composable
private fun MessageRow(row: ChatTimeline.Message, ctx: RowContext) {
    val c = Rk.colors
    val author = ctx.members[row.actor]
    val name = ctx.names.display(author)
    val accent = c.accent
    val longPress = ctx.onLongPress?.takeIf { row.pending == null && row.id != null }
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (longPress != null) messageActions(stringResource(R.string.chat_msg_actions)) { longPress(row) } else Modifier)
            .then(if (row.mentionsMe) Modifier.drawBehind { drawLine(accent, Offset(1.dp.toPx(), 0f), Offset(1.dp.toPx(), size.height), 2.dp.toPx()) } else Modifier)
            .padding(start = 16.dp, end = 16.dp, top = if (row.head) 8.dp else 1.dp, bottom = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.width(32.dp)) {
            if (row.head) Avatar(if (author?.state == "deleted") "?" else author?.name, row.actor, size = 32.dp)
        }
        Column(Modifier.weight(1f)) {
            if (row.reply && row.head) row.context?.let { ReplyContext(it, ctx) }
            if (row.head) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(name, style = Rk.type.text13.semibold, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    memberTag(author)?.let { Tag(it) }
                    Text(ctx.dates.time(row.at), style = Rk.type.text12.tabular, color = c.text3, maxLines = 1)
                }
            }
            if (row.removed) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    RkIcon(RukooIcons.Trash, null, size = 14.dp, tint = c.text2)
                    Text(stringResource(R.string.chat_log_removed), style = Rk.type.text13_5.copy(fontStyle = FontStyle.Italic), color = c.text2)
                }
            } else {
                val text = row.text.orEmpty()
                val annotated = remember(text, row.mentions, row.blocked, ctx.me, c) { messageText(text, row, ctx, c) }
                Text(annotated, style = Rk.type.text13_5.lineHeight(1.5f), color = if (row.pending != null) c.text2 else c.text)
            }
            row.replies?.let { r -> ctx.onOpenThread?.let { open -> ReplySummaryRow(r, ctx) { open(row.id!!) } } }
            row.pending?.let { PendingLine(row, it, ctx) }
        }
    }
}

/** A message's text with mentions styled (§3.17) and http and https links that open in the browser. */
private fun messageText(text: String, row: ChatTimeline.Message, ctx: RowContext, c: nl.bvdm.rukoo.ui.theme.RukooColors): AnnotatedString = buildAnnotatedString {
    for (s in ChatText.segments(text, row.mentions, ctx.me, row.blocked)) {
        val part = text.substring(s.start, s.end)
        when (s.kind) {
            ChatText.Kind.TEXT -> append(part)
            ChatText.Kind.MENTION -> withStyle(SpanStyle(color = c.link, background = c.accentSoft, fontWeight = androidx.compose.ui.text.font.FontWeight(500))) { append(part) }
            ChatText.Kind.MENTION_ME -> withStyle(SpanStyle(color = c.text, background = c.accent.copy(alpha = 0.24f), fontWeight = androidx.compose.ui.text.font.FontWeight(500))) { append(part) }
            ChatText.Kind.LINK -> {
                val url = s.url ?: part
                withLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = c.link, textDecoration = TextDecoration.Underline))) { ctx.onOpenUrl(url) }) { append(part) }
            }
        }
    }
}

/** The tag after a name: Former member for someone who left, Guest for a guest; a deleted member's name is the tag. */
@Composable
private fun memberTag(member: Member?): String? = when {
    member == null || member.state == "deleted" -> null
    member.state != "active" -> stringResource(R.string.chat_log_former_member)
    member.role == "guest" -> stringResource(R.string.chat_roles_guest)
    else -> null
}

@Composable
private fun Tag(text: String) {
    val c = Rk.colors
    Text(
        text,
        style = Rk.type.text11.medium,
        color = c.text2,
        maxLines = 1,
        modifier = Modifier.background(c.chip, Rk.shapes.chip).padding(horizontal = 6.dp, vertical = 1.dp),
    )
}

/** A reply row's line about the message it answers; a tap opens the thread. */
@Composable
private fun ReplyContext(context: ChatTimeline.Context, ctx: RowContext) {
    val c = Rk.colors
    val text = when (context) {
        is ChatTimeline.Context.Quote -> stringResource(R.string.chat_log_reply_to, ctx.names.display(ctx.members[context.actor]), context.text)
        is ChatTimeline.Context.Missing -> stringResource(R.string.chat_log_reply_in_thread)
        is ChatTimeline.Context.Removed -> stringResource(R.string.chat_log_reply_to_removed)
    }
    val open = ctx.onOpenThread
    Row(
        Modifier
            .padding(bottom = 2.dp)
            .then(if (open != null) Modifier.rkClickable(Rk.shapes.chip, onClick = { open(context.root) }) else Modifier)
            .heightIn(min = 24.dp)
            .padding(end = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RkIcon(RukooIcons.Reply, null, size = 14.dp, tint = c.text3)
        Text(text, style = Rk.type.text12, color = c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** "3 replies · Last reply 10:42" with up to three repliers, and a dot while a reply is new; opens the thread. */
@Composable
private fun ReplySummaryRow(r: ChatTimeline.Replies, ctx: RowContext, onClick: () -> Unit) {
    val c = Rk.colors
    val label = if (r.hasNew) pluralStringResource(R.plurals.chat_log_replies_unread, r.count, r.count) else pluralStringResource(R.plurals.chat_log_replies, r.count, r.count)
    Row(
        Modifier
            .padding(top = 4.dp)
            .rkClickable(Rk.shapes.chip, onClickLabel = stringResource(R.string.chat_thread_label), onClick = onClick)
            .heightIn(min = 32.dp)
            .padding(end = 6.dp)
            .clearAndSetSemantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy((-4).dp)) {
            for (a in r.actors) {
                Box(Modifier.background(c.panel, CircleShape).padding(1.dp)) { Avatar(ctx.members[a]?.name, a, size = 16.dp) }
            }
        }
        if (r.hasNew) Box(Modifier.size(6.dp).background(c.accent, CircleShape))
        Text(pluralStringResource(R.plurals.chat_log_replies, r.count, r.count), style = Rk.type.text12_5.medium, color = c.link, maxLines = 1)
        r.lastAt?.let { at ->
            Text(stringResource(R.string.chat_log_last_reply, ctx.dates.listTime(at, ctx.now)), style = Rk.type.text12, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * How a send on its way is doing (contract §5.5): sending after a second, waiting for a connection (with the next try's
 * time), behind another, held or failed. A held or failed one has its actions under the line (§3.8 "Answers").
 */
@Composable
private fun PendingLine(row: ChatTimeline.Message, state: PendingState, ctx: RowContext) {
    val c = Rk.colors
    val reason = row.reason
    var slow by remember(state) { mutableStateOf(state != PendingState.SENDING) }
    if (state == PendingState.SENDING) {
        LaunchedEffect(Unit) {
            delay(SENDING_QUIET_MS)
            slow = true
        }
    }
    if (!slow) return
    val locale = LocalConfiguration.current.locales[0]
    val text = when (state) {
        PendingState.SENDING -> stringResource(R.string.chat_msg_sending)
        PendingState.QUEUED -> {
            val next = row.nextAt?.takeIf { it > ctx.now }
            val waiting = stringResource(R.string.chat_msg_waiting)
            if (next == null) {
                waiting
            } else {
                val time = remember(next, locale) { DateTimeFormatter.ofLocalizedTime(FormatStyle.MEDIUM).withLocale(locale).format(Instant.ofEpochMilli(next).atZone(ZoneId.systemDefault())) }
                "$waiting · ${stringResource(R.string.chat_msg_retry_at, time)}"
            }
        }
        PendingState.WAITING -> stringResource(R.string.chat_msg_waiting_turn)
        PendingState.HELD -> stringResource(if (reason == "stale_grant") R.string.chat_msg_stale_grant else R.string.chat_msg_unknown)
        PendingState.FAILED -> stringResource(R.string.chat_msg_failed, ctx.reasonText(reason))
    }
    val danger = state == PendingState.HELD || state == PendingState.FAILED
    Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.heightIn(min = 18.dp), contentAlignment = Alignment.Center) {
            when (state) {
                PendingState.SENDING -> Spinner(size = 12.dp)
                PendingState.QUEUED, PendingState.WAITING -> RkIcon(RukooIcons.Clock, null, size = 12.dp, tint = c.text3)
                else -> RkIcon(RukooIcons.Info, null, size = 12.dp, tint = c.danger)
            }
        }
        Text(text, style = Rk.type.text12.lineHeight(1.4f), color = if (danger) c.danger else c.text2)
    }
    val on = ctx.onPending ?: return
    val actions = MessageRules.pendingActions(state, reason, ctx.writable)
    if (actions.isEmpty()) return
    val busy = row.local?.let { ctx.isBusy("pending:$it") } == true
    Row(Modifier.padding(start = 12.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        for (action in actions) {
            val label = when (action) {
                PendingAction.SEND -> stringResource(R.string.chat_msg_send)
                PendingAction.SEND_AGAIN -> stringResource(R.string.chat_msg_send_again)
                PendingAction.RETRY -> stringResource(R.string.chat_msg_retry)
                PendingAction.SEND_WITHOUT_MENTIONS -> stringResource(R.string.chat_msg_send_without_mentions)
                PendingAction.COPY -> stringResource(R.string.chat_msg_copy)
                PendingAction.DISCARD -> stringResource(R.string.chat_msg_discard)
            }
            RkLinkButton(label, onClick = { on(row, action) }, style = Rk.type.text12_5.medium, enabled = !busy)
        }
    }
}

// How far from the bottom, in pixels, the timeline still counts as at the bottom.
private const val STICK_PX = 80

// Older messages load when the top comes this many rows close.
private const val OLDER_AHEAD = 10

// §3.19 READ_REPORT_DELAY.
private const val READ_REPORT_DELAY_MS = 1_000L

// A quick send shows nothing, so it doesn't flicker (desktop-ui 5.3).
private const val SENDING_QUIET_MS = 1_000L

// The server's default retention, while the workspace's own isn't known yet.
internal const val DEFAULT_RETENTION_DAYS = 90
