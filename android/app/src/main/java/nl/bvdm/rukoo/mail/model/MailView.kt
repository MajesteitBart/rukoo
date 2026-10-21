package nl.bvdm.rukoo.mail.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Desktop's views (engine.js:805-826). INBOX, UNREAD and VIP leave out senders on the spam list;
 * STARRED spans every folder except Trash and Spam; ARCHIVE includes Gmail's All Mail without the
 * copies that sit in another folder; EVERYTHING is every cached message ("search all folders").
 */
@Serializable
enum class ViewKind {
    @SerialName("inbox") INBOX,
    @SerialName("unread") UNREAD,
    @SerialName("vip") VIP,
    @SerialName("starred") STARRED,
    @SerialName("drafts") DRAFTS,
    @SerialName("sent") SENT,
    @SerialName("archive") ARCHIVE,
    @SerialName("junk") JUNK,
    @SerialName("trash") TRASH,
    @SerialName("folder") FOLDER,
    @SerialName("everything") EVERYTHING,
}

/**
 * What a message list shows: a view over all accounts ([accountId] null, desktop's scope `all`) or one
 * account. FOLDER needs both [accountId] and [folder].
 */
@Serializable
data class MailView(
    val kind: ViewKind = ViewKind.INBOX,
    val accountId: String? = null,
    val folder: String? = null,
) {
    companion object {
        val AllInboxes = MailView()

        fun folder(accountId: String, path: String) = MailView(ViewKind.FOLDER, accountId, path)
    }
}

/** Desktop's `sort` setting (engine.js:842-848). */
@Serializable
enum class SortOrder(val wire: String) {
    @SerialName("date-desc") DATE_DESC("date-desc"),
    @SerialName("date-asc") DATE_ASC("date-asc"),
    /** Unread first, then newest. */
    @SerialName("unread") UNREAD("unread"),
    /** By sender name or address, then newest. */
    @SerialName("sender") SENDER("sender"),
}

/** The list's quick filters, applied on top of a view (app.js:53-58). */
enum class QuickFilter { ALL, UNREAD, STARRED, ATTACHMENTS }
