package nl.bvdm.rukoo.ui.icons

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * Full-color provider tiles for account setup, ported from `providerLogos` in `src/renderer/icons.js` (a 48
 * grid, drawn at 56 on desktop). Draw them with `Image`, not `Icon`, so their colors stay.
 */
object ProviderLogos {
    private class LogoBuilder(name: String) {
        val builder = ImageVector.Builder(name, 56.dp, 56.dp, 48f, 48f)

        fun part(d: String, fill: Long? = null, stroke: Long? = null, width: Float = 1f) {
            builder.addPath(
                pathData = addPathNodes(d),
                fill = fill?.let { SolidColor(Color(it)) },
                stroke = stroke?.let { SolidColor(Color(it)) },
                strokeLineWidth = width,
            )
        }
    }

    private fun logo(name: String, block: LogoBuilder.() -> Unit): ImageVector = LogoBuilder(name).apply(block).builder.build()

    val Google: ImageVector by lazy {
        logo("google") {
            part("M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z", fill = 0xFFEA4335)
            part("M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 2.9-2.2 5.4-4.7 7.1l7.6 5.9c4.4-4.1 6.9-10.1 6.9-17.5z", fill = 0xFF4285F4)
            part("M10.6 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A23.9 23.9 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7z", fill = 0xFFFBBC05)
            part("M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.2 0-11.5-4.2-13.4-9.9l-8 6.1C6.6 42.6 14.6 48 24 48z", fill = 0xFF34A853)
        }
    }

    val Yahoo: ImageVector by lazy {
        logo("yahoo") {
            part(rectPath(5f, 10f, 38f, 28f, 3f), fill = 0xFF4B0099)
            part("m6 13 18 13 18-13", stroke = 0xFFFFFFFF, width = 3.5f)
        }
    }

    val Outlook: ImageVector by lazy {
        logo("outlook") {
            part(rectPath(20f, 11f, 22f, 26f, 2f), stroke = 0xFF1D72C6, width = 2.4f)
            part("m21 14 10 8 10-8", stroke = 0xFF1D72C6, width = 2.4f)
            part("M4 9.5 25 5v38L4 38.5z", fill = 0xFF1D72C6)
            part(ellipsePath(14.5f, 24f, 5f, 6.5f), stroke = 0xFFFFFFFF, width = 3f)
        }
    }

    val Exchange: ImageVector by lazy {
        logo("exchange") {
            part("M4 9 25 5v38L4 39z", fill = 0xFF1D72C6)
            part("M10 16h9M10 24h8M10 32h9M10 16v16", stroke = 0xFFFFFFFF, width = 3f)
            part(rectPath(26f, 11f, 17f, 26f, 2f), fill = 0xFF2F8AE0)
            part("m29 17 10 14M39 17 29 31M31 15h7M31 33h7", stroke = 0xFFFFFFFF, width = 2f)
        }
    }

    val Office365: ImageVector by lazy {
        logo("office365") {
            part("M8 11 30 4l10 4v32l-10 4-22-7 22 3V10l-15 4v18l-7 3z", fill = 0xFFEB3C00)
        }
    }

    val Other: ImageVector by lazy {
        logo("other") {
            part(rectPath(6f, 11f, 36f, 26f, 2f), stroke = 0xFF9A9A9A, width = 3f)
            part("m7 12 17 13 17-13", stroke = 0xFF9A9A9A, width = 3f)
        }
    }

    val Demo: ImageVector by lazy {
        logo("demo") {
            part(circlePath(24f, 24f, 20f), fill = 0xFF2FD6C0)
            part("M14 18h20v13H14z", stroke = 0xFF04332D, width = 2.6f)
            part("m15 19 9 7 9-7", stroke = 0xFF04332D, width = 2.6f)
        }
    }

    /** The tile for a provider id from account setup; `other` for anything unknown. */
    fun forProvider(id: String?): ImageVector = when (id) {
        "google" -> Google
        "yahoo" -> Yahoo
        "outlook" -> Outlook
        "exchange" -> Exchange
        "office365" -> Office365
        "demo" -> Demo
        else -> Other
    }
}
