package nl.bvdm.rukoo.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.EmptyState
import nl.bvdm.rukoo.ui.components.Hairline
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.mail.CornerButton
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.ChatPane
import nl.bvdm.rukoo.ui.root.ChatSheet
import nl.bvdm.rukoo.ui.root.NavState
import nl.bvdm.rukoo.ui.root.PaneDivider
import nl.bvdm.rukoo.ui.root.PaneWidths
import nl.bvdm.rukoo.ui.root.layoutPrefs
import nl.bvdm.rukoo.ui.settings.SettingsRoutes
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.workspaces.ChatState

/**
 * One pane of Chat on the cover screen (android.md "Where Chat lives"): [pane] fills the window, and RukooRoot slides
 * between them as it does the mail panes. A state of all of Chat (signed out, no workspace) takes the whole window.
 */
@Composable
fun ChatCompactLayout(app: AppViewModel, nav: NavState, pane: ChatPane, modifier: Modifier = Modifier) {
    val chat by app.chatState.collectAsStateWithLifecycle()
    ChatOverlays(app)
    val gate = ChatListModel.gate(chat)
    if (gate != null) return ChatGateView(app, gate, chat, modifier)
    ChatPaneContent(app, nav, pane, modifier, twoPane = false)
}

/**
 * Chat on the inner screen: the conversation list at its own width beside the room, or the room beside its thread at
 * the chat column's fixed width (android.md "Two panes", contract §7.3). The list's divider drags, and its width is
 * kept apart from mail's. [backProgress] lets a closing thread follow the back gesture.
 */
@Composable
fun ChatTwoPaneLayout(app: AppViewModel, nav: NavState, holder: SaveableStateHolder, backProgress: Float) {
    val chat by app.chatState.collectAsStateWithLifecycle()
    ChatOverlays(app)
    val gate = ChatListModel.gate(chat)
    if (gate != null) return ChatGateView(app, gate, chat, Modifier.fillMaxSize())
    val context = LocalContext.current
    val prefs = remember { context.layoutPrefs() }
    var listWidth by remember { mutableFloatStateOf(prefs.getFloat(CHAT_LIST_WIDTH, PaneWidths.List.value)) }
    val layout = nav.chatTwoPanes()
    BoxWithConstraints(Modifier.fillMaxSize().background(Rk.colors.panel)) {
        val window = maxWidth
        val density = LocalDensity.current
        if (layout.right == ChatPane.THREAD) {
            // A draggable thread divider with its own width waits (§1.4); the room takes what the thread leaves.
            val thread = PaneWidths.clamp(PaneWidths.Chat.value, PaneWidths.ChatMin, PaneWidths.ChatMax, window).dp
            Row(Modifier.fillMaxSize()) {
                holder.SaveableStateProvider(paneKey(layout.left)) { ChatPaneContent(app, nav, layout.left, Modifier.weight(1f).fillMaxHeight(), twoPane = true) }
                Hairline(Modifier.fillMaxHeight(), vertical = true)
                holder.SaveableStateProvider(paneKey(layout.right)) {
                    ChatPaneContent(
                        app, nav, layout.right,
                        Modifier.width(thread).fillMaxHeight().graphicsLayer {
                            // Predictive back closes the thread: let it follow the gesture.
                            translationX = backProgress * 48.dp.toPx()
                            alpha = 1f - backProgress * 0.5f
                        },
                        twoPane = true,
                    )
                }
            }
        } else {
            val list = PaneWidths.clamp(listWidth, PaneWidths.ListMin, PaneWidths.ListMax, window).dp
            Row(Modifier.fillMaxSize()) {
                holder.SaveableStateProvider(paneKey(layout.left)) { ChatPaneContent(app, nav, layout.left, Modifier.width(list).fillMaxHeight(), twoPane = true) }
                Hairline(Modifier.fillMaxHeight(), vertical = true)
                holder.SaveableStateProvider(paneKey(layout.right)) { ChatPaneContent(app, nav, layout.right, Modifier.weight(1f).fillMaxHeight(), twoPane = true) }
            }
            PaneDivider(
                x = list,
                onDrag = { dx -> listWidth = PaneWidths.clamp(listWidth + with(density) { dx.toDp().value }, PaneWidths.ListMin, PaneWidths.ListMax, window) },
                onDone = { prefs.edit().putFloat(CHAT_LIST_WIDTH, listWidth).apply() },
            )
        }
    }
}

/** The key each Chat pane keeps its saved state under, the same in both layouts, so it survives folding. */
fun paneKey(pane: ChatPane): String = "chat:${pane.name}"

// Chat's own list width (android.md "Two panes"), apart from the mail list's.
private const val CHAT_LIST_WIDTH = "chat_list_width"

/**
 * A Chat pane, tracked like the mail panes: a tap or focus anywhere in it makes it the one that stays when the phone
 * folds. The room and thread show "Pick a conversation" while nothing is open.
 */
@Composable
private fun ChatPaneContent(app: AppViewModel, nav: NavState, pane: ChatPane, modifier: Modifier, twoPane: Boolean) {
    val tracked = modifier
        .pointerInput(pane) {
            awaitEachGesture {
                awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                app.chatInteracted(pane)
            }
        }
        .onFocusChanged { if (it.hasFocus) app.chatInteracted(pane) }
    val ws = nav.chat.workspaceId
    val room = nav.chat.roomId
    val root = nav.chat.threadRoot
    when {
        pane == ChatPane.HOME -> ChatHomePane(app, tracked)
        ws == null || room == null -> RoomPick(tracked)
        pane == ChatPane.ROOM -> RoomPane(app, ws, room, tracked, twoPane = twoPane)
        root == null -> RoomPick(tracked)
        else -> ThreadPane(app, ws, room, root, tracked, twoPane = twoPane)
    }
}

/** The room's place on two panes while no conversation is open. */
@Composable
private fun RoomPick(modifier: Modifier) {
    Box(modifier.background(Rk.colors.panel), contentAlignment = Alignment.Center) {
        EmptyState(stringResource(R.string.chat_room_pick), icon = ChatIcons.Bubble)
    }
}

/**
 * All of Chat while it can't show a workspace (android.md "States"): the cache couldn't open, signed out (Create an
 * account and Sign in open Settings > Rukoo account, with the invitation hint where the server takes one), the first
 * listing on its way, or no workspace yet (Join and Make). The workspace button in the corner opens the drawer with the
 * mode switch.
 */
@Composable
private fun ChatGateView(app: AppViewModel, gate: ChatGate, chat: ChatState, modifier: Modifier) {
    Box(modifier.background(Rk.colors.panel)) {
        if (gate == ChatGate.LOADING) {
            ChatLoading(stringResource(R.string.chat_empty_loading), Modifier.fillMaxSize())
        } else {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 80.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                when (gate) {
                    ChatGate.STORAGE -> EmptyState(
                        stringResource(R.string.chat_empty_storage_title),
                        hint = stringResource(R.string.chat_empty_storage_body),
                        icon = ChatIcons.Bubble,
                    )
                    ChatGate.SIGNED_OUT -> {
                        EmptyState(
                            stringResource(R.string.chat_empty_signed_out_title),
                            hint = stringResource(R.string.chat_empty_signed_out_body, chat.host),
                            icon = ChatIcons.Bubble,
                        )
                        GateButtons(
                            primary = stringResource(R.string.chat_empty_sign_up_action) to { app.openSettings(listOf(SettingsRoutes.RUKOO, SettingsRoutes.RUKOO_SIGNUP)) },
                            secondary = stringResource(R.string.chat_empty_sign_in_action) to { app.openSettings(listOf(SettingsRoutes.RUKOO, SettingsRoutes.RUKOO_SIGNIN)) },
                        )
                        if (chat.inviteSignups) {
                            Text(
                                stringResource(R.string.chat_empty_invite_hint),
                                style = Rk.type.text12_5,
                                color = Rk.colors.text3,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.padding(horizontal = 32.dp, vertical = 12.dp),
                            )
                        }
                    }
                    ChatGate.NO_WORKSPACE -> {
                        EmptyState(
                            stringResource(R.string.chat_empty_no_workspace_title),
                            hint = stringResource(R.string.chat_empty_no_workspace_body),
                            icon = ChatIcons.Bubble,
                        )
                        GateButtons(
                            primary = stringResource(R.string.chat_workspace_join) to { app.openChatSheet(ChatSheet.JOIN) },
                            secondary = stringResource(R.string.chat_workspace_make) to { app.openChatSheet(ChatSheet.CREATE_WORKSPACE) },
                        )
                    }
                    ChatGate.LOADING -> Unit
                }
            }
        }
        CornerButton(onClick = app::openDrawer, modifier = Modifier.align(Alignment.BottomStart).padding(16.dp)) {
            RkIcon(RukooIcons.Menu, stringResource(R.string.chat_workspace_switch), size = 20.dp, tint = Rk.colors.text2)
        }
    }
}

@Composable
private fun GateButtons(primary: Pair<String, () -> Unit>, secondary: Pair<String, () -> Unit>) {
    Row(
        Modifier.padding(horizontal = 24.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RkButton(secondary.first, secondary.second, kind = RkButtonKind.SECONDARY)
        RkButton(primary.first, primary.second, kind = RkButtonKind.PRIMARY)
    }
}
