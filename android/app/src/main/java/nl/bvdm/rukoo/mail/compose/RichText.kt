package nl.bvdm.rukoo.mail.compose

import nl.bvdm.rukoo.mail.mime.MailText
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode
import org.jsoup.select.NodeFilter
import org.jsoup.select.NodeTraversor

/** Inline formatting the composer writes: `<b>`, `<i>`, `<u>` and `<s>`. */
enum class Mark { BOLD, ITALIC, UNDERLINE, STRIKE }

/** What a paragraph is: text in a `<div>`, a bulleted or numbered list item, or a heading (`<h2>`). */
enum class Block { TEXT, BULLET, NUMBER, HEADING }

/** [mark] over the characters [start] until [end]. */
data class MarkRange(val start: Int, val end: Int, val mark: Mark)

/** A link to [url] over the characters [start] until [end]. */
data class LinkRange(val start: Int, val end: Int, val url: String)

/**
 * The composer's formatted text: [text] with a `\n` between paragraphs, its inline [marks] and [links], and one
 * [Block] per paragraph (missing entries are [Block.TEXT]). Ranges may cross a line break; the HTML closes them at
 * the end of each paragraph.
 */
data class RichDoc(
    val text: String,
    val marks: List<MarkRange> = emptyList(),
    val links: List<LinkRange> = emptyList(),
    val blocks: List<Block> = emptyList(),
) {
    fun block(paragraph: Int): Block = blocks.getOrNull(paragraph) ?: Block.TEXT

    /** No formatting at all: the plain-text composer would send the same. */
    val isPlain: Boolean get() = marks.isEmpty() && links.isEmpty() && blocks.all { it == Block.TEXT }
}

/**
 * The composer's HTML subset and its conversions. The composer writes the structure desktop's editor writes
 * (a `<div>` per line, `<div><br></div>` for an empty one) plus `<ul>`/`<ol>` with `<li>`, `<h2>`, `<b>`, `<i>`,
 * `<u>`, `<s>` and `<a href>` to the web or an address. [parse] reads any HTML onto that subset: desktop's
 * editor (which writes bold and italic as CSS on spans), agent drafts and other mail clients. Markup outside the
 * subset is reduced to its text, so no words are lost and nothing else gets into the editor.
 */
object RichText {
    /** The heading's inline style: one size step up, so desktop and other mail clients don't shout it. */
    const val HEADING_OPEN = "<h2 style=\"font-size:1.3em;margin:0.4em 0\">"

    private const val ZWSP = '​'
    private val SAFE_HREF = Regex("^(https?:|mailto:)", RegexOption.IGNORE_CASE)

    fun fromText(text: String): RichDoc = RichDoc(text.replace("\r\n", "\n").replace('\r', '\n'))

    /** Starts of the paragraphs of [text]: 0 and every index after a line break. */
    fun paragraphStarts(text: CharSequence): IntArray {
        var n = 1
        for (i in text.indices) if (text[i] == '\n') n++
        val out = IntArray(n)
        var k = 1
        for (i in text.indices) if (text[i] == '\n') out[k++] = i + 1
        return out
    }

    /** End of the paragraph starting at [start], before its line break. */
    fun paragraphEnd(text: CharSequence, start: Int): Int {
        var i = start
        while (i < text.length && text[i] != '\n') i++
        return i
    }

    /** Whether [url] is a link the composer keeps: http, https or mailto. */
    fun safeUrl(url: String): Boolean = SAFE_HREF.containsMatchIn(url.trim())

    /**
     * An address as typed into the link field: a web or mail address keeps its scheme, an email address gets
     * `mailto:` and anything else `https://` (desktop's insertLink). Null when nothing usable is left.
     */
    fun linkTarget(typed: String): String? {
        val t = typed.trim()
        if (t.isEmpty() || t.any { it.isWhitespace() }) return null
        return when {
            safeUrl(t) -> t
            Regex("^[a-z][a-z0-9+.-]*:", RegexOption.IGNORE_CASE).containsMatchIn(t) && !Regex("^[^:/]+:\\d").containsMatchIn(t) -> null
            Regex("^[^@\\s/]+@[^@\\s/]+\\.[^@\\s/]+$").matches(t) -> "mailto:$t"
            else -> "https://$t"
        }
    }

    // ---------- plain text ----------

    /**
     * The text as the composer's plain projection: what agents read with get_draft, what list previews show and
     * what tells an empty draft from a written one. Bullets are ` * ` and numbers `1. `, as the plain-text part
     * of the mail writes them; links keep only their text.
     */
    fun plain(doc: RichDoc): String {
        val starts = paragraphStarts(doc.text)
        val out = StringBuilder(doc.text.length + starts.size * 3)
        var number = 0
        for (i in starts.indices) {
            if (i > 0) out.append('\n')
            val block = doc.block(i)
            number = if (block == Block.NUMBER) number + 1 else 0
            when (block) {
                Block.BULLET -> out.append(" * ")
                Block.NUMBER -> out.append(number).append(". ")
                else -> {}
            }
            out.append(doc.text, starts[i], paragraphEnd(doc.text, starts[i]))
        }
        return out.toString()
    }

    /**
     * Whether two plain projections hold the same words: spacing and empty lines at the ends don't count. A stored
     * HTML body is only used while it still matches the plain body next to it.
     */
    fun sameText(a: String, b: String): Boolean = squash(a) == squash(b)

    private val SPACES = Regex("[ \\t\\u00A0\\u200B]+")
    private fun squash(s: String) = s.replace("\r\n", "\n").lines().joinToString("\n") { SPACES.replace(it, " ").trim() }.trim()

    /**
     * The plain-text part of a mail whose typed part is [html]: desktop's html-to-text port, with a link's
     * address after its text in brackets (html-to-text's own format), so a reader of the text part can follow it.
     */
    fun textPart(html: String): String = MailText.htmlToPlain(html, linkUrls = true)

    // ---------- trimming ----------

    /** [doc] without empty plain paragraphs at the end. */
    fun trimEnd(doc: RichDoc): RichDoc {
        val starts = paragraphStarts(doc.text)
        var last = starts.size - 1
        while (last > 0 && doc.block(last) == Block.TEXT && doc.text.substring(starts[last], paragraphEnd(doc.text, starts[last])).isBlank()) last--
        if (last == starts.size - 1) return doc
        return cut(doc, 0, paragraphEnd(doc.text, starts[last]), 0, last + 1)
    }

    /** [doc] without empty plain paragraphs at either end. */
    fun trim(doc: RichDoc): RichDoc {
        val end = trimEnd(doc)
        val starts = paragraphStarts(end.text)
        var first = 0
        while (first < starts.size - 1 && end.block(first) == Block.TEXT && end.text.substring(starts[first], paragraphEnd(end.text, starts[first])).isBlank()) first++
        if (first == 0) return end
        return cut(end, starts[first], end.text.length, first, starts.size)
    }

    private fun cut(doc: RichDoc, from: Int, to: Int, firstParagraph: Int, paragraphs: Int): RichDoc = RichDoc(
        text = doc.text.substring(from, to),
        marks = doc.marks.mapNotNull { m -> clip(m.start, m.end, from, to)?.let { (s, e) -> MarkRange(s, e, m.mark) } },
        links = doc.links.mapNotNull { l -> clip(l.start, l.end, from, to)?.let { (s, e) -> LinkRange(s, e, l.url) } },
        blocks = (firstParagraph until paragraphs).map { doc.block(it) },
    )

    private fun clip(start: Int, end: Int, from: Int, to: Int): Pair<Int, Int>? {
        val s = maxOf(start, from)
        val e = minOf(end, to)
        return if (s < e) (s - from) to (e - from) else null
    }

    // ---------- HTML out ----------

    /** [doc] in the composer's HTML subset (see [RichText]). */
    fun toHtml(doc: RichDoc): String {
        val starts = paragraphStarts(doc.text)
        val out = StringBuilder(doc.text.length * 2 + 32)
        var list: Block? = null
        for (i in starts.indices) {
            val block = doc.block(i)
            val inner = inline(doc, starts[i], paragraphEnd(doc.text, starts[i])).ifEmpty { "<br>" }
            val listKind = block.takeIf { it == Block.BULLET || it == Block.NUMBER }
            if (list != listKind) {
                if (list != null) out.append(if (list == Block.NUMBER) "</ol>" else "</ul>")
                if (listKind != null) out.append(if (listKind == Block.NUMBER) "<ol>" else "<ul>")
                list = listKind
            }
            when (block) {
                Block.BULLET, Block.NUMBER -> out.append("<li>").append(inner).append("</li>")
                Block.HEADING -> out.append(HEADING_OPEN).append(inner).append("</h2>")
                Block.TEXT -> out.append("<div>").append(inner).append("</div>")
            }
        }
        if (list != null) out.append(if (list == Block.NUMBER) "</ol>" else "</ul>")
        return out.toString()
    }

    // The order tags nest in: a link outermost, then bold, italic, underline, strikethrough.
    private val ORDER = listOf(Mark.BOLD, Mark.ITALIC, Mark.UNDERLINE, Mark.STRIKE)
    private fun open(mark: Mark) = when (mark) {
        Mark.BOLD -> "<b>"
        Mark.ITALIC -> "<i>"
        Mark.UNDERLINE -> "<u>"
        Mark.STRIKE -> "<s>"
    }
    private fun close(mark: Mark) = when (mark) {
        Mark.BOLD -> "</b>"
        Mark.ITALIC -> "</i>"
        Mark.UNDERLINE -> "</u>"
        Mark.STRIKE -> "</s>"
    }

    // One tag a segment of text sits in: a link (with its address) or a mark.
    private data class Tag(val mark: Mark?, val url: String?)

    private fun inline(doc: RichDoc, start: Int, end: Int): String {
        if (start >= end) return ""
        val cuts = sortedSetOf(start, end)
        for (m in doc.marks) if (m.end > start && m.start < end) {
            cuts += m.start.coerceIn(start, end)
            cuts += m.end.coerceIn(start, end)
        }
        for (l in doc.links) if (l.end > start && l.start < end) {
            cuts += l.start.coerceIn(start, end)
            cuts += l.end.coerceIn(start, end)
        }
        val out = StringBuilder()
        val stack = ArrayList<Tag>()
        val points = cuts.toIntArray()
        for (k in 0 until points.size - 1) {
            val a = points[k]
            val b = points[k + 1]
            if (a >= b) continue
            val want = ArrayList<Tag>()
            doc.links.firstOrNull { it.start <= a && it.end >= b }?.let { want += Tag(null, it.url) }
            for (mark in ORDER) if (doc.marks.any { it.mark == mark && it.start <= a && it.end >= b }) want += Tag(mark, null)
            var same = 0
            while (same < stack.size && same < want.size && stack[same] == want[same]) same++
            for (j in stack.size - 1 downTo same) out.append(stack[j].mark?.let(::close) ?: "</a>")
            while (stack.size > same) stack.removeAt(stack.size - 1)
            for (j in same until want.size) {
                val tag = want[j]
                out.append(tag.mark?.let(::open) ?: "<a href=\"${MailText.esc(tag.url.orEmpty())}\">")
                stack += tag
            }
            escapeText(doc.text, a, b, start, end, out)
        }
        for (j in stack.size - 1 downTo 0) out.append(stack[j].mark?.let(::close) ?: "</a>")
        return out.toString()
    }

    // Spaces HTML would collapse stay as no-break spaces, the way a browser's editor keeps them: at the start and
    // end of a line and after another space.
    private fun escapeText(text: String, from: Int, to: Int, lineStart: Int, lineEnd: Int, out: StringBuilder) {
        for (i in from until to) {
            when (val ch = text[i]) {
                '&' -> out.append("&amp;")
                '<' -> out.append("&lt;")
                '>' -> out.append("&gt;")
                '"' -> out.append("&quot;")
                '\'' -> out.append("&#39;")
                ZWSP -> {}
                ' ', '\t' -> if (i == lineStart || i == lineEnd - 1 || text[i - 1] == ' ' || text[i - 1] == '\t') out.append("&nbsp;") else out.append(' ')
                else -> out.append(ch)
            }
        }
    }

    // ---------- HTML in ----------

    /** Elements left out with everything in them: what desktop's sanitizers drop, and media. */
    private val DROP = setOf(
        "script", "style", "svg", "math", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "button",
        "input", "select", "option", "optgroup", "datalist", "textarea", "template", "noscript", "link", "meta", "base",
        "title", "head", "video", "audio", "source", "track", "picture", "img", "canvas", "map", "area",
    )

    /** Elements that start and end a line. */
    private val BLOCKS = setOf(
        "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "tr", "td", "th",
        "section", "article", "header", "footer", "nav", "aside", "address", "center", "dl", "dt", "dd", "figure",
        "figcaption", "main", "caption", "details", "summary", "body",
    )
    private val HEADINGS = setOf("h1", "h2", "h3", "h4", "h5", "h6")

    /**
     * [html] onto the composer's subset. Lines come from block elements and `<br>`, the way a browser lays them
     * out; a `<p>` with its margins leaves an empty line; nested lists become one level; a quote's lines start with
     * `> `. Formatting comes from tags and from the CSS desktop's editor writes (`font-weight`, `font-style`,
     * `text-decoration`). Links keep http, https and mailto addresses only.
     */
    fun parse(html: String): RichDoc {
        if (html.isBlank()) return RichDoc("")
        val reader = Reader()
        NodeTraversor.filter(reader, Jsoup.parseBodyFragment(html).body())
        return reader.result()
    }

    /** [html] reduced to the subset and written again: what the composer would send. */
    fun sanitize(html: String): String = toHtml(parse(html))

    private class Style(val marks: Set<Mark>, val link: String?)

    private class Frame(
        val style: Boolean = false,
        val block: Boolean = false,
        val list: Boolean = false,
        val quote: Boolean = false,
        val pre: Boolean = false,
        val after: Int = 0,
    )

    private class Run(val start: Int, val end: Int, val style: Style)

    private class Reader : NodeFilter {
        private val sb = StringBuilder()
        private val blocks = ArrayList<Block>()
        private val runs = ArrayList<Run>()
        private val styles = ArrayList<Style>().apply { add(Style(emptySet(), null)) }
        private val blockKinds = ArrayList<Block>()
        private val lists = ArrayList<String>()
        private val frames = ArrayList<Frame>()
        private var quoteDepth = 0
        private var preDepth = 0

        // A paragraph is open; else the next content starts one, after [pending] line breaks (2: an empty line).
        private var open = false
        private var pending = 0

        // A collapsed space waits for the next word on the same line, in the style of the text before it.
        private var space: Style? = null

        private val style get() = styles.last()

        override fun head(node: Node, depth: Int): NodeFilter.FilterResult {
            when (node) {
                is TextNode -> if (preDepth > 0) preText(node.wholeText) else text(node.wholeText)
                is Element -> {
                    val tag = node.normalName()
                    if (tag in DROP) return NodeFilter.FilterResult.SKIP_ENTIRELY
                    if (tag == "br") {
                        lineBreak()
                        frames += Frame()
                        return NodeFilter.FilterResult.CONTINUE
                    }
                    if (tag == "hr") {
                        boundary(2)
                        frames += Frame(after = 2)
                        return NodeFilter.FilterResult.CONTINUE
                    }
                    var frame = Frame()
                    if (tag == "p") {
                        val tight = node.attr("style").replace(" ", "").contains("margin:0") || node.hasClass("MsoNormal")
                        boundary(if (tight) 1 else 2)
                        frame = Frame(after = if (tight) 1 else 2)
                    } else if (tag in BLOCKS) {
                        boundary(1)
                        frame = Frame(after = 1)
                    }
                    var pushedBlock = false
                    var pushedList = false
                    when (tag) {
                        "ul", "ol" -> {
                            lists += tag
                            pushedList = true
                        }
                        "li" -> {
                            blockKinds += if (lists.lastOrNull() == "ol") Block.NUMBER else Block.BULLET
                            pushedBlock = true
                        }
                        in HEADINGS -> {
                            blockKinds += Block.HEADING
                            pushedBlock = true
                        }
                    }
                    if (tag == "blockquote") quoteDepth++
                    if (tag == "pre") preDepth++
                    val next = styled(node, tag)
                    if (next != null) styles += next
                    frames += Frame(
                        style = next != null,
                        block = pushedBlock,
                        list = pushedList,
                        quote = tag == "blockquote",
                        pre = tag == "pre",
                        after = frame.after,
                    )
                }
            }
            return NodeFilter.FilterResult.CONTINUE
        }

        override fun tail(node: Node, depth: Int): NodeFilter.FilterResult {
            if (node !is Element) return NodeFilter.FilterResult.CONTINUE
            val frame = frames.removeAt(frames.size - 1)
            if (frame.style) styles.removeAt(styles.size - 1)
            if (frame.block) blockKinds.removeAt(blockKinds.size - 1)
            if (frame.list) lists.removeAt(lists.size - 1)
            if (frame.quote) quoteDepth--
            if (frame.pre) preDepth--
            if (frame.after > 0) boundary(frame.after)
            return NodeFilter.FilterResult.CONTINUE
        }

        // The style inside [el], or null when it changes nothing.
        private fun styled(el: Element, tag: String): Style? {
            var marks = style.marks
            var link = style.link
            when (tag) {
                "b", "strong" -> marks = marks + Mark.BOLD
                "i", "em", "cite", "var", "dfn" -> marks = marks + Mark.ITALIC
                "u", "ins" -> marks = marks + Mark.UNDERLINE
                "s", "strike", "del" -> marks = marks + Mark.STRIKE
                "a" -> {
                    val href = el.attr("href").trim()
                    if (href.isNotEmpty() && SAFE_HREF.containsMatchIn(href) && href.length <= 4000) link = href
                }
            }
            val css = el.attr("style")
            if (css.isNotBlank()) marks = applyCss(marks, css)
            return if (marks == style.marks && link == style.link) null else Style(marks, link)
        }

        private fun applyCss(start: Set<Mark>, css: String): Set<Mark> {
            var marks = start
            for (decl in css.split(';')) {
                val name = decl.substringBefore(':', "").trim().lowercase()
                val value = decl.substringAfter(':', "").trim().lowercase().removeSuffix("!important").trim()
                if (name.isEmpty() || value.isEmpty()) continue
                when (name) {
                    "font-weight" -> {
                        val n = value.toIntOrNull()
                        marks = when {
                            value == "bold" || value == "bolder" || (n != null && n >= 600) -> marks + Mark.BOLD
                            value == "normal" || value == "lighter" || (n != null && n < 600) -> marks - Mark.BOLD
                            else -> marks
                        }
                    }
                    "font-style" -> marks = when {
                        value.startsWith("italic") || value.startsWith("oblique") -> marks + Mark.ITALIC
                        value == "normal" -> marks - Mark.ITALIC
                        else -> marks
                    }
                    "text-decoration", "text-decoration-line" -> {
                        if (value.contains("underline")) marks = marks + Mark.UNDERLINE
                        if (value.contains("line-through")) marks = marks + Mark.STRIKE
                        if (value == "none") marks = marks - Mark.UNDERLINE - Mark.STRIKE
                    }
                }
            }
            return marks
        }

        private fun boundary(n: Int) {
            open = false
            if (n > pending) pending = n
            space = null
        }

        private fun startParagraph() {
            if (open) return
            if (blocks.isNotEmpty()) {
                if (pending >= 2 && !(sb.isEmpty() || sb.last() == '\n')) {
                    sb.append('\n')
                    blocks += Block.TEXT
                }
                sb.append('\n')
            }
            blocks += blockKinds.lastOrNull() ?: Block.TEXT
            open = true
            pending = 0
            space = null
            // Up to three marks, however deep the quotes nest: thousands of nested quotes would otherwise multiply the text.
            if (quoteDepth > 0) append("> ".repeat(minOf(quoteDepth, MAX_QUOTE_MARKS)), Style(emptySet(), null))
        }

        private fun lineBreak() {
            startParagraph()
            open = false
            pending = 1
            space = null
        }

        private fun append(text: String, s: Style) {
            if (text.isEmpty()) return
            val start = sb.length
            sb.append(text)
            if (s.marks.isNotEmpty() || s.link != null) runs += Run(start, sb.length, s)
        }

        private fun text(raw: String) {
            if (raw.isEmpty()) return
            val collapsed = WHITESPACE.replace(raw, " ").replace("​", "").replace(' ', ' ')
            if (collapsed.isEmpty()) return
            val leading = WHITESPACE.matchesAt(raw, 0)
            val trailing = raw.last().let { it == ' ' || it == '\t' || it == '\n' || it == '\r' || it == '\u000C' }
            val words = collapsed.let { if (leading) it.drop(1) else it }.let { if (trailing && it.endsWith(' ')) it.dropLast(1) else it }
            if (words.isEmpty()) {
                if (open && space == null) space = style
                return
            }
            if (leading && open && space == null) space = style
            startParagraph()
            space?.let { append(" ", it) }
            space = null
            append(words, style)
            if (trailing) space = style
        }

        private fun preText(raw: String) {
            val lines = raw.replace("\r\n", "\n").replace('\r', '\n').replace("​", "").replace(' ', ' ').split('\n')
            lines.forEachIndexed { i, line ->
                if (i > 0) lineBreak()
                if (line.isNotEmpty()) {
                    startParagraph()
                    append(line, style)
                }
            }
        }

        fun result(): RichDoc {
            if (blocks.isEmpty()) return RichDoc("")
            val text = sb.toString()
            val marks = ArrayList<MarkRange>()
            for (mark in Mark.entries) {
                var start = -1
                var end = -1
                for (r in runs) {
                    if (mark !in r.style.marks) continue
                    if (r.start == end) {
                        end = r.end
                    } else {
                        if (start >= 0) marks += MarkRange(start, end, mark)
                        start = r.start
                        end = r.end
                    }
                }
                if (start >= 0) marks += MarkRange(start, end, mark)
            }
            val links = ArrayList<LinkRange>()
            var current: LinkRange? = null
            for (r in runs) {
                val url = r.style.link ?: continue
                val c = current
                current = if (c != null && c.url == url && c.end == r.start) c.copy(end = r.end) else {
                    if (c != null) links += c
                    LinkRange(r.start, r.end, url)
                }
            }
            current?.let { links += it }
            return RichDoc(text, marks.sortedWith(compareBy({ it.start }, { it.mark })), links, blocks.toList())
        }

        private companion object {
            val WHITESPACE = Regex("[ \\t\\n\\r\\u000C]+")
            const val MAX_QUOTE_MARKS = 3
        }
    }
}
