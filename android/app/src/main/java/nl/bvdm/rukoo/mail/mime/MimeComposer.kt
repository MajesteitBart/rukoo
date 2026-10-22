package nl.bvdm.rukoo.mail.mime

import jakarta.activation.CommandMap
import jakarta.activation.DataHandler
import jakarta.activation.MailcapCommandMap
import jakarta.mail.Message
import jakarta.mail.Session
import jakarta.mail.internet.InternetAddress
import jakarta.mail.internet.MimeBodyPart
import jakarta.mail.internet.MimeMessage
import jakarta.mail.internet.MimeMultipart
import jakarta.mail.internet.MimeUtility
import jakarta.mail.util.ByteArrayDataSource
import java.io.ByteArrayOutputStream
import java.util.Date
import java.util.Properties
import nl.bvdm.rukoo.mail.model.Address

/** A file in an outgoing message. [cid] makes it an inline image the HTML refers to as `cid:<cid>`. */
class MailAttachment(
    val filename: String,
    val contentType: String,
    val bytes: ByteArray,
    val cid: String? = null,
)

/**
 * A message ready to be written as MIME, desktop's buildMail result (spec 4 §3.2). Bcc goes into the
 * header only with [keepBcc] (drafts); sent mail carries it in the SMTP envelope alone.
 */
class ComposedMail(
    val from: Address,
    val to: List<Address> = emptyList(),
    val cc: List<Address> = emptyList(),
    val bcc: List<Address> = emptyList(),
    val subject: String = "",
    val text: String = "",
    val html: String? = null,
    val inReplyTo: String? = null,
    val references: List<String> = emptyList(),
    val date: Long,
    val messageId: String,
    val attachments: List<MailAttachment> = emptyList(),
    /** Extra headers, such as the demo newsletters' List-Unsubscribe. */
    val headers: Map<String, String> = emptyMap(),
    val keepBcc: Boolean = false,
) {
    val recipients: List<Address> get() = to + cc + bcc
}

/**
 * Writes [ComposedMail] as RFC 822 bytes the way nodemailer's MailComposer lays it out:
 * mixed(alternative(text, related(html, inline images)), attachments), leaving out the levels a
 * message doesn't need.
 */
object MimeComposer {
    private val session: Session by lazy {
        ensureMailcap()
        Session.getInstance(Properties().apply { setProperty("mail.mime.encodefilename", "true") })
    }

    /**
     * Some Android builds lose META-INF/mailcap from the jars; Jakarta Mail then can't write text or
     * multipart content. Registering Angus's handlers directly makes that independent of packaging.
     */
    fun ensureMailcap() {
        val map = CommandMap.getDefaultCommandMap() as? MailcapCommandMap ?: return
        if (map.createDataContentHandler("multipart/mixed") != null && map.createDataContentHandler("text/plain") != null) return
        map.addMailcap("text/plain;; x-java-content-handler=org.eclipse.angus.mail.handlers.text_plain")
        map.addMailcap("text/html;; x-java-content-handler=org.eclipse.angus.mail.handlers.text_html")
        map.addMailcap("text/xml;; x-java-content-handler=org.eclipse.angus.mail.handlers.text_xml")
        map.addMailcap("multipart/*;; x-java-content-handler=org.eclipse.angus.mail.handlers.multipart_mixed; x-java-fallback-entry=true")
        map.addMailcap("message/rfc822;; x-java-content-handler=org.eclipse.angus.mail.handlers.message_rfc822")
    }

    /** Lenient: a draft may hold an address the user is still typing; sending validates first. */
    fun internetAddress(a: Address): InternetAddress = InternetAddress().apply {
        address = a.address.trim()
        if (a.name.isNotBlank()) setPersonal(a.name, "UTF-8")
    }

    private fun textPart(text: String, subtype: String): MimeBodyPart = MimeBodyPart().apply {
        // A data source rather than setText: writing it needs no content handler from mailcap.
        dataHandler = DataHandler(ByteArrayDataSource(text.toByteArray(Charsets.UTF_8), "text/$subtype; charset=UTF-8"))
        setHeader("Content-Type", "text/$subtype; charset=UTF-8")
    }

    private fun filePart(a: MailAttachment): MimeBodyPart = MimeBodyPart().apply {
        dataHandler = DataHandler(ByteArrayDataSource(a.bytes, a.contentType))
        fileName = a.filename
        if (a.cid != null) {
            disposition = MimeBodyPart.INLINE
            contentID = "<${a.cid}>"
        } else {
            disposition = MimeBodyPart.ATTACHMENT
        }
    }

    /** A message's readable content: one text part, or a multipart of them. */
    private sealed interface Content {
        class Text(val text: String, val subtype: String) : Content {
            val type: String get() = "text/$subtype; charset=UTF-8"
        }

        class Multi(val multipart: MimeMultipart) : Content
    }

    private fun Content.asPart(): MimeBodyPart = when (this) {
        is Content.Text -> textPart(text, subtype)
        is Content.Multi -> MimeBodyPart().apply { setContent(multipart) }
    }

    fun compose(mail: ComposedMail): ByteArray {
        val msg = object : MimeMessage(session) {
            // Our own Message-ID: Jakarta's would end in the phone's host name, and drafts are found again by it.
            override fun updateMessageID() = setHeader("Message-ID", mail.messageId)
        }
        msg.setFrom(internetAddress(mail.from))
        if (mail.to.isNotEmpty()) msg.setRecipients(Message.RecipientType.TO, mail.to.map(::internetAddress).toTypedArray())
        if (mail.cc.isNotEmpty()) msg.setRecipients(Message.RecipientType.CC, mail.cc.map(::internetAddress).toTypedArray())
        if (mail.keepBcc && mail.bcc.isNotEmpty()) msg.setRecipients(Message.RecipientType.BCC, mail.bcc.map(::internetAddress).toTypedArray())
        msg.setSubject(mail.subject, "UTF-8")
        msg.sentDate = Date(mail.date)
        mail.inReplyTo?.takeIf { it.isNotBlank() }?.let { msg.setHeader("In-Reply-To", it) }
        if (mail.references.isNotEmpty()) msg.setHeader("References", MimeUtility.fold(12, mail.references.joinToString(" ")))
        for ((name, value) in mail.headers) msg.setHeader(name, value)

        val inline = mail.attachments.filter { it.cid != null }
        val files = mail.attachments.filter { it.cid == null }
        // The readable part: plain text alone, HTML alone (with its inline images), or both as alternatives.
        // Like nodemailer, only the parts the message has: an HTML-only newsletter gets no empty text part.
        val htmlOrRelated: Content? = mail.html?.let { html ->
            if (inline.isEmpty()) {
                Content.Text(html, "html")
            } else {
                Content.Multi(MimeMultipart("related").apply { addBodyPart(textPart(html, "html")); inline.forEach { addBodyPart(filePart(it)) } })
            }
        }
        val readable: Content = when {
            htmlOrRelated == null -> Content.Text(mail.text, "plain")
            mail.text.isEmpty() -> htmlOrRelated
            else -> Content.Multi(MimeMultipart("alternative").apply { addBodyPart(textPart(mail.text, "plain")); addBodyPart(htmlOrRelated.asPart()) })
        }
        if (files.isNotEmpty()) {
            msg.setContent(MimeMultipart("mixed").apply { addBodyPart(readable.asPart()); files.forEach { addBodyPart(filePart(it)) } })
        } else {
            when (readable) {
                is Content.Multi -> msg.setContent(readable.multipart)
                is Content.Text -> {
                    msg.dataHandler = DataHandler(ByteArrayDataSource(readable.text.toByteArray(Charsets.UTF_8), readable.type))
                    msg.setHeader("Content-Type", readable.type)
                }
            }
        }
        msg.saveChanges()
        return ByteArrayOutputStream().also { msg.writeTo(it) }.toByteArray()
    }
}
