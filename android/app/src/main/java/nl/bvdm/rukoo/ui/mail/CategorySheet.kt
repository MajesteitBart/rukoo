package nl.bvdm.rukoo.ui.mail

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.settings.CategoryDot

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
