package nl.bvdm.rukoo.mail.model

import kotlinx.serialization.Serializable
import nl.bvdm.rukoo.categories.MailSignals

/** A mailbox, desktop's `{name, address}`. Either part can be empty. */
@Serializable
data class Address(val name: String = "", val address: String = "") {
    /** `Name <address>` when the name adds something, else the address (desktop context.js person()). */
    fun display(): String {
        val n = name.trim()
        return if (n.isNotEmpty() && !n.equals(address, ignoreCase = true)) "$n <$address>" else address
    }
}

/**
 * One message header in the cache, desktop's cached message (spec 4 §1.6). The first eleven fields
 * never change on the server (desktop's STORED); the flags do. References are not cached; they come
 * with the full message.
 */
@Serializable
data class CachedMessage(
    val uid: Long,
    /** Message-ID with angle brackets, as the server returns it. */
    val messageId: String? = null,
    val inReplyTo: String? = null,
    val subject: String = "",
    val from: Address = Address(),
    val to: List<Address> = emptyList(),
    val cc: List<Address> = emptyList(),
    val replyTo: List<Address> = emptyList(),
    val date: Long = 0,
    /** Up to 200 characters of body text. */
    val preview: String = "",
    val unread: Boolean = false,
    val starred: Boolean = false,
    val answered: Boolean = false,
    val hasAttachments: Boolean = false,
    val size: Long = 0,
    /** What kind of mail an inbox message is, from its headers (inbox categories); null until a sync fetched them. */
    val signals: MailSignals? = null,
    /** The Gmail tab an inbox message is in (`primary`, `promotions`, `social`, `updates`, `forums`), for Gmail accounts. */
    val gmailTab: String? = null,
)

/**
 * A list row: desktop's publicMessage (engine.js:745-769) plus the threading headers the cache has.
 * [id] is the Rukoo id from [MessageIds]; it changes when the message moves.
 */
@Serializable
data class MessageSummary(
    val id: String,
    val accountId: String,
    val accountColor: String = "",
    val folder: String,
    val role: FolderRole = FolderRole.NONE,
    val uid: Long,
    val messageId: String? = null,
    val inReplyTo: String? = null,
    val subject: String = "",
    val from: Address = Address(),
    val to: List<Address> = emptyList(),
    val cc: List<Address> = emptyList(),
    val replyTo: List<Address> = emptyList(),
    val date: Long = 0,
    val preview: String = "",
    val unread: Boolean = false,
    val starred: Boolean = false,
    val answered: Boolean = false,
    val hasAttachments: Boolean = false,
    /** The sender is in the user's VIP list. */
    val vip: Boolean = false,
    /** What inbox categories sort by: the message's signals and its Gmail tab (CachedMessage). */
    val signals: MailSignals? = null,
    val gmailTab: String? = null,
)

/**
 * An attachment of a parsed message. [index] is its position among all parsed parts, so indexes of
 * listed attachments can have gaps where inline images were left out (spec 4 §1.8).
 */
@Serializable
data class AttachmentInfo(
    val index: Int,
    val filename: String,
    val contentType: String = "application/octet-stream",
    val size: Long = 0,
    /** An inline image the HTML refers to by Content-ID; not listed as an attachment. */
    val related: Boolean = false,
    val contentId: String? = null,
)

/** The List-Unsubscribe header (spec 4 §3.12): an https link, a mailto address, and whether one-click POST works. */
@Serializable
data class Unsubscribe(
    val url: String? = null,
    val mail: String? = null,
    val oneClick: Boolean = false,
)

/**
 * A message parsed from its source, desktop's getMessage (spec 4 §1.8). [html] is sanitized HTML
 * (or the text turned into HTML); [text] is the plain text part, or the HTML as plain text.
 * [attachments] leaves out inline related parts.
 */
@Serializable
data class FullMessage(
    val summary: MessageSummary,
    val from: Address = summary.from,
    val to: List<Address> = summary.to,
    val cc: List<Address> = summary.cc,
    val bcc: List<Address> = emptyList(),
    val replyTo: List<Address> = summary.replyTo,
    val subject: String = summary.subject,
    val date: Long = summary.date,
    val messageId: String? = summary.messageId,
    val inReplyTo: String? = summary.inReplyTo,
    val references: List<String> = emptyList(),
    val html: String = "",
    val isHtml: Boolean = false,
    val text: String = "",
    val unsubscribe: Unsubscribe? = null,
    val attachments: List<AttachmentInfo> = emptyList(),
) {
    val id: String get() = summary.id
    val accountId: String get() = summary.accountId
    val folder: String get() = summary.folder
}

/**
 * What an approval card was made for (desktop tools.js pinOf): the Message-ID and the folder's
 * UIDVALIDITY. A rebuilt server mailbox gets a new UIDVALIDITY and hands out the uids again, so an
 * approved action checks [matches] first and never lands on another message that took over the id.
 */
@Serializable
data class MessagePin(val messageId: String? = null, val uidValidity: String? = null) {
    /** Desktop's samePin: a part that is known on both sides must be equal. */
    fun matches(now: MessagePin): Boolean {
        if (uidValidity != null && now.uidValidity != null && uidValidity != now.uidValidity) return false
        if (messageId != null && MessageIds.headerKey(now.messageId) != MessageIds.headerKey(messageId)) return false
        return true
    }
}

/** One attachment's bytes, desktop's `attachment(id, index)`. */
class AttachmentContent(
    val filename: String,
    val contentType: String,
    val charset: String?,
    val bytes: ByteArray,
)

/** A recipient suggestion for the composer (spec 4 §1.18), best first. */
typealias Contact = Address
