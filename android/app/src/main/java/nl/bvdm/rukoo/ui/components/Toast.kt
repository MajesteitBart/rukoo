package nl.bvdm.rukoo.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooDurations
import nl.bvdm.rukoo.ui.theme.RukooEasing
import nl.bvdm.rukoo.ui.theme.RukooIndication
import nl.bvdm.rukoo.ui.theme.title

/** One toast: a message, an optional action (Undo) and how long it stays. */
class RkToast internal constructor(
    val id: Long,
    val message: String,
    val actionLabel: String?,
    val durationMs: Long,
    val onAction: (() -> Unit)?,
)

/**
 * The app's toasts (ui.js `toast`). One at a time; a new one replaces the old. It stays 2.6s, 8s with an
 * action, 5s for errors. Touching or hovering it pauses the timer; letting go restarts it at 2.5s.
 */
@Stable
class RkToastState {
    var current: RkToast? by mutableStateOf(null)
        private set
    private var nextId = 0L

    /** Shows [message], with an [actionLabel] such as Undo that runs [onAction] and closes the toast. */
    fun showToast(message: String, actionLabel: String? = null, durationMs: Long? = null, onAction: (() -> Unit)? = null) {
        val action = if (actionLabel != null && onAction != null) actionLabel else null
        current = RkToast(
            id = ++nextId,
            message = message,
            actionLabel = action,
            durationMs = durationMs ?: if (action != null) 8000L else 2600L,
            onAction = if (action != null) onAction else null,
        )
    }

    /** An error from the mail engine or an agent: 5 seconds, no action, as desktop shows main-process errors. */
    fun showError(message: String) = showToast(message, durationMs = 5000L)

    /** Closes the toast; with an [id], only if that toast is still the current one. */
    fun dismiss(id: Long? = null) {
        if (id == null || current?.id == id) current = null
    }

    /** Runs the action of the toast on screen, once: a toast that is fading out or replaced does nothing. */
    internal fun runAction(toast: RkToast) {
        if (current?.id != toast.id) return
        current = null
        toast.onAction?.invoke()
    }
}

/** The screen's toasts, so any composable can show one: `LocalRkToast.current.showToast(...)`. */
val LocalRkToast = staticCompositionLocalOf { RkToastState() }

@Composable
fun rememberRkToastState(): RkToastState = remember { RkToastState() }

/**
 * Where toasts appear: place it at the bottom center of the screen, above bottom bars (pass their height as
 * bottom padding in [modifier]). It keeps clear of the navigation bar and the keyboard. The toast is dark in
 * both themes on purpose (components.md), slides up 16dp and fades in over 160ms.
 */
@Composable
fun RkToastHost(state: RkToastState, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val toast = state.current
    // Keeps the last toast on screen while it fades out.
    var shown by remember { mutableStateOf<RkToast?>(null) }
    if (toast != null) shown = toast

    var pressed by remember(toast?.id) { mutableStateOf(false) }
    var hovered by remember(toast?.id) { mutableStateOf(false) }
    var resumed by remember(toast?.id) { mutableStateOf(false) }
    val paused = pressed || hovered
    if (toast != null) {
        LaunchedEffect(toast.id, paused, resumed) {
            if (paused) return@LaunchedEffect
            delay(if (resumed) 2500L else toast.durationMs)
            state.dismiss(toast.id)
        }
    }

    val rise = with(LocalDensity.current) { 16.dp.roundToPx() }
    Box(
        modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(bottom = 24.dp),
        contentAlignment = Alignment.BottomCenter,
    ) {
        AnimatedVisibility(
            visible = toast != null,
            enter = fadeIn(Rk.motion.tween(RukooDurations.TOAST, RukooEasing.Css)) +
                slideInVertically(Rk.motion.tween(RukooDurations.TOAST, RukooEasing.Css)) { rise },
            exit = fadeOut(tween(120)),
        ) {
            val t = shown ?: return@AnimatedVisibility
            val shape = Rk.shapes.card
            Row(
                Modifier
                    .padding(horizontal = 16.dp)
                    .widthIn(max = 560.dp)
                    .heightIn(min = 40.dp)
                    .pointerInput(t.id) {
                        // Watch without consuming, so the action button still gets its tap.
                        awaitPointerEventScope {
                            while (true) {
                                val event = awaitPointerEvent(PointerEventPass.Initial)
                                when (event.type) {
                                    PointerEventType.Press -> pressed = true
                                    PointerEventType.Release -> {
                                        pressed = false
                                        resumed = true
                                    }
                                    PointerEventType.Enter -> hovered = true
                                    PointerEventType.Exit -> {
                                        hovered = false
                                        resumed = true
                                    }
                                }
                            }
                        }
                    }
                    .dropShadow(shape, Shadow(radius = 30.dp, color = Color.Black.copy(alpha = 0.3f), offset = DpOffset(0.dp, 10.dp)))
                    .background(c.toastBackground, shape)
                    .semantics { liveRegion = LiveRegionMode.Polite }
                    .padding(start = 16.dp, end = if (t.actionLabel != null) 6.dp else 16.dp),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    t.message,
                    style = Rk.type.text13,
                    color = c.toastText,
                    modifier = Modifier.weight(1f, fill = false).padding(vertical = 10.dp),
                )
                if (t.actionLabel != null) {
                    val actionShape = Rk.shapes.chip
                    val indication = RukooIndication(c.toastActionPressed, c.toastActionPressed, c.toastAction, actionShape)
                    Box(
                        Modifier
                            .rkClickable(actionShape, indication = indication) { state.runAction(t) }
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                    ) {
                        Text(t.actionLabel, style = Rk.type.text13.title, color = c.toastAction)
                    }
                }
            }
        }
    }
}
