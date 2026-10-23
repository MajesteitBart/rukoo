package nl.bvdm.rukoo.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.unit.dp

/**
 * A 4dp grid with 2dp half steps inside small controls (tokens.md "Spacing"). Desktop px map to dp one to
 * one for spacing, radii, borders and icons (spec 6 §2.6).
 */
@Immutable
class RukooSpacing internal constructor() {
    val s2 = 2.dp
    val s4 = 4.dp
    val s6 = 6.dp
    val s8 = 8.dp
    val s10 = 10.dp
    val s12 = 12.dp
    val s14 = 14.dp
    val s16 = 16.dp
    val s20 = 20.dp
    val s24 = 24.dp
    val s32 = 32.dp

    /** Card body padding. */
    val card = 12.dp

    /** Gap between transcript items in the chat. */
    val transcriptGap = 14.dp

    /** Settings rows and pages: horizontal inset. */
    val row = 16.dp

    companion object {
        val Default = RukooSpacing()
    }
}

/**
 * Control heights. Visual sizes stay the desktop's (32, 28, 24, 22), plus 4dp where a control is the main tap
 * target; every tappable thing still gets a 48dp touch target through `minimumInteractiveComponentSize()`.
 */
object RukooSizes {
    val touch = 48.dp
    val control = 32.dp
    val controlLarge = 36.dp
    val small = 28.dp
    val chip = 24.dp
    val xs = 22.dp
    val topBar = 56.dp
    val listTopBar = 64.dp
    val bottomBar = 56.dp
    val sheetRow = 48.dp
    val hairline = 1.dp
}
