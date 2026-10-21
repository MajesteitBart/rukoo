// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine.
package nl.bvdm.rukoo.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooDurations
import nl.bvdm.rukoo.ui.theme.rkSurface
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular

/** Inside an [RkBottomSheet]: a column that can also close the sheet with its slide-out. */
class RkSheetScope internal constructor(column: ColumnScope, private val close: () -> Unit) : ColumnScope by column {
    /** Slides the sheet away, then calls the sheet's `onDismissRequest`. */
    fun dismiss() = close()
}

/**
 * A bottom sheet for long menus and pickers on a phone (the message menu, the chat list, the model list):
 * `raised`, 14dp top corners, a 36x4 drag handle in `borderStrong`, over Rukoo's scrim. Long flows such as
 * the chat get a full-screen route instead (spec 6 §5.5). Show it while a flag is set and clear the flag in
 * [onDismissRequest]; rows call [RkSheetScope.dismiss] to close it with its animation.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RkBottomSheet(
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    title: String? = null,
    content: @Composable RkSheetScope.() -> Unit,
) {
    val c = Rk.colors
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val close: () -> Unit = {
        scope.launch { sheetState.hide() }.invokeOnCompletion { if (!sheetState.isVisible) onDismissRequest() }
    }
    ModalBottomSheet(
        onDismissRequest = onDismissRequest,
        modifier = modifier,
        sheetState = sheetState,
        shape = Rk.shapes.sheet,
        containerColor = c.raised,
        contentColor = c.text,
        tonalElevation = 0.dp,
        scrimColor = c.scrim,
        dragHandle = {
            Box(Modifier.padding(top = 8.dp, bottom = 6.dp).size(36.dp, 4.dp).background(c.borderStrong, Rk.shapes.pill))
        },
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
            if (title != null) SheetHeading(title)
            RkSheetScope(this, close).content()
        }
    }
}

/**
 * A row in a sheet or menu: 48dp, an optional icon in `text2`, the label, then a [tag] or [hint] in `text3`.
 * A [checked] row is the current choice (600 and a check); a [danger] row is red. Rows are 48dp on a phone
 * where desktop menus use 32.
 */
@Composable
fun SheetRow(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    hint: String? = null,
    tag: String? = null,
    checked: Boolean = false,
    danger: Boolean = false,
    enabled: Boolean = true,
) {
    val c = Rk.colors
    val content = if (danger) c.danger else c.text
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .alpha(if (enabled) 1f else 0.45f)
            .rkClickable(RectangleShape, enabled = enabled, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) RkIcon(icon, null, size = 18.dp, tint = if (danger) c.danger else c.text2)
        Column(Modifier.weight(1f)) {
            Text(
                label,
                style = if (checked) Rk.type.text13.semibold else Rk.type.text13,
                color = content,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (hint != null) Text(hint, style = Rk.type.text12, color = c.text3, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (tag != null) Text(tag, style = Rk.type.text11.tabular, color = c.text3, maxLines = 1)
        if (checked) RkIcon(RukooIcons.Check, null, size = 16.dp, tint = c.text2)
    }
}

/** A heading inside a sheet or menu: 11.5/600 `text3`. */
@Composable
fun SheetHeading(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 4.dp),
        style = Rk.type.text11_5.semibold,
        color = Rk.colors.text3,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/** A separator between groups of sheet or menu rows. */
@Composable
fun SheetDivider(modifier: Modifier = Modifier) {
    Hairline(modifier.padding(vertical = 4.dp))
}

/**
 * A short anchored menu (the agent picker, the effort menu), drawn like the panel's menus (bui.js
 * `glideMenu`): `surface`, 10dp corners, the raised ring and blur, popping in over 180ms. It opens below its
 * anchor when it fits, else above; put it in a Box with the anchor and fill it with [RkMenuItem]. A tap
 * outside the card, the back gesture or Escape closes it through [onDismissRequest].
 */
@Composable
fun RkDropdownMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    offset: DpOffset = DpOffset(0.dp, 4.dp),
    content: @Composable ColumnScope.() -> Unit,
) {
    if (!expanded) return
    val density = LocalDensity.current
    // The popup window clips what it draws, so the card sits inside a margin that holds its blur.
    val room = 24.dp
    val provider = remember(offset, density) {
        with(density) { MenuPositionProvider(offset.x.roundToPx(), offset.y.roundToPx(), room.roundToPx()) }
    }
    Popup(popupPositionProvider = provider, onDismissRequest = onDismissRequest, properties = PopupProperties(focusable = true)) {
        val c = Rk.colors
        val shape = Rk.shapes.card
        Box(Modifier.pointerInput(Unit) { detectTapGestures { onDismissRequest() } }.padding(room)) {
            Column(
                Modifier
                    .popIn(RukooDurations.POPOVER)
                    .then(modifier)
                    .widthIn(min = 176.dp, max = 320.dp)
                    .width(IntrinsicSize.Max)
                    .heightIn(max = 420.dp)
                    .rkSurface(Rk.elevation.raised, shape, c.surface)
                    // Taps on the card itself don't close the menu.
                    .pointerInput(Unit) { detectTapGestures { } }
                    .verticalScroll(rememberScrollState())
                    .padding(vertical = 4.dp),
                content = content,
            )
        }
    }
}

/** Below the anchor (start-aligned) when the card fits, else above; positions account for the blur margin. */
private class MenuPositionProvider(private val dx: Int, private val gap: Int, private val room: Int) : PopupPositionProvider {
    override fun calculatePosition(
        anchorBounds: IntRect,
        windowSize: IntSize,
        layoutDirection: LayoutDirection,
        popupContentSize: IntSize,
    ): IntOffset {
        val cardWidth = popupContentSize.width - 2 * room
        val cardHeight = popupContentSize.height - 2 * room
        val start = if (layoutDirection == LayoutDirection.Ltr) anchorBounds.left + dx else anchorBounds.right - cardWidth - dx
        val x = start.coerceIn(0, (windowSize.width - cardWidth).coerceAtLeast(0))
        val below = anchorBounds.bottom + gap
        val above = anchorBounds.top - gap - cardHeight
        val y = if (below + cardHeight <= windowSize.height || above < 0) below else above
        return IntOffset(x - room, y - room)
    }
}

/**
 * A row in an [RkDropdownMenu] (bui.js `glideMenu` rows): 40dp on touch, 6dp corners inside the menu's 4dp
 * inset, icon 16 in `ink2`, label 12.5/500, a [tag] in `ink3` and a check on the [checked] row. [leading]
 * replaces the icon, for a status dot.
 */
@Composable
fun RkMenuItem(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    leading: (@Composable () -> Unit)? = null,
    tag: String? = null,
    checked: Boolean = false,
    danger: Boolean = false,
    enabled: Boolean = true,
) {
    val c = Rk.colors
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp)
            .heightIn(min = 40.dp)
            .alpha(if (enabled) 1f else 0.45f)
            .rkClickable(Rk.shapes.chip, enabled = enabled, onClick = onClick)
            .padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            leading != null -> leading()
            icon != null -> RkIcon(icon, null, size = 16.dp, tint = if (danger) c.danger else c.ink2)
        }
        Text(
            label,
            style = Rk.type.text12_5.medium,
            color = if (danger) c.danger else c.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (tag != null) Text(tag, style = Rk.type.text11.tabular, color = c.ink3, maxLines = 1)
        if (checked) RkIcon(RukooIcons.Check, null, size = 13.dp, tint = c.ink2)
    }
}

/**
 * An empty state (`.empty`): an icon at 60% opacity, a title in `text2` and a hint in `text3`, centered,
 * with an optional link action ("Show all").
 */
@Composable
fun EmptyState(
    title: String,
    modifier: Modifier = Modifier,
    hint: String? = null,
    icon: ImageVector? = RukooIcons.MailOpen,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val c = Rk.colors
    Column(
        modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (icon != null) RkIcon(icon, null, Modifier.alpha(0.6f).padding(bottom = 6.dp), size = 40.dp, tint = c.text3)
        Text(title, style = Rk.type.text14.semibold, color = c.text2, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        if (hint != null) Text(hint, style = Rk.type.text12_5, color = c.text3, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        if (actionLabel != null && onAction != null) RkLinkButton(actionLabel, onAction, style = Rk.type.text12_5.medium)
    }
}
