package nl.bvdm.rukoo.agents

import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.withContext
import nl.bvdm.rukoo.agents.model.MailApproval
import nl.bvdm.rukoo.agents.model.NoticeMail
import nl.bvdm.rukoo.agents.model.NoticeUndo
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.compose.ComposeBody
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.DeleteOutcome
import nl.bvdm.rukoo.mail.model.Folder
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.MessagePin
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.mail.model.UnsubscribeResult
import nl.bvdm.rukoo.ui.ComposerController
import nl.bvdm.rukoo.ui.ComposerState
import nl.bvdm.rukoo.ui.composer.Recipients

/** What an approved (or automatic) mail action did (tools.js executeMail). [text] is the result line the chat and the agent get. */
data class MailOutcome(
    val done: List<String>,
    val failed: List<Pair<String, String>>,
    val undo: List<String>,
    val text: String,
    val mail: NoticeMail,
)

/**
 * What an unsubscribe needs the user for (desktop's deps.unsubscribe opening the page, and deps.openMailto). Both
 * may refuse; the action then reports that email as failed with the reason.
 */
interface UnsubscribeOpener {
    /** The sender's unsubscribe page in the browser. False when Android didn't let Rukoo show it. */
    suspend fun openPage(url: String): Boolean

    /**
     * The unsubscribe email, filled in and sent from [accountId], in the composer; the user sends it, Rukoo never does.
     * Returns the address it goes to; throws with the reason when the composer can't take it.
     */
    suspend fun openEmail(accountId: String, email: UnsubscribeResult.SendEmail): String

    object None : UnsubscribeOpener {
        override suspend fun openPage(url: String) = false

        override suspend fun openEmail(accountId: String, email: UnsubscribeResult.SendEmail): String = throw IllegalStateException(MailActions.ONLY_BY_EMAIL)
    }
}

/**
 * The phone's opener. It has one composer, which the unsubscribe email only takes while nothing is in it: never the
 * user's words, an agent's draft, or the unsubscribe email before it in the same batch. Desktop opens a window of its
 * own for each one instead. Composer changes run in [main], where the UI changes it too.
 */
class ComposerUnsubscribeOpener(
    private val mail: MailEngine,
    private val composer: ComposerController,
    private val pages: (String) -> Boolean,
    private val main: CoroutineContext = EmptyCoroutineContext,
) : UnsubscribeOpener {
    override suspend fun openPage(url: String): Boolean = withContext(main) { pages(url) }

    override suspend fun openEmail(accountId: String, email: UnsubscribeResult.SendEmail): String {
        // The engine joins every mailto address with commas; each one becomes a recipient.
        val to = Recipients.parse(email.to).filter { Recipients.isValid(it.address) }
        if (to.isEmpty()) throw IllegalStateException(MailActions.ONLY_BY_EMAIL)
        val ids = mail.identities(accountId)
        val from = (ids.firstOrNull { it.primary } ?: ids.firstOrNull())?.let { Address(it.name, it.address) }
        // Like any new message, it ends with the account's signature (desktop's compose window adds it too).
        val body = email.body + ComposeBody.initialText(mail.signatureFor(accountId))
        return withContext(main) {
            if (!isEmpty(composer.current())) throw IllegalStateException(COMPOSER_BUSY)
            composer.open(ComposerState(accountId = accountId, from = from, to = to, subject = email.subject, body = body, replyKind = ReplyKind.NEW))
            to[0].address.take(320)
        }
    }

    companion object {
        const val COMPOSER_BUSY = "Rukoo's composer holds another email, so the unsubscribe email was not opened. Ask the user to send or close it first."

        /** Nothing in it the user or an agent wrote or picked: closed, or opened and left untouched. */
        fun isEmpty(open: ComposerState?): Boolean = open == null || (
            open.draftedBy == null && !open.dirty && open.body.isBlank() && open.subject.isBlank() && open.quote.isBlank() &&
                open.to.isEmpty() && open.cc.isEmpty() && open.bcc.isEmpty() && open.attachments.isEmpty() &&
                open.typed.values.all { it.isBlank() }
            )
    }
}

/** A folder name an agent passed that fits more than one folder. */
class AmbiguousFolder(val paths: List<String>) : Exception("More than one folder is called that: ${paths.joinToString(", ")}.")

/** An account's folders as agents see them (desktop publicAccount and resolveFolder), for the tools and the hub alike. */
object AgentFolders {
    private val ROLE_WORDS = mapOf(
        "inbox" to "inbox", "sent" to "sent", "drafts" to "drafts", "draft" to "drafts", "archive" to "archive",
        "trash" to "trash", "deleted" to "trash", "bin" to "trash", "junk" to "junk", "spam" to "junk",
    )

    /**
     * Starred and Important are views, not folders an agent can move mail to. Gmail's All Mail only counts when it is
     * the account's archive ([archive], the engine's archiveFolder), so `archive` never means All Mail while the
     * account has an Archive folder of its own.
     */
    fun visible(folders: List<Folder>, archive: String?): List<Folder> =
        folders.filter { it.role != FolderRole.FLAGGED && it.role != FolderRole.IMPORTANT && (it.role != FolderRole.ALL || it.path == archive) }

    /** Gmail's All Mail is `archive` to agents; only the cache keeps `all`. A user folder is null. */
    fun role(role: FolderRole): String? = if (role == FolderRole.ALL) "archive" else role.wire

    /**
     * The folder [value] names: the exact path wins; a path in another case or a name must fit one folder only, else
     * [AmbiguousFolder]; then a role word. Null when nothing fits.
     */
    fun resolve(folders: List<Folder>, archive: String?, value: String?): String? {
        val v = value.orEmpty().trim()
        val lv = v.lowercase()
        val shown = visible(folders, archive)
        shown.firstOrNull { it.path == v }?.let { return it.path }
        for (same in listOf<(Folder) -> Boolean>({ it.path.lowercase() == lv }, { it.name.lowercase() == lv })) {
            val hits = shown.filter(same)
            if (hits.size > 1) throw AmbiguousFolder(hits.map { it.path })
            if (hits.isNotEmpty()) return hits[0].path
        }
        val role = ROLE_WORDS[lv] ?: return null
        return shown.firstOrNull { role(it.role) == role }?.path
    }
}

/**
 * Mail actions an agent asked for, a port of desktop tools.js (mailTitle, executeMail). The hub runs every one of
 * them, approved or automatic, on the chat's mail chain. Each email is checked against its pin first, so an approval
 * never lands on another message that took over the id, and nothing is ever deleted for good.
 */
class MailActions(
    private val mail: MailEngine,
    private val opener: UnsubscribeOpener = UnsubscribeOpener.None,
) {
    companion object {
        /** The verb for the card's button and the past tense for the result (tools.js VERBS). */
        val VERBS = mapOf(
            "archive" to ("Archive" to "Archived"),
            "trash" to ("Delete" to "Moved to Trash:"),
            "move" to ("Move" to "Moved"),
            "mark_read" to ("Mark as read" to "Marked as read:"),
            "mark_unread" to ("Mark as unread" to "Marked as unread:"),
            "star" to ("Star" to "Starred"),
            "unstar" to ("Unstar" to "Removed the star from"),
            "unsubscribe" to ("Unsubscribe" to "Unsubscribed from"),
        )
        val ACTIONS = VERBS.keys.toList()
        private val MOVES = setOf("archive", "trash", "move")
        private const val GONE = "The email is no longer there (it may have moved)."
        const val ONLY_BY_EMAIL = "This sender only takes unsubscribe requests by email."

        fun emails(n: Int) = "$n email${if (n == 1) "" else "s"}"

        // Desktop's samePin: a missing or empty pin is no check, but an email the cache can't pin any more is not the
        // same one.
        private fun samePin(pin: MessagePin?, now: MessagePin?): Boolean =
            pin == null || (pin.messageId == null && pin.uidValidity == null) || (now != null && pin.matches(now))
    }

    /** From the email, so one line and short: it ends up in card titles and in the agent's notes. */
    suspend fun senderName(id: String): String {
        val m = mail.summary(id)
        val name = m?.from?.let { it.name.ifEmpty { it.address } }.orEmpty()
        return jsOneLine(name).take(80).ifEmpty { "this sender" }
    }

    /** The card's title (tools.js mailTitle). */
    suspend fun title(spec: MailApproval): String {
        val n = spec.ids.size
        return when (spec.action) {
            "move" -> "Move ${emails(n)} to ${spec.folder}"
            "trash" -> "Delete ${emails(n)}"
            "mark_read" -> "Mark ${emails(n)} as read"
            "mark_unread" -> "Mark ${emails(n)} as unread"
            "unsubscribe" -> {
                val senders = spec.ids.map { senderName(it) }.distinct()
                if (senders.size == 1) "Unsubscribe from ${senders[0]}" else "Unsubscribe from ${senders.size} senders"
            }
            else -> "${VERBS[spec.action]?.first ?: spec.action} ${emails(n)}"
        }
    }

    /** A folder of an account by what an agent passed (tools.js resolveFolder); throws [AmbiguousFolder]. */
    fun resolveFolder(accountId: String, value: String): String? =
        AgentFolders.resolve(mail.folders.value[accountId].orEmpty(), mail.archiveFolder(accountId), value)

    private fun accountEmail(accountId: String) = mail.accounts.value.firstOrNull { it.id == accountId }?.email ?: accountId

    /** Runs the action on each email and says what happened (tools.js executeMail). Never throws for one email. */
    suspend fun execute(spec: MailApproval): MailOutcome {
        val done = mutableListOf<String>()
        val failed = mutableListOf<Pair<String, String>>()
        val undo = mutableListOf<String>()
        // Unsubscribes by what Rukoo could do: one-click, the page opened in the browser, or an email to send.
        val unsubscribed = mutableListOf<String>()
        val opened = mutableListOf<String>()
        val mailed = mutableListOf<String>()
        for ((i, id) in spec.ids.withIndex()) {
            try {
                val key = MessageIds.decode(id) ?: throw IllegalStateException(GONE)
                val cached = mail.summary(id)
                if (cached == null || !samePin(spec.pins.getOrNull(i), mail.pinOf(id))) throw IllegalStateException(GONE)
                val email = accountEmail(key.accountId)
                var undoable = false
                when (spec.action) {
                    "archive" -> {
                        val r = mail.archive(listOf(id))
                        r.failed.firstOrNull()?.let { throw IllegalStateException(it.error) }
                        undoable = id in r.undoIds
                    }
                    "trash" -> {
                        val trash = mail.folders.value[key.accountId].orEmpty().firstOrNull { it.role == FolderRole.TRASH }
                        // Never delete for good: mail that is already in the trash stays there.
                        if (trash?.path != key.folder) {
                            val r = mail.delete(listOf(id), force = false)
                            if (r.outcome == DeleteOutcome.NEEDS_CONFIRM) throw IllegalStateException("$email has no Trash folder.")
                            r.move.failed.firstOrNull()?.let { throw IllegalStateException(it.error) }
                            undoable = id in r.move.undoIds
                        }
                    }
                    "move" -> {
                        // The folder was there when the action was asked for. Its name came from the agent and may be a
                        // sender's text, and this message reaches the agent, so it does not repeat the name.
                        val dest = try {
                            resolveFolder(key.accountId, spec.folder.orEmpty())
                        } catch (_: AmbiguousFolder) {
                            throw IllegalStateException("More than one folder in $email has the destination's name now. Ask again with its full path.")
                        } ?: throw IllegalStateException("The destination folder is no longer in $email.")
                        val r = mail.move(listOf(id), dest)
                        r.failed.firstOrNull()?.let { throw IllegalStateException(it.error) }
                        undoable = id in r.undoIds
                    }
                    "mark_read" -> mail.setFlags(listOf(id), unread = false)
                    "mark_unread" -> mail.setFlags(listOf(id), unread = true)
                    "star" -> mail.setFlags(listOf(id), starred = true)
                    "unstar" -> mail.setFlags(listOf(id), starred = false)
                    "unsubscribe" -> when (val r = mail.unsubscribe(id)) {
                        UnsubscribeResult.Done -> unsubscribed += id
                        is UnsubscribeResult.OpenPage -> {
                            if (!opener.openPage(r.url)) throw IllegalStateException("Rukoo could not open the unsubscribe page on the phone.")
                            opened += id
                        }
                        // The sender only takes requests by email: it opens, filled in, like the reader's Unsubscribe
                        // button does. The user sends it; Rukoo never does.
                        is UnsubscribeResult.SendEmail -> {
                            if (r.to.isBlank()) throw IllegalStateException(ONLY_BY_EMAIL)
                            mailed += opener.openEmail(key.accountId, r)
                        }
                        UnsubscribeResult.Unavailable -> throw IllegalStateException("This email has no unsubscribe link.")
                    }
                    else -> throw IllegalStateException("Unknown action ${spec.action}.")
                }
                done += id
                if (spec.action in MOVES && (undoable || mail.canUndo(id))) undo += id
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                failed += id to (e.message ?: e.javaClass.simpleName)
            }
        }
        val verbs = VERBS[spec.action] ?: (spec.action to spec.action)
        var text = when {
            spec.action == "unsubscribe" -> {
                // Only a one-click unsubscribe is done; a page may still ask to confirm, and Rukoo can't see whether it worked.
                val parts = mutableListOf<String>()
                if (unsubscribed.isNotEmpty()) {
                    val senders = unsubscribed.map { senderName(it) }.distinct()
                    parts += if (senders.size == 1) "Unsubscribed from ${senders[0]}" else "Unsubscribed from ${senders.size} senders"
                }
                if (opened.isNotEmpty()) {
                    parts += if (opened.size == 1) {
                        "Opened the unsubscribe page for ${senderName(opened[0])} in the browser. Finish there; Rukoo cannot tell whether it worked"
                    } else {
                        "Opened ${opened.size} unsubscribe pages in the browser. Finish there; Rukoo cannot tell whether they worked"
                    }
                }
                if (mailed.isNotEmpty()) parts += if (mailed.size == 1) "Opened an unsubscribe email to ${mailed[0]}. Send it to finish" else "Opened ${mailed.size} unsubscribe emails. Send them to finish"
                parts.joinToString(". ")
            }
            spec.action == "move" -> "Moved ${emails(done.size)} to ${spec.folder}"
            else -> "${verbs.second} ${emails(done.size)}"
        }
        if (done.isEmpty()) text = "Could not ${verbs.first.lowercase()} ${emails(spec.ids.size)}"
        if (failed.isNotEmpty()) text += ". ${failed.size} failed: ${failed[0].second}"
        // An unsubscribe that still needs sending or finishing in the browser is not "Unsubscribed".
        val notice = NoticeMail(
            action = when {
                mailed.isNotEmpty() -> "unsubscribe_email"
                opened.isNotEmpty() -> "unsubscribe_page"
                else -> spec.action
            },
            count = done.size,
            failed = failed.size,
            folder = spec.folder,
            mailed = mailed.size,
            to = if (mailed.size == 1) mailed[0] else null,
            opened = opened.size,
            sender = if (opened.size == 1) senderName(opened[0]) else null,
        )
        return MailOutcome(done, failed, undo, text, notice)
    }

    /** The notice's undo for an outcome: the moves Rukoo can take back. */
    fun undoOf(outcome: MailOutcome): NoticeUndo? = if (outcome.undo.isNotEmpty()) NoticeUndo("move", outcome.undo) else null
}
