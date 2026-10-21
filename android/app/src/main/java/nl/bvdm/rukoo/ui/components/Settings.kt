package nl.bvdm.rukoo.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.ParentDataModifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooDurations
import nl.bvdm.rukoo.ui.theme.RukooEasing
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.tabular

/** How far a row's separator is inset from the start; rows with an avatar push it past the avatar. */
private class DividerInset(val inset: Dp) : ParentDataModifier {
    override fun Density.modifyParentData(parentData: Any?): Any = this@DividerInset
}

/** Insets the separator above this row of a [SettingsCard] (16dp by default, 60dp after an avatar). */
fun Modifier.settingsDividerInset(inset: Dp): Modifier = this.then(DividerInset(inset))

/**
 * A settings card (`.card`): `panel`, a 1dp `border`, 12dp corners. It stacks its children and draws the
 * separators between them, inset 16dp on both sides as on desktop, so callers only list rows.
 */
@Composable
fun SettingsCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = Rk.colors
    val shape = Rk.shapes.panel
    // Separator positions are found while measuring and drawn afterwards: (y, start inset) in px.
    val separators = remember { mutableStateOf(emptyList<Pair<Int, Float>>()) }
    val line = c.border
    Layout(
        content = content,
        modifier = modifier
            .fillMaxWidth()
            .background(c.panel, shape)
            .border(1.dp, c.border, shape)
            .clip(shape)
            .drawWithContent {
                drawContent()
                val end = size.width - 16.dp.toPx()
                for ((y, start) in separators.value) {
                    drawLine(line, Offset(start, y + 0.5f), Offset(end, y + 0.5f), strokeWidth = 1.dp.toPx())
                }
            },
    ) { measurables, constraints ->
        val placeables = measurables.map { it.measure(constraints.copy(minHeight = 0)) }
        val width = if (constraints.hasBoundedWidth) constraints.maxWidth else placeables.maxOfOrNull { it.width } ?: 0
        val found = ArrayList<Pair<Int, Float>>()
        var y = 0
        placeables.forEachIndexed { i, p ->
            if (i > 0) found += y to ((measurables[i].parentData as? DividerInset)?.inset ?: 16.dp).toPx()
            y += p.height
        }
        if (found != separators.value) separators.value = found
        layout(width, y) {
            var top = 0
            for (p in placeables) {
                p.place(0, top)
                top += p.height
            }
        }
    }
}

/**
 * A settings row (`.row`): title 13.5/500, an optional description in `text2`, and the current [value] in
 * accent under it (the row opens a choice). [leading] holds an avatar or icon; [trailing] a switch, a
 * chevron ([SettingsChevron]) or a short value ([SettingsTrailingValue]).
 */
@Composable
fun SettingsRow(
    title: String,
    modifier: Modifier = Modifier,
    description: String? = null,
    value: String? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    titleColor: Color = Rk.colors.text,
) {
    var m = modifier.fillMaxWidth()
    if (leading != null) m = m.settingsDividerInset(60.dp)
    if (onClick != null) m = m.rkClickable(androidx.compose.ui.graphics.RectangleShape, enabled = enabled, onClick = onClick)
    RowBody(m, title, description, value, leading, trailing, enabled, titleColor)
}

/** A settings row with a switch; the whole row toggles, as a Switch row should on touch. */
@Composable
fun SettingsSwitchRow(
    title: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    description: String? = null,
    enabled: Boolean = true,
) {
    val m = modifier
        .fillMaxWidth()
        .toggleable(
            value = checked,
            enabled = enabled,
            role = Role.Switch,
            interactionSource = null,
            indication = Rk.indication(androidx.compose.ui.graphics.RectangleShape),
            onValueChange = onCheckedChange,
        )
    RowBody(m, title, description, null, null, { RkSwitch(checked, null, enabled = enabled) }, enabled, Rk.colors.text)
}

@Composable
private fun RowBody(
    modifier: Modifier,
    title: String,
    description: String?,
    value: String?,
    leading: (@Composable () -> Unit)?,
    trailing: (@Composable () -> Unit)?,
    enabled: Boolean,
    titleColor: Color,
) {
    val c = Rk.colors
    Row(
        modifier
            .heightIn(min = 56.dp)
            .alpha(if (enabled) 1f else 0.45f)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) leading()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = Rk.type.text13_5.medium, color = titleColor)
            if (description != null) Text(description, style = Rk.type.text12_5, color = c.text2)
            if (value != null) Text(value, style = Rk.type.text12_5, color = c.accent, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (trailing != null) trailing()
    }
}

/** The chevron at the end of a row that opens a page. */
@Composable
fun SettingsChevron() {
    RkIcon(RukooIcons.ChevronRight, null, size = 16.dp, tint = Rk.colors.text3)
}

/** A short value at the end of a row, in `text3`. */
@Composable
fun SettingsTrailingValue(text: String) {
    Text(text, style = Rk.type.text12_5.tabular, color = Rk.colors.text3, maxLines = 1)
}

/**
 * Rukoo's switch (`.switch`), not Material's: a 36x20 track, `borderStrong` off and `accent` on, with a 14dp
 * white knob that travels 16dp in 140ms. The animation runs on a fraction, not on colors, so a theme change
 * flips it at once. Pass [onCheckedChange] null when the row around it handles the toggle.
 */
@Composable
fun RkSwitch(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val c = Rk.colors
    val on by animateFloatAsState(
        if (checked) 1f else 0f,
        Rk.motion.tween(RukooDurations.SWITCH, RukooEasing.App),
        label = "switch",
    )
    var m = modifier.alpha(if (enabled) 1f else 0.45f)
    if (onCheckedChange != null) {
        m = m.minimumInteractiveComponentSize().toggleable(
            value = checked,
            enabled = enabled,
            role = Role.Switch,
            interactionSource = null,
            indication = Rk.focusIndication(Rk.shapes.pill),
            onValueChange = onCheckedChange,
        )
    }
    Box(m, contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(36.dp, 20.dp)
                .background(lerp(c.borderStrong, c.accent, on), Rk.shapes.pill),
            contentAlignment = Alignment.CenterStart,
        ) {
            Box(
                Modifier
                    .offset(x = 3.dp + 16.dp * on)
                    .size(14.dp)
                    .dropShadow(CircleShape, Shadow(radius = 2.dp, color = Color.Black.copy(alpha = 0.3f), offset = DpOffset(0.dp, 1.dp)))
                    .background(c.knob, CircleShape),
            )
        }
    }
}
