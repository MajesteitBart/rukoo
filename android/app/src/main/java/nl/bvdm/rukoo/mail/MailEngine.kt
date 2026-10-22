package nl.bvdm.rukoo.mail

import java.io.File
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import nl.bvdm.rukoo.mail.compose.ComposerFields
import nl.bvdm.rukoo.mail.compose.ReplyBuilder
import nl.bvdm.rukoo.mail.google.GoogleSignIn
import nl.bvdm.rukoo.mail.model.MailPrefs
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.mail.model.Signature
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

    // Added by the mail engine (track A). Defaults keep other implementations compiling.

    /** VIP and spam addresses and the general signature (desktop settings, imported from the computer). */
    val prefs: StateFlow<MailPrefs> get() = NO_PREFS

    suspend fun updatePrefs(transform: (MailPrefs) -> MailPrefs): MailPrefs = prefs.value

    /** Adds [address] to the VIPs or takes it off; returns whether it is a VIP now. */
    suspend fun toggleVip(address: String): Boolean = false

    /** Puts the senders on the spam list and moves the messages to the account's Spam folder, when it has one. */
    suspend fun markSpam(ids: List<String>): MoveResult = MoveResult()

    /** The signature an account sends with: its own, else the general one; null for none. */
    fun signatureFor(accountId: String): Signature? = null

    /**
     * What the composer starts with to reply to, forward or reopen [id] ([kind] REPLY, REPLY_ALL,
     * FORWARD or DRAFT): recipients, subject, the account's signature, the quote and threading headers.
     */
    suspend fun replyFields(id: String, kind: ReplyKind): ComposerFields {
        val m = fullMessage(id)
        val account = accounts.value.firstOrNull { it.id == m.accountId } ?: throw MailException("Account not found.")
        return ReplyBuilder.build(kind, m, account, identities(account.id), signatureFor(account.id))
    }

    /**
     * Stores [message] in the account's Drafts folder, replacing [OutgoingMessage.draftId]. Returns the
     * new draft's id, or null when the server didn't report where it went.
     */
    suspend fun saveDraft(message: OutgoingMessage): String? = null

    /** Deletes a stored draft for good. */
    suspend fun discardDraft(id: String) = Unit

    /** Empties a folder: for good inside Trash, to Trash elsewhere. Returns how many messages it handled. */
    suspend fun emptyFolder(accountId: String, path: String): Int = 0

    /** Google sign-in, for engines with real accounts. */
    val google: GoogleSignIn? get() = null

    /** Signs a Google account in again with new [tokens]; the email must be the account's. */
    suspend fun reauthorizeGoogle(accountId: String, tokens: GoogleTokens): Account = throw MailException("Google sign-in is unavailable.")

    // Google sign-in (spec 4 §4). The defaults stand in until the engine implements them; settings shows
    // code `unsupported` as "not available in this version".

    /** The Google OAuth client sign-in uses, or null until one is set (from the computer's export or a client file). */
    suspend fun googleClient(): GoogleClient? = null

    /** Keeps [client] for Google sign-in, encrypted like the accounts' secrets. [importAccounts] sets it too. */
    suspend fun setGoogleClient(client: GoogleClient): Unit = throw MailException("Google sign-in is not available.", UNSUPPORTED)

    /**
     * Signs in with Google (spec 4 §4.3 and §4.7: PKCE, a loopback redirect on 127.0.0.1) and adds the
     * account, or renews the sign-in of [reauthAccountId]. [openUrl] opens Google's consent page in a Custom
     * Tab; the call returns once the redirect arrived and the account is saved. Cancelling the caller
     * cancels the sign-in.
     */
    suspend fun signInWithGoogle(openUrl: (String) -> Unit, reauthAccountId: String? = null): Account =
        throw MailException("Google sign-in is not available.", UNSUPPORTED)

    companion object {
        /** [MailException.code] of a feature this engine doesn't have. */
        const val UNSUPPORTED = "unsupported"
    }
}

private val NO_PREFS: StateFlow<MailPrefs> = MutableStateFlow(MailPrefs()).asStateFlow()

/** A mail failure with a message fit for the user (desktop's friendlyError). [code] is for logic, not for display. */
class MailException(message: String, val code: String? = null, cause: Throwable? = null) : Exception(message, cause)
