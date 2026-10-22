package nl.bvdm.rukoo.mail.html

import nl.bvdm.rukoo.mail.mime.MailText
import org.jsoup.Jsoup
import org.jsoup.nodes.Comment
import org.jsoup.nodes.DataNode
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode

/**
 * Signatures reduced to static formatting, ported from desktop's signature.js (spec 4 §3.10): text,
 * links, tables, inline styles and images, rebuilt from the parsed DOM so only what is listed here can
 * come out. Signatures arrive with accounts imported from the computer and go into every mail sent.
 */
object SignatureHtml {
    class TooLarge : IllegalArgumentException("signature too large")

    private val DROP = setOf(
        "script", "style", "head", "title", "meta", "link", "base", "template", "noscript", "xmp", "plaintext", "noembed",
        "noframes", "iframe", "frame", "frameset", "object", "embed", "applet", "param", "form", "input", "button", "select",
        "option", "optgroup", "datalist", "textarea", "output", "svg", "math", "video", "audio", "source", "track", "picture",
        "canvas", "map", "area", "dialog", "slot",
    )
    private val COMMON = listOf("style", "title", "dir", "align")
    private val CELL = listOf("width", "height", "colspan", "rowspan", "valign", "bgcolor", "nowrap")
    private val KEEP: Map<String, List<String>> = buildMap {
        for (name in listOf(
            "div", "p", "br", "span", "b", "strong", "i", "em", "u", "s", "strike", "small", "big", "sub", "sup", "code", "pre",
            "blockquote", "center", "h1", "h2", "h3", "h4", "h5", "h6", "li", "caption", "thead", "tbody", "tfoot",
        )) put(name, emptyList())
        put("hr", listOf("width", "size", "color", "noshade"))
        put("ul", listOf("type"))
        put("ol", listOf("type", "start"))
        put("font", listOf("color", "face", "size"))
        put("a", listOf("href"))
        put("img", listOf("src", "alt", "width", "height", "border", "hspace", "vspace"))
        put("table", listOf("width", "border", "cellpadding", "cellspacing", "bgcolor"))
        put("colgroup", listOf("span", "width"))
        put("col", listOf("span", "width"))
        put("tr", listOf("valign", "bgcolor", "height"))
        put("td", CELL)
        put("th", CELL)
    }
    private val VOID = setOf("br", "hr", "img", "col")
    private val SAFE_HREF = Regex("^(https?:|mailto:|tel:)", RegexOption.IGNORE_CASE)
    private val SAFE_SRC = Regex("^(https?://|data:image/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\\s]+$)", RegexOption.IGNORE_CASE)
    private val SAFE_VALUE = Regex("^[\\w\\s#%.,'\"-]{0,100}$")
    private val STYLE_PROPS = Regex(
        "^(color|background|background-color|font|font-(family|size|style|weight|variant)|text-(align|decoration|transform|indent)|line-height|letter-spacing|word-spacing|white-space|vertical-align|(margin|padding)(-(top|right|bottom|left))?|border(-(top|right|bottom|left))?(-(width|style|color))?|border-(collapse|spacing|radius)|(min-|max-)?(width|height)|display|list-style(-type)?|direction|overflow|float|clear)$",
    )
    private val UNSAFE_STYLE = Regex("url\\s*\\(|image-set|expression|javascript:|behavior|binding|@import|[<>\\\\{}]", RegexOption.IGNORE_CASE)
    private val DISPLAY = Regex("^(block|inline|inline-block|table|table-row|table-cell|none)$", RegexOption.IGNORE_CASE)
    private const val MAX_INPUT = 5 * 1024 * 1024
    private const val MAX_HTML = 1024 * 1024
    private const val MAX_DEPTH = 100

    private fun escapeText(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace(" ", "&nbsp;")

    private fun escapeAttr(s: String) = escapeText(s).replace("\"", "&quot;")

    private fun cleanStyle(style: String): String = style.split(';').mapNotNull { decl ->
        val at = decl.indexOf(':')
        if (at < 0) return@mapNotNull null
        val prop = decl.substring(0, at).trim().lowercase()
        val value = decl.substring(at + 1).trim()
        if (!STYLE_PROPS.matches(prop) || value.isEmpty() || value.length > 200 || UNSAFE_STYLE.containsMatchIn(value)) return@mapNotNull null
        // A pasted signature must not cover the composer or slip out of its place.
        if (prop == "display" && !DISPLAY.matches(value)) return@mapNotNull null
        "$prop:$value"
    }.joinToString(";")

    private fun cleanAttrs(name: String, el: Element): String {
        val allowed = COMMON + KEEP.getValue(name)
        val out = StringBuilder()
        for (attr in el.attributes()) {
            val key = attr.key.lowercase()
            if (key !in allowed) continue
            var value = attr.value.trim()
            when (key) {
                "style" -> value = cleanStyle(value)
                "href" -> if (!SAFE_HREF.containsMatchIn(value)) continue
                "src" -> if (!SAFE_SRC.containsMatchIn(value)) continue
                "alt", "title" -> value = value.take(300)
                else -> if (!SAFE_VALUE.matches(value)) continue
            }
            if (key == "style" && value.isEmpty()) continue
            out.append(' ').append(key).append("=\"").append(escapeAttr(value)).append('"')
        }
        return out.toString()
    }

    private fun serialize(nodes: List<Node>, depth: Int, out: StringBuilder) {
        for (node in nodes) {
            when (node) {
                is TextNode -> out.append(escapeText(node.wholeText))
                // Comments (Outlook's conditional ones among them) and script or style content go.
                is Comment, is DataNode -> Unit
                is Element -> {
                    val name = node.normalName()
                    if (name in DROP || depth > MAX_DEPTH) continue
                    if (name !in KEEP) {
                        serialize(node.childNodes(), depth + 1, out)
                        continue
                    }
                    // A link or image whose address is not allowed keeps only its text.
                    if (name == "a" && !SAFE_HREF.containsMatchIn(node.attr("href").trim())) {
                        serialize(node.childNodes(), depth + 1, out)
                        continue
                    }
                    if (name == "img" && !SAFE_SRC.containsMatchIn(node.attr("src").trim())) continue
                    out.append('<').append(name).append(cleanAttrs(name, node)).append('>')
                    if (name in VOID) continue
                    serialize(node.childNodes(), depth + 1, out)
                    out.append("</").append(name).append('>')
                }
            }
        }
    }

    /** The signature as safe HTML; '' for nothing. Throws [TooLarge] when it can't go under every mail. */
    fun clean(html: String?): String {
        val source = html.orEmpty()
        if (source.length > MAX_INPUT) throw TooLarge()
        val doc = Jsoup.parse(source)
        val out = StringBuilder()
        // Head content parsed out of a pasted fragment (a stray <title>, <style>) is dropped anyway.
        serialize(doc.body().childNodes(), 0, out)
        val clean = out.toString().trim()
        if (clean.length > MAX_HTML) throw TooLarge()
        // Only whitespace and empty elements: no signature.
        return if (text(clean).isNotEmpty() || Regex("<img\\b").containsMatchIn(clean)) clean else ""
    }

    /** The cleaned signature, or '' when it can't be cleaned; for signatures stored before. */
    fun reclean(html: String?): String = runCatching { clean(html) }.getOrDefault("")

    /** The readable text of a signature, for the plain-text part. */
    fun text(html: String?): String =
        MailText.htmlToPlain(html.orEmpty()).replace(Regex("[ \\t]+\\n"), "\n").replace(Regex("\\n{3,}"), "\n\n").trim()
}
