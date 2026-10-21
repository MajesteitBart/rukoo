// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine.
package nl.bvdm.rukoo.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.panel

/**
 * An entity chip (bui.js `entityChip`): a person, an email or an agent inline, as a monogram and a name in
 * a field pill with a hairline. [sub] follows in `ink3` (the sender after a subject). [leading] replaces the
 * monogram (a mail badge, a file-type badge). With [onRemove] it ends in a 20dp x named [removeLabel]. A
 * [pending] chip (a file still on its way) shimmers its name and has no x. [animateEntry] pops it in once;
 * turn it off for chips in a lazy list that come back into view.
 */
@Composable
fun EntityChip(
    label: String,
    modifier: Modifier = Modifier,
    sub: String? = null,
    monogram: String? = label,
    monogramHueKey: String? = null,
    agent: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    onRemove: (() -> Unit)? = null,
    removeLabel: String? = null,
    pending: Boolean = false,
    animateEntry: Boolean = true,
) {
    val c = Rk.colors
    val shape = Rk.shapes.pill
    val source = remember { MutableInteractionSource() }
    var m = modifier
        .then(if (animateEntry) Modifier.popIn(200) else Modifier)
        .heightIn(min = 28.dp)
        .background(c.field, shape)
        .border(1.dp, c.line, shape)
    if (onClick != null) m = m.pressScale(source, 0.97f).rkClickable(shape, interactionSource = source, onClick = onClick)
    Row(
        m.padding(start = 4.dp, end = if (onRemove != null && !pending) 3.dp else 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            leading != null -> leading()
            monogram != null -> Monogram(monogram, hueKey = monogramHueKey, agent = agent, size = 18.dp)
        }
        val nameStyle = Rk.type.text12.medium.panel
        if (pending) {
            ShimmerText(label, style = nameStyle, modifier = Modifier.widthIn(max = 144.dp))
        } else {
            Text(label, style = nameStyle, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 144.dp))
        }
        if (sub != null) {
            Text(sub, style = Rk.type.text11_5.panel, color = c.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        }
        if (onRemove != null && !pending) {
            Box(
                Modifier
                    .size(22.dp)
                    .rkClickable(CircleShape, onClick = onRemove)
                    .semantics { contentDescription = removeLabel ?: label },
                contentAlignment = Alignment.Center,
            ) {
                RkIcon(PanelIcons.named("x"), null, size = 11.dp, tint = c.ink3)
            }
        }
    }
}

/**
 * The add chip (bui.js `addChip`): dashed and empty, a place to put something back, such as "Add this
 * email" after it was left out of a chat.
 */
@Composable
fun AddChip(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val shape = Rk.shapes.pill
    val dash = c.lineStrong
    val source = remember { MutableInteractionSource() }
    Row(
        modifier
            .pressScale(source, 0.97f)
            .heightIn(min = 28.dp)
            .drawBehind {
                val stroke = 1.dp.toPx()
                drawRoundRect(
                    color = dash,
                    topLeft = androidx.compose.ui.geometry.Offset(stroke / 2, stroke / 2),
                    size = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke),
                    cornerRadius = CornerRadius(size.height / 2),
                    style = Stroke(stroke, pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx()))),
                )
            }
            .rkClickable(shape, interactionSource = source, onClick = onClick)
            .padding(start = 8.dp, end = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RkIcon(PanelIcons.Plus, null, size = 11.dp, tint = c.ink3)
        Text(label, style = Rk.type.text12.medium.panel, color = c.ink2, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * A small pill action of the app chrome (`.chip-btn`), such as Unsubscribe next to the date in the reader:
 * 24 high on desktop, 28 here, `chip` fill, `text2`, 12/500, icon 14.
 */
@Composable
fun RkChipButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null, enabled: Boolean = true) {
    val c = Rk.colors
    val shape = Rk.shapes.pill
    val source = remember { MutableInteractionSource() }
    CompositionLocalProvider(LocalContentColor provides c.text2) {
        Row(
            modifier
                .pressScale(source, 0.97f)
                .heightIn(min = 28.dp)
                .background(c.chip, shape)
                .rkClickable(shape, enabled = enabled, interactionSource = source, onClick = onClick)
                .padding(start = if (icon != null) 8.dp else 10.dp, end = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (icon != null) RkIcon(icon, null, size = 14.dp)
            Text(label, style = Rk.type.text12.medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * A quick-action or suggestion chip under the empty chat (bui.js `suggestionChips`): 26 high on desktop,
 * 32 here, `raised` with a hairline on the chat canvas, icon 13 in `ink3`, 12/500 `ink2`.
 */
@Composable
fun SuggestionChip(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    delayMs: Int = 0,
    animateEntry: Boolean = true,
) {
    val c = Rk.colors
    val shape = Rk.shapes.pill
    val source = remember { MutableInteractionSource() }
    Row(
        modifier
            .then(if (animateEntry) Modifier.popIn(200, delayMs) else Modifier)
            .pressScale(source, 0.97f)
            .heightIn(min = 32.dp)
            .background(c.raised, shape)
            .border(1.dp, c.line, shape)
            .rkClickable(shape, interactionSource = source, onClick = onClick)
            .padding(start = 10.dp, end = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) RkIcon(icon, null, size = 13.dp, tint = c.ink3)
        Text(label, style = Rk.type.text12.medium.panel, color = c.ink2, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
