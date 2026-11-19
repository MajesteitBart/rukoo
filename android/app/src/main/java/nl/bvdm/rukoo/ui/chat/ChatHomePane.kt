package nl.bvdm.rukoo.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.text.Collator
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.Avatar
import nl.bvdm.rukoo.ui.components.EmptyState
import nl.bvdm.rukoo.ui.components.ExpandChevron
import nl.bvdm.rukoo.ui.components.Monogram
import nl.bvdm.rukoo.ui.components.NewsDot
import nl.bvdm.rukoo.ui.components.NewsTone
import nl.bvdm.rukoo.ui.components.PixelLoader
import nl.bvdm.rukoo.ui.components.QuickFilter
import nl.bvdm.rukoo.ui.components.QuickFilterRow
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkButtonSize
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkIconButtonSize
import nl.bvdm.rukoo.ui.components.ShimmerText
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.mail.CornerButton
import nl.bvdm.rukoo.ui.mail.MailDates
import nl.bvdm.rukoo.ui.mail.NewMessageButton
import nl.bvdm.rukoo.ui.mail.rememberMailDates
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.ChatPane
import nl.bvdm.rukoo.ui.root.ChatSheet
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular
import nl.bvdm.rukoo.workspaces.Connection
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.RoomKind
import nl.bvdm.rukoo.workspaces.WorkspaceStatus

/**
 * The conversation list (android.md "Conversation list", contract §7.4): the workspace's name over the host, the All
 * and Unread filters, Channels and Direct messages with their badges, Browse channels, the archived channels folded
 * away, pull to refresh, the workspace button in the bottom left and New message in the bottom right. A stopped
 * workspace says so above the list with Start over; one that needs a newer Rukoo says that.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatHomePane(app: AppViewModel, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val nav by app.state.collectAsStateWithLifecycle()
    val chat by app.chatState.collectAsStateWithLifecycle()
    val viewNow by app.chatView.collectAsStateWithLifecycle()
    val names = rememberChatNames()
    val dates = rememberMailDates()
    val wsId = nav.chat.workspaceId
    val summary = chat.workspaces.firstOrNull { it.id == wsId }
    val view = viewNow?.takeIf { it.ws.id == wsId }
    val locale = LocalConfiguration.current.locales[0]
    val compare = remember(locale) {
        val collator = Collator.getInstance(locale).apply { strength = Collator.PRIMARY }
        Comparator<String> { a, b -> collator.compare(a, b) }
    }
    val members = remember(view) { view?.members.orEmpty().associateBy { it.id } }
    // Only two panes show a room beside the list; on one pane the room read last mustn't stay under Unread.
    val beside = nav.chatRoomBesideList(app.twoPane)
    val sections = remember(view, nav.chat.filter, beside, names, compare) {
        view?.let { ChatListModel.sections(it.rooms, nav.chat.filter, it.me, members, names, open = beside, compare = compare) }
    }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    Box(modifier.background(c.panel)) {
        Column(Modifier.fillMaxSize()) {
            HomeHeader(
                title = summary?.name ?: stringResource(R.string.chat_view_label),
                subtitle = if (chat.connection == Connection.OFFLINE) stringResource(R.string.chat_status_offline) else chat.host,
                onOpenWorkspaces = app::openDrawer,
            )
            when (summary?.status) {
                WorkspaceStatus.QUARANTINED -> PausedBanner(summary.name, busy = app.chatUi.isBusy("reload:${summary.id}")) { app.chatUi.reload(summary.id) }
                WorkspaceStatus.UPGRADE -> UpgradeBanner(chat.host)
                else -> Unit
            }
            QuickFilterRow(
                filters = listOf(
                    QuickFilter(ChatFilter.ALL.name, stringResource(R.string.chat_filter_all)),
                    QuickFilter(ChatFilter.UNREAD.name, stringResource(R.string.chat_filter_unread), sections?.unreadCount ?: 0),
                ),
                selectedKey = nav.chat.filter.name,
                onSelect = { app.setChatFilter(ChatFilter.valueOf(it)) },
            )
            var pulled by remember { mutableStateOf(false) }
            val pullState = rememberPullToRefreshState()
            PullToRefreshBox(
                isRefreshing = pulled,
                onRefresh = {
                    pulled = true
                    scope.launch {
                        app.chatUi.refresh(wsId)?.join()
                        pulled = false
                    }
                },
                state = pullState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                indicator = {
                    PullToRefreshDefaults.Indicator(
                        state = pullState,
                        isRefreshing = pulled,
                        modifier = Modifier.align(Alignment.TopCenter),
                        containerColor = c.raised,
                        color = c.text2,
                    )
                },
            ) {
                when {
                    view == null || sections == null || (summary?.status == WorkspaceStatus.LOADING && view.rooms.isEmpty()) ->
                        ChatLoading(stringResource(R.string.chat_empty_loading), Modifier.fillMaxSize())
                    else -> RoomList(
                        app = app,
                        sections = sections,
                        filter = nav.chat.filter,
                        selected = beside,
                        members = members,
                        me = view.me,
                        dates = dates,
                        state = listState,
                    )
                }
            }
        }
        // The workspaces, where the thumb is, mirroring mail's folders button; it opens the drawer or the sheet.
        val switchLabel = stringResource(R.string.chat_workspace_switch)
        CornerButton(onClick = app::openDrawer, modifier = Modifier.align(Alignment.BottomStart).padding(16.dp)) {
            Monogram(summary?.name ?: "?", Modifier.clearAndSetSemantics { contentDescription = switchLabel }, size = 28.dp, hueKey = summary?.id)
        }
        if (sections?.canCreate == true) {
            NewMessageButton(
                expanded = !listState.lastScrolledForward || !listState.canScrollBackward,
                onClick = { app.openChatSheet(ChatSheet.NEW) },
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
                label = stringResource(R.string.chat_sidebar_new_message),
            )
        }
    }
}

/** The workspace's name with a chevron that opens the workspace list, over the host or "Offline". */
@Composable
private fun HomeHeader(title: String, subtitle: String, onOpenWorkspaces: () -> Unit) {
    val c = Rk.colors
    val label = stringResource(R.string.chat_workspace_switch)
    Column(Modifier.fillMaxWidth().background(c.panel).windowInsetsPadding(WindowInsets.statusBars)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(start = 8.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(
                Modifier
                    .rkClickable(Rk.shapes.control, onClickLabel = label, onClick = onOpenWorkspaces)
                    .padding(horizontal = 10.dp, vertical = 4.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        title,
                        style = Rk.type.pageTitle,
                        color = c.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false).semantics { heading() },
                    )
                    RkIcon(RukooIcons.ChevronDown, null, size = 16.dp, tint = c.text3)
                }
                Text(subtitle, style = Rk.type.text12, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** A stopped workspace (§3.6 quarantine): what happened and Start over, which loads it again from the server. */
@Composable
internal fun PausedBanner(workspace: String, busy: Boolean, onStartOver: () -> Unit) {
    val c = Rk.colors
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).background(c.orangeTint, Rk.shapes.card).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(stringResource(R.string.chat_banner_paused, workspace), style = Rk.type.text12_5, color = c.text)
        RkButton(
            stringResource(R.string.chat_banner_start_over),
            onStartOver,
            kind = RkButtonKind.SECONDARY,
            size = RkButtonSize.SMALL,
            enabled = !busy,
        )
    }
}

/** The server speaks a newer version of team chat than this Rukoo: the list stays readable. */
@Composable
private fun UpgradeBanner(host: String) {
    val c = Rk.colors
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).background(c.field, Rk.shapes.card).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(stringResource(R.string.chat_empty_upgrade_title), style = Rk.type.text13.semibold, color = c.text)
        Text(stringResource(R.string.chat_empty_upgrade_body, host), style = Rk.type.text12_5, color = c.text2)
    }
}

/** The pixel loader with a shimmering label, centered: a list or room that has nothing cached yet. */
@Composable
internal fun ChatLoading(label: String, modifier: Modifier = Modifier) {
    Box(modifier, contentAlignment = Alignment.Center) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            PixelLoader()
            ShimmerText(label, style = Rk.type.text13.medium)
        }
    }
}

@Composable
private fun RoomList(
    app: AppViewModel,
    sections: ChatSections,
    filter: ChatFilter,
    selected: String?,
    members: Map<String, Member>,
    me: Member,
    dates: MailDates,
    state: LazyListState,
) {
    val all = filter == ChatFilter.ALL
    var archivedOpen by rememberSaveable { mutableStateOf(false) }
    val now = remember(sections) { System.currentTimeMillis() }
    if (!all && sections.isEmpty) {
        EmptyState(
            stringResource(R.string.chat_filter_none),
            icon = ChatIcons.Bubble,
            actionLabel = stringResource(R.string.mailbox_empty_show_all),
            onAction = { app.setChatFilter(ChatFilter.ALL) },
        )
        return
    }
    val open: (String) -> Unit = { id ->
        app.chatInteracted(ChatPane.HOME)
        app.openRoom(id)
    }
    LazyColumn(state = state, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 2.dp, bottom = 88.dp)) {
        item(key = "head:channels") {
            SectionHead(
                stringResource(R.string.chat_sidebar_channels),
                addLabel = stringResource(R.string.chat_sidebar_add_channel).takeIf { sections.canCreate },
                onAdd = { app.openChatSheet(ChatSheet.NEW_CHANNEL) },
            )
        }
        items(sections.channels, key = { "c:${it.key}" }) { row -> ChannelRow(row, selected = row.room.id == selected, onClick = { open(row.room.id) }) }
        if (all && sections.channels.isEmpty()) item(key = "none:channels") { EmptyLine(stringResource(R.string.chat_sidebar_no_channels)) }
        if (all && sections.canCreate) {
            item(key = "browse") {
                PlainRow(stringResource(R.string.chat_sidebar_browse), icon = RukooIcons.Search, onClick = { app.openChatSheet(ChatSheet.BROWSE) })
            }
        }
        if (sections.showDms) {
            item(key = "head:dms") {
                SectionHead(
                    stringResource(R.string.chat_sidebar_direct),
                    addLabel = stringResource(R.string.chat_sidebar_new_message).takeIf { sections.canCreate },
                    onAdd = { app.openChatSheet(ChatSheet.NEW_DM) },
                )
            }
            items(sections.dms, key = { "d:${it.key}" }) { row ->
                DmRow(row, members, me.id, dates, now, selected = row.room.id == selected, onClick = { open(row.room.id) })
            }
            if (all && sections.dms.isEmpty()) item(key = "none:dms") { EmptyLine(stringResource(R.string.chat_sidebar_no_direct)) }
        }
        if (sections.archived.isNotEmpty()) {
            item(key = "head:archived") {
                ArchivedHead(sections.archived.size, archivedOpen) { archivedOpen = !archivedOpen }
            }
            if (archivedOpen) {
                items(sections.archived, key = { "a:${it.key}" }) { row -> ChannelRow(row, selected = row.room.id == selected, onClick = { open(row.room.id) }) }
            }
        }
    }
}

/** A section's heading (Channels, Direct messages) with its + for full members; touch shows the + always. */
@Composable
private fun SectionHead(text: String, addLabel: String?, onAdd: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 14.dp, bottom = 2.dp).heightIn(min = 32.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text,
            style = Rk.type.text11_5.semibold,
            color = Rk.colors.text3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        if (addLabel != null) RkIconButton(RukooIcons.Plus, addLabel, onClick = onAdd, size = RkIconButtonSize.SMALL)
    }
}

@Composable
private fun EmptyLine(text: String) {
    Text(text, style = Rk.type.text12_5, color = Rk.colors.text3, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
}

/** A row of the list's own: Browse channels. */
@Composable
private fun PlainRow(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    val c = Rk.colors
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .heightIn(min = 44.dp)
            .rkClickable(Rk.shapes.control, onClick = onClick)
            .padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RkIcon(icon, null, size = 16.dp, tint = c.text3)
        Text(label, style = Rk.type.text13, color = c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** "Archived (n)", folding the archived channels away. */
@Composable
private fun ArchivedHead(count: Int, open: Boolean, onToggle: () -> Unit) {
    val c = Rk.colors
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .padding(top = 10.dp)
            .heightIn(min = 40.dp)
            .rkClickable(Rk.shapes.control, onClick = onToggle)
            .padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            pluralStringResource(R.plurals.chat_channel_archived_section, count, count),
            style = Rk.type.text11_5.semibold,
            color = c.text3,
            modifier = Modifier.weight(1f),
        )
        ExpandChevron(open, tint = c.text3)
    }
}

/** What a row reads as to a screen reader: its name with its mentions, unread messages, muted or closed state. */
@Composable
private fun rowDescription(row: RoomRow, title: String): String = when {
    row.room.muted -> stringResource(R.string.chat_sidebar_row_muted, title)
    row.closed -> stringResource(R.string.chat_sidebar_row_closed, title)
    row.room.kind == RoomKind.CHANNEL && row.room.mentions > 0 ->
        pluralStringResource(R.plurals.chat_sidebar_row_mentions, row.room.mentions, title, row.room.mentions)
    row.room.unread > 0 -> pluralStringResource(R.plurals.chat_sidebar_row_unread, row.room.unread, title, row.room.unread)
    else -> title
}

/** A row's frame: the open room is filled on two panes; muted and closed rows are dimmed (§3.10). */
@Composable
private fun RowFrame(row: RoomRow, selected: Boolean, description: String, onClick: () -> Unit, minHeight: androidx.compose.ui.unit.Dp, content: @Composable () -> Unit) {
    val c = Rk.colors
    Box(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .heightIn(min = minHeight)
            .background(if (selected) c.active else Color.Transparent, Rk.shapes.control)
            .rkClickable(Rk.shapes.control, onClick = onClick)
            .clearAndSetSemantics { contentDescription = description }
            .padding(horizontal = 12.dp, vertical = 6.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(Modifier.alpha(if (row.badge.dim) 0.62f else 1f)) { content() }
    }
}

/** A channel: # or a lock, the name, bold while unread, and its pill or dot. */
@Composable
private fun ChannelRow(row: RoomRow, selected: Boolean, onClick: () -> Unit) {
    val c = Rk.colors
    val strong = row.badge.bold && !row.badge.dim
    RowFrame(row, selected, rowDescription(row, "#${row.title}"), onClick, 44.dp) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            RkIcon(if (row.private) ChatIcons.Lock else ChatIcons.Hash, null, size = 16.dp, tint = c.text3)
            Text(
                row.title,
                style = if (strong) Rk.type.text13.semibold else Rk.type.text13,
                color = when {
                    row.badge.dim -> c.text3
                    strong -> c.text
                    else -> c.text2
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (row.room.muted) RkIcon(RukooIcons.BellOff, null, size = 14.dp, tint = c.text3)
            RowBadgeView(row.badge, ring = if (selected) c.active else c.panel)
        }
    }
}

/** A DM: the people's avatars, their names and the time, the newest message under them, and the unread pill. */
@Composable
private fun DmRow(row: RoomRow, members: Map<String, Member>, me: String, dates: MailDates, now: Long, selected: Boolean, onClick: () -> Unit) {
    val c = Rk.colors
    val strong = row.badge.bold && !row.badge.dim
    val others = row.room.participants.orEmpty().distinct().filter { it != me }.ifEmpty { listOf(me) }
    RowFrame(row, selected, rowDescription(row, row.title), onClick, 56.dp) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            DmAvatars(others, members)
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        row.title,
                        style = if (strong) Rk.type.text13.semibold else Rk.type.text13.medium,
                        color = if (row.badge.dim) c.text3 else c.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    row.room.lastAt?.let { at ->
                        Spacer(Modifier.width(8.dp))
                        Text(dates.listTime(at, now), style = Rk.type.text11_5.tabular, color = c.text3, maxLines = 1)
                    }
                }
                val preview = row.preview
                if (preview != null) {
                    val text = when {
                        preview.removed -> stringResource(R.string.chat_log_removed)
                        preview.author != null -> stringResource(R.string.chat_notify_body, preview.author, preview.text.orEmpty())
                        else -> preview.text.orEmpty()
                    }
                    Text(text, style = Rk.type.text12_5, color = if (strong) c.text2 else c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (row.room.muted) RkIcon(RukooIcons.BellOff, null, size = 14.dp, tint = c.text3)
            RowBadgeView(row.badge, ring = if (selected) c.active else c.panel)
        }
    }
}

/** One avatar for a one-to-one DM, two overlapping ones for a group. */
@Composable
private fun DmAvatars(others: List<String>, members: Map<String, Member>) {
    if (others.size <= 1) {
        val id = others.firstOrNull().orEmpty()
        Avatar(members[id]?.name, id, size = 32.dp)
        return
    }
    val ring = Rk.colors.panel
    Box(Modifier.size(32.dp)) {
        Avatar(members[others[0]]?.name, others[0], size = 22.dp)
        Box(Modifier.align(Alignment.BottomEnd).offset(x = 1.dp, y = 1.dp).background(ring, CircleShape).padding(1.5.dp)) {
            Avatar(members[others[1]]?.name, others[1], size = 21.dp)
        }
    }
}

@Composable
private fun RowBadgeView(badge: RowBadge, ring: Color) {
    when {
        badge.pill != null -> ChatCountPill(if (badge.pill > 99) "99+" else badge.pill.toString())
        badge.dot -> NewsDot(NewsTone.UNREAD, ring = ring)
    }
}
