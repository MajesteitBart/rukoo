// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine.
package nl.bvdm.rukoo.ui.theme

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween as coreTween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext

/** The desktop's curves (agent.css:47-51, styles.css). Built-in curves are too weak for Rukoo's motion. */
object RukooEasing {
    /** Entries, expand, glide, progress. */
    val OutStrong: Easing = CubicBezierEasing(0.23f, 1f, 0.32f, 1f)

    /** Movement between places. */
    val InOutStrong: Easing = CubicBezierEasing(0.77f, 0f, 0.175f, 1f)

    /** Underline draw-in. */
    val Link: Easing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)

    /** Color and background changes. */
    val Default: Easing = CubicBezierEasing(0.4f, 0f, 0.2f, 1f)

    /** Fades and button feedback. */
    val Out: Easing = CubicBezierEasing(0f, 0f, 0.2f, 1f)

    /** App menus, dialogs, pages and the swipe snap. */
    val App: Easing = CubicBezierEasing(0.2f, 0.8f, 0.2f, 1f)

    /** CSS `ease`, as in "120ms ease". */
    val Css: Easing = CubicBezierEasing(0.25f, 0.1f, 0.25f, 1f)
}

/** Durations in ms (spec 6 §2.8). Exits are faster than entries, or not animated. */
object RukooDurations {
    const val HOVER = 120
    const val MENU = 120
    const val DIALOG = 140
    const val PAGE = 160
    const val TOAST = 160
    const val SWITCH = 140
    const val POPOVER = 180
    const val SEGMENTED = 200
    const val OVERLAY = 200
    const val SWIPE = 200
    const val FADE_UP = 300
    const val CARD = 380
    const val EXPAND = 300
    const val CHEVRON = 300
    const val STAGGER = 80
    const val SHIMMER = 1800
    const val SHIMMER_THINKING = 1400
    const val SPINNER = 700
    const val PULSE = 1000
}

/**
 * Motion for the current composition. When the system's "Remove animations" is on (animator duration scale
 * 0), [reduced] is true: one-off motion snaps, and looping work (shimmer, spinner, pulse) draws a still frame.
 */
@Immutable
class RukooMotion(val reduced: Boolean) {
    /** A tween on Rukoo's curve, or a snap with reduced motion. */
    fun <T> tween(durationMs: Int, easing: Easing = RukooEasing.OutStrong, delayMs: Int = 0): FiniteAnimationSpec<T> =
        if (reduced) snap() else coreTween(durationMillis = durationMs, delayMillis = delayMs, easing = easing)

    /** Hover and pressed fills: 120ms ease. */
    fun <T> fill(): FiniteAnimationSpec<T> = tween(RukooDurations.HOVER, RukooEasing.Css)

    /** Expand and collapse: 300ms, strong ease-out. */
    fun <T> expand(): FiniteAnimationSpec<T> = tween(RukooDurations.EXPAND, RukooEasing.OutStrong)

    /** Linear, for loops. */
    fun <T> linear(durationMs: Int): FiniteAnimationSpec<T> = tween(durationMs, LinearEasing)
}

internal fun animationsRemoved(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

/** Whether the system removes animations, updated while the app runs. */
@Composable
fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    var reduced by remember(context) { mutableStateOf(animationsRemoved(context)) }
    DisposableEffect(context) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                reduced = animationsRemoved(context)
            }
        }
        val uri = Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE)
        context.contentResolver.registerContentObserver(uri, false, observer)
        onDispose { context.contentResolver.unregisterContentObserver(observer) }
    }
    return reduced
}
