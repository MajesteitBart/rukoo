package nl.bvdm.rukoo.mail.compose

import java.security.SecureRandom
import java.util.Base64
import nl.bvdm.rukoo.mail.mime.MailAttachment
import nl.bvdm.rukoo.mail.mime.MailText
import nl.bvdm.rukoo.mail.model.Signature

/** The HTML and plain-text bodies of a message written in the phone's plain-text composer. */
data class ComposedBody(val html: String, val text: String)

/**
 * Builds what desktop's composer sends (composer.js payload, spec 4 §3.6-3.10) from plain text: the
 * typed lines, the account's signature as `<div class="signature">`, the quote block, all inside
 * desktop's font wrapper, so a draft or a sent mail looks the same and reopens the same on desktop.
 */
object ComposeBody {
    /**
     * [text] is what the user typed. The composer keeps the signature out of it, so an agent's draft that
     * replaces the text never takes the signature along; [signature] always goes under the text, formatted,
     * above the quote as desktop places it (composer.js:96-98, 1121-1126). Null leaves it out.
     */
    fun build(text: String, signature: Signature?, rawQuote: String): ComposedBody {
        val quote = Quote.normalize(rawQuote)
        val typed = text.replace("\r\n", "\n").trimEnd()
        val sigHtml = signature?.html?.takeIf { it.isNotBlank() }
        val signatureBlock = sigHtml?.let { "<div><br></div><div class=\"signature\">$it</div>" }.orEmpty()
        val body = "<div>${MailText.esc(typed).replace("\n", "<br>").ifEmpty { "<br>" }}</div>"
        val html = "${Quote.WRAPPER_OPEN}$body$signatureBlock$quote</div>"
        val sigText = if (sigHtml != null) signature.text.trim() else ""
        val plain = listOf(typed, sigText, Quote.plain(quote)).filter { it.isNotEmpty() }.joinToString("\n\n")
        return ComposedBody(html, plain)
    }

    private val DATA_IMAGE = Regex(
        "(<img\\b[^>]*?\\ssrc\\s*=\\s*)([\"'])data:image/(png|jpe?g|gif|webp);base64,([a-z0-9+/=\\s]+)\\2",
        RegexOption.IGNORE_CASE,
    )
    private val random = SecureRandom()

    /**
     * Inline data: images (a signature's logo) go out as inline attachments the HTML refers to by
     * Content-ID, because Gmail and Outlook drop data: images; the same picture twice is attached once
     * (mailutil.js inlineDataImages).
     */
    fun inlineDataImages(html: String): Pair<String, List<MailAttachment>> {
        val attachments = mutableListOf<MailAttachment>()
        val byData = mutableMapOf<String, String>()
        val out = DATA_IMAGE.replace(html) { m ->
            val (prefix, quote, type, data) = m.destructured
            val base64 = data.replace(Regex("\\s+"), "")
            val cid = byData.getOrPut(base64) {
                val bytes = ByteArray(10).also(random::nextBytes)
                val cid = bytes.joinToString("") { "%02x".format(it) } + "@rukoo"
                val ext = if (type.lowercase() == "jpg") "jpeg" else type.lowercase()
                val content = runCatching { Base64.getMimeDecoder().decode(base64) }.getOrElse { ByteArray(0) }
                attachments += MailAttachment("image-${attachments.size + 1}.${if (ext == "jpeg") "jpg" else ext}", "image/$ext", content, cid)
                cid
            }
            "$prefix${quote}cid:$cid$quote"
        }
        return out to attachments
    }
}
