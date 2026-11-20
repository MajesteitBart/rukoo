package nl.bvdm.rukoo.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkLinkButton
import nl.bvdm.rukoo.ui.components.RkTopBar
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.mail.rememberMailDates
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.ChatPane
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.lineHeight
import nl.bvdm.rukoo.workspaces.Connection
import nl.bvdm.rukoo.workspaces.RoomKind
import nl.bvdm.rukoo.workspaces.WorkspaceStatus

/**
 * One thread (android.md "Thread", contract §3.13): its first message, a divider with the reply count, the replies and
 * the replies on their way, then a composer that answers in the thread. It fills the screen on one pane and sits at
 * the chat column's width beside the room on two. A thread partly on the phone says so with Load earlier, one whose
 * first message aged out says that, and a removed first message takes the composer's place with a note. A long press
 * on a message opens its menu. Threads never report reads (§3.9), and opening one leaves the room's timeline as it is.
 */
@Composable
fun ThreadPane(app: AppViewModel, ws: String, room: String, root: String, modifier: Modifier = Modifier, twoPane: Boolean = app.twoPane) {
    val c = Rk.colors
    val workspaces = app.services.workspaces ?: return
    val viewNow by app.chatView.collectAsStateWithLifecycle()
    val chat by app.chatState.collectAsStateWithLifecycle()
    val view = viewNow?.takeIf { it.ws.id == ws }
    val flow = remember(ws, room, root) { workspaces.thread(ws, room, root).catch { } }
    val thread by flow.collectAsStateWithLifecycle(initialValue = null)
    val scope = rememberCoroutineScope()
    var loadingEarlier by remember(ws, room, root) { mutableStateOf(false) }
    // The first message may be older than the cache: page back towards it, at most 10 pages (§3.7 "Threads").
    LaunchedEffect(ws, room, root) { runCatching { workspaces.loadThread(ws, room, root) } }
    val names = rememberChatNames()
    val members = remember(view) { view?.members.orEmpty().associateBy { it.id } }
    val me = view?.me?.id
    val roomModel = view?.rooms?.firstOrNull { it.id == room }
    val summary = chat.workspaces.firstOrNull { it.id == ws }
    val paused = summary?.status == WorkspaceStatus.QUARANTINED
    val roomTitle = roomModel?.let { if (it.kind == RoomKind.DM) names.title(it, members, me) else "#${it.name.orEmpty()}" }.orEmpty()
    val where = when {
        roomModel == null -> null
        roomModel.kind == RoomKind.DM -> stringResource(R.string.chat_thread_in_direct, names.title(roomModel, members, me))
        else -> stringResource(R.string.chat_thread_in_channel, roomModel.name.orEmpty())
    }
    var actionsFor by remember(ws, room, root) { mutableStateOf<ChatTimeline.Message?>(null) }
    val context = LocalContext.current

    Column(modifier.background(c.panel)) {
        RkTopBar(
            title = stringResource(R.string.chat_thread_label),
            subtitle = where,
            navigation = if (twoPane) null else {
                { RkIconButton(RukooIcons.Back, stringResource(R.string.chat_thread_back, roomTitle), onClick = { app.back() }) }
            },
            actions = {
                if (twoPane) RkIconButton(RukooIcons.Close, stringResource(R.string.chat_thread_close), onClick = app::closeThread)
            },
        )
        if (!paused && chat.connection == Connection.OFFLINE) OfflineBanner(chat.host, busy = app.chatUi.isBusy("refresh:$ws")) { app.chatUi.refresh(ws) }
        val t = thread
        if (t == null || roomModel == null || (t.loading && t.root == null && t.replies.isEmpty())) {
            ChatLoading(stringResource(R.string.chat_thread_loading), Modifier.weight(1f).fillMaxWidth())
            return@Column
        }
        val blocked = remember(view) { view?.blocks.orEmpty().mapTo(HashSet()) { it.member } }
        val rows = remember(t, me, blocked) { ChatTimeline.rows(listOfNotNull(t.root) + t.replies, t.pending, me, root = root, blocked = blocked) }
        // Bottom up, like the room: the newest reply is item 0, so the thread opens at its latest replies.
        val items = remember(rows) { rows.asReversed() }
        val locale = LocalConfiguration.current.locales[0]
        val today = stringResource(R.string.common_dates_today)
        val yesterday = stringResource(R.string.common_dates_yesterday)
        val days = remember(locale, today, yesterday) { ChatDays(locale, today, yesterday) }
        val ctx = RowContext(
            members = members,
            me = me,
            names = names,
            dates = rememberMailDates(),
            days = days,
            now = remember(rows) { System.currentTimeMillis() },
            room = roomModel,
            workspace = summary?.name.orEmpty(),
            host = chat.host,
            retentionDays = chat.retention?.contentDays ?: DEFAULT_RETENTION_DAYS,
            events = emptyList(),
            onOpenThread = null,
            onOpenUrl = app::openUrl,
            reasonText = { app.chatUi.reasonText(it, app.chatUi.context(ws)) },
            onLongPress = { row -> if (MessageRules.hasActions(row, me, roomModel, inThread = true, view?.me?.role, members[row.actor], blocked)) actionsFor = row },
            onPending = { row, action ->
                row.local?.let { local ->
                    app.chatUi.pendingAction(ws, room, PendingRow(local, row.root, row.text.orEmpty(), row.mentions), action) { copyText(context, app, it) }
                }
            },
            isBusy = app.chatUi::isBusy,
        )
        val listState = rememberLazyListState()
        LazyColumn(
            state = listState,
            reverseLayout = true,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(top = 8.dp, bottom = 12.dp),
        ) {
            items(items, key = { it.key }, contentType = { it::class }) { row -> TimelineRowView(row, ctx) }
            if (t.expired) {
                item(key = "expired") {
                    val d = ctx.retentionDays
                    Text(
                        pluralStringResource(R.plurals.chat_thread_root_expired, d, d),
                        style = Rk.type.text12_5.lineHeight(1.4f),
                        color = c.text3,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 6.dp),
                    )
                }
            } else if (!t.complete) {
                item(key = "partial") {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(stringResource(R.string.chat_thread_partial), style = Rk.type.text12_5, color = c.text3, modifier = Modifier.weight(1f))
                        RkLinkButton(stringResource(R.string.chat_thread_load_earlier), enabled = !loadingEarlier && !t.loading, onClick = {
                            loadingEarlier = true
                            scope.launch {
                                try {
                                    workspaces.loadThread(ws, room, root)
                                } catch (e: kotlin.coroutines.cancellation.CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    app.chatUi.showError(e, app.chatUi.context(ws))
                                } finally {
                                    loadingEarlier = false
                                }
                            }
                        })
                    }
                }
            }
        }
        // Your own reply goes to the bottom, as in the room.
        val bottom = items.firstOrNull()
        var lastBottom by remember(ws, room, root) { mutableStateOf(bottom?.key) }
        LaunchedEffect(bottom?.key) {
            if (bottom?.key == lastBottom) return@LaunchedEffect
            lastBottom = bottom?.key
            val own = bottom is ChatTimeline.Message && bottom.pending != null
            if (own || listState.firstVisibleItemIndex <= 1) listState.scrollToItem(0)
        }
        val rootRemoved = t.root != null && (t.root.redacted || t.root.text == null)
        val slot = ComposerSlots.of(roomModel, paused = paused, rootRemoved = rootRemoved)
        if (slot == ComposerSlot.Composer) {
            ChatComposer(
                app = app,
                ws = ws,
                room = roomModel,
                root = root,
                draft = t.draft,
                members = members,
                me = me,
                recent = remember(rows, me) { rows.filterIsInstance<ChatTimeline.Message>().filter { it.pending == null }.asReversed().map { it.actor }.filter { it != me }.distinct() },
                placeholder = stringResource(R.string.chat_input_placeholder_thread),
                pane = ChatPane.THREAD,
            )
        } else {
            ComposerBar(app, ws, slot, roomModel, me, summary?.name.orEmpty(), inThread = true)
        }
        actionsFor?.let { row ->
            MessageActionsSheet(
                app = app,
                ws = ws,
                room = roomModel,
                message = row,
                me = me,
                myRole = view?.me?.role,
                blocked = blocked,
                inThread = true,
                where = roomTitle,
                author = members[row.actor],
                names = names,
                onDismiss = { actionsFor = null },
            )
        }
    }
}
