package nl.bvdm.rukoo.ui.icons

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp
import java.util.concurrent.ConcurrentHashMap

/** One SVG element of a line icon. A null width takes the icon's stroke width. */
internal class IconPart(val pathData: String, val fill: Boolean, val stroke: Boolean, val width: Float?)

/**
 * A desktop line icon: SVG path data on a 24 grid, drawn in `currentColor` with round caps and joins. The
 * vector is drawn in black and takes its color from the `tint` of `Icon` (or `RkIcon`), which is how
 * `currentColor` ports.
 */
internal class IconSpec(val strokeWidth: Float, val parts: List<IconPart>) {
    fun build(name: String, strokeWidth: Float = this.strokeWidth): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
            for (part in parts) {
                addPath(
                    pathData = addPathNodes(part.pathData),
                    fill = if (part.fill) Ink else null,
                    stroke = if (part.stroke) Ink else null,
                    strokeLineWidth = part.width ?: strokeWidth,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    private companion object {
        val Ink = SolidColor(Color.Black)
    }
}

internal class IconSpecBuilder {
    val parts = mutableListOf<IconPart>()

    fun path(d: String, fill: Boolean = false, stroke: Boolean = true, width: Float? = null) {
        parts += IconPart(d, fill, stroke, width)
    }

    fun circle(cx: Float, cy: Float, r: Float, fill: Boolean = false, stroke: Boolean = true, width: Float? = null) =
        path(circlePath(cx, cy, r), fill, stroke, width)

    fun rect(x: Float, y: Float, w: Float, h: Float, rx: Float = 0f, fill: Boolean = false, stroke: Boolean = true, width: Float? = null) =
        path(rectPath(x, y, w, h, rx), fill, stroke, width)
}

/** A built icon set with a cache per stroke width, so `named("x", 3f)` doesn't rebuild on every frame. */
internal class IconSet(private val specs: Map<String, IconSpec>, private val fallback: String?) {
    private val cache = ConcurrentHashMap<String, ImageVector>()

    val names: Set<String> get() = specs.keys

    fun has(name: String) = name in specs

    fun get(name: String, strokeWidth: Float? = null): ImageVector {
        val key = specs[name]?.let { name } ?: fallback ?: error("No icon named $name")
        val spec = specs.getValue(key)
        val width = strokeWidth ?: spec.strokeWidth
        return cache.getOrPut("$key@$width") { spec.build(key, width) }
    }
}

private fun f(v: Float): String = if (v == v.toLong().toFloat()) v.toLong().toString() else v.toString()

/** SVG `<circle>` as path data: two half arcs. */
internal fun circlePath(cx: Float, cy: Float, r: Float): String =
    "M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0z"

/** SVG `<ellipse>` as path data. */
internal fun ellipsePath(cx: Float, cy: Float, rx: Float, ry: Float): String =
    "M${f(cx - rx)} ${f(cy)}a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0z"

/** SVG `<rect>` with an optional corner radius as path data. */
internal fun rectPath(x: Float, y: Float, w: Float, h: Float, rx: Float = 0f): String {
    if (rx <= 0f) return "M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}z"
    val r = minOf(rx, w / 2, h / 2)
    return "M${f(x + r)} ${f(y)}h${f(w - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(r)}v${f(h - 2 * r)}" +
        "a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(r)}h${f(-(w - 2 * r))}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(-r)}" +
        "v${f(-(h - 2 * r))}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-r)}z"
}
