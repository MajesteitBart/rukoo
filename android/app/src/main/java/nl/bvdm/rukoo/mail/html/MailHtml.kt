package nl.bvdm.rukoo.mail.html

import nl.bvdm.rukoo.mail.mime.MimeParser
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element

/**
 * Email HTML made safe to show. Desktop strips active content with regexes (mailutil.js
 * sanitizeHtml) and relies on a script-less sandboxed iframe; the phone renders in a WebView with
 * JavaScript off and cleans the parsed DOM instead, which can't be fooled by odd markup. Styles,
 * style sheets, remote images and links stay, like desktop (spec 4 §6.1, §6.4).
 */
object MailHtml {
    /** Elements removed with everything inside them. */
    private val DROP = setOf(
        "script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "portal", "fencedframe",
        "param", "template",
    )

    /** Attributes holding a URL that could run something. */
    private val URL_ATTRS = setOf(
        "href", "src", "action", "formaction", "background", "poster", "xlink:href", "data", "codebase", "cite",
        "longdesc", "lowsrc", "dynsrc", "srcset", "ping",
    )

    private val UNSAFE_URL = Regex("^(javascript|vbscript|livescript|data:text/html|data:application/x?html)", RegexOption.IGNORE_CASE)
    private val CID = Regex("\\bcid:([^'\"\\s)]{1,256})", RegexOption.IGNORE_CASE)

    private fun isUnsafeUrl(value: String): Boolean {
        // Browsers ignore whitespace and control characters inside a scheme ("java\tscript:").
        val compact = value.filter { it > ' ' && it != '\u007f' }
        return UNSAFE_URL.containsMatchIn(compact)
    }

    /**
     * Cleans [html] and returns it as a document string. Inline images referred to as `cid:` become the
     * data: URLs in [inline] (keys from [MimeParser.cidKey]), as mailparser does for desktop.
     */
    fun sanitize(html: String, inline: Map<String, String> = emptyMap()): String {
        val doc = Jsoup.parse(html)
        clean(doc, inline)
        doc.outputSettings().prettyPrint(false)
        return doc.outerHtml()
    }

    internal fun clean(doc: Document, inline: Map<String, String>) {
        doc.select(DROP.joinToString(",")).remove()
        // A refresh would navigate the reader away; other meta tags are harmless.
        doc.select("meta[http-equiv]").remove()
        // Forms can't submit without their tag; their fields stay as inert text boxes, like desktop.
        doc.select("form").unwrap()
        doc.select("link").forEach { if (!it.attr("rel").equals("stylesheet", ignoreCase = true)) it.remove() }
        for (el in doc.getAllElements()) {
            for (attr in el.attributes().asList()) {
                val key = attr.key.lowercase()
                when {
                    key.startsWith("on") -> el.removeAttr(attr.key)
                    key in URL_ATTRS && isUnsafeUrl(attr.value) ->
                        if (key == "href" || key == "action" || key == "src") el.attr(attr.key, "#") else el.removeAttr(attr.key)
                    key == "style" && inline.isNotEmpty() -> el.attr(attr.key, resolveCid(attr.value, inline))
                    (key == "src" || key == "background") && inline.isNotEmpty() -> el.attr(attr.key, resolveCid(attr.value, inline))
                }
            }
            if (el.normalName() == "style" && inline.isNotEmpty()) {
                val css = el.data()
                val resolved = resolveCid(css, inline)
                if (resolved != css) el.empty().appendChild(org.jsoup.nodes.DataNode(resolved))
            }
        }
    }

    private fun resolveCid(value: String, inline: Map<String, String>): String =
        CID.replace(value) { m -> inline[MimeParser.cidKey(m.groupValues[1])] ?: m.value }

    /**
     * The mail as a fragment to put inside another document (a reply's blockquote): its style sheets
     * followed by the body's content, without html, head or body tags.
     */
    fun fragment(html: String): String {
        if (html.isBlank()) return ""
        val doc = Jsoup.parse(html)
        doc.outputSettings().prettyPrint(false)
        val styles = doc.head().select("style, link[rel=stylesheet]").joinToString("") { it.outerHtml() }
        return styles + doc.body().html()
    }

    /** The body element's own attributes that carry presentation, for wrapping the body elsewhere. */
    internal val BODY_ATTRS = setOf("style", "bgcolor", "background", "text", "link", "vlink", "alink", "dir", "lang", "class", "data-rukoo-canvas")

    internal fun bodyAttributes(body: Element): String =
        body.attributes().asList().filter { it.key.lowercase() in BODY_ATTRS }.joinToString("") { " ${it.html()}" }
}
