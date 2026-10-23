// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine.
package nl.bvdm.rukoo.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.material3.LocalContentColor
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RkShadow
import nl.bvdm.rukoo.ui.theme.RukooIndication
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.panel
import nl.bvdm.rukoo.ui.theme.rkShadow
import nl.bvdm.rukoo.ui.theme.semibold
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember

// ---------- app family: rounded rectangles (styles.css .btn, .tbtn, .icon-btn, .link-btn) ----------

/** `.btn` kinds. One filled button per surface: [PRIMARY] is ink on canvas, never blue. */
enum class RkButtonKind {
    /** `chip` fill: buttons in pages and setup. */
    DEFAULT,

    /** The one filled action: `primary` on `onPrimary`. */
    PRIMARY,

    /** `panel` fill with a ring, for a second action beside the primary one. */
    SECONDARY,

    /** No fill, `text2`; fills on press. */
    GHOST,

    /** No fill, `text`; fills on press. */
    QUIET,

    /** A destructive last button in a dialog: `danger` fill, white text. */
    DANGER,
}

/** Heights 28, 32 (desktop `.btn`) and 36 for a main tap target such as Send. */
enum class RkButtonSize(val height: Dp, val padding: Dp) {
    SMALL(28.dp, 12.dp),
    REGULAR(32.dp, 14.dp),
    LARGE(36.dp, 16.dp),
}

private class Fill(val background: Color, val content: Color, val shadow: RkShadow?, val ring: Color?, val pressed: Color)

/** A rounded app button (`.btn`): weight 600, icon 16 before the label, press scale 0.96. */
@Composable
fun RkButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: RkButtonKind = RkButtonKind.DEFAULT,
    size: RkButtonSize = RkButtonSize.REGULAR,
    icon: ImageVector? = null,
    trailingIcon: ImageVector? = null,
    enabled: Boolean = true,
) {
    val c = Rk.colors
    val e = Rk.elevation
    val fill = when (kind) {
        RkButtonKind.DEFAULT -> Fill(c.chip, c.text, null, null, c.active)
        RkButtonKind.PRIMARY -> Fill(c.primary, c.onPrimary, null, null, c.onPrimary.copy(alpha = 0.10f))
        RkButtonKind.SECONDARY -> Fill(c.panel, c.text, e.shadowSm, c.borderStrong, c.hover)
        RkButtonKind.GHOST -> Fill(Color.Transparent, c.text2, null, null, c.active)
        RkButtonKind.QUIET -> Fill(Color.Transparent, c.text, null, null, c.hover)
        RkButtonKind.DANGER -> Fill(c.danger, Color.White, null, null, Color.Black.copy(alpha = 0.10f))
    }
    val shape = Rk.shapes.control
    val style = if (size == RkButtonSize.SMALL) Rk.type.text12_5.semibold else Rk.type.text13.semibold
    ButtonFrame(
        modifier = modifier,
        shape = shape,
        fill = fill,
        enabled = enabled,
        disabledAlpha = 0.55f,
        pressScale = 0.96f,
        height = size.height,
        padding = PaddingValues(horizontal = size.padding),
        gap = 8.dp,
        onClick = onClick,
    ) {
        if (icon != null) RkIcon(icon, null, size = 16.dp)
        Text(label, style = style, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (trailingIcon != null) RkIcon(trailingIcon, null, size = 16.dp)
    }
}

/**
 * A toolbar button with a label (`.tbtn`), such as Reply in the reader's bottom bar: no fill, weight 500,
 * the icon in `text2`. [primary] fills it (Edit on a draft); [danger] colors it red. With [showLabel] off the
 * label becomes the content description, as on narrow desktop windows. A [collapsible] label shows while the
 * button gets room for all of it and leaves when it doesn't, rather than ending in "…".
 */
@Composable
fun RkToolbarButton(
    label: String,
    icon: ImageVector?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    primary: Boolean = false,
    danger: Boolean = false,
    showLabel: Boolean = true,
    collapsible: Boolean = false,
    enabled: Boolean = true,
) {
    val c = Rk.colors
    val fill = when {
        primary -> Fill(c.primary, c.onPrimary, null, null, c.onPrimary.copy(alpha = 0.10f))
        danger -> Fill(Color.Transparent, c.danger, null, null, c.active)
        else -> Fill(Color.Transparent, c.text, null, null, c.active)
    }
    val iconTint = if (primary || danger) fill.content else c.text2
    ButtonFrame(
        modifier = if (showLabel && !collapsible) modifier else modifier.semantics { contentDescription = label },
        shape = Rk.shapes.control,
        fill = fill,
        enabled = enabled,
        disabledAlpha = 0.35f,
        pressScale = 1f,
        height = 36.dp,
        padding = PaddingValues(horizontal = if (showLabel) 10.dp else 8.dp),
        gap = if (collapsible) 0.dp else 6.dp,
        onClick = onClick,
    ) {
        if (icon != null) RkIcon(icon, null, size = 18.dp, tint = iconTint)
        when {
            !showLabel -> Unit
            collapsible -> CollapsingLabel(label, Rk.type.text13.medium)
            else -> Text(label, style = Rk.type.text13.medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * A toolbar label that is placed only when it gets its whole width, with its own gap after the icon. The
 * button carries the label as its content description, so a screen reader says it either way.
 */
@Composable
private fun CollapsingLabel(text: String, style: TextStyle) {
    Layout(content = { Text(text, Modifier.padding(start = 6.dp).clearAndSetSemantics {}, style = style, maxLines = 1) }) { measurables, constraints ->
        val label = measurables.single()
        if (label.maxIntrinsicWidth(constraints.maxHeight) > constraints.maxWidth) return@Layout layout(0, 0) {}
        val placeable = label.measure(constraints.copy(minWidth = 0))
        layout(placeable.width, placeable.height) { placeable.place(0, 0) }
    }
}

/** An action that reads as a link (`.link-btn`), such as "Save all" above attachments. Underlined on press. */
@Composable
fun RkLinkButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    style: TextStyle = Rk.type.text13.medium,
    color: Color = Rk.colors.link,
    enabled: Boolean = true,
) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    Row(
        modifier
            .minimumInteractiveComponentSize()
            .alpha(if (enabled) 1f else 0.45f)
            .rkClickable(Rk.shapes.chip, enabled = enabled, indication = Rk.focusIndication(Rk.shapes.chip), interactionSource = source, onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) RkIcon(icon, null, size = 15.dp, tint = color)
        Text(
            label,
            style = style.copy(textDecoration = if (pressed) TextDecoration.Underline else null),
            color = color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** `.icon-btn` sizes: the visual box, its icon and its radius. Every size still gets a 48dp touch target. */
enum class RkIconButtonSize(val box: Dp, val icon: Dp, val radius: Dp) {
    REGULAR(32.dp, 18.dp, 8.dp),
    SMALL(28.dp, 16.dp, 8.dp),
    XS(22.dp, 14.dp, 6.dp),
}

/**
 * An icon-only action (`.icon-btn`): `text2`, filled with `active` when pressed or [selected]. The
 * [contentDescription] is also its long-press tooltip, which is touch's version of the desktop `title`.
 * [news] adds the 7dp dot of the agent entry point and the chat bell, ringed in [newsRing] (the bar color).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RkIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: RkIconButtonSize = RkIconButtonSize.REGULAR,
    selected: Boolean = false,
    enabled: Boolean = true,
    tint: Color? = null,
    news: NewsTone? = null,
    newsRing: Color = Rk.colors.panel,
    tooltip: Boolean = true,
) {
    val c = Rk.colors
    val shape = androidx.compose.foundation.shape.RoundedCornerShape(size.radius)
    val button: @Composable () -> Unit = {
        Box(
            modifier
                .minimumInteractiveComponentSize()
                .alpha(if (enabled) 1f else 0.35f),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                Modifier
                    .size(size.box)
                    .background(if (selected) c.active else Color.Transparent, shape)
                    .rkClickable(shape, enabled = enabled, onClickLabel = null, onClick = onClick)
                    .semantics { this.contentDescription = contentDescription },
                contentAlignment = Alignment.Center,
            ) {
                RkIcon(icon, null, size = size.icon, tint = tint ?: if (selected) c.text else c.text2)
            }
            if (news != null) {
                // The 7dp dot sits 4dp in from the top right of the visual box, as on the desktop sparkle button.
                val shift = size.box / 2 - 7.5.dp
                NewsDot(news, ring = newsRing, modifier = Modifier.offset(x = shift, y = -shift))
            }
        }
    }
    if (tooltip && enabled) {
        TooltipBox(
            positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
            tooltip = { PlainTooltip(containerColor = c.toastBackground, contentColor = c.toastText) { Text(contentDescription, style = Rk.type.text12) } },
            state = rememberTooltipState(),
        ) { button() }
    } else {
        button()
    }
}

// ---------- panel family: pills (agent.css .bui-btn) ----------

/** `.bui-btn` kinds. */
enum class RkPillKind { PRIMARY, SECONDARY, GHOST, ACCENT, DANGER, QUIET, LINK }

/**
 * `.bui-btn` sizes. XS is 28 at 12px/400; SM is 27 on desktop and 32 here, since approval and draft card
 * buttons are a main tap target on a phone; MD has no fixed height (9 by 16 padding at 14px).
 */
enum class RkPillSize { XS, SM, MD }

/**
 * The agent panel's pill button. Keep the two families apart: pills in the panel, rounded rectangles in the
 * app chrome (SKILL.md "How to build it").
 */
@Composable
fun RkPillButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: RkPillKind = RkPillKind.SECONDARY,
    size: RkPillSize = RkPillSize.SM,
    icon: ImageVector? = null,
    enabled: Boolean = true,
) {
    val c = Rk.colors
    val e = Rk.elevation
    val fill = when (kind) {
        RkPillKind.PRIMARY -> Fill(c.ink, c.canvas, null, null, c.canvas.copy(alpha = 0.12f))
        RkPillKind.SECONDARY -> Fill(c.surface, c.ink, e.btn, e.btn.ring, c.inset)
        RkPillKind.GHOST -> Fill(c.hover2, c.ink, null, null, c.lineStrong)
        RkPillKind.ACCENT -> Fill(c.accent, Color.White, null, null, c.accentInk)
        RkPillKind.DANGER -> Fill(c.redTint, c.red, null, c.redRing, c.red.copy(alpha = 0.22f))
        RkPillKind.QUIET -> Fill(Color.Transparent, c.ink, null, null, c.hover)
        RkPillKind.LINK -> Fill(Color.Transparent, c.accentInk, null, null, Color.Transparent)
    }
    val filled = kind == RkPillKind.PRIMARY || kind == RkPillKind.ACCENT
    val style = when (size) {
        RkPillSize.XS -> Rk.type.text12.panel
        RkPillSize.SM -> Rk.type.text13.medium.panel
        RkPillSize.MD -> Rk.type.text14.medium.panel
    }
    val link = kind == RkPillKind.LINK
    val padding = when {
        link -> PaddingValues(0.dp)
        size == RkPillSize.XS -> PaddingValues(horizontal = 10.dp)
        size == RkPillSize.SM -> PaddingValues(horizontal = 12.dp)
        else -> PaddingValues(horizontal = 16.dp, vertical = 9.dp)
    }
    ButtonFrame(
        modifier = modifier,
        shape = Rk.shapes.pill,
        fill = fill,
        enabled = enabled,
        disabledAlpha = 0.5f,
        pressScale = 0.96f,
        height = when {
            link || size == RkPillSize.MD -> null
            size == RkPillSize.XS -> 28.dp
            else -> 32.dp
        },
        padding = padding,
        gap = when (size) {
            RkPillSize.XS -> 4.dp
            RkPillSize.SM -> 6.dp
            RkPillSize.MD -> 8.dp
        },
        highlight = if (filled) e.filledHighlight else null,
        onClick = onClick,
    ) {
        if (icon != null) RkIcon(icon, null, size = if (size == RkPillSize.MD) 15.dp else 13.dp)
        Text(label, style = style, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun ButtonFrame(
    modifier: Modifier,
    shape: Shape,
    fill: Fill,
    enabled: Boolean,
    disabledAlpha: Float,
    pressScale: Float,
    height: Dp?,
    padding: PaddingValues,
    gap: Dp,
    onClick: () -> Unit,
    highlight: Color? = null,
    content: @Composable () -> Unit,
) {
    val indication = RukooIndication(fill.pressed, fill.pressed.copy(alpha = fill.pressed.alpha * 0.6f), Rk.colors.focus, shape)
    val source = remember { MutableInteractionSource() }
    var m = modifier.minimumInteractiveComponentSize().alpha(if (enabled) 1f else disabledAlpha)
    if (pressScale != 1f) m = m.pressScale(source, pressScale)
    if (fill.shadow != null) m = m.rkShadow(fill.shadow, shape)
    m = m.background(fill.background, shape)
    if (fill.ring != null) m = m.border(1.dp, fill.ring, shape)
    if (highlight != null) {
        // The inner top highlight of filled buttons: inset 0 1px 0 white/0.14.
        m = m.drawWithContent {
            drawContent()
            val inset = size.height / 2
            drawLine(highlight, Offset(inset, 0.5f), Offset(size.width - inset, 0.5f), strokeWidth = 1.dp.toPx())
        }
    }
    m = m.rkClickable(shape, enabled = enabled, indication = indication, interactionSource = source, onClick = onClick)
    // A minimum, not a fixed height: at large font scales the label grows the button instead of clipping.
    m = if (height != null) m.heightIn(min = height) else m
    CompositionLocalProvider(LocalContentColor provides fill.content) {
        Row(
            m.padding(padding),
            horizontalArrangement = Arrangement.spacedBy(gap, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) { content() }
    }
}
