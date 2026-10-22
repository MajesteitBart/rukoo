package nl.bvdm.rukoo.mail.mime

import jakarta.mail.Part
import jakarta.mail.Session
import jakarta.mail.internet.ContentType
import jakarta.mail.internet.InternetAddress
import jakarta.mail.internet.MimeMessage
import jakarta.mail.internet.MimeMultipart
import jakarta.mail.internet.MimePart
import jakarta.mail.internet.MimePartDataSource
import jakarta.mail.internet.MimeUtility
import java.io.ByteArrayInputStream
import java.util.Properties
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.Unsubscribe

/** One non-body part of a parsed message. [index] counts every such part, inline images included (spec 4 §1.8). */
class ParsedAttachment(
    val index: Int,
    /** Null when the part has no name; the engine numbers it then. */
    val filename: String?,
    val contentType: String,
    val charset: String?,
    val contentId: String?,
    /** An inline image the HTML refers to; not listed as an attachment. */
    val related: Boolean,
    val bytes: ByteArray,
) {
    val size: Long get() = bytes.size.toLong()
}

/** A message parsed from its raw source, what desktop gets from mailparser's simpleParser. */
class ParsedMail(
    val from: List<Address>,
    val to: List<Address>,
    val cc: List<Address>,
    val bcc: List<Address>,
    val replyTo: List<Address>,
    val subject: String?,
    val date: Long?,
    val messageId: String?,
    val inReplyTo: String?,
    val references: List<String>,
    /** The HTML body as sent, or null for plain mail. */
    val html: String?,
    val text: String?,
    val attachments: List<ParsedAttachment>,
    val unsubscribe: Unsubscribe?,
) {
    /** `cid` (without brackets, lower case) → a data: URL, for inline images. */
    fun inlineImages(): Map<String, String> = attachments.filter { !it.contentId.isNullOrEmpty() }.associate {
        MimeParser.cidKey(it.contentId!!) to "data:${it.contentType};base64,${java.util.Base64.getEncoder().encodeToString(it.bytes)}"
    }
}

/** Parses raw RFC 822 messages with Jakarta Mail, leniently, the way mailparser reads them on desktop. */
object MimeParser {
    private val session: Session by lazy {
        Session.getInstance(
            Properties().apply {
                setProperty("mail.mime.address.strict", "false")
                setProperty("mail.mime.decodetext.strict", "false")
                setProperty("mail.mime.parameters.strict", "false")
                setProperty("mail.mime.decodefilename", "true")
                setProperty("mail.mime.decodeparameters", "true")
                setProperty("mail.mime.base64.ignoreerrors", "true")
                setProperty("mail.mime.multipart.ignoremissingendboundary", "true")
                setProperty("mail.mime.multipart.ignoremissingboundaryparameter", "true")
            },
        )
    }

    private val MESSAGE_ID = Regex("<[^<>]*>")

    fun cidKey(cid: String): String = cid.trim().removePrefix("<").removeSuffix(">").lowercase()

    fun parse(raw: ByteArray): ParsedMail {
        val msg = MimeMessage(session, ByteArrayInputStream(raw))
        val body = Body()
        walk(msg, body, inRelated = false)
        val listUnsubscribe = header(msg, "List-Unsubscribe")
        return ParsedMail(
            from = addresses(msg, "From"),
            to = addresses(msg, "To"),
            cc = addresses(msg, "Cc"),
            bcc = addresses(msg, "Bcc"),
            replyTo = addresses(msg, "Reply-To"),
            subject = runCatching { msg.subject }.getOrNull() ?: header(msg, "Subject"),
            date = runCatching { msg.sentDate?.time }.getOrNull(),
            messageId = header(msg, "Message-ID")?.let { MESSAGE_ID.find(it)?.value ?: it.trim() }?.takeIf { it.isNotEmpty() },
            inReplyTo = header(msg, "In-Reply-To")?.let { MESSAGE_ID.find(it)?.value ?: it.trim() }?.takeIf { it.isNotEmpty() },
            references = header(msg, "References")?.let { refs -> MESSAGE_ID.findAll(refs).map { it.value }.toList() }.orEmpty(),
            html = body.html,
            text = body.text,
            attachments = body.attachments,
            unsubscribe = unsubscribeInfo(listUnsubscribe, header(msg, "List-Unsubscribe-Post")),
        )
    }

    /**
     * The List-Unsubscribe header (RFC 2369) with one-click support (RFC 8058, https only), as desktop's
     * unsubscribeInfo (mailutil.js:239-249). [mail] keeps the `mailto:` link with its query.
     */
    fun unsubscribeInfo(listUnsubscribe: String?, post: String?): Unsubscribe? {
        if (listUnsubscribe.isNullOrBlank()) return null
        val links = Regex("<([^>]*)>").findAll(listUnsubscribe).map { it.groupValues[1].trim() }.toList()
            .ifEmpty { listUnsubscribe.split(',').map { it.trim() } }
        val url = links.firstOrNull { Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(it) }
        val mail = links.firstOrNull { it.startsWith("mailto:", ignoreCase = true) }?.let { "mailto:" + it.substring(7) }
        val oneClick = url != null && url.startsWith("https:", ignoreCase = true) && post?.contains("one-click", ignoreCase = true) == true
        return if (url != null || mail != null) Unsubscribe(url, mail, oneClick) else null
    }

    private fun header(part: Part, name: String): String? =
        runCatching { part.getHeader(name)?.firstOrNull() }.getOrNull()?.let { MimeUtility.unfold(it) }?.trim()

    private fun addresses(msg: MimeMessage, name: String): List<Address> {
        val value = runCatching { msg.getHeader(name, ",") }.getOrNull() ?: return emptyList()
        val parsed = runCatching { InternetAddress.parseHeader(value, false).toList() }.getOrElse {
            // A header Jakarta can't read: keep what looks like addresses.
            Regex("[^\\s<>,;\"]+@[^\\s<>,;\"]+").findAll(value).map { InternetAddress().apply { address = it.value } }.toList()
        }
        return parsed.flatMap { a ->
            // Groups are flattened, like desktop's addressFromParsed.
            if (runCatching { a.isGroup }.getOrDefault(false)) {
                runCatching { a.getGroup(false)?.toList() }.getOrNull().orEmpty()
            } else {
                listOf(a)
            }
        }.map { Address(it.personal.orEmpty(), it.address.orEmpty()) }
    }

    private class Body {
        var html: String? = null
        var text: String? = null
        val attachments = mutableListOf<ParsedAttachment>()
    }

    private fun contentType(part: Part): ContentType =
        runCatching { ContentType(part.contentType) }.getOrElse { ContentType("text", "plain", null) }

    private fun disposition(part: Part): String? = runCatching { part.disposition }.getOrNull()?.lowercase()

    private fun bytes(part: Part): ByteArray {
        // Angus decodes quoted-printable with a call per soft line break, so a part made of thousands of them runs
        // out of stack. MailText decodes it in one pass instead.
        val encoding = runCatching { (part as? MimePart)?.encoding }.getOrNull()?.trim()?.lowercase()
        if (encoding == "quoted-printable") raw(part)?.let { return MailText.decodeQuotedPrintable(it) }
        return try {
            part.inputStream.use { it.readBytes() }
        } catch (e: Exception) {
            // A broken transfer encoding: keep the bytes as they are rather than lose the part.
            raw(part) ?: ByteArray(0)
        }
    }

    /** The part's content before its transfer encoding is undone. */
    private fun raw(part: Part): ByteArray? = runCatching {
        when (part) {
            is jakarta.mail.internet.MimeBodyPart -> part.rawInputStream
            is MimeMessage -> part.rawInputStream
            else -> null
        }?.use { it.readBytes() }
    }.getOrNull()

    private fun walk(part: Part, body: Body, inRelated: Boolean, depth: Int = 0) {
        val type = contentType(part)
        val base = type.baseType.lowercase()
        val disposition = disposition(part)
        if (base.startsWith("multipart/")) {
            // Nesting past the limit is a crafted message, not mail: what is below it is left out.
            if (depth >= Structure.MAX_DEPTH) return
            val multipart = runCatching { MimeMultipart(MimePartDataSource(part as MimePart)) }.getOrNull() ?: return
            val count = runCatching { multipart.count }.getOrDefault(0)
            val related = inRelated || base == "multipart/related"
            if (base == "multipart/alternative") {
                // The alternatives come in rising preference: the last HTML and the last plain text win.
                for (i in 0 until count) {
                    val child = Body()
                    walk(multipart.getBodyPart(i), child, related, depth + 1)
                    child.html?.let { body.html = it }
                    child.text?.let { body.text = it }
                    for (a in child.attachments) body.attachments += a.reindexed(body.attachments.size)
                }
            } else {
                for (i in 0 until count) walk(multipart.getBodyPart(i), body, related, depth + 1)
            }
            return
        }
        val isBodyText = (base == "text/plain" || base == "text/html") && disposition != "attachment"
        if (isBodyText) {
            val text = MailText.decodeCharset(bytes(part), type.getParameter("charset"))
            if (base == "text/html") {
                body.html = body.html?.let { it + text } ?: text
            } else {
                body.text = body.text?.let { "$it\n$text" } ?: text
                // A plain tail after HTML in a mixed message (a mailing list footer) shows in the HTML too, like mailparser.
                body.html?.let { body.html = it + MailText.textToHtml(text) }
            }
            return
        }
        val contentId = runCatching { (part as? MimePart)?.contentID }.getOrNull()?.takeIf { it.isNotBlank() }
        val filename = runCatching { part.fileName }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: type.getParameter("name")?.let { runCatching { MimeUtility.decodeText(it) }.getOrDefault(it) }
        body.attachments += ParsedAttachment(
            index = body.attachments.size,
            filename = filename,
            contentType = base,
            charset = type.getParameter("charset"),
            contentId = contentId,
            related = inRelated && contentId != null || (disposition == "inline" && contentId != null),
            bytes = bytes(part),
        )
    }

    private fun ParsedAttachment.reindexed(i: Int) =
        if (i == index) this else ParsedAttachment(i, filename, contentType, charset, contentId, related, bytes)
}
