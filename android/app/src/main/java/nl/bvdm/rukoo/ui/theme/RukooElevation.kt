// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine.
package nl.bvdm.rukoo.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp

/**
 * One elevation token: a 1dp ring plus blur layers, outermost first. CSS blur radii are used as the Compose
 * shadow radius. Light mode's six-layer stacks are cut to their largest, middle and smallest layer, which a
 * phone can't tell apart; the ring stays exact.
 */
@Immutable
class RkShadow(val ring: Color?, val layers: List<Shadow>)

private fun layer(y: Float, blur: Float, color: Color, spread: Float = 0f) =
    Shadow(radius = blur.dp, color = color, spread = spread.dp, offset = DpOffset(0.dp, y.dp))

private fun black(alpha: Float) = Color.Black.copy(alpha = alpha)
private fun navy(alpha: Float) = Color(0xFF141828).copy(alpha = alpha)
private fun white(alpha: Float) = Color.White.copy(alpha = alpha)

/**
 * The desktop's elevation tokens (spec 6 §2.7). The agent panel's family is a ring plus a blur
 * ([hairline] to [overlay]); the app chrome has [shadow] for menus and dialogs and [shadowSm] for secondary
 * buttons. Never use `Modifier.shadow(elevation)`: Android's tonal shadow is invisible in dark mode, which is
 * why the dark tokens lean on a white ring.
 */
@Immutable
class RukooElevation private constructor(
    val hairline: RkShadow,
    val btn: RkShadow,
    val card: RkShadow,
    val raised: RkShadow,
    val overlay: RkShadow,
    val shadow: RkShadow,
    val shadowSm: RkShadow,
    /** Recessed inputs: an inner shadow at the top (drawn by the field itself). */
    val insetField: Color,
) {
    /** Filled buttons (primary, accent) get a 1dp highlight on their top edge. */
    val filledHighlight: Color get() = white(0.14f)

    companion object {
        val Dark = RukooElevation(
            hairline = RkShadow(RukooColors.Dark.border, emptyList()),
            btn = RkShadow(white(0.10f), listOf(layer(1f, 2f, black(0.30f)))),
            card = RkShadow(white(0.11f), listOf(layer(2f, 6f, black(0.20f)), layer(1f, 2f, black(0.20f)))),
            raised = RkShadow(white(0.13f), listOf(layer(2f, 10f, black(0.22f)))),
            overlay = RkShadow(white(0.15f), listOf(layer(8f, 28f, black(0.34f)))),
            shadow = RkShadow(null, listOf(layer(12f, 32f, black(0.45f)), layer(2f, 6f, black(0.30f)))),
            shadowSm = RkShadow(white(0.04f), listOf(layer(1f, 2f, black(0.35f)))),
            insetField = black(0.40f),
        )

        val Light = RukooElevation(
            hairline = RkShadow(RukooColors.Light.border, emptyList()),
            btn = RkShadow(RukooColors.Light.borderStrong, listOf(layer(0f, 4f, Color(0x0A000000)))),
            card = RkShadow(
                RukooColors.Light.border,
                listOf(layer(18f, 47f, Color(0x08000000)), layer(4f, 10.5f, Color(0x05000000)), layer(1.2f, 3.1f, Color(0x03000000))),
            ),
            raised = RkShadow(
                RukooColors.Light.border,
                listOf(layer(17.54f, 23.39f, Color(0x0A000000)), layer(5.25f, 7f, Color(0x05000000)), layer(1.16f, 1.5f, Color(0x03000000))),
            ),
            overlay = RkShadow(
                RukooColors.Light.border,
                listOf(layer(25f, 50f, Color(0x0D000000)), layer(6f, 12f, Color(0x08000000)), layer(1.5f, 3f, Color(0x05000000))),
            ),
            shadow = RkShadow(null, listOf(layer(12f, 32f, navy(0.14f)), layer(2f, 6f, navy(0.06f)))),
            shadowSm = RkShadow(navy(0.06f), listOf(layer(1f, 2f, navy(0.07f)))),
            insetField = black(0.12f),
        )
    }
}

/** Only the blur layers of [shadow], drawn behind whatever comes next in the chain. */
fun Modifier.rkShadow(shadow: RkShadow, shape: Shape): Modifier =
    shadow.layers.fold(this) { m, layer -> m.dropShadow(shape, layer) }

/**
 * A raised surface: blur layers behind, the fill, then the ring on top, all in [shape]. The ring is drawn
 * inside the bounds as a 1dp border (spec 6 §2.7), so content padding already leaves room for it.
 */
fun Modifier.rkSurface(shadow: RkShadow?, shape: Shape, color: Color, clip: Boolean = true): Modifier {
    var m = if (shadow != null) rkShadow(shadow, shape) else this
    m = m.background(color, shape)
    if (shadow?.ring != null) m = m.border(1.dp, shadow.ring, shape)
    return if (clip) m.clip(shape) else m
}
