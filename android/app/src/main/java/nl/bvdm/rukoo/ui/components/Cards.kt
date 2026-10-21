// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine.
package nl.bvdm.rukoo.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooDurations
import nl.bvdm.rukoo.ui.theme.RukooEasing
import nl.bvdm.rukoo.ui.theme.RukooMono
import nl.bvdm.rukoo.ui.theme.lineHeight
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.panel
import nl.bvdm.rukoo.ui.theme.rkSurface

/** What a source points at; it picks the bar icon (mail, globe, list). */
enum class SourceKind { EMAIL, WEB, OTHER }

/**
 * A source (bui.js `contextCards`): a card naming the email or page an answer came from. The bar shows the
 * kind's icon, the [title] and the [host]; an [excerpt] of up to four lines follows under a hairline; the
 * foot holds a source chip with [sourceLabel] ("Email" for emails). With [onOpen] the card opens the source.
 * [delayMs] staggers cards that appear together (100ms apart); [animateEntry] off skips the entry, for cards
 * that scroll back into a lazy list.
 */
@Composable
fun ContextCard(
    title: String,
    modifier: Modifier = Modifier,
    kind: SourceKind = SourceKind.OTHER,
    host: String? = null,
    excerpt: String? = null,
    sourceLabel: String? = null,
    onOpen: (() -> Unit)? = null,
    delayMs: Int = 0,
    animateEntry: Boolean = true,
) {
    val c = Rk.colors
    val shape = Rk.shapes.card
    var m = modifier
        .fillMaxWidth()
        .then(if (animateEntry) Modifier.fadeUp(400, delayMs) else Modifier)
        .rkSurface(Rk.elevation.card, shape, c.surface)
    if (onOpen != null) m = m.rkClickable(shape, onClick = onOpen)
    Column(m) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val hostMax = maxWidth * 0.4f
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val icon = when (kind) {
                    SourceKind.EMAIL -> PanelIcons.Mail
                    SourceKind.WEB -> PanelIcons.Globe
                    SourceKind.OTHER -> PanelIcons.List
                }
                RkIcon(icon, null, size = 13.dp, tint = c.ink3)
                Text(
                    title,
                    style = Rk.type.text13.medium.panel,
                    color = c.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (host != null) {
                    Text(host, style = Rk.type.text12.panel, color = c.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = hostMax))
                }
            }
        }
        if (excerpt != null) {
            Hairline()
            Text(
                excerpt,
                style = Rk.type.text12_5.panel.lineHeight(1.625f),
                color = c.ink2,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp),
            )
        }
        if (sourceLabel != null) {
            SourceChip(
                sourceLabel,
                email = kind == SourceKind.EMAIL,
                animateEntry = animateEntry,
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 12.dp),
            )
        } else if (excerpt != null) {
            androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
        }
    }
}

/**
 * The chip in a source card's foot: 24dp pill on `inset` with the button shadow, a 14dp badge, the source
 * name and an arrow out.
 */
@Composable
fun SourceChip(label: String, modifier: Modifier = Modifier, email: Boolean = false, animateEntry: Boolean = true) {
    val c = Rk.colors
    val shape = Rk.shapes.pill
    val e = Rk.elevation
    Row(
        modifier
            .then(if (animateEntry) Modifier.popIn(200, 150) else Modifier)
            .heightIn(min = 24.dp)
            .rkSurface(e.btn, shape, c.inset)
            .padding(start = 5.dp, end = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SourceBadge(label, email = email, emailIcon = PanelIcons.Mail)
        Text(label, style = Rk.type.text12.medium.panel, color = c.ink2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        RkIcon(PanelIcons.ArrowOut, null, size = 9.dp, tint = c.ink3)
    }
}

/**
 * Expands and collapses [content] the Rukoo way: height and opacity together over 300ms with the strong
 * ease-out, and a quicker exit. With reduced motion it snaps.
 */
@Composable
fun RkExpandable(expanded: Boolean, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val motion = Rk.motion
    AnimatedVisibility(
        visible = expanded,
        modifier = modifier,
        enter = expandVertically(motion.tween(RukooDurations.EXPAND, RukooEasing.OutStrong)) +
            fadeIn(motion.tween(RukooDurations.EXPAND, RukooEasing.OutStrong)),
        exit = shrinkVertically(motion.tween(200, RukooEasing.OutStrong)) + fadeOut(motion.tween(150, RukooEasing.Out)),
    ) {
        Column(content = content)
    }
}

/**
 * The detail drawer under a tool row (bui.js `toolChip` details): a 1dp `line` rail on the left with the
 * detail beside it, opened and closed by [expanded]. Put [RailText] in it.
 */
@Composable
fun CollapsibleRail(expanded: Boolean, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val line = Rk.colors.line
    RkExpandable(expanded, modifier) {
        Column(
            Modifier
                .padding(start = 8.dp, top = 2.dp, bottom = 2.dp)
                .drawBehind { drawLine(line, Offset(0.5f, 0f), Offset(0.5f, size.height), strokeWidth = 1.dp.toPx()) }
                .padding(start = 12.dp, top = 2.dp, bottom = 2.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            content = content,
        )
    }
}

/** Detail text beside a rail: 11.5 `ink2` at line height 1.6, selectable; commands in mono 11. */
@Composable
fun RailText(text: String, modifier: Modifier = Modifier, mono: Boolean = false) {
    val c = Rk.colors
    SelectionContainer(modifier) {
        Text(
            text,
            style = if (mono) Rk.type.mono.copy(fontSize = Rk.type.text11.fontSize, fontFamily = RukooMono) else Rk.type.text11_5.panel.lineHeight(1.6f),
            color = c.ink2,
        )
    }
}

/** A disclosure chevron that turns 180° in 300ms when [expanded]. */
@Composable
fun ExpandChevron(expanded: Boolean, modifier: Modifier = Modifier, size: Dp = 14.dp, tint: Color = Rk.colors.ink3) {
    val turn by animateFloatAsState(
        if (expanded) 180f else 0f,
        Rk.motion.tween(RukooDurations.CHEVRON, RukooEasing.Default),
        label = "chevron",
    )
    RkIcon(PanelIcons.Chevron, null, modifier.rotate(turn), size = size, tint = tint)
}

/**
 * A card on the agent canvas (approval, plan, draft, recommendation): `surface`, 10dp corners and the card
 * elevation, with 12dp padding inside by default.
 */
@Composable
fun PanelCard(modifier: Modifier = Modifier, padding: Dp = 12.dp, content: @Composable ColumnScope.() -> Unit) {
    val shape = Rk.shapes.card
    Column(
        modifier.fillMaxWidth().rkSurface(Rk.elevation.card, shape, Rk.colors.surface).padding(padding),
        content = content,
    )
}

/**
 * A quiet full-width row with a hairline (bui.js `offerRow`), such as "Continue the chat about the earlier
 * message": a leading monogram, a label over a sub line, and a chevron.
 */
@Composable
fun OfferRow(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, sub: String? = null, leading: (@Composable () -> Unit)? = null) {
    val c = Rk.colors
    val shape = Rk.shapes.card
    val source = remember { MutableInteractionSource() }
    Row(
        modifier
            .fillMaxWidth()
            .pressScale(source, 0.99f)
            .rkSurface(Rk.elevation.hairline, shape, Color.Transparent)
            .rkClickable(shape, interactionSource = source, onClick = onClick)
            .padding(start = 9.dp, end = 10.dp, top = 8.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) leading()
        Column(Modifier.weight(1f)) {
            Text(label, style = Rk.type.text12_5.medium.panel, color = c.ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (sub != null) Text(sub, style = Rk.type.text11_5.panel, color = c.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        RkIcon(PanelIcons.ChevronRight, null, size = 13.dp, tint = c.ink3)
    }
}
