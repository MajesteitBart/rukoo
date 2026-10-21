package nl.bvdm.rukoo.ui.icons

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/** Effort levels on the dial (panel.js `METER`); unknown efforts have no level and show only the centre. */
object EffortLevels {
    private val meter = mapOf(
        "minimal" to 0f,
        "low" to 0.15f,
        "medium" to 0.35f,
        "high" to 0.55f,
        "xhigh" to 0.75f,
        "max" to 0.9f,
        "ultra" to 1f,
    )

    fun levelOf(effort: String?): Float? = effort?.lowercase()?.let { meter[it] }
}

/**
 * The effort dial (bui.js `gauge`): an upper half circle of radius 8.5 around (12, 17) on a 24 grid, stroke 2,
 * with a needle from 0 (left) to 1 (right). Without a level only the centre dot shows, as while the agent
 * decides the effort itself.
 */
@Composable
fun Gauge(level: Float?, modifier: Modifier = Modifier, size: Dp = 13.dp, color: Color = LocalContentColor.current) {
    Canvas(modifier.size(size)) {
        val unit = this.size.minDimension / 24f
        val stroke = 2f * unit
        val cx = 12f * unit
        val cy = 17f * unit
        val r = 8.5f * unit
        drawArc(
            color = color,
            startAngle = 180f,
            sweepAngle = 180f,
            useCenter = false,
            topLeft = Offset(cx - r, cy - r),
            size = Size(2 * r, 2 * r),
            style = Stroke(stroke, cap = StrokeCap.Round),
        )
        if (level == null || level.isNaN()) {
            drawCircle(color, radius = 1.3f * unit, center = Offset(cx, cy))
        } else {
            val a = PI * (1 - level.coerceIn(0f, 1f))
            val end = Offset(cx + 6.5f * unit * cos(a).toFloat(), cy - 6.5f * unit * sin(a).toFloat())
            drawLine(color, Offset(cx, cy), end, strokeWidth = stroke, cap = StrokeCap.Round)
        }
    }
}
