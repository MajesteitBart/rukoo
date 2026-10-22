package nl.bvdm.rukoo.ui.reader

import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element

/**
 * The document the reader's WebView shows, ported from desktop's mailframe.js (frameDoc and clearCanvas).
 * The WebView runs without JavaScript, so what desktop does with script after the frame loads happens
 * here, on the parsed HTML: grey newsletter canvases become transparent and a light pass removes what a
 * script-free page could still act on (forms, frames, meta refreshes).
 */
object MailFrame {
    private data class Key(val html: String, val isHtml: Boolean, val light: Boolean, val darkEmails: Boolean)

    // The reader leaves the screen whenever the composer or the chat takes it, and comes back with a new
    // WebView; the last few documents are kept so coming back doesn't parse the mail again.
    private val recent = object : LinkedHashMap<Key, String>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Key, String>?) = size > 6
    }

    /** A document [document] made before for the same mail and theme, or null. */
    fun cached(html: String, isHtml: Boolean, light: Boolean, darkEmails: Boolean): String? =
        synchronized(recent) { recent[Key(html, isHtml, light, darkEmails)] }

    /** [document], remembered for [cached]. */
    fun documentCached(html: String, isHtml: Boolean, light: Boolean, darkEmails: Boolean): String {
        cached(html, isHtml, light, darkEmails)?.let { return it }
        val doc = document(html, isHtml, light, darkEmails)
        synchronized(recent) { recent[Key(html, isHtml, light, darkEmails)] = doc }
        return doc
    }

    /**
     * [light] is the app theme; [darkEmails] the setting. Dark theme plus dark emails inverts HTML mail and
     * turns images back, so a light newsletter reads dark with its hues intact (mailframe.js:4-33).
     * [isHtml] false is plain-text mail, which only gets the dark text color.
     */
    fun document(html: String, isHtml: Boolean, light: Boolean, darkEmails: Boolean): String {
        val invert = !light && darkEmails && isHtml
        val textColor = if (light || invert) "#15171c" else "#e6e8ee"
        val link = if (invert) "#1a5fd0" else if (light) "#2f63c8" else "#8ab0ff"
        // Desktop filters the html element. The Android WebView paints the root's background as a canvas the
        // filter doesn't reach, and paints it past the view's own edges, so here the mail sits in a wrapper
        // that carries the filter and the background, and the page canvas stays transparent.
        val invertCss = if (invert) {
            "[data-rukoo-mail]{filter:invert(1) hue-rotate(180deg);background:#e2e3e8}\n" +
                "img,picture,video,svg,[style*=\"background-image\"]:not([data-rukoo-canvas]),[background]{filter:invert(1) hue-rotate(180deg)}"
        } else {
            ""
        }
        val scheme = if (light || invert) "light" else "dark"
        // width=device-width without an initial scale: mail wider than the phone is zoomed out to fit
        // (the WebView's overview mode), which stands in for desktop's "fit content to window".
        val doc = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
html,body{background:transparent}
html{color-scheme:$scheme}
body{margin:0;padding:0 2px 8px;font:14.5px/1.6 'Segoe UI',system-ui,sans-serif;overflow-wrap:anywhere}
[data-rukoo-mail]{color:$textColor}
a{color:$link}
img{max-width:100%;height:auto}
pre{white-space:pre-wrap}
blockquote{border-left:3px solid rgba(128,128,128,.45);margin:0 0 0 2px;padding-left:12px}
$invertCss
</style></head><body><div data-rukoo-mail>$html</div></body></html>"""
        val parsed = Jsoup.parse(doc)
        val wrapper = parsed.selectFirst("[data-rukoo-mail]") ?: parsed.body()
        liftBody(parsed.body(), wrapper)
        defuse(parsed)
        // Clearing the canvas is cosmetic; mail it can't make sense of keeps its own colours.
        if (isHtml) runCatching { clearCanvas(wrapper) }
        return parsed.outerHtml()
    }

    /**
     * The frame without any parsing, for mail [document] fails on. The WebView still runs it without
     * JavaScript, file or content access, and links still leave through the reader's link handler.
     */
    fun unprocessed(html: String, light: Boolean): String {
        val textColor = if (light) "#15171c" else "#e6e8ee"
        return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">" +
            "<style>html,body{background:transparent}body{margin:0;padding:0 2px 8px;color:$textColor;" +
            "font:14.5px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>$html</body></html>"
    }

    /**
     * The mail's own `<body>` attributes merge into the frame's body when it is parsed. A body background
     * would become the page canvas again, so they move to the wrapper, as CSS (a div knows no bgcolor).
     */
    private fun liftBody(body: Element, wrapper: Element) {
        val css = StringBuilder()
        body.attr("bgcolor").takeIf { it.isNotBlank() }?.let { css.append("background-color:").append(it.trim()).append(';') }
        body.attr("text").takeIf { it.isNotBlank() }?.let { css.append("color:").append(it.trim()).append(';') }
        body.attr("background").takeIf { it.isNotBlank() && !it.contains('"') }?.let { css.append("background-image:url(\"").append(it.trim()).append("\");") }
        body.attr("style").takeIf { it.isNotBlank() }?.let { css.append(it.trim().trimEnd(';')).append(';') }
        if (css.isNotEmpty()) wrapper.attr("style", css.toString())
        for (key in body.attributes().asList().map { it.key }) body.removeAttr(key)
    }

    // What a page without script can still do: submit forms, load frames, refresh itself. JavaScript is
    // off in the WebView; this keeps the rest out as well (desktop's sanitizeHtml, mailutil.js:184-192).
    private fun defuse(doc: Document) {
        doc.select("script, iframe, object, embed, frame, frameset, applet, base, meta[http-equiv]").remove()
        doc.select("form").unwrap()
        for (el in doc.getAllElements()) {
            val names = el.attributes().asList().map { it.key }
            for (name in names) {
                val lower = name.lowercase()
                if (lower.startsWith("on")) el.removeAttr(name)
                if (lower == "href" || lower == "src" || lower == "action") {
                    val value = el.attr(name).trim().lowercase()
                    if (value.startsWith("javascript:") || value.startsWith("vbscript:")) el.attr(name, "#")
                }
            }
        }
    }

    private val SKIP = setOf("style", "script", "meta", "link", "title")

    /**
     * Desktop's clearCanvas without layout: walk down from the mail's top ([root], where its body's
     * attributes now are) through single children that span the page (no width, or 100%), at most five
     * deep; each with a neutral light background loses it.
     */
    fun clearCanvas(root: Element) {
        val chain = mutableListOf(root)
        var el: Element = root
        for (depth in 0 until 5) {
            val kids = el.children().filter { it.tagName().lowercase() !in SKIP }
            if (kids.size != 1 || !spans(kids[0])) break
            el = kids[0]
            chain.add(el)
        }
        for (node in chain) {
            val color = backgroundOf(node) ?: continue
            if (!neutral(color)) continue
            val style = node.attr("style")
            if (!style.contains("url(", ignoreCase = true)) node.attr("data-rukoo-canvas", "")
            node.attr("style", (if (style.isBlank()) "" else style.trimEnd().trimEnd(';') + ";") + "background-color:transparent !important")
            node.removeAttr("bgcolor")
        }
    }

    private val WIDTH_STYLE = Regex("(?:^|;)\\s*width\\s*:\\s*([^;]+)", RegexOption.IGNORE_CASE)

    // Without layout, "spans the page" means a width of 100%, or no width on a block (a table without one
    // shrinks to its content; its body, row and single cell span the table).
    private fun spans(el: Element): Boolean {
        val width = (WIDTH_STYLE.find(el.attr("style"))?.groupValues?.get(1) ?: el.attr("width")).trim()
        if (width.isNotEmpty()) return width.replace(" ", "").startsWith("100%")
        return el.tagName().lowercase() != "table"
    }

    private val BG_STYLE = Regex("(?:^|;)\\s*background(?:-color)?\\s*:\\s*([^;]+)", RegexOption.IGNORE_CASE)

    private fun backgroundOf(el: Element): IntArray? {
        val style = BG_STYLE.findAll(el.attr("style")).lastOrNull()?.groupValues?.get(1)
        return style?.let(::parseColor) ?: el.attr("bgcolor").takeIf { it.isNotBlank() }?.let(::parseColor)
    }

    private val HEX = Regex("#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\\b")
    private val RGB = Regex("rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*(?:,\\s*([\\d.]+)\\s*)?\\)", RegexOption.IGNORE_CASE)

    /** The first color in a CSS value: #rgb, #rrggbb, rgb()/rgba(), or white. Null when there is none. */
    internal fun parseColor(value: String): IntArray? {
        HEX.find(value)?.let { m ->
            val h = m.groupValues[1]
            val full = if (h.length == 3) h.map { "$it$it" }.joinToString("") else h
            return intArrayOf(full.substring(0, 2).toInt(16), full.substring(2, 4).toInt(16), full.substring(4, 6).toInt(16), 255)
        }
        RGB.find(value)?.let { m ->
            // Mail is untrusted: a channel like 999999999999 is no colour, not a crash.
            fun channel(s: String) = s.toIntOrNull()?.takeIf { it in 0..255 }
            val r = channel(m.groupValues[1]) ?: return null
            val g = channel(m.groupValues[2]) ?: return null
            val b = channel(m.groupValues[3]) ?: return null
            val alpha = if (m.groupValues[4].isEmpty()) 255 else m.groupValues[4].toFloatOrNull()?.coerceIn(0f, 1f)?.let { (it * 255).toInt() } ?: return null
            return intArrayOf(r, g, b, alpha)
        }
        if (Regex("\\bwhite\\b", RegexOption.IGNORE_CASE).containsMatchIn(value)) return intArrayOf(255, 255, 255, 255)
        return null
    }

    /** Light and grey: every channel at least 225, spread at most 14, not transparent. */
    internal fun neutral(c: IntArray): Boolean {
        if (c[3] == 0) return false
        val min = minOf(c[0], c[1], c[2])
        val max = maxOf(c[0], c[1], c[2])
        return min >= 225 && max - min <= 14
    }
}

/** A file-type tile's kind and label (app.js attachmentKind). */
data class AttachmentKind(val label: String, val kind: String)

object Attachments {
    private val KINDS = mapOf(
        "pdf" to "pdf",
        "doc" to "doc", "docx" to "doc", "odt" to "doc", "rtf" to "doc", "txt" to "doc",
        "xls" to "sheet", "xlsx" to "sheet", "csv" to "sheet", "ods" to "sheet",
        "ppt" to "slides", "pptx" to "slides", "key" to "slides",
        "png" to "image", "jpg" to "image", "jpeg" to "image", "gif" to "image", "webp" to "image", "heic" to "image", "svg" to "image",
        "zip" to "archive", "rar" to "archive", "7z" to "archive", "gz" to "archive",
        "ics" to "cal", "eml" to "mail", "msg" to "mail",
    )

    fun kindOf(name: String): AttachmentKind {
        val ext = Regex("\\.([a-z0-9]{1,5})$", RegexOption.IGNORE_CASE).find(name)?.groupValues?.get(1)?.lowercase().orEmpty()
        return AttachmentKind(if (ext.isEmpty()) "FILE" else ext.uppercase().take(4), KINDS[ext] ?: "other")
    }

    // Desktop's RISKY list (files.js:7) plus Android's own installers: these are shared, never opened from mail.
    private val RISKY = Regex(
        "\\.(apk|apks|xapk|aab|dex|dmg|pkg|mpkg|command|tool|terminal|scpt|scptd|applescript|workflow|app|prefpane|fileloc|inetloc|webloc|" +
            "exe|bat|cmd|com|scr|pif|lnk|url|hta|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|psd1|msi|msp|mst|reg|cpl|jar|appref-ms|application|gadget|" +
            "inf|scf|sct|chm|iso|img|vhd|vhdx|msc|xll|library-ms|settingcontent-ms|sh|bash|zsh|fish|ksh|csh|desktop|appimage|run)$",
        RegexOption.IGNORE_CASE,
    )

    fun isRisky(name: String): Boolean = RISKY.containsMatchIn(name.trim())

    /** The MIME type to hand another app: the part's own unless it is generic, else one guessed from the name. */
    fun viewType(name: String, contentType: String): String {
        val own = contentType.substringBefore(';').trim().lowercase()
        if (own.isNotEmpty() && own != "application/octet-stream") return own
        return when (kindOf(name).label.lowercase()) {
            "pdf" -> "application/pdf"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "txt" -> "text/plain"
            "csv" -> "text/csv"
            "ics" -> "text/calendar"
            "doc" -> "application/msword"
            "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            "xls" -> "application/vnd.ms-excel"
            "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            "ppt" -> "application/vnd.ms-powerpoint"
            "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            "zip" -> "application/zip"
            "eml" -> "message/rfc822"
            else -> "application/octet-stream"
        }
    }
}
