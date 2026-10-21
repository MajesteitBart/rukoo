package nl.bvdm.rukoo.mail

import java.io.File
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.AccountPatch
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.AttachmentContent
import nl.bvdm.rukoo.mail.model.DeleteResult
import nl.bvdm.rukoo.mail.model.Folder
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.GoogleClient
import nl.bvdm.rukoo.mail.model.GoogleTokens
import nl.bvdm.rukoo.mail.model.Identity
import nl.bvdm.rukoo.mail.model.ImapAccountInput
import nl.bvdm.rukoo.mail.model.ImportedAccount
import nl.bvdm.rukoo.mail.model.MailCounts
import nl.bvdm.rukoo.mail.model.MailEvent
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.MessagePin
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.model.MoveResult
import nl.bvdm.rukoo.mail.model.OutgoingMessage
import nl.bvdm.rukoo.mail.model.SortOrder
import nl.bvdm.rukoo.mail.model.SyncStatus
import nl.bvdm.rukoo.mail.model.UndoResult
import nl.bvdm.rukoo.mail.model.UnsubscribeResult

/**
 * The phone's mail engine, the port of desktop's Engine (spec 4 §8). Lists, counts and search come
 * from the local cache; changes are optimistic and revert when the server refuses. Failures throw
 * [MailException] with a message the UI may show. Ids are Rukoo ids from MessageIds.
 */
interface MailEngine {
    val accounts: StateFlow<List<Account>>

    /** True once accounts were read from disk; until then an empty [accounts] means "not known yet", not "first run". */
    val loaded: StateFlow<Boolean>

    /** Folders per account id, with roles; Gmail's Starred and Important included (the UI hides them). */
    val folders: StateFlow<Map<String, List<Folder>>>

    val sync: StateFlow<SyncStatus>

    /** Unread inbox messages across all accounts: the badge and the drawer total. */
    val unreadCount: StateFlow<Int>

    val events: SharedFlow<MailEvent>

    /** Messages in [view] from the cache, sorted, updating live. A [query] filters like desktop search (spec 4 §1.14). */
    fun messages(view: MailView, query: String = "", sort: SortOrder = SortOrder.DATE_DESC): Flow<List<MessageSummary>>

    /** One snapshot of [messages], for tools and one-off reads. */
    suspend fun listMessages(view: MailView, query: String = "", sort: SortOrder = SortOrder.DATE_DESC): List<MessageSummary>

    /** Counts for one account, or all accounts when [accountId] is null. */
    fun counts(accountId: String? = null): Flow<MailCounts>

    /** The cached row of [id], or null when it isn't in the cache. */
    suspend fun summary(id: String): MessageSummary?

    /** Every cached copy of the message with this Message-ID header (any form), live folders before Gmail's All Mail. */
    suspend fun findByMessageId(messageId: String, accountId: String? = null): List<MessageSummary>

    /** Where Rukoo last moved the message with this Message-ID (desktop findMoved): its current id, or null. */
    suspend fun findMoved(accountId: String, messageId: String, fromFolder: String? = null): String?

    /** The cached message's Message-ID and its folder's UIDVALIDITY, for approval cards; null when it isn't cached. */
    suspend fun pinOf(id: String): MessagePin?

    /** The parsed message, from the body cache or the server. Doesn't mark it read. */
    suspend fun fullMessage(id: String): FullMessage

    suspend fun rawSource(id: String): ByteArray

    suspend fun attachment(id: String, index: Int): AttachmentContent

    /** The attachment written to the app's cache (cache/attachments), for opening and sharing through the FileProvider. */
    suspend fun attachmentFile(id: String, index: Int): File

    /** Sync one account, or every account when null. */
    suspend fun refresh(accountId: String? = null)

    /** Sync a folder the user opened, unless it synced in the last minute (desktop openFolder). */
    suspend fun openFolder(accountId: String, path: String)

    suspend fun setFlags(ids: List<String>, unread: Boolean? = null, starred: Boolean? = null, answered: Boolean? = null)

    /** Marks every unread message in [view] read; returns how many. */
    suspend fun markAllRead(view: MailView): Int

    suspend fun archive(ids: List<String>): MoveResult

    suspend fun move(ids: List<String>, targetPath: String): MoveResult

    /** Moves to Trash; from Trash (or without one) it asks for [force] first, then deletes for good. */
    suspend fun delete(ids: List<String>, force: Boolean = false): DeleteResult

    fun canUndo(oldId: String): Boolean

    /** Moves messages back to where they came from, by the ids they had before the move. */
    suspend fun undoMove(oldIds: List<String>): UndoResult

    suspend fun createFolder(accountId: String, name: String): String

    suspend fun send(message: OutgoingMessage)

    suspend fun unsubscribe(id: String): UnsubscribeResult

    /** The archive folder of an account: the `archive` role, else Gmail's All Mail. */
    fun archiveFolder(accountId: String): String?

    /** The addresses an account can send from, primary first. */
    fun identities(accountId: String): List<Identity>

    /** Recipient suggestions, best first (spec 4 §1.18). */
    suspend fun contacts(): List<Address>

    // Accounts

    /** Verifies IMAP and SMTP login, then saves the account and starts a sync. */
    suspend fun addImapAccount(input: ImapAccountInput): Account

    suspend fun addGoogleAccount(tokens: GoogleTokens): Account

    suspend fun addDemoAccount(): Account

    /** Accounts sent over by desktop Rukoo; skips ones already here (by email). */
    suspend fun importAccounts(imported: List<ImportedAccount>, googleClient: GoogleClient?): List<Account>

    suspend fun updateAccount(id: String, patch: AccountPatch): Account

    suspend fun removeAccount(id: String)
}

/** A mail failure with a message fit for the user (desktop's friendlyError). [code] is for logic, not for display. */
class MailException(message: String, val code: String? = null, cause: Throwable? = null) : Exception(message, cause)
