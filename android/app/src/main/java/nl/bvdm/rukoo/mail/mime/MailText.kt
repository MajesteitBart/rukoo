package nl.bvdm.rukoo.mail.mime

import java.nio.charset.Charset
import java.util.Base64
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode
import org.jsoup.select.NodeFilter
import org.jsoup.select.NodeTraversor

/** Text helpers ported from desktop's mailutil.js (spec 4 §2.7, §6.1). */
object MailText {
    /** JavaScript's `\s`, which Java's `\s` doesn't fully cover (no-break and other Unicode spaces). */
    private const val JS_SPACE = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    private val SPACES = Regex("[$JS_SPACE]+")
    private val INVISIBLE = Regex("[\\u00A0\\u200C\\u200B\\u034F\\uFEFF]")
    private val URL = Regex("(https?://[^\\s<]+[^\\s<.,;:!?)\\]'\"])")

    /** How many elements deep [htmlToPlain] keeps the layout; the same limit as signatures. */
    private const val MAX_DEPTH = 100

    /** Elements [htmlToPlain] leaves out with everything in them. */
    private val SKIP = setOf("img", "style", "script", "head", "title", "meta", "link", "template", "noscript")

    /** Desktop's escapeHtml: `& < > "`. */
    fun escapeHtml(text: String): String =
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    /** The renderer's esc(), which also escapes `'`; used where desktop builds HTML in the renderer. */
    fun esc(text: String): String = escapeHtml(text).replace("'", "&#39;")

    /** JavaScript's String.prototype.trim. */
    fun jsTrim(text: String): String = text.trim { it.isWhitespace() || it == ' ' || it == '﻿' }

    /** Plain mail shown as HTML: escaped, links made clickable, line breaks kept (mailutil.js textToHtml). */
    fun textToHtml(text: String): String {
        val linked = URL.replace(escapeHtml(text)) { "<a href=\"${it.value}\">${it.value}</a>" }
        return "<div style=\"white-space:pre-wrap;word-wrap:break-word\">$linked</div>"
    }

    /** The first [max] characters of text as one line, invisible spacers removed (mailutil.js makePreview). */
    fun makePreview(text: String, max: Int = 200): String {
        val flat = jsTrim(SPACES.replace(INVISIBLE.replace(text, " "), " "))
        return if (flat.length <= max) flat else flat.substring(0, max)
    }

    /**
     * HTML as readable text, like html-to-text with desktop's options: no word wrap, links without their
     * address, images, styles, scripts and the head left out, headings as they are, and table cells on
     * lines of their own so a signature's name and phone number don't run together.
     */
    fun htmlToPlain(html: String): String {
        if (html.isBlank()) return ""
        return try {
            PlainWriter().apply { walk(Jsoup.parse(html).body()) }.result()
        } catch (e: Exception) {
            // A preview is never worth failing a sync over; strip tags instead.
            html.replace(Regex("<(style|script|head)[\\s\\S]*?</\\1>", RegexOption.IGNORE_CASE), " ")
                .replace(Regex("<[^>]+>"), " ")
                .replace("&nbsp;", " ")
        }
    }

    /** Undoes a Content-Transfer-Encoding on (possibly cut-off) bytes (mailutil.js decodeTransfer). */
    fun decodeTransfer(bytes: ByteArray, encoding: String?): ByteArray = when (encoding?.lowercase()) {
        "base64" -> {
            // Partial fetches can cut a base64 group in half; drop the incomplete tail.
            val clean = String(bytes, Charsets.US_ASCII).replace(Regex("[^A-Za-z0-9+/=]"), "")
            val cut = clean.substring(0, clean.length - clean.length % 4)
            runCatching { Base64.getMimeDecoder().decode(cut) }.getOrElse { ByteArray(0) }
        }
        "quoted-printable" -> decodeQuotedPrintable(bytes)
        else -> bytes
    }

    fun decodeQuotedPrintable(bytes: ByteArray): ByteArray {
        val out = java.io.ByteArrayOutputStream(bytes.size)
        var i = 0
        while (i < bytes.size) {
            val b = bytes[i].toInt() and 0xff
            if (b != '='.code) {
                out.write(b)
                i++
                continue
            }
            // Soft line break: "=" at the end of a line.
            if (i + 1 < bytes.size && (bytes[i + 1] == '\r'.code.toByte() || bytes[i + 1] == '\n'.code.toByte())) {
                i += if (i + 2 < bytes.size && bytes[i + 1] == '\r'.code.toByte() && bytes[i + 2] == '\n'.code.toByte()) 3 else 2
                continue
            }
            val hi = if (i + 1 < bytes.size) Character.digit(bytes[i + 1].toInt(), 16) else -1
            val lo = if (i + 2 < bytes.size) Character.digit(bytes[i + 2].toInt(), 16) else -1
            if (hi >= 0 && lo >= 0) {
                out.write((hi shl 4) or lo)
                i += 3
            } else {
                // A broken escape (or one cut off by a partial fetch) stays as it is.
                out.write(b)
                i++
            }
        }
        return out.toByteArray()
    }

    /** Bytes in the part's charset; an unknown charset reads as UTF-8 (mailutil.js decodeCharset). */
    fun decodeCharset(bytes: ByteArray, charset: String?): String = String(bytes, charsetOf(charset))

    fun charsetOf(name: String?): Charset {
        val cs = name?.trim()?.trim('"')?.takeIf { it.isNotEmpty() } ?: return Charsets.UTF_8
        return runCatching { Charset.forName(jakarta.mail.internet.MimeUtility.javaCharset(cs)) }.getOrNull()
            ?: runCatching { Charset.forName(cs) }.getOrNull()
            ?: Charsets.UTF_8
    }

    /** A preview from the first bytes of a text part (mailutil.js previewFromPart). */
    fun previewFromPart(bytes: ByteArray, type: String, encoding: String?, charset: String?): String {
        val decoded = decodeCharset(decodeTransfer(bytes, encoding), charset)
        // Cut-off HTML may end mid-tag; jsoup copes.
        val text = if (type.equals("text/html", ignoreCase = true)) htmlToPlain(decoded) else decoded
        return makePreview(text)
    }

    /** Writes a DOM as text with html-to-text's block spacing. */
    private class PlainWriter {
        private val out = StringBuilder()
        private var breaks = 0
        private var space = false
        private var atLineStart = true

        fun result(): String = out.toString()
            .replace(Regex("[ \\t]+\\n"), "\n")
            .replace(Regex("\\n{3,}"), "\n\n")
            .trim()

        private fun block(n: Int) {
            breaks = maxOf(breaks, n)
        }

        private fun flushBreaks() {
            if (breaks > 0 && out.isNotEmpty()) {
                repeat(breaks) { out.append('\n') }
                atLineStart = true
            }
            breaks = 0
            space = false
        }

        private fun word(text: String) {
            if (breaks > 0) flushBreaks()
            if (space && !atLineStart) out.append(' ')
            out.append(text)
            space = false
            atLineStart = false
        }

        private fun text(raw: String, pre: Boolean) {
            if (pre) {
                if (raw.isEmpty()) return
                if (breaks > 0) flushBreaks()
                out.append(raw.replace("\r\n", "\n").replace(' ', ' '))
                atLineStart = raw.endsWith("\n")
                return
            }
            if (raw.isEmpty()) return
            if (raw.first().let { it.isWhitespace() || it == ' ' }) space = true
            val words = raw.split(SPACES).filter { it.isNotEmpty() }
            words.forEachIndexed { i, w ->
                if (i > 0) space = true
                word(w)
            }
            if (raw.last().let { it.isWhitespace() || it == ' ' }) space = true
        }

        private fun lineBreak() {
            out.append('\n')
            atLineStart = true
            space = false
            breaks = 0
        }

        fun walk(node: Node, pre: Boolean = false, list: ListState? = null, depth: Int = 0) {
            // Real mail never nests this deep; a crafted one does to exhaust the stack.
            if (depth > MAX_DEPTH && node is Element) return flat(node, pre)
            for (child in node.childNodes()) {
                when (child) {
                    is TextNode -> text(if (pre) child.wholeText else child.wholeText, pre)
                    is Element -> element(child, pre, list, depth + 1)
                }
            }
        }

        /**
         * [walk] past the limit: the text and its line breaks, through jsoup's traversal, which is a loop. [root]
         * itself was laid out by [element] already (a list item has its bullet), so only what is inside it breaks.
         */
        private fun flat(root: Element, pre: Boolean) {
            NodeTraversor.filter(object : NodeFilter {
                override fun head(node: Node, depth: Int): NodeFilter.FilterResult {
                    if (node is TextNode) text(node.wholeText, pre)
                    if (node is Element && node !== root) {
                        if (node.normalName() in SKIP) return NodeFilter.FilterResult.SKIP_ENTIRELY
                        if (node.isBlock || node.normalName() == "br") block(1)
                    }
                    return NodeFilter.FilterResult.CONTINUE
                }

                override fun tail(node: Node, depth: Int): NodeFilter.FilterResult {
                    if (node is Element && node !== root && node.isBlock) block(1)
                    return NodeFilter.FilterResult.CONTINUE
                }
            }, root)
        }

        private class ListState(val ordered: Boolean, var n: Int)

        private fun element(el: Element, pre: Boolean, list: ListState?, depth: Int) {
            when (val tag = el.normalName()) {
                in SKIP -> return
                "br" -> {
                    if (breaks > 0) flushBreaks()
                    lineBreak()
                }
                "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr" -> {
                    block(2)
                    if (tag != "hr") walk(el, pre || tag == "pre", list, depth)
                    block(2)
                }
                "ul", "ol" -> {
                    block(2)
                    walk(el, pre, ListState(tag == "ol", el.attr("start").toIntOrNull() ?: 1), depth)
                    block(2)
                }
                "li" -> {
                    block(1)
                    val prefix = if (list?.ordered == true) "${list.n++}. " else " * "
                    if (breaks > 0) flushBreaks()
                    out.append(prefix)
                    atLineStart = true
                    space = false
                    walk(el, pre, list, depth)
                    block(1)
                }
                "td", "th", "div", "table", "tr", "section", "article", "header", "footer", "nav", "aside", "address",
                "center", "dl", "dt", "dd", "figure", "figcaption", "form", "fieldset", "main", "caption", "tbody",
                "thead", "tfoot" -> {
                    block(1)
                    walk(el, pre, list, depth)
                    block(1)
                }
                else -> walk(el, pre, list, depth)
            }
        }
    }
}
