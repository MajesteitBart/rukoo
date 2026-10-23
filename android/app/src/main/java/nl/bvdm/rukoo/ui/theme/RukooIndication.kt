package nl.bvdm.rukoo.ui.theme

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.IndicationNodeFactory
import androidx.compose.foundation.interaction.FocusInteraction
import androidx.compose.foundation.interaction.HoverInteraction
import androidx.compose.foundation.interaction.Interaction
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.node.DelegatableNode
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * Rukoo's press feedback instead of Material's ripple (spec 6 §4.0): pressed surfaces fill with `active`,
 * hovered ones (mouse, DeX) with `hover`, and keyboard focus draws a 2dp `focus` ring inset by 1dp. The fill
 * appears at once and fades out over 120ms, like `:active` with a 120ms transition.
 *
 * Provided as `LocalIndication` by [RukooTheme] with a rectangle; components clip to their shape first, or
 * pass their shape through [Rk.indication] so the focus ring follows the corners.
 */
class RukooIndication(
    private val pressed: Color,
    private val hovered: Color,
    private val focus: Color,
    private val shape: Shape = RectangleShape,
) : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode =
        RukooIndicationNode(interactionSource, pressed, hovered, focus, shape)

    override fun equals(other: Any?): Boolean =
        other is RukooIndication && other.pressed == pressed && other.hovered == hovered &&
            other.focus == focus && other.shape == shape

    override fun hashCode(): Int = ((pressed.hashCode() * 31 + hovered.hashCode()) * 31 + focus.hashCode()) * 31 + shape.hashCode()
}

private class RukooIndicationNode(
    private val source: InteractionSource,
    private val pressed: Color,
    private val hovered: Color,
    private val focus: Color,
    private val shape: Shape,
) : Modifier.Node(), DrawModifierNode {
    private val pressAlpha = Animatable(0f)
    private val hoverAlpha = Animatable(0f)
    private var focused = false

    override fun onAttach() {
        coroutineScope.launch {
            val presses = mutableListOf<PressInteraction.Press>()
            val hovers = mutableListOf<HoverInteraction.Enter>()
            val focuses = mutableListOf<FocusInteraction.Focus>()
            source.interactions.collect { interaction: Interaction ->
                when (interaction) {
                    is PressInteraction.Press -> presses += interaction
                    is PressInteraction.Release -> presses -= interaction.press
                    is PressInteraction.Cancel -> presses -= interaction.press
                    is HoverInteraction.Enter -> hovers += interaction
                    is HoverInteraction.Exit -> hovers -= interaction.enter
                    is FocusInteraction.Focus -> focuses += interaction
                    is FocusInteraction.Unfocus -> focuses -= interaction.focus
                }
                launch { if (presses.isNotEmpty()) pressAlpha.snapTo(1f) else pressAlpha.animateTo(0f, tween(120)) }
                launch { hoverAlpha.animateTo(if (hovers.isNotEmpty()) 1f else 0f, tween(120)) }
                if (focused != focuses.isNotEmpty()) {
                    focused = focuses.isNotEmpty()
                    invalidateDraw()
                }
            }
        }
    }

    override fun ContentDrawScope.draw() {
        val outline = shape.createOutline(size, layoutDirection, this)
        if (hoverAlpha.value > 0f) drawOutline(outline, hovered, alpha = hoverAlpha.value)
        if (pressAlpha.value > 0f) drawOutline(outline, pressed, alpha = pressAlpha.value)
        drawContent()
        if (focused) {
            val inset = 2.dp.toPx()
            val ring = shape.createOutline(Size(size.width - inset, size.height - inset), layoutDirection, this)
            translate(inset / 2, inset / 2) { drawOutline(ring, focus, style = Stroke(2.dp.toPx())) }
        }
    }
}
