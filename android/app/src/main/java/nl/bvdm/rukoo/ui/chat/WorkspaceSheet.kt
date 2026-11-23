package nl.bvdm.rukoo.ui.chat

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.DotTone
import nl.bvdm.rukoo.ui.components.Hairline
import nl.bvdm.rukoo.ui.components.Monogram
import nl.bvdm.rukoo.ui.components.NewsDot
import nl.bvdm.rukoo.ui.components.NewsTone
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.StatusDot
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.ChatSheet
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.workspaces.WorkspaceStatus
import nl.bvdm.rukoo.workspaces.WorkspaceSummary
import nl.bvdm.rukoo.workspaces.WorkspaceView

/**
 * The workspace drawer, Chat's counterpart of the folder drawer (android.md "Workspace drawer and sheet"): the mode
 * switch, one row per workspace with its badge, and the status line with the server's host. Two panes show it as a
 * drawer, one pane as [WorkspaceSheet].
 */
@Composable
fun WorkspaceDrawerContent(app: AppViewModel, modifier: Modifier = Modifier) {
    Column(modifier.background(Rk.colors.bg).windowInsetsPadding(WindowInsets.systemBars)) {
        WorkspaceList(
            app,
            Modifier.weight(1f).verticalScroll(rememberScrollState()),
            pick = app::selectWorkspace,
            act = { then ->
                app.closeDrawer()
                then()
            },
        )
        Hairline()
        WorkspaceFooter(app)
    }
}

/**
 * The workspaces on one pane: a sheet from the bottom, where the thumb is, like the folder sheet. A pick slides it
 * away before the list changes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceSheet(app: AppViewModel, onDismiss: () -> Unit) {
    val c = Rk.colors
    val sheetState = rememberModalBottomSheetState()
    val scope = rememberCoroutineScope()
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        shape = Rk.shapes.sheet,
        containerColor = c.bg,
        contentColor = c.text,
        tonalElevation = 0.dp,
        scrimColor = c.scrim,
        dragHandle = {
            Box(Modifier.padding(top = 8.dp, bottom = 2.dp).size(36.dp, 4.dp).background(c.borderStrong, Rk.shapes.pill))
        },
    ) {
        // Back closes it from either height; the sheet's own back would first drop a dragged-up sheet to half.
        BackHandler { scope.launch { sheetState.hide() }.invokeOnCompletion { onDismiss() } }
        Column(Modifier.fillMaxWidth()) {
            WorkspaceList(
                app,
                Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                pick = { id -> scope.launch { sheetState.hide() }.invokeOnCompletion { app.selectWorkspace(id) } },
                act = { then ->
                    scope.launch { sheetState.hide() }.invokeOnCompletion {
                        app.closeDrawer()
                        then()
                    }
                },
            )
            Hairline()
            WorkspaceFooter(app)
        }
    }
}

/**
 * The mode switch and the workspaces; [pick] shows one. Under them, what can be done in the workspace on screen
 * (contract §5.10, §7.4): your name, Members, Invite people for owners and admins, Agents for full members while the
 * server has agents on, Blocked people, Leave workspace and,
 * for an owner, Delete workspace, which works only while they are its only member. Then Join and Make. [act] closes
 * the drawer or the sheet before the action runs.
 */
@Composable
private fun WorkspaceList(app: AppViewModel, modifier: Modifier, pick: (String) -> Unit, act: (() -> Unit) -> Unit) {
    val c = Rk.colors
    val nav by app.state.collectAsStateWithLifecycle()
    val chat by app.chatState.collectAsStateWithLifecycle()
    val viewNow by app.chatView.collectAsStateWithLifecycle()
    val view = viewNow?.takeIf { it.ws.id == nav.chat.workspaceId }
    Column(modifier.padding(horizontal = 10.dp, vertical = 10.dp)) {
        AppModeSwitch(app, Modifier.padding(bottom = 12.dp))
        if (chat.workspaces.isNotEmpty()) {
            Text(
                stringResource(R.string.chat_workspace_menu_heading),
                style = Rk.type.text11_5.semibold,
                color = c.text3,
                maxLines = 1,
                modifier = Modifier.padding(start = 10.dp, end = 10.dp, top = 4.dp, bottom = 4.dp),
            )
        }
        for (w in chat.workspaces) {
            WorkspaceRow(w, chat.host, selected = w.id == nav.chat.workspaceId, onClick = { pick(w.id) })
        }
        if (chat.signedIn && chat.available) WorkspaceActions(app, view, act)
    }
}

@Composable
private fun WorkspaceActions(app: AppViewModel, view: WorkspaceView?, act: (() -> Unit) -> Unit) {
    val ui = app.chatUi
    val chat by app.chatState.collectAsStateWithLifecycle()
    Column {
        if (view != null) {
            val ws = view.ws.id
            // While the server asks for an update (426) the workspace is read-only: only Members, whose sheet offers no
            // write then. The service refuses a write all the same.
            val writable = chat.workspaces.firstOrNull { it.id == ws }?.status != WorkspaceStatus.UPGRADE
            Hairline(Modifier.padding(vertical = 8.dp))
            for (action in SheetRules.workspaceActions(view, writable, agents = chat.agents)) {
                when (action) {
                    WorkspaceAction.RENAME_ME ->
                        DrawerAction(stringResource(R.string.chat_workspace_your_name), RukooIcons.Edit, hint = view.me.name) { act { ui.askRenameMe(ws, view.me.name) } }
                    WorkspaceAction.MEMBERS ->
                        DrawerAction(stringResource(R.string.chat_workspace_members), RukooIcons.People) { act { app.openChatSheet(ChatSheet.MEMBERS) } }
                    WorkspaceAction.INVITE ->
                        DrawerAction(stringResource(R.string.chat_workspace_invite), RukooIcons.Plus) { act { app.openChatSheet(ChatSheet.INVITE) } }
                    WorkspaceAction.AGENTS ->
                        DrawerAction(stringResource(R.string.chat_workspace_agents), RukooIcons.Sparkle) { act { app.openChatSheet(ChatSheet.AGENTS) } }
                    WorkspaceAction.BLOCKED ->
                        DrawerAction(stringResource(R.string.chat_block_list), RukooIcons.Ban) { act { app.openChatSheet(ChatSheet.BLOCKED) } }
                    // The only owner can't leave; the row stays, and opens the dialog that says how to. Alone in the
                    // workspace there is nobody to make owner, and Delete workspace below is the way out.
                    WorkspaceAction.LEAVE -> DrawerAction(
                        stringResource(R.string.chat_workspace_leave),
                        RukooIcons.Back,
                        danger = true,
                        hint = if (SheetRules.ownerFirstHint(view)) stringResource(R.string.chat_leave_only_owner_hint) else null,
                    ) {
                        act { ui.askLeaveWorkspace(ws, view) { app.openChatSheet(ChatSheet.MEMBERS) } }
                    }
                    WorkspaceAction.DELETE -> {
                        val canDelete = SheetRules.canDelete(view)
                        DrawerAction(
                            stringResource(R.string.chat_workspace_delete),
                            RukooIcons.Trash,
                            danger = true,
                            enabled = canDelete,
                            hint = if (canDelete) null else stringResource(R.string.chat_delete_only_you),
                        ) { act { ui.askDeleteWorkspace(ws) } }
                    }
                }
            }
        }
        Hairline(Modifier.padding(vertical = 8.dp))
        DrawerAction(stringResource(R.string.chat_workspace_join), RukooIcons.Link) { act { app.openChatSheet(ChatSheet.JOIN) } }
        DrawerAction(stringResource(R.string.chat_workspace_make), RukooIcons.Plus) { act { app.openChatSheet(ChatSheet.CREATE_WORKSPACE) } }
    }
}

/** A row of the drawer's actions: icon and label, a quiet [hint] under it, red when it removes something. */
@Composable
private fun DrawerAction(label: String, icon: ImageVector, danger: Boolean = false, enabled: Boolean = true, hint: String? = null, onClick: () -> Unit) {
    val c = Rk.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .alpha(if (enabled) 1f else 0.5f)
            .rkClickable(Rk.shapes.control, enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RkIcon(icon, null, size = 18.dp, tint = if (danger) c.danger else c.text2)
        Column(Modifier.weight(1f)) {
            Text(label, style = Rk.type.text13, color = if (danger) c.danger else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (hint != null) Text(hint, style = Rk.type.text11_5, color = c.text3, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A workspace: its monogram (with a warning dot while stopped), name, your role and the host, and its badge. */
@Composable
private fun WorkspaceRow(w: WorkspaceSummary, host: String, selected: Boolean, onClick: () -> Unit) {
    val c = Rk.colors
    val badge = ChatBadge.of(w.attention, w.unread)
    val role = roleName(w.role)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .background(if (selected) c.active else Color.Transparent, Rk.shapes.control)
            .rkClickable(Rk.shapes.control, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            Monogram(w.name, size = 30.dp, hueKey = w.id)
            if (w.status == WorkspaceStatus.QUARANTINED) {
                Box(Modifier.align(Alignment.TopEnd).offset(x = 2.dp, y = (-2).dp).background(c.bg, Rk.shapes.pill).padding(2.dp)) {
                    StatusDot(DotTone.WARN, size = 7.dp)
                }
            }
        }
        Column(Modifier.weight(1f)) {
            Text(w.name, style = if (selected) Rk.type.text13.semibold else Rk.type.text13, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                stringResource(R.string.chat_workspace_sub, role, host),
                style = Rk.type.text11_5,
                color = c.text3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        when {
            badge == null -> Unit
            badge.dot -> NewsDot(NewsTone.UNREAD, ring = if (selected) c.active else c.bg)
            else -> ChatCountPill(badge.text)
        }
    }
}

/** A workspace role's name: Owner, Admin, Member or Guest. */
@Composable
internal fun roleName(role: String): String = stringResource(
    when (role) {
        "owner" -> R.string.chat_roles_owner
        "admin" -> R.string.chat_roles_admin
        "guest" -> R.string.chat_roles_guest
        else -> R.string.chat_roles_member
    },
)

/** The status line (desktop's foot status): the connection and the host, Sync and Settings, like the mail drawer's. */
@Composable
private fun WorkspaceFooter(app: AppViewModel) {
    val c = Rk.colors
    val nav by app.state.collectAsStateWithLifecycle()
    val chat by app.chatState.collectAsStateWithLifecycle()
    val ws = chat.workspaces.firstOrNull { it.id == nav.chat.workspaceId }
    val status = ChatListModel.status(chat, ws)
    val text = when (status) {
        ChatStatus.SIGNED_OUT -> stringResource(R.string.chat_status_signed_out)
        ChatStatus.CATCHING_UP -> stringResource(R.string.chat_status_catching_up)
        ChatStatus.CONNECTED -> stringResource(R.string.chat_status_connected)
        ChatStatus.CONNECTING -> stringResource(R.string.chat_status_connecting)
        ChatStatus.OFFLINE -> stringResource(R.string.chat_status_offline)
        ChatStatus.IDLE -> chat.host
    }
    val tone = when (status) {
        ChatStatus.CONNECTED -> DotTone.OK
        ChatStatus.CATCHING_UP, ChatStatus.CONNECTING -> DotTone.WARN
        ChatStatus.OFFLINE -> DotTone.DANGER
        ChatStatus.SIGNED_OUT, ChatStatus.IDLE -> DotTone.MUTED
    }
    val connectedTo = stringResource(R.string.chat_status_connected_title, chat.host)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(start = 20.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        StatusDot(tone, pulsing = status == ChatStatus.CATCHING_UP || status == ChatStatus.CONNECTING)
        Column(
            Modifier.weight(1f).then(if (status == ChatStatus.CONNECTED) Modifier.semantics { contentDescription = connectedTo } else Modifier),
        ) {
            Text(text, style = Rk.type.text12, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (status != ChatStatus.IDLE && chat.host.isNotEmpty()) {
                Text(chat.host, style = Rk.type.text11, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (chat.signedIn) RkIconButton(RukooIcons.Sync, stringResource(R.string.mailbox_actions_sync), onClick = { app.chatUi.refresh() })
        RkIconButton(RukooIcons.Settings, stringResource(R.string.mail_drawer_settings), onClick = {
            app.closeDrawer()
            app.openSettings()
        })
    }
}
