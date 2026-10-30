package nl.bvdm.rukoo.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular
import nl.bvdm.rukoo.ui.theme.title

/**
 * A pane's top bar: title over an optional subline, a navigation control on the left and actions on the
 * right, on [background] with a bottom hairline. The list uses the 18/650 title at 64dp ("Inbox" over
 * "6 unread · demo@example.com"); the reader, composer and chat use 14/650 at 56dp. It pads for the status
 * bar by default; pass `WindowInsets(0)` for a bar below another one.
 */
@Composable
fun RkTopBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    navigation: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    titleStyle: TextStyle = Rk.type.text14.title,
    height: Dp = 56.dp,
    background: Color = Rk.colors.panel,
    hairline: Boolean = true,
    windowInsets: WindowInsets = WindowInsets.statusBars,
    /**
     * A color that washes the bar from the top down and puts a 10dp dot before the title: an inbox category's tab
     * (styles.css .list-head.cat-head), so it can't be taken for Inbox itself.
     */
    tint: Color? = null,
) {
    val c = Rk.colors
    val wash = if (tint != null) Modifier.background(Brush.verticalGradient(listOf(tint.copy(alpha = 0.18f), Color.Transparent))) else Modifier
    Column(modifier.fillMaxWidth().background(background).then(wash).windowInsetsPadding(windowInsets)) {
        CompositionLocalProvider(LocalContentColor provides c.text) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = height).padding(start = if (navigation != null) 4.dp else 18.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (navigation != null) {
                    navigation()
                    Spacer(Modifier.width(4.dp))
                }
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (tint != null) {
                            Box(Modifier.size(10.dp).background(tint, CircleShape))
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(title, style = titleStyle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (subtitle != null) {
                        Text(subtitle, style = Rk.type.text12, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, content = actions)
            }
        }
        if (hairline) Hairline()
    }
}

/** One quick filter above the list: All, Unread, Starred, Attachments. [count] shows only when above 0. */
data class QuickFilter(val key: String, val label: String, val count: Int = 0)

/**
 * The list's quick filters (app.js `renderListTools`): borderless tabs, the active one filled with the
 * primary ink. Counts follow the label at 60% and hide below 380dp, where the row scrolls sideways and fades
 * out at the right edge.
 */
@Composable
fun QuickFilterRow(
    filters: List<QuickFilter>,
    selectedKey: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    hairline: Boolean = true,
) {
    val c = Rk.colors
    Column(modifier.fillMaxWidth()) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val showCounts = maxWidth >= 380.dp
            val scroll = rememberScrollState()
            val fadeWidth = 18.dp
            Row(
                Modifier
                    .fillMaxWidth()
                    .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
                    .drawWithContent {
                        drawContent()
                        if (scroll.canScrollForward) {
                            val fade = fadeWidth.toPx()
                            drawRect(
                                brush = Brush.horizontalGradient(
                                    0f to Color.Black,
                                    ((size.width - fade) / size.width) to Color.Black,
                                    1f to Color.Transparent,
                                ),
                                blendMode = BlendMode.DstIn,
                            )
                        }
                    }
                    .horizontalScroll(scroll)
                    .padding(start = 14.dp, end = 10.dp, top = 2.dp, bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                for (filter in filters) {
                    FilterTab(filter, filter.key == selectedKey, showCounts) { onSelect(filter.key) }
                }
            }
        }
        if (hairline) Hairline()
    }
}

@Composable
private fun FilterTab(filter: QuickFilter, selected: Boolean, showCount: Boolean, onClick: () -> Unit) {
    val c = Rk.colors
    val shape = Rk.shapes.control
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val hovered by source.collectIsHoveredAsState()
    val content = if (selected) c.onPrimary else c.text2
    // The fill comes from the interaction state and the indication only draws the focus ring, so selecting
    // a focused tab keeps one indication node and its ring stays visible.
    val fill = when {
        selected -> c.primary
        pressed -> c.active
        hovered -> c.hover
        else -> Color.Transparent
    }
    Row(
        Modifier
            .heightIn(min = 32.dp)
            .background(fill, shape)
            .clip(shape)
            .selectable(
                selected = selected,
                interactionSource = source,
                indication = Rk.focusIndication(shape),
                role = Role.Tab,
                onClick = onClick,
            )
            .padding(horizontal = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            filter.label,
            style = if (selected) Rk.type.text12_5.semibold else Rk.type.text12_5.medium,
            color = content,
            maxLines = 1,
        )
        if (showCount && filter.count > 0) {
            Text(filter.count.toString(), style = Rk.type.text11.medium.tabular, color = content.copy(alpha = 0.6f), maxLines = 1)
        }
    }
}

/** A 1dp hairline in `border`, horizontal by default. */
@Composable
fun Hairline(modifier: Modifier = Modifier, vertical: Boolean = false, color: Color = Rk.colors.border) {
    if (vertical) {
        Box(modifier.width(1.dp).background(color))
    } else {
        Box(modifier.fillMaxWidth().height(1.dp).background(color))
    }
}

/** A settings group title (`.group-title`): 12/600 `text3` above a card. */
@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier.padding(start = 4.dp, top = 18.dp, bottom = 6.dp, end = 4.dp),
        style = Rk.type.text12.semibold,
        color = Rk.colors.text3,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/** A heading in the agent panel ("Sources", a plan's title): 13/600 `ink` with an optional count pill. */
@Composable
fun PanelHeading(text: String, modifier: Modifier = Modifier, count: Int? = null) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            text,
            style = Rk.type.panelBody.semibold,
            color = Rk.colors.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (count != null) CountPill(count.toString())
    }
}
