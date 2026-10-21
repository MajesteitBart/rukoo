package nl.bvdm.rukoo.ui.root

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.SeekableTransitionState
import androidx.compose.animation.core.rememberTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.ui.agent.ChatListSheet
import nl.bvdm.rukoo.ui.agent.ChatPane
import nl.bvdm.rukoo.ui.composer.ComposerPane
import nl.bvdm.rukoo.ui.mail.FolderDrawerContent
import nl.bvdm.rukoo.ui.mail.MailListPane
import nl.bvdm.rukoo.ui.onboarding.OnboardingScreen
import nl.bvdm.rukoo.ui.reader.ReaderPane
import nl.bvdm.rukoo.ui.settings.SettingsScreen

/** Two columns from this window width (spec 6 §5.1): the Fold's inner screen is about 750dp. */
val TwoPaneMinWidth: Dp = 600.dp

private val ListWidth = 340.dp
private val ListMinWidth = 300.dp
private val ChatWidth = 360.dp
private val ChatMinWidth = 320.dp

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
 * predictive back. Both layouts read the same [AppViewModel] state, so folding keeps what is open.
 */
@Composable
fun RukooRoot(app: AppViewModel, modifier: Modifier = Modifier) {
    val nav by app.state.collectAsStateWithLifecycle()
    val accounts by app.services.mail.accounts.collectAsStateWithLifecycle()
    val loaded by app.services.mail.loaded.collectAsStateWithLifecycle()
    val holder = rememberSaveableStateHolder()

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
            val previous = nav.back(twoPane)?.compactSlot()
            try {
                events.collect { event ->
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
            drawerContent = {
                ModalDrawerSheet(Modifier.widthIn(max = 300.dp)) {
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
            }
        }

        if (nav.chatListOpen) ChatListSheet(app, onDismiss = app::closeChatList)
    }
}

@Composable
private fun CompactLayout(app: AppViewModel, nav: NavState, holder: SaveableStateHolder, state: SeekableTransitionState<Slot>) {
    val transition = rememberTransition(state, label = "compact")
    val shift = with(LocalDensity.current) { 24.dp.roundToPx() }
    transition.AnimatedContent(
        transitionSpec = {
            // The chat and reader come in from 24dp to the right with a fade (spec 6 §5.5); back reverses it.
            val forward = depth(targetState) >= depth(initialState)
            val enter = slideInHorizontally(tween(200, easing = FastOutSlowInEasing)) { if (forward) shift else -shift } + fadeIn(tween(200))
            val exit = slideOutHorizontally(tween(200, easing = FastOutSlowInEasing)) { if (forward) -shift else shift } + fadeOut(tween(150))
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

@Composable
private fun TwoPaneLayout(app: AppViewModel, nav: NavState, holder: SaveableStateHolder, backProgress: Float) {
    nav.overlay?.let {
        OverlayContent(app, it)
        return
    }
    val layout = nav.twoPanes()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val chatRight = layout.right == Pane.CHAT
        val width = maxWidth
        Row(Modifier.fillMaxSize()) {
            if (chatRight) {
                val chat = ChatWidth.coerceAtMost(width - ListMinWidth).coerceAtLeast(ChatMinWidth)
                holder.SaveableStateProvider(Slot.OfPane(layout.left).key()) { PaneContent(app, nav, layout.left, Modifier.weight(1f).fillMaxHeight()) }
                VerticalDivider()
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
            } else {
                val list = ListWidth.coerceAtMost(width * 0.45f).coerceAtLeast(ListMinWidth)
                holder.SaveableStateProvider(Slot.OfPane(layout.left).key()) { PaneContent(app, nav, layout.left, Modifier.width(list).fillMaxHeight()) }
                VerticalDivider()
                holder.SaveableStateProvider(Slot.OfPane(layout.right).key()) {
                    PaneContent(
                        app, nav, layout.right,
                        Modifier.weight(1f).fillMaxHeight().graphicsLayer {
                            if (layout.right == Pane.COMPOSER) alpha = 1f - backProgress * 0.5f
                        },
                    )
                }
            }
        }
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
