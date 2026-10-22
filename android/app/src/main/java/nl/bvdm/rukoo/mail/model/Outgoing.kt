package nl.bvdm.rukoo.mail.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** What the composer is writing. The serial names are the agent tools' `mode` values. */
@Serializable
enum class ReplyKind {
    @SerialName("new") NEW,
    @SerialName("reply") REPLY,
    @SerialName("reply_all") REPLY_ALL,
    @SerialName("forward") FORWARD,
    /** A saved draft opened again. */
    @SerialName("draft") DRAFT,
}

/** A file to attach: a local file the app can read (copied into its own storage first). */
@Serializable
data class OutgoingAttachment(
    val filename: String,
    val contentType: String = "application/octet-stream",
    /** Absolute path of the file in the app's storage. */
    val path: String,
    val size: Long = 0,
    /** Forwarded attachments: the source message and attachment index, fetched at send time. */
    val sourceMessageId: String? = null,
    val sourceIndex: Int? = null,
)

/**
 * A message to send or save (spec 4 §3.2). [text] is what the user typed, without signature or quote, and
 * [html] the same with its formatting when it has any;
 * the engine builds the HTML and plain bodies from it, the account's signature and [quote], the way
 * desktop's composer lays them out. Threading headers come from the source.
 */
@Serializable
data class OutgoingMessage(
    val accountId: String,
    val from: Address,
    val to: List<Address> = emptyList(),
    val cc: List<Address> = emptyList(),
    val bcc: List<Address> = emptyList(),
    val subject: String = "",
    val text: String = "",
    val inReplyTo: String? = null,
    val references: List<String> = emptyList(),
    val attachments: List<OutgoingAttachment> = emptyList(),
    val replyKind: ReplyKind = ReplyKind.NEW,
    /** The Rukoo id of the message replied to or forwarded; it gets the \Answered flag after a reply. */
    val sourceMessageId: String? = null,
    /**
     * The quoted original as an HTML block (desktop's `data-rukoo-quote` header and blockquote, see
     * mail.compose.Quote), appended after the text and signature. Empty for no quote.
     */
    val quote: String = "",
    /** Whether the account's signature (MailEngine.signatureFor) goes under the text. */
    val signature: Boolean = true,
    /** The Rukoo id of the stored draft this message replaces; it is deleted after sending or saving again. */
    val draftId: String? = null,
    /** [text] with its formatting, in the composer's HTML subset (mail.compose.RichText); null for plain text. */
    val html: String? = null,
)
