package nl.bvdm.rukoo.ui.chat

import androidx.compose.runtime.Composable
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.ChatSheet

/**
 * The host of Chat's sheets and dialogs (android.md "Sheets and dialogs"): RukooRoot calls it while
 * `NavState.chat.sheet` is set, with the room or member it is about as [target]. Each sheet is an RkBottomSheet on one
 * pane and the same content in a centered dialog capped at 480dp on [twoPane], and closes through
 * [AppViewModel.closeChatSheet]. Work package A9 draws the sheets here; until then the host draws nothing and Back
 * closes the sheet state.
 */
@Composable
fun ChatSheetHost(app: AppViewModel, sheet: ChatSheet, target: String?, twoPane: Boolean) {
}
