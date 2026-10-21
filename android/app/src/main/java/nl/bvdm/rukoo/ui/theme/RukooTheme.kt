package nl.bvdm.rukoo.ui.theme

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.Indication
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

val LocalRukooColors = staticCompositionLocalOf { RukooColors.Dark }
val LocalRukooType = staticCompositionLocalOf { RukooType.Default }
val LocalRukooShapes = staticCompositionLocalOf { RukooShapes.Default }
val LocalRukooSpacing = staticCompositionLocalOf { RukooSpacing.Default }
val LocalRukooElevation = staticCompositionLocalOf { RukooElevation.Dark }
val LocalRukooMotion = staticCompositionLocalOf { RukooMotion(reduced = false) }

/** Rukoo's tokens for the current composition: `Rk.colors.text2`, `Rk.type.text12_5`, `Rk.shapes.card`, ... */
object Rk {
    val colors: RukooColors
        @Composable @ReadOnlyComposable get() = LocalRukooColors.current
    val type: RukooType
        @Composable @ReadOnlyComposable get() = LocalRukooType.current
    val shapes: RukooShapes
        @Composable @ReadOnlyComposable get() = LocalRukooShapes.current
    val spacing: RukooSpacing
        @Composable @ReadOnlyComposable get() = LocalRukooSpacing.current
    val elevation: RukooElevation
        @Composable @ReadOnlyComposable get() = LocalRukooElevation.current
    val motion: RukooMotion
        @Composable @ReadOnlyComposable get() = LocalRukooMotion.current

    /** Press, hover and focus feedback clipped to [shape]; pass it to `clickable(indication = ...)`. */
    @Composable
    @ReadOnlyComposable
    fun indication(shape: Shape): Indication {
        val c = LocalRukooColors.current
        return RukooIndication(pressed = c.active, hovered = c.hover, focus = c.focus, shape = shape)
    }

    /**
     * Only the keyboard focus ring, for controls whose press shows another way (the active filter, a switch,
     * a link). Keyboard and DeX users still see where they are.
     */
    @Composable
    @ReadOnlyComposable
    fun focusIndication(shape: Shape): Indication =
        RukooIndication(pressed = Color.Transparent, hovered = Color.Transparent, focus = LocalRukooColors.current.focus, shape = shape)
}

/**
 * Rukoo's theme. Material 3 is the plumbing, not the look: the tokens live in Rukoo's own CompositionLocals,
 * and Material components get a color scheme mapped from them, so a TextField, DropdownMenu or
 * ModalBottomSheet doesn't stand out. Material's ripple is off in favor of [RukooIndication].
 *
 * Switching [theme] swaps the color object in one frame, without animating colors (SKILL.md "Known drift").
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RukooTheme(theme: ThemeMode = ThemeMode.SYSTEM, content: @Composable () -> Unit) {
    val dark = when (theme) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.DARK -> true
        ThemeMode.LIGHT -> false
    }
    val colors = if (dark) RukooColors.Dark else RukooColors.Light
    val elevation = if (dark) RukooElevation.Dark else RukooElevation.Light
    val reduced = rememberReducedMotion()
    val motion = remember(reduced) { RukooMotion(reduced) }
    val type = RukooType.Default
    val scheme = remember(colors) { materialColors(colors) }

    // Edge to edge: the canvas runs behind the system bars, whose icons follow the app's theme rather than
    // the system's, so a light app on a dark phone still gets dark icons.
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = view.context.findActivity()?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }

    MaterialTheme(colorScheme = scheme, typography = MaterialTypography, shapes = MaterialShapes) {
        CompositionLocalProvider(
            LocalRukooColors provides colors,
            LocalRukooType provides type,
            LocalRukooShapes provides RukooShapes.Default,
            LocalRukooSpacing provides RukooSpacing.Default,
            LocalRukooElevation provides elevation,
            LocalRukooMotion provides motion,
            LocalIndication provides RukooIndication(colors.active, colors.hover, colors.focus),
            LocalRippleConfiguration provides null,
            LocalTextSelectionColors provides TextSelectionColors(handleColor = colors.accent, backgroundColor = colors.accentSoft),
            LocalContentColor provides colors.text,
            LocalTextStyle provides type.body,
            content = content,
        )
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/**
 * Material roles mapped onto Rukoo tokens. `primary` is the accent on purpose: Material uses it for "on"
 * states (switch, checkbox, radio, cursor, focused field), which are accent in Rukoo. Rukoo's own filled
 * button is ink and is drawn by RkButton, never by Material's Button.
 */
internal fun materialColors(c: RukooColors): ColorScheme {
    val base = if (c.isDark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = c.accent,
        onPrimary = c.onAccent,
        primaryContainer = c.accentSoft,
        onPrimaryContainer = c.link,
        inversePrimary = c.toastAction,
        secondary = c.text2,
        onSecondary = c.panel,
        secondaryContainer = c.active,
        onSecondaryContainer = c.text,
        tertiary = c.link,
        onTertiary = c.onAccent,
        tertiaryContainer = c.accentSoft,
        onTertiaryContainer = c.link,
        background = c.bg,
        onBackground = c.text,
        surface = c.panel,
        onSurface = c.text,
        surfaceVariant = c.chip,
        onSurfaceVariant = c.text2,
        surfaceTint = Color.Transparent,
        inverseSurface = c.toastBackground,
        inverseOnSurface = c.toastText,
        error = c.danger,
        onError = Color.White,
        errorContainer = c.redTint,
        onErrorContainer = c.red,
        outline = c.borderStrong,
        outlineVariant = c.border,
        scrim = Color(0xFF0A0C12),
        surfaceBright = c.raised,
        surfaceDim = c.bg,
        // Sheets, menus and dialogs float on `raised`; the drawer passes `bg` itself (spec 6 §5.2).
        surfaceContainerLowest = c.panel,
        surfaceContainerLow = c.raised,
        surfaceContainer = c.raised,
        surfaceContainerHigh = c.raised,
        surfaceContainerHighest = c.chip,
    )
}

private val MaterialTypography: Typography = RukooType.Default.let { t ->
    Typography(
        displayLarge = t.text26.title,
        displayMedium = t.text26.title,
        displaySmall = t.text20.title,
        headlineLarge = t.text26.title,
        headlineMedium = t.text20.title,
        headlineSmall = t.text18.title,
        titleLarge = t.text18.title,
        titleMedium = t.text14.semibold,
        titleSmall = t.text13.semibold,
        bodyLarge = t.text13_5,
        bodyMedium = t.text13,
        bodySmall = t.text12,
        labelLarge = t.text13.medium,
        labelMedium = t.text12.medium,
        labelSmall = t.text11.medium,
    )
}

private val MaterialShapes = Shapes(
    extraSmall = RoundedCornerShape(Radius.chip),
    small = RoundedCornerShape(Radius.control),
    medium = RoundedCornerShape(Radius.card),
    large = RoundedCornerShape(Radius.panel),
    extraLarge = RoundedCornerShape(Radius.window),
)
