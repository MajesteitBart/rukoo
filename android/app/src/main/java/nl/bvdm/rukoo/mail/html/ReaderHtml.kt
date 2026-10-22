package nl.bvdm.rukoo.mail.html

import java.util.Locale
import nl.bvdm.rukoo.mail.model.FullMessage
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element

/**
 * The document the reader's WebView shows, ported from desktop's frameDoc and fillFrame
 * (src/renderer/mailframe.js, spec 4 §6.2). The WebView runs without JavaScript, so the two things
 * desktop measures at runtime are estimated from the markup here: the neutral canvas around a
 * newsletter (clearCanvas) and the zoom that fits wide mail to the window (fit, at least 0.8).
 *
 * The WebView must turn off its own algorithmic darkening, keep text zoom at 100 % and draw a
 * transparent background, or the colours below stack with Android's.
 */
object ReaderHtml {
    /** "Fit content to window" shrinks wide mail to no less than this (mailframe.js MIN_ZOOM). */
    const val MIN_ZOOM = 0.8

    fun document(m: FullMessage, light: Boolean, darkEmails: Boolean = true, availableWidth: Int? = null): String =
        document(m.html, m.isHtml, light, darkEmails, availableWidth)

    /**
     * [html] is the sanitized mail (FullMessage.html). [availableWidth] is the WebView's width in CSS
     * pixels (dp); with it, mail wider than that is zoomed out, down to [MIN_ZOOM].
     */
    fun document(html: String, isHtml: Boolean, light: Boolean, darkEmails: Boolean = true, availableWidth: Int? = null): String {
        val invert = !light && darkEmails && isHtml
        val textColor = if (light || invert) "#15171c" else "#e6e8ee"
        val link = if (invert) "#1a5fd0" else if (light) "#2f63c8" else "#8ab0ff"
        // Inverting #e2e3e8 and turning the hue back lands on the reader's dark panel colour. Images are turned back;
        // a canvas made transparent below is not one.
        val invertCss = if (invert) {
            "html{filter:invert(1) hue-rotate(180deg);background:#e2e3e8}\n" +
                "img,picture,video,svg,[style*=\"background-image\"]:not([data-rukoo-canvas]),[background]{filter:invert(1) hue-rotate(180deg)}\n"
        } else {
            ""
        }
        val scheme = if (light || invert) "light" else "dark"
        val doc = Jsoup.parse(html)
        doc.outputSettings().prettyPrint(false)
        if (isHtml) clearCanvas(doc)
        val zoom = if (isHtml && availableWidth != null) fitZoom(doc, availableWidth) else null
        val zoomCss = zoom?.let { "body{zoom:${String.format(Locale.ROOT, "%.3f", it)}}\n" } ?: ""
        val headStyles = doc.head().select("style, link[rel=stylesheet]").joinToString("") { it.outerHtml() }
        return "<!doctype html><html><head><meta charset=\"utf-8\">" +
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<style>\n" +
            "html{color-scheme:$scheme;color:$textColor;background:transparent;overflow-x:auto;-webkit-text-size-adjust:100%}\n" +
            "body{margin:0;padding:0 2px 8px;font:14.5px/1.6 system-ui,'Segoe UI',sans-serif;overflow-wrap:anywhere}\n" +
            "a{color:$link}\n" +
            "img{max-width:100%;height:auto}\n" +
            "pre{white-space:pre-wrap}\n" +
            "blockquote{border-left:3px solid rgba(128,128,128,.45);margin:0 0 0 2px;padding-left:12px}\n" +
            invertCss + zoomCss +
            "</style>" + headStyles + "</head><body" + MailHtml.bodyAttributes(doc.body()) + ">" +
            doc.body().html() + "</body></html>"
    }

    private val SKIP = setOf("style", "script", "meta", "link", "title")
    private val BLOCKS = setOf(
        "div", "table", "tbody", "thead", "tr", "td", "th", "center", "section", "main", "article", "header", "footer", "body", "font",
    )

    /**
     * Desktop's clearCanvas without layout: from the body down through single children that span the
     * width (no fixed pixel width), up to five levels, a light neutral background becomes transparent, so
     * a newsletter's grey canvas disappears and its card floats on the reader. Content colours stay.
     */
    internal fun clearCanvas(doc: Document) {
        var el: Element = doc.body()
        val chain = mutableListOf(el)
        for (depth in 0 until 5) {
            val kids = el.children().filter { it.normalName() !in SKIP }
            if (kids.size != 1 || !spansWidth(kids[0])) break
            el = kids[0]
            // add(), not +=: jsoup's Element is Iterable, which would add its descendants.
            chain.add(el)
        }
        for (node in chain) {
            val color = backgroundOf(node) ?: continue
            if (!neutral(color)) continue
            // Unless the canvas has a real image, keep it out of the rule that turns images back in dark mode,
            // or its text is inverted twice and stays dark.
            val style = node.attr("style")
            if (!style.contains("url(", ignoreCase = true) && !node.hasAttr("background")) node.attr("data-rukoo-canvas", "")
            node.attr("style", (if (style.isBlank()) "" else style.trimEnd().trimEnd(';') + ";") + "background-color:transparent !important")
            node.removeAttr("bgcolor")
        }
    }

    private fun spansWidth(el: Element): Boolean {
        if (el.normalName() !in BLOCKS) return false
        val width = el.attr("width").trim()
        if (width.isNotEmpty() && width != "100%") return false
        val styleWidth = styleValue(el.attr("style"), "width")
        return styleWidth == null || styleWidth.trim() == "100%" || styleWidth.trim() == "auto"
    }

    private fun styleValue(style: String, property: String): String? {
        var found: String? = null
        for (decl in style.split(';')) {
            val at = decl.indexOf(':')
            if (at < 0) continue
            if (decl.substring(0, at).trim().equals(property, ignoreCase = true)) found = decl.substring(at + 1).replace("!important", "").trim()
        }
        return found
    }

    /** The element's own background colour as RGBA, from bgcolor or its style. */
    internal fun backgroundOf(el: Element): IntArray? {
        val style = el.attr("style")
        styleValue(style, "background-color")?.let { parseColor(it)?.let { c -> return c } }
        styleValue(style, "background")?.let { bg ->
            // The shorthand: its colour is one of the space-separated parts (or an rgb() group).
            Regex("rgba?\\([^)]*\\)|#[0-9a-fA-F]{3,8}\\b|\\b[a-zA-Z]+\\b").findAll(bg).forEach { m -> parseColor(m.value)?.let { return it } }
        }
        return el.attr("bgcolor").takeIf { it.isNotBlank() }?.let(::parseColor)
    }

    private val NAMED = mapOf(
        "white" to intArrayOf(255, 255, 255, 255), "whitesmoke" to intArrayOf(245, 245, 245, 255),
        "snow" to intArrayOf(255, 250, 250, 255), "ghostwhite" to intArrayOf(248, 248, 255, 255),
        "gainsboro" to intArrayOf(220, 220, 220, 255), "lightgray" to intArrayOf(211, 211, 211, 255),
        "lightgrey" to intArrayOf(211, 211, 211, 255), "transparent" to intArrayOf(0, 0, 0, 0),
        "black" to intArrayOf(0, 0, 0, 255),
    )

    internal fun parseColor(value: String): IntArray? {
        val v = value.trim().lowercase()
        NAMED[v]?.let { return it }
        if (v.startsWith("#")) {
            val hex = v.substring(1)
            val full = when (hex.length) {
                3, 4 -> hex.map { "$it$it" }.joinToString("")
                6, 8 -> hex
                else -> return null
            }
            val n = full.chunked(2).map { it.toIntOrNull(16) ?: return null }
            return intArrayOf(n[0], n[1], n[2], if (n.size > 3) n[3] else 255)
        }
        val m = Regex("^rgba?\\(([^)]*)\\)$").find(v) ?: return null
        val parts = m.groupValues[1].split(Regex("[,\\s/]+")).filter { it.isNotEmpty() }
        if (parts.size < 3) return null
        val rgb = parts.take(3).map { p -> if (p.endsWith("%")) (p.dropLast(1).toDoubleOrNull()?.times(2.55)) else p.toDoubleOrNull() }
        if (rgb.any { it == null }) return null
        val alpha = parts.getOrNull(3)?.let { a -> if (a.endsWith("%")) a.dropLast(1).toDoubleOrNull()?.div(100) else a.toDoubleOrNull() } ?: 1.0
        return intArrayOf(rgb[0]!!.toInt(), rgb[1]!!.toInt(), rgb[2]!!.toInt(), (alpha * 255).toInt())
    }

    /** Light and grey: no channel under 225 and at most 14 apart (mailframe.js neutral). */
    private fun neutral(c: IntArray): Boolean {
        if (c[3] == 0) return false
        val min = minOf(c[0], c[1], c[2])
        val max = maxOf(c[0], c[1], c[2])
        return min >= 225 && max - min <= 14
    }

    /**
     * The zoom that fits the mail's widest fixed-width element (tables, cells, blocks; images shrink by
     * themselves) into [available], or null when it fits. Desktop measures the rendered scroll width;
     * without script this reads the widths the markup declares.
     */
    internal fun fitZoom(doc: Document, available: Int): Double? {
        var needed = 0
        for (el in doc.body().getAllElements()) {
            if (el.normalName() == "img") continue
            val attr = el.attr("width").trim().removeSuffix("px").toIntOrNull()
            val style = listOf("width", "min-width").mapNotNull { p ->
                styleValue(el.attr("style"), p)?.let { Regex("^(\\d+(?:\\.\\d+)?)px$").find(it.trim())?.groupValues?.get(1)?.toDoubleOrNull()?.toInt() }
            }.maxOrNull()
            needed = maxOf(needed, attr ?: 0, style ?: 0)
        }
        // The body's own side padding (2px each side) counts as desktop's scroll width does.
        needed += 4
        if (needed <= available + 4) return null
        return maxOf(MIN_ZOOM, available.toDouble() / needed)
    }
}
