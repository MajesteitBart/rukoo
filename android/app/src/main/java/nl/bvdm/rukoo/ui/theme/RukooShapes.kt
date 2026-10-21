package nl.bvdm.rukoo.ui.theme

import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Immutable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Radii by role (tokens.md "Radii"). Corners nest: an inner shape takes the outer radius minus the inset,
 * which is where odd values like 5, 7 and 9 come from; use [nested] for those.
 */
@Immutable
class RukooShapes internal constructor() {
    /** 6: chips, menu rows, xs icon buttons. */
    val chip = RoundedCornerShape(Radius.chip)

    /** 8: controls, buttons, inputs, icon buttons. */
    val control = RoundedCornerShape(Radius.control)

    /** 10: cards and menus. */
    val card = RoundedCornerShape(Radius.card)

    /** 12: large panels, settings cards. */
    val panel = RoundedCornerShape(Radius.panel)

    /** 14: windows, dialogs, the chat input box. */
    val window = RoundedCornerShape(Radius.window)

    /** Bottom sheets: the window radius on the top corners only. */
    val sheet = RoundedCornerShape(topStart = Radius.window, topEnd = Radius.window)

    /** Pills: panel buttons, status pills, entity chips, segmented controls, toggles. */
    val pill = RoundedCornerShape(50)

    /** Avatars and dots. */
    val circle = CircleShape

    /** The concentric inner radius: outer minus inset. */
    fun nested(outer: Dp, inset: Dp) = RoundedCornerShape((outer - inset).coerceAtLeast(0.dp))

    companion object {
        val Default = RukooShapes()
    }
}

object Radius {
    val chip = 6.dp
    val control = 8.dp
    val card = 10.dp
    val panel = 12.dp
    val window = 14.dp
}
