package nl.bvdm.rukoo.mcp.tools

import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode
import org.jsoup.select.NodeFilter
import org.jsoup.select.NodeTraversor

/**
 * An agent's draft body as the HTML structure Rukoo's composer uses (desktop markdown.js, ported one to one): one
 * `<div>` per line, `<div><br></div>` for an empty line, a small markdown subset with safe links only.
 */
object DraftHtml {
    private val ESC = mapOf('&' to "&amp;", '<' to "&lt;", '>' to "&gt;", '"' to "&quot;", '\'' to "&#39;")

    fun esc(s: String): String = buildString(s.length) { for (c in s) append(ESC[c] ?: c) }

    private val SAFE_HREF = Regex("^(https?://|mailto:)", RegexOption.IGNORE_CASE)
    private const val EMPTY = "<div><br></div>"
    private val CONTROL = Regex("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]")
    private val EDGE_NEWLINES = Regex("^\\n+|\\n+$")

    private fun clean(text: String): String = text.replace(Regex("\\r\\n?"), "\n").replace(CONTROL, "")

    private fun line(html: String) = if (html.isNotEmpty()) "<div>$html</div>" else EMPTY

    fun textToHtml(text: String): String =
        clean(text).replace(EDGE_NEWLINES, "").split('\n').joinToString("") { line(esc(it)) }

    private val CODE = Regex("`([^`\\n]+)`")
    private val LINK = Regex("\\[([^\\]\\n]+)]\\(\\s*<?([^)\\s>]+)>?(?:\\s+\"[^\"]*\")?\\s*\\)")
    private val URL = Regex("\\b(https?://[^\\s<>()]+[^\\s<>().,;:!?'\"\\]])")
    private val MAILTO = Regex("\\bmailto:[^\\s<>()]+[^\\s<>().,;:!?'\"\\]]")
    private val SLOT = Regex("\\u0000(\\d+)\\u0000")

    // Inline markdown: code spans, links, bare URLs, bold, italic. Everything else is escaped.
    private fun inline(src: String): String {
        val slots = mutableListOf<String>()
        fun keep(html: String): String {
            slots += html
            return "\u0000${slots.size - 1}\u0000"
        }
        var s = src
        s = CODE.replace(s) { keep("<code>${esc(it.groupValues[1])}</code>") }
        s = LINK.replace(s) { m ->
            val label = m.groupValues[1]
            val url = m.groupValues[2]
            if (SAFE_HREF.containsMatchIn(url)) keep("<a href=\"${esc(url)}\">${inlineText(label)}</a>") else keep(inlineText(label))
        }
        s = URL.replace(s) { keep("<a href=\"${esc(it.value)}\">${esc(it.value)}</a>") }
        s = MAILTO.replace(s) { keep("<a href=\"${esc(it.value)}\">${esc(it.value.substring(7))}</a>") }
        return SLOT.replace(emphasis(esc(s))) { slots[it.groupValues[1].toInt()] }
    }

    // Link labels may carry emphasis but no further links.
    private fun inlineText(src: String) = emphasis(esc(src))

    private val BOLD_STARS = Regex("\\*\\*(?=\\S)([^*]+?)(?<=\\S)\\*\\*")
    private val BOLD_UNDERSCORES = Regex("(^|[^\\w])__(?=\\S)([^_]+?)(?<=\\S)__(?!\\w)")
    private val ITALIC_STAR = Regex("(^|[^\\w*])\\*(?=\\S)([^*\\n]+?)(?<=\\S)\\*(?![\\w*])")
    // Underscores only count at word edges, so snake_case and file_names stay as they are.
    private val ITALIC_UNDERSCORE = Regex("(^|[^\\w])_(?=\\S)([^_\\n]+?)(?<=\\S)_(?!\\w)")

    private fun emphasis(html: String): String = html
        .replace(BOLD_STARS, "<b>$1</b>")
        .replace(BOLD_UNDERSCORES, "$1<b>$2</b>")
        .replace(ITALIC_STAR, "$1<i>$2</i>")
        .replace(ITALIC_UNDERSCORE, "$1<i>$2</i>")

    private val BULLET = Regex("^\\s{0,3}[-*+]\\s+(.*)$")
    private val ORDERED = Regex("^\\s{0,3}\\d{1,3}[.)]\\s+(.*)$")
    private val QUOTE = Regex("^\\s{0,3}>\\s?(.*)$")
    private val HEADING = Regex("^\\s{0,3}#{1,6}\\s+(.*?)\\s*#*\\s*$")
    private val FENCE = Regex("^\\s{0,3}```")
    private val RULE = Regex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")

    fun markdownToHtml(text: String): String {
        val lines = clean(text).replace(EDGE_NEWLINES, "").split('\n')
        val out = mutableListOf<String>()
        var blank = false
        fun block(html: String) {
            if (blank && out.isNotEmpty()) out += EMPTY
            blank = false
            out += html
        }
        var i = 0
        while (i < lines.size) {
            val l = lines[i]
            if (l.isBlank()) {
                blank = true
                i++
                continue
            }
            if (FENCE.containsMatchIn(l)) {
                val body = mutableListOf<String>()
                i++
                while (i < lines.size && !FENCE.containsMatchIn(lines[i])) body += lines[i++]
                i++
                block("<pre><code>${esc(body.joinToString("\n"))}</code></pre>")
                continue
            }
            if (RULE.matches(l)) {
                block("<hr>")
                i++
                continue
            }
            val list = when {
                BULLET.matches(l) -> BULLET
                ORDERED.matches(l) -> ORDERED
                else -> null
            }
            if (list != null) {
                val items = mutableListOf<String>()
                while (i < lines.size) {
                    val item = list.matchEntire(lines[i]) ?: break
                    items += "<li>${inline(item.groupValues[1])}</li>"
                    i++
                }
                val tag = if (list === BULLET) "ul" else "ol"
                block("<$tag>${items.joinToString("")}</$tag>")
                continue
            }
            if (QUOTE.matches(l)) {
                val quoted = mutableListOf<String>()
                while (i < lines.size) {
                    val q = QUOTE.matchEntire(lines[i]) ?: break
                    quoted += q.groupValues[1]
                    i++
                }
                block("<blockquote>${quoted.joinToString("") { line(inline(it)) }}</blockquote>")
                continue
            }
            // Headings read as shouting in an email; a bold line keeps the structure without the size.
            val heading = HEADING.matchEntire(l)
            block(line(if (heading != null) "<b>${inline(heading.groupValues[1])}</b>" else inline(l)))
            i++
        }
        return out.joinToString("")
    }

    fun toHtml(text: String, format: String = "markdown"): String = when (format) {
        "html" -> text
        "text" -> textToHtml(text)
        else -> markdownToHtml(text)
    }
}

/**
 * HTML as plain text for the phone's plain-text composer, close to what desktop's html-to-text gives (mailutil.js
 * htmlToPlain with wordwrap off): block elements on lines of their own, list items with bullets or numbers,
 * quotes with `> `, links as their text, images left out.
 */
object PlainText {
    private val BLOCKS = setOf(
        "div", "p", "li", "ul", "ol", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "tr",
        "td", "th", "section", "article", "header", "footer", "address",
    )
    private val SPACED = setOf("p", "ul", "ol", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "table")
    private val SKIP = setOf("img", "style", "script", "head", "title")

    /** How deep the layout is kept; below it only text and line breaks, so HTML nested thousands deep can't exhaust the stack. */
    private const val MAX_DEPTH = 100

    fun fromHtml(html: String): String {
        val out = StringBuilder()
        render(Jsoup.parseBodyFragment(html).body(), out, pre = false)
        return out.toString()
            .lines()
            .joinToString("\n") { it.trimEnd() }
            .replace(Regex("\\n{3,}"), "\n\n")
            .trim()
    }

    private fun breakLine(out: StringBuilder) {
        if (out.isNotEmpty() && !out.endsWith("\n")) out.append('\n')
    }

    private fun blankLine(out: StringBuilder) {
        breakLine(out)
        if (out.isNotEmpty() && !out.endsWith("\n\n")) out.append('\n')
    }

    private fun render(node: Node, out: StringBuilder, pre: Boolean, depth: Int = 0) {
        when (node) {
            is TextNode -> {
                val text = if (pre) node.wholeText else node.text().replace('\u00a0', ' ')
                if (!pre && text.isBlank()) {
                    if (text.isNotEmpty() && out.isNotEmpty() && !out.endsWith("\n") && !out.endsWith(" ")) out.append(' ')
                    return
                }
                out.append(if (pre) text else text.replace(Regex("\\s+"), " "))
            }
            is Element -> {
                val tag = node.normalName()
                if (tag in SKIP) return
                if (depth > MAX_DEPTH) return flat(node, out, pre)
                if (tag == "br") {
                    out.append('\n')
                    return
                }
                if (tag == "hr") {
                    blankLine(out)
                    out.append("---")
                    blankLine(out)
                    return
                }
                val block = tag in BLOCKS
                if (tag in SPACED) blankLine(out) else if (block) breakLine(out)
                when (tag) {
                    "li" -> {
                        val parent = node.parent()
                        if (parent?.normalName() == "ol") out.append("${node.elementSiblingIndex() + 1}. ") else out.append(" * ")
                        node.childNodes().forEach { render(it, out, pre, depth + 1) }
                    }
                    "blockquote" -> {
                        val inner = StringBuilder()
                        node.childNodes().forEach { render(it, inner, pre, depth + 1) }
                        out.append(inner.toString().trim('\n').lines().joinToString("\n") { "> $it".trimEnd() })
                    }
                    else -> node.childNodes().forEach { render(it, out, pre || tag == "pre", depth + 1) }
                }
                if (tag in SPACED) blankLine(out) else if (block) breakLine(out)
            }
        }
    }

    /** [render] past the limit: the text and its line breaks, through jsoup's traversal, which is a loop. */
    private fun flat(root: Element, out: StringBuilder, pre: Boolean) {
        NodeTraversor.filter(object : NodeFilter {
            override fun head(node: Node, depth: Int): NodeFilter.FilterResult {
                if (node is TextNode) render(node, out, pre)
                if (node is Element) {
                    if (node.normalName() in SKIP) return NodeFilter.FilterResult.SKIP_ENTIRELY
                    if (node.normalName() in BLOCKS || node.normalName() == "br") breakLine(out)
                }
                return NodeFilter.FilterResult.CONTINUE
            }

            override fun tail(node: Node, depth: Int): NodeFilter.FilterResult {
                if (node is Element && node.normalName() in BLOCKS) breakLine(out)
                return NodeFilter.FilterResult.CONTINUE
            }
        }, root)
    }
}
