package nl.bvdm.rukoo.ui.mail

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.categories.Category
import nl.bvdm.rukoo.ui.components.Hairline
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.settings.CategoryDot
import nl.bvdm.rukoo.ui.settings.categoryColor
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular

/**
 * The category tabs above the inbox (desktop's renderCategoryTabs): All, then each category with its color dot and
 * its unread count, underlined in the category's color when on screen. The row scrolls sideways and fades out at the
 * right edge where there is more.
 */
@Composable
fun CategoryTabs(
    categories: List<Category>,
    selected: String?,
    unread: (String?) -> Int,
    onSelect: (String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scroll = rememberScrollState()
    val label = stringResource(R.string.mailbox_categories_label)
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
                .drawWithContent {
                    drawContent()
                    if (scroll.canScrollForward) {
                        val fade = 22.dp.toPx()
                        drawRect(
                            brush = Brush.horizontalGradient(0f to Color.Black, ((size.width - fade) / size.width) to Color.Black, 1f to Color.Transparent),
                            blendMode = BlendMode.DstIn,
                        )
                    }
                }
                .horizontalScroll(scroll)
                .selectableGroup()
                .semantics { contentDescription = label }
                .padding(horizontal = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Tab(stringResource(R.string.mailbox_categories_all), null, selected == null, unread(null)) { onSelect(null) }
            for (c in categories) {
                Tab(c.name, c.color, selected == c.id, unread(c.id)) { onSelect(c.id) }
            }
        }
        Hairline()
    }
}

@Composable
private fun Tab(name: String, color: String?, on: Boolean, unread: Int, onClick: () -> Unit) {
    val c = Rk.colors
    val line = color?.let(::categoryColor) ?: c.text
    val countLabel = if (unread > 0) pluralStringResource(R.plurals.mailbox_categories_unread_count, unread, unread) else null
    Row(
        Modifier
            .heightIn(min = 44.dp)
            .selectable(on, interactionSource = remember { MutableInteractionSource() }, indication = Rk.indication(RoundedCornerShape(6.dp)), role = Role.Tab, onClick = onClick)
            .drawWithContent {
                drawContent()
                if (on) {
                    val h = 2.dp.toPx()
                    drawLine(line, Offset(0f, size.height - h / 2), Offset(size.width, size.height - h / 2), strokeWidth = h)
                }
            }
            .padding(horizontal = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (color != null) CategoryDot(color, size = 7.dp)
        Text(name, style = if (on) Rk.type.text12_5.semibold else Rk.type.text12_5.medium, color = if (on) c.text else c.text2, maxLines = 1)
        if (countLabel != null) {
            Box(
                Modifier
                    .heightIn(min = 16.dp)
                    .widthIn(min = 16.dp)
                    .background(c.chip, RoundedCornerShape(8.dp))
                    .padding(horizontal = 5.dp)
                    .semantics { contentDescription = countLabel },
                contentAlignment = Alignment.Center,
            ) {
                Text(unread.toString(), style = Rk.type.text11.medium.tabular, color = c.text2, maxLines = 1)
            }
        }
    }
}

/** Move to category as a bottom sheet (desktop's choiceDialog in moveToCategory): the category they share is checked. */
@Composable
fun CategorySheet(mailUi: MailUi) {
    val current = mailUi.categorizing?.second
    if (mailUi.categorizing == null) return
    val state = mailUi.categories?.state?.value ?: return
    RkBottomSheet(onDismissRequest = mailUi::closeCategoryPicker, title = stringResource(R.string.mailbox_categories_pick)) {
        val sheet = this
        Column(Modifier.verticalScroll(rememberScrollState())) {
            for (c in state.categories) {
                SheetRow(
                    label = c.name,
                    leading = { Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) { CategoryDot(c.color) } },
                    checked = c.id == current,
                    onClick = {
                        sheet.dismiss()
                        mailUi.moveToCategory(c.id)
                    },
                )
            }
        }
    }
}
