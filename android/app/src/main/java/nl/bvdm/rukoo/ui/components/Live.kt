// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine.
package nl.bvdm.rukoo.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooDurations
import nl.bvdm.rukoo.ui.theme.medium

/**
 * The working label (bui.js `shimmer`): a highlight sweeps left to right across the text every [periodMs]
 * (1.8s; the thinking and loading labels use 1.4s). Only live work moves. With reduced motion the text is
 * a still `ink2`.
 *
 * The gradient is applied in the draw phase over the laid-out text, so the sweep redraws without
 * recomposing.
 */
@Composable
fun ShimmerText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = Rk.type.panelBody.medium,
    periodMs: Int = RukooDurations.SHIMMER,
) {
    val c = Rk.colors
    if (Rk.motion.reduced) {
        Text(text, modifier, style = style, color = c.ink2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        return
    }
    val t = rememberInfiniteTransition(label = "shimmer").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(periodMs, easing = LinearEasing)),
        label = "shimmer",
    )
    val dim = c.ink3
    val bright = c.ink
    Text(
        text,
        modifier
            .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
            .drawWithContent {
                drawContent()
                // CSS: a 200%-wide gradient (ink3 35%, ink 50%, ink3 65%) whose position runs 150% → -50%.
                val w = size.width
                val start = -1.5f * w + 2f * w * t.value
                drawRect(
                    brush = Brush.horizontalGradient(
                        0f to dim, 0.35f to dim, 0.5f to bright, 0.65f to dim, 1f to dim,
                        startX = start,
                        endX = start + 2f * w,
                    ),
                    blendMode = BlendMode.SrcIn,
                )
            },
        style = style,
        color = c.ink3,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/**
 * The panel spinner (`.bui-spin`): a 1.5dp ring in `lineStrong` with its top quarter in `ink2`, turning
 * every 700ms. With reduced motion the ring stands still.
 */
@Composable
fun Spinner(
    modifier: Modifier = Modifier,
    size: Dp = 12.dp,
    color: Color = Rk.colors.ink2,
    track: Color = Rk.colors.lineStrong,
    strokeWidth: Dp = 1.5.dp,
) {
    val angle: State<Float>? = if (Rk.motion.reduced) null else rememberInfiniteTransition(label = "spin").animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(RukooDurations.SPINNER, easing = LinearEasing)),
        label = "spin",
    )
    Canvas(modifier.size(size)) {
        val w = strokeWidth.toPx()
        val inset = w / 2
        val arcSize = Size(this.size.width - w, this.size.height - w)
        rotate(angle?.value ?: 0f) {
            drawArc(track, 0f, 360f, false, Offset(inset, inset), arcSize, style = Stroke(w))
            // A CSS border-top colors the quarter between the diagonals: from 225° to 315°.
            drawArc(color, 225f, 90f, false, Offset(inset, inset), arcSize, style = Stroke(w, cap = StrokeCap.Butt))
        }
    }
}

/**
 * The pixel loader (bui.js `loadingState`): a 3x3 grid of 4dp cells blinking 0.15 → 1 → 0.15 over 650ms,
 * each delayed by `((i % 3) + |i / 3 - 1|) * 90ms`. With reduced motion the cells are still and solid.
 */
@Composable
fun PixelLoader(modifier: Modifier = Modifier, color: Color = Rk.colors.ink) {
    val reduced = Rk.motion.reduced
    val t: State<Float>? = if (reduced) null else rememberInfiniteTransition(label = "pixels").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(650, easing = LinearEasing), RepeatMode.Restart),
        label = "pixels",
    )
    Canvas(modifier.size(15.dp)) {
        val cell = 4.dp.toPx()
        val gap = 1.5.dp.toPx()
        for (i in 0 until 9) {
            val alpha = if (t == null) 1f else {
                val delay = ((i % 3) + abs(i / 3 - 1)) * 90f / 650f
                pixelOpacity(((t.value - delay) % 1f + 1f) % 1f)
            }
            drawRoundRect(
                color = color,
                topLeft = Offset((i % 3) * (cell + gap), (i / 3) * (cell + gap)),
                size = Size(cell, cell),
                cornerRadius = CornerRadius(1.dp.toPx()),
                alpha = alpha,
            )
        }
    }
}

/** `bui-pixel-on`: 0.15 rising to 1 at 18%, held to 42%, back to 0.15 at 62%, then resting. */
internal fun pixelOpacity(p: Float): Float = when {
    p < 0.18f -> 0.15f + (1f - 0.15f) * (p / 0.18f)
    p < 0.42f -> 1f
    p < 0.62f -> 1f - (1f - 0.15f) * ((p - 0.42f) / 0.2f)
    else -> 0.15f
}
