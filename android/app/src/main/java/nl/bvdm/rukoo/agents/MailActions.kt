package nl.bvdm.rukoo.agents

import nl.bvdm.rukoo.agents.model.MailApproval
import nl.bvdm.rukoo.agents.model.NoticeMail
import nl.bvdm.rukoo.agents.model.NoticeUndo
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.model.DeleteOutcome
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.UnsubscribeResult

/** What an approved (or automatic) mail action did (tools.js executeMail). [text] is the result line the chat and the agent get. */
data class MailOutcome(
    val done: List<String>,
    val failed: List<Pair<String, String>>,
    val undo: List<String>,
    val text: String,
    val mail: NoticeMail,
)

/**
 * Mail actions an agent asked for, a port of desktop tools.js (mailTitle, executeMail). Each email is
 * checked against its pin first, so an approval never lands on another message that took over the id,
 * and nothing is ever deleted for good.
 */
class MailActions(
    private val mail: MailEngine,
    /** Opens what an unsubscribe needs the user for: the sender's page in the browser, or the email to send. False when it can't. */
    private val openUnsubscribe: suspend (UnsubscribeResult) -> Boolean = { false },
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
        private val ROLE_WORDS = mapOf(
            "inbox" to FolderRole.INBOX, "sent" to FolderRole.SENT, "drafts" to FolderRole.DRAFTS, "draft" to FolderRole.DRAFTS,
            "archive" to FolderRole.ARCHIVE, "trash" to FolderRole.TRASH, "deleted" to FolderRole.TRASH, "bin" to FolderRole.TRASH,
            "junk" to FolderRole.JUNK, "spam" to FolderRole.JUNK,
        )

        fun emails(n: Int) = "$n email${if (n == 1) "" else "s"}"
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

    /**
     * A folder of an account by what an agent passed (tools.js resolveFolder): the exact path wins; a path in
     * another case or a name must belong to one folder only, else this throws; then a role word.
     */
    fun resolveFolder(accountId: String, value: String): String? {
        val v = value.trim()
        val lv = v.lowercase()
        val folders = mail.folders.value[accountId].orEmpty()
        folders.firstOrNull { it.path == v }?.let { return it.path }
        for (same in listOf<(nl.bvdm.rukoo.mail.model.Folder) -> Boolean>({ it.path.lowercase() == lv }, { it.name.lowercase() == lv })) {
            val hits = folders.filter(same)
            if (hits.size > 1) throw AgentException("ambiguous", "More than one folder is called that: ${hits.joinToString(", ") { it.path }}.")
            if (hits.isNotEmpty()) return hits[0].path
        }
        val role = ROLE_WORDS[lv] ?: return null
        return folders.firstOrNull { it.role == role }?.path
    }

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
                val key = MessageIds.decode(id) ?: throw IllegalStateException("The email is no longer there (it may have moved).")
                val cached = mail.summary(id)
                val pin = spec.pins.getOrNull(i)
                val now = mail.pinOf(id)
                if (cached == null || (pin != null && now != null && !pin.matches(now))) throw IllegalStateException("The email is no longer there (it may have moved).")
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
                        // The folder's name came from the agent and may be a sender's text, so this doesn't repeat it.
                        val dest = try {
                            resolveFolder(key.accountId, spec.folder.orEmpty())
                        } catch (_: AgentException) {
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
                            if (!openUnsubscribe(r)) throw IllegalStateException("Unsubscribe is not available.")
                            opened += id
                        }
                        // The sender only takes requests by email: the composer opens with it, and the user sends it.
                        is UnsubscribeResult.SendEmail -> {
                            if (r.to.isBlank() || !openUnsubscribe(r)) throw IllegalStateException("This sender only takes unsubscribe requests by email.")
                            mailed += r.to.take(320)
                        }
                        UnsubscribeResult.Unavailable -> throw IllegalStateException("Unsubscribe is not available.")
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
