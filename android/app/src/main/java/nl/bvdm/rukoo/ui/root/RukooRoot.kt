package nl.bvdm.rukoo.ui.root

import android.content.Context
import android.net.Uri
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.SeekableTransitionState
import androidx.compose.animation.core.rememberTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.ui.agent.ChatListSheet
import nl.bvdm.rukoo.ui.agent.ChatPane
import nl.bvdm.rukoo.ui.components.Hairline
import nl.bvdm.rukoo.ui.components.LocalRkToast
import nl.bvdm.rukoo.ui.components.RkToastHost
import nl.bvdm.rukoo.ui.composer.ComposerPane
import nl.bvdm.rukoo.ui.mail.FolderDrawerContent
import nl.bvdm.rukoo.ui.mail.MailDialog
import nl.bvdm.rukoo.ui.mail.MailListPane
import nl.bvdm.rukoo.ui.mail.MoveSheet
import nl.bvdm.rukoo.ui.mail.ResourceStrings
import nl.bvdm.rukoo.ui.onboarding.OnboardingScreen
import nl.bvdm.rukoo.ui.reader.ReaderPane
import nl.bvdm.rukoo.ui.reader.openInBrowser
import nl.bvdm.rukoo.ui.settings.SettingsScreen
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooEasing

/** Two columns from this window width (spec 6 §5.1): the Fold's inner screen is about 750dp. */
val TwoPaneMinWidth: Dp = 600.dp

/** Pane widths on the inner screen (spec 6 §5.3); the user drags the divider and the width sticks (desktop prefs). */
internal object PaneWidths {
    val List = 340.dp
    val ListMin = 300.dp
    val ListMax = 640.dp
    val Chat = 360.dp
    val ChatMin = 320.dp
    val ChatMax = 560.dp

    /** The pane next to a sized one keeps at least this much. */
    val OtherMin = 300.dp

    fun clamp(width: Float, min: Dp, max: Dp, window: Dp): Float {
        val upper = minOf(max.value, window.value - OtherMin.value).coerceAtLeast(min.value)
        return width.coerceIn(min.value, upper)
    }
}

/** What fills the window in one pane: a pane, or an overlay over everything. */
private sealed interface Slot {
    data class OfPane(val pane: Pane) : Slot

    data class OfOverlay(val overlay: Overlay) : Slot
}

private fun NavState.compactSlot(): Slot = overlay?.let { Slot.OfOverlay(it) } ?: Slot.OfPane(top)

// The same key in both layouts, so a pane keeps its saved state (scroll position, input) across fold and unfold.
private fun Slot.key(): String = when (this) {
    is Slot.OfPane -> pane.name
    is Slot.OfOverlay -> overlay.name
}

/**
 * The adaptive root: one pane below 600dp, two from 600dp, the folder drawer as a modal drawer, and
 * predictive back. Both layouts read the same [AppViewModel] state, so folding keeps what is open. It
 * also hosts what every pane shares: the toasts, the mail dialogs and the move sheet.
 */
@Composable
fun RukooRoot(app: AppViewModel, modifier: Modifier = Modifier) {
    val nav by app.state.collectAsStateWithLifecycle()
    val accounts by app.services.mail.accounts.collectAsStateWithLifecycle()
    val loaded by app.services.mail.loaded.collectAsStateWithLifecycle()
    val holder = rememberSaveableStateHolder()
    val context = LocalContext.current
    val resources = context.resources
    SideEffect { app.mailUi.strings = ResourceStrings(resources) }
    LaunchedEffect(app) {
        app.effects.collect { effect ->
            when (effect) {
                is UiEffect.OpenUrl -> openInBrowser(context, Uri.parse(effect.url))
            }
        }
    }

    CompositionLocalProvider(LocalRkToast provides app.mailUi.toasts) {
        BoxWithConstraints(modifier.fillMaxSize()) {
            val twoPane = maxWidth >= TwoPaneMinWidth
            LaunchedEffect(twoPane) { app.onLayout(twoPane) }

            val drawerState = rememberDrawerState(if (nav.drawerOpen) DrawerValue.Open else DrawerValue.Closed)
            LaunchedEffect(nav.drawerOpen) {
                if (nav.drawerOpen && !drawerState.isOpen) drawerState.open()
                if (!nav.drawerOpen && !drawerState.isClosed) drawerState.close()
            }
            // A swipe or a tap outside closes the drawer without going through the view model.
            LaunchedEffect(drawerState) {
                snapshotFlow { drawerState.currentValue }.collect { if (it == DrawerValue.Closed) app.closeDrawer() }
            }

            // No accounts yet: first run.
            val setup = loaded && accounts.isEmpty() && nav.overlay != Overlay.SETTINGS
            val canBack = nav.back(twoPane) != null && !setup
            var backProgress by remember { mutableFloatStateOf(0f) }
            val scope = rememberCoroutineScope()
            val compactState = remember { SeekableTransitionState(nav.compactSlot()) }
            val target = nav.compactSlot()
            LaunchedEffect(target) { compactState.animateTo(target) }

            PredictiveBackHandler(enabled = canBack) { events ->
                // Back that stops at "Save draft?" doesn't preview the pane behind the composer.
                val asks = app.backAsks()
                val previous = if (asks) null else nav.back(twoPane)?.compactSlot()
                try {
                    events.collect { event ->
                        if (asks) return@collect
                        backProgress = event.progress
                        if (!twoPane && previous != null && previous != target) compactState.seekTo(event.progress, previous)
                    }
                    app.back()
                } catch (e: CancellationException) {
                    // The gesture was abandoned: settle back on the pane that was showing.
                    if (!twoPane) scope.launch { compactState.animateTo(target) }
                    throw e
                } finally {
                    backProgress = 0f
                }
            }

            ModalNavigationDrawer(
                drawerState = drawerState,
                gesturesEnabled = drawerState.isOpen,
                scrimColor = Rk.colors.scrim,
                drawerContent = {
                    ModalDrawerSheet(
                        Modifier.widthIn(max = 300.dp),
                        drawerShape = RoundedCornerShape(topEnd = 14.dp, bottomEnd = 14.dp),
                        drawerContainerColor = Rk.colors.bg,
                        drawerContentColor = Rk.colors.text,
                        drawerTonalElevation = 0.dp,
                        windowInsets = WindowInsets(0),
                    ) {
                        FolderDrawerContent(app, Modifier.fillMaxSize())
                    }
                },
            ) {
                Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                    when {
                        setup -> OnboardingScreen(app, Modifier.fillMaxSize())
                        twoPane -> TwoPaneLayout(app, nav, holder, backProgress)
                        else -> CompactLayout(app, nav, holder, compactState)
                    }
                    // Toasts sit above the bottom bars and the New message button (spec 6 §5.2).
                    RkToastHost(app.mailUi.toasts, Modifier.align(Alignment.BottomCenter).padding(bottom = 56.dp))
                }
            }

            if (nav.chatListOpen) ChatListSheet(app, onDismiss = app::closeChatList)
            MoveSheet(app.mailUi)
            app.mailUi.dialog?.let { MailDialog(it) }
        }
    }
}

@Composable
private fun CompactLayout(app: AppViewModel, nav: NavState, holder: SaveableStateHolder, state: SeekableTransitionState<Slot>) {
    val transition = rememberTransition(state, label = "compact")
    val shift = with(LocalDensity.current) { 24.dp.roundToPx() }
    val reduced = Rk.motion.reduced
    transition.AnimatedContent(
        transitionSpec = {
            // The chat and reader come in from 24dp to the right with a fade, 200ms on the app curve (spec 6
            // §5.5); back reverses it, and exits are quicker than entries.
            val forward = depth(targetState) >= depth(initialState)
            val enterMs = if (reduced) 0 else 200
            val exitMs = if (reduced) 0 else 150
            val enter = slideInHorizontally(tween(enterMs, easing = RukooEasing.App)) { if (forward) shift else -shift } + fadeIn(tween(enterMs, easing = RukooEasing.App))
            val exit = slideOutHorizontally(tween(exitMs, easing = RukooEasing.App)) { if (forward) -shift else shift } + fadeOut(tween(exitMs))
            enter togetherWith exit
        },
        contentKey = { it },
    ) { slot ->
        holder.SaveableStateProvider(slot.key()) {
            when (slot) {
                is Slot.OfOverlay -> OverlayContent(app, slot.overlay)
                is Slot.OfPane -> PaneContent(app, nav, slot.pane, Modifier.fillMaxSize())
            }
        }
    }
}

private fun depth(slot: Slot): Int = when (slot) {
    is Slot.OfOverlay -> 10
    is Slot.OfPane -> slot.pane.ordinal
}

private const val PREFS = "rukoo_layout"
private const val LIST_WIDTH = "list_width"
private const val CHAT_WIDTH = "chat_width"

private fun Context.layoutPrefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

@Composable
private fun TwoPaneLayout(app: AppViewModel, nav: NavState, holder: SaveableStateHolder, backProgress: Float) {
    nav.overlay?.let {
        OverlayContent(app, it)
        return
    }
    val context = LocalContext.current
    val prefs = remember { context.layoutPrefs() }
    var listWidth by remember { mutableFloatStateOf(prefs.getFloat(LIST_WIDTH, PaneWidths.List.value)) }
    var chatWidth by remember { mutableFloatStateOf(prefs.getFloat(CHAT_WIDTH, PaneWidths.Chat.value)) }
    val layout = nav.twoPanes()
    BoxWithConstraints(Modifier.fillMaxSize().background(Rk.colors.panel)) {
        val chatRight = layout.right == Pane.CHAT
        val window = maxWidth
        val density = LocalDensity.current
        if (chatRight) {
            val chat = PaneWidths.clamp(chatWidth, PaneWidths.ChatMin, PaneWidths.ChatMax, window).dp
            Row(Modifier.fillMaxSize()) {
                holder.SaveableStateProvider(Slot.OfPane(layout.left).key()) { PaneContent(app, nav, layout.left, Modifier.weight(1f).fillMaxHeight()) }
                Hairline(Modifier.fillMaxHeight(), vertical = true)
                holder.SaveableStateProvider(Slot.OfPane(layout.right).key()) {
                    PaneContent(
                        app, nav, layout.right,
                        Modifier.width(chat).fillMaxHeight().graphicsLayer {
                            // Predictive back closes the chat column: let it follow the gesture.
                            translationX = backProgress * 48.dp.toPx()
                            alpha = 1f - backProgress * 0.5f
                        },
                    )
                }
            }
            Divider(
                x = window - chat,
                onDrag = { dx -> chatWidth = PaneWidths.clamp(chatWidth - with(density) { dx.toDp().value }, PaneWidths.ChatMin, PaneWidths.ChatMax, window) },
                onDone = { prefs.edit().putFloat(CHAT_WIDTH, chatWidth).apply() },
            )
        } else {
            val list = PaneWidths.clamp(listWidth, PaneWidths.ListMin, PaneWidths.ListMax, window).dp
            Row(Modifier.fillMaxSize()) {
                holder.SaveableStateProvider(Slot.OfPane(layout.left).key()) { PaneContent(app, nav, layout.left, Modifier.width(list).fillMaxHeight()) }
                Hairline(Modifier.fillMaxHeight(), vertical = true)
                holder.SaveableStateProvider(Slot.OfPane(layout.right).key()) {
                    PaneContent(
                        app, nav, layout.right,
                        Modifier.weight(1f).fillMaxHeight().graphicsLayer {
                            if (layout.right == Pane.COMPOSER) alpha = 1f - backProgress * 0.5f
                        },
                    )
                }
            }
            Divider(
                x = list,
                onDrag = { dx -> listWidth = PaneWidths.clamp(listWidth + with(density) { dx.toDp().value }, PaneWidths.ListMin, PaneWidths.ListMax, window) },
                onDone = { prefs.edit().putFloat(LIST_WIDTH, listWidth).apply() },
            )
        }
    }
}

/**
 * The drag handle on the hairline between the panes: 16dp wide, centered on the line at [x], with a grip
 * that shows while dragging. Desktop resizes with the mouse; this is the touch version (spec 6 §5.7).
 */
@Composable
private fun Divider(x: Dp, onDrag: (Float) -> Unit, onDone: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val dragging by source.collectIsDraggedAsState()
    Box(
        Modifier
            .offset(x = x - 8.dp)
            .width(16.dp)
            .fillMaxHeight()
            .draggable(
                orientation = Orientation.Horizontal,
                state = rememberDraggableState(onDrag),
                interactionSource = source,
                onDragStopped = { onDone() },
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (dragging) Box(Modifier.size(width = 4.dp, height = 36.dp).background(Rk.colors.borderStrong, Rk.shapes.pill))
    }
}

@Composable
private fun PaneContent(app: AppViewModel, nav: NavState, pane: Pane, modifier: Modifier) {
    // A tap, scroll or focus anywhere in a pane makes it the one that stays when the phone folds (spec 6 §5.6).
    // The initial pass sees the touch before the pane's own content and consumes nothing.
    val tracked = modifier
        .pointerInput(pane) {
            awaitEachGesture {
                awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                app.interacted(pane)
            }
        }
        .onFocusChanged { if (it.hasFocus) app.interacted(pane) }
    when (pane) {
        Pane.LIST -> MailListPane(app, tracked)
        Pane.READER -> ReaderPane(app, nav.openMessageId, tracked)
        Pane.CHAT -> ChatPane(app, nav.chatConversationId, nav.chatEmailId, tracked)
        Pane.COMPOSER -> ComposerPane(app, tracked)
    }
}

@Composable
private fun OverlayContent(app: AppViewModel, overlay: Overlay) {
    when (overlay) {
        Overlay.SETTINGS -> SettingsScreen(app, Modifier.fillMaxSize())
        Overlay.ONBOARDING -> OnboardingScreen(app, Modifier.fillMaxSize())
    }
}
