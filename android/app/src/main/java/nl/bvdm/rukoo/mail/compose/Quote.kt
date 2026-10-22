package nl.bvdm.rukoo.mail.compose

import java.time.Instant
import java.time.ZoneId
import java.time.chrono.IsoChronology
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.time.format.FormatStyle
import java.util.Locale
import nl.bvdm.rukoo.mail.html.MailHtml
import nl.bvdm.rukoo.mail.mime.MailText
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.FullMessage
import org.jsoup.Jsoup
import org.jsoup.nodes.Element

/**
 * The header lines above a quoted message, as format strings with one `%1$s` each (desktop's
 * composer.quote.* keys). The engine fills them from the app's catalog; [ENGLISH] is for tests and
 * callers without resources.
 */
data class QuoteLabels(
    val marker: String,
    val from: String,
    val date: String,
    val to: String,
    val subject: String,
) {
    companion object {
        val ENGLISH = QuoteLabels(
            marker = "-------- Original message --------",
            from = "From: %1\$s",
            date = "Date: %1\$s",
            to = "To: %1\$s",
            subject = "Subject: %1\$s",
        )

        /** The markers of earlier English and Dutch drafts, for finding a quote without the data attribute. */
        internal val MARKERS = Regex("^-------- (Oorspronkelijk bericht|Original message) --------")
    }
}

/** A quote split off a reopened draft: the header text and the quoted HTML. */
data class SplitQuote(val body: String, val head: String?, val quoteHtml: String?)

/** Desktop's quote format (composer.js:227-237, 822-828; spec 4 §3.6), kept exactly so drafts round-trip. */
object Quote {
    const val WRAPPER_OPEN = "<div style=\"font-family:'Segoe UI',Arial,sans-serif;font-size:12pt\">"
    private const val HEAD_STYLE = "font-size:13px;color:#555"
    private const val BLOCKQUOTE_STYLE = "margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex"

    /** `Name <address>`, or the address alone (ui.js formatAddress). */
    fun formatAddress(a: Address?): String = when {
        a == null -> ""
        a.name.isNotEmpty() -> "${a.name} <${a.address}>"
        else -> a.address
    }

    /**
     * Desktop's quoteDate: the numeric date in the locale's order with two-digit day and month and a
     * four-digit year, the time as HH:mm, and the offset from GMT ("22-10-2026 14:45 (GMT+02:00)").
     */
    fun quoteDate(ms: Long, zone: ZoneId, locale: Locale): String {
        val at = Instant.ofEpochMilli(ms).atZone(zone)
        val pattern = DateTimeFormatterBuilder.getLocalizedDateTimePattern(FormatStyle.SHORT, null, IsoChronology.INSTANCE, locale)
            .replace(Regex("y+"), "yyyy").replace(Regex("d+"), "dd").replace(Regex("M+"), "MM")
        val date = DateTimeFormatter.ofPattern(pattern, locale).format(at)
        val offset = at.offset.totalSeconds / 60
        val sign = if (offset >= 0) "+" else "-"
        val abs = Math.abs(offset)
        return "$date ${DateTimeFormatter.ofPattern("HH:mm", locale).format(at)} (GMT$sign${"%02d".format(abs / 60)}:${"%02d".format(abs % 60)})"
    }

    fun header(m: FullMessage, labels: QuoteLabels, zone: ZoneId, locale: Locale): String {
        val lines = mutableListOf(
            labels.marker,
            labels.from.format(formatAddress(m.from)),
            labels.date.format(quoteDate(m.date, zone, locale)),
            labels.to.format(m.to.joinToString(", ") { formatAddress(it) }),
        )
        // Desktop writes the Cc label untranslated.
        if (m.cc.isNotEmpty()) lines += "Cc: ${m.cc.joinToString(", ") { formatAddress(it) }}"
        lines += labels.subject.format(m.subject)
        return lines.joinToString("\n")
    }

    /**
     * The block appended after the user's text: a `data-rukoo-quote` header and the original in a
     * blockquote, starting with the line break desktop puts before it.
     */
    fun block(head: String, originalHtml: String): String =
        "<br><div data-rukoo-quote style=\"$HEAD_STYLE\">${MailText.esc(head).replace("\n", "<br>")}</div><br>" +
            "<blockquote style=\"$BLOCKQUOTE_STYLE\">$originalHtml</blockquote>"

    /** The quote block of [m], with its sanitized HTML as a fragment. */
    fun of(m: FullMessage, labels: QuoteLabels, zone: ZoneId, locale: Locale): String =
        block(header(m, labels, zone, locale), MailHtml.fragment(m.html))

    /** The quote as plain text for the text part: header, then the original with "> " before each line. */
    fun plain(quoteHtml: String): String {
        if (quoteHtml.isBlank()) return ""
        val doc = Jsoup.parse(quoteHtml)
        val head = doc.selectFirst("div[data-rukoo-quote]")?.let { el ->
            el.select("br").forEach { it.replaceWith(org.jsoup.nodes.TextNode("\n")) }
            el.wholeText().trim()
        }.orEmpty()
        val quoted = doc.selectFirst("blockquote")?.html()?.let { MailText.htmlToPlain(it) }.orEmpty()
        val body = quoted.lines().joinToString("\n") { if (it.isEmpty()) ">" else "> $it" }
        return listOf(head, body).filter { it.isNotBlank() }.joinToString("\n\n")
    }

    /**
     * Splits a reopened draft's HTML (composer.js splitQuote): the first div marked `data-rukoo-quote`,
     * or whose text starts with an English or Dutch quote marker, followed by a blockquote, is cut out.
     */
    fun split(html: String): SplitQuote {
        val doc = Jsoup.parse(html)
        doc.outputSettings().prettyPrint(false)
        for (head in doc.body().select("div")) {
            if (!head.hasAttr("data-rukoo-quote") && !QuoteLabels.MARKERS.containsMatchIn(head.text().trim())) continue
            var quote: Element? = head.nextElementSibling()
            while (quote != null && quote.normalName() == "br") quote = quote.nextElementSibling()
            if (quote == null || quote.normalName() != "blockquote") continue
            head.select("br").forEach { it.replaceWith(org.jsoup.nodes.TextNode("\n")) }
            val text = head.wholeText().trim()
            val quoteHtml = quote.html()
            // Remove the line break before the header, the header, the breaks after it and the quote.
            head.previousSibling()?.takeIf { it is Element && it.normalName() == "br" }?.remove()
            var node: org.jsoup.nodes.Node? = head
            while (node != null && node !== quote) {
                val next = node.nextSibling()
                node.remove()
                node = next
            }
            quote.remove()
            return SplitQuote(doc.body().html(), text, quoteHtml)
        }
        return SplitQuote(html, null, null)
    }
}
