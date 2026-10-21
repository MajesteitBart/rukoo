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
 * A message to send (spec 4 §3.2). [text] is the plain body; [html], when set, is the HTML body the
 * composer built from it (quote and signature included). Threading headers come from the source.
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
    val html: String? = null,
    val inReplyTo: String? = null,
    val references: List<String> = emptyList(),
    val attachments: List<OutgoingAttachment> = emptyList(),
    val replyKind: ReplyKind = ReplyKind.NEW,
    /** The Rukoo id of the message replied to or forwarded; it gets the \Answered flag after a reply. */
    val sourceMessageId: String? = null,
)
