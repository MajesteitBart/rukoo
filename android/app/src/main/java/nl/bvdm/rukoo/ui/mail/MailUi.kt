package nl.bvdm.rukoo.ui.mail

import android.content.res.Resources
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.Locale
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.categories.Categories
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.model.Folder
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.model.DeleteOutcome
import nl.bvdm.rukoo.mail.model.DeleteResult
import nl.bvdm.rukoo.mail.model.Moved
import nl.bvdm.rukoo.mail.model.UnsubscribeResult
import nl.bvdm.rukoo.ui.Mailto
import nl.bvdm.rukoo.ui.components.RkToastState

/** Strings for code outside composition: resources in the app, a fake in tests. */
interface UiStrings {
    fun get(@StringRes id: Int, vararg args: Any): String

    fun plural(@PluralsRes id: Int, count: Int, vararg args: Any): String

    /** The interface language, for dates in quote headers. */
    val locale: Locale get() = Locale.getDefault()
}

class ResourceStrings(private val resources: Resources) : UiStrings {
    override fun get(id: Int, vararg args: Any): String = resources.getString(id, *args)

    override fun plural(id: Int, count: Int, vararg args: Any): String = resources.getQuantityString(id, count, *args)

    override val locale: Locale get() = resources.configuration.locales[0] ?: Locale.getDefault()
}

/** How a dialog was answered: the main button, Cancel (or dismissed), or the third button ("Don't save"). */
enum class DialogChoice { CONFIRM, CANCEL, OTHER }

data class DialogAnswer(val choice: DialogChoice, val text: String = "")

/**
 * A question shown by the root (desktop's confirmDialog, promptDialog and the composer's three-way close).
 * With [input] set it has a text field, prefilled with it, whose text comes back in the answer.
 */
class DialogRequest(
    val title: String,
    val message: String?,
    val confirmLabel: String,
    val cancelLabel: String,
    val danger: Boolean = false,
    val otherLabel: String? = null,
    val input: String? = null,
    val inputPlaceholder: String? = null,
) {
    internal val answer = CompletableDeferred<DialogAnswer>()

    fun answer(choice: DialogChoice, text: String = "") {
        answer.complete(DialogAnswer(choice, text))
    }
}

/** What the mail actions need from navigation. AppViewModel implements it. */
interface MailUiHost {
    /** Takes [ids] off the screen before they move; true when the open message was among them (desktop detach). */
    fun detach(ids: Collection<String>): Boolean

    /** Opens a restored message again after Undo. */
    fun reopen(id: String)

    /** An unsubscribe page, in the browser. */
    fun openUrl(url: String)

    /** An unsubscribe email, in the composer. */
    fun composeMailto(fields: nl.bvdm.rukoo.ui.MailtoFields)

    /** A folder made in the drawer: show it. */
    fun showFolder(accountId: String, path: String)
}

/**
 * The mail actions of the list, the selection bar and the reader, with desktop's toasts and undo
 * (app.js:1393-1559). It lives in the view model, so a delete started in the reader finishes after the
 * reader has gone. Dialogs and the move picker are state the root draws.
 */
class MailUi(
    private val mail: MailEngine,
    private val scope: CoroutineScope,
    private val host: MailUiHost,
    val toasts: RkToastState = RkToastState(),
    /** Inbox categories, for Move to category; null where there are none (tests, the preview engine). */
    val categories: Categories? = null,
) {
    /** Set by the root from the current resources, so texts follow the language. */
    var strings: UiStrings = object : UiStrings {
        override fun get(id: Int, vararg args: Any) = ""
        override fun plural(id: Int, count: Int, vararg args: Any) = ""
    }

    var dialog: DialogRequest? by mutableStateOf(null)
        private set

    /** Messages waiting for a folder from the move sheet. */
    var moving: List<MessageSummary>? by mutableStateOf(null)
        private set

    // Engine failures carry a message meant for the user (MailException); anything else at least says what broke.
    private fun error(e: Throwable) = toasts.showError(e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName)

    /** Shows [request] and waits for the answer; an earlier open question is cancelled. */
    suspend fun ask(request: DialogRequest): DialogAnswer {
        dialog?.answer(DialogChoice.CANCEL)
        dialog = request
        return try {
            request.answer.await()
        } finally {
            if (dialog === request) dialog = null
        }
    }

    private suspend fun confirm(title: String, message: String?, label: String, danger: Boolean = false): Boolean =
        ask(DialogRequest(title, message, label, strings.get(R.string.common_actions_cancel), danger)).choice == DialogChoice.CONFIRM

    /** The name a folder goes by: the translated role name, or the server's. */
    fun folderLabel(folder: Folder?, path: String): String = folder?.let { roleLabel(it.role) ?: it.name } ?: path

    fun roleLabel(role: FolderRole): String? = when (role) {
        FolderRole.INBOX -> strings.get(R.string.mailbox_folders_inbox)
        FolderRole.SENT -> strings.get(R.string.mailbox_folders_sent)
        FolderRole.DRAFTS -> strings.get(R.string.mailbox_folders_drafts)
        FolderRole.TRASH -> strings.get(R.string.mailbox_folders_trash)
        FolderRole.JUNK -> strings.get(R.string.mailbox_folders_junk)
        FolderRole.ARCHIVE, FolderRole.ALL -> strings.get(R.string.mailbox_folders_archive)
        FolderRole.FLAGGED -> strings.get(R.string.mailbox_folders_starred)
        FolderRole.IMPORTANT, FolderRole.NONE -> null
    }

    private fun folderOf(accountId: String, path: String): Folder? = mail.folders.value[accountId]?.firstOrNull { it.path == path }

    /**
     * Read or unread, with an Undo that puts back the flags of the emails that changed. Desktop has no toast
     * here; the phone's swipe makes the change easy to do by accident, so it gets one.
     */
    fun setUnread(list: List<MessageSummary>, unread: Boolean) {
        val changed = list.filter { it.unread != unread }.map { it.id }.distinct()
        if (changed.isEmpty()) return
        scope.launch {
            try {
                mail.setFlags(changed, unread = unread)
                offerFlagUndo(changed, unread)
            } catch (e: Exception) {
                error(e)
            }
        }
    }

    private fun offerFlagUndo(ids: List<String>, unread: Boolean) {
        val message = if (unread) strings.get(R.string.mailbox_actions_marked_unread) else strings.plural(R.plurals.mailbox_actions_read_count, ids.size, ids.size)
        toasts.showToast(message, strings.get(R.string.common_actions_undo)) {
            scope.launch {
                try {
                    mail.setFlags(ids, unread = !unread)
                } catch (e: Exception) {
                    error(e)
                }
            }
        }
    }

    fun setStarred(list: List<MessageSummary>, starred: Boolean) {
        if (list.isEmpty()) return
        scope.launch {
            try {
                mail.setFlags(list.map { it.id }, starred = starred)
            } catch (e: Exception) {
                error(e)
            }
        }
    }

    fun markAllRead(view: MailView) {
        scope.launch {
            try {
                // The unread ones in the view are marked by id rather than through markAllRead, so a sync landing
                // in between can't make Undo mark a different set unread again than the one this changed.
                val unread = mail.listMessages(view).filter { it.unread }.map { it.id }
                if (unread.isEmpty()) return@launch toasts.showToast(strings.get(R.string.mailbox_actions_already_read))
                mail.setFlags(unread, unread = false)
                offerFlagUndo(unread, unread = false)
            } catch (e: Exception) {
                error(e)
            }
        }
    }

    fun refresh(accountId: String? = null) {
        scope.launch {
            try {
                mail.refresh(accountId)
            } catch (e: Exception) {
                error(e)
            }
        }
    }

    /**
     * "Moved to Trash" with Undo. A [failure] the server reported for some of the emails takes the message's
     * place, so it stays readable (one toast shows at a time), and Undo still reverts the ones that moved.
     */
    private suspend fun offerUndo(moved: List<Moved>, message: String, reopen: Boolean, failure: String? = null) {
        val undoable = moved.filter { it.undoable && mail.canUndo(it.oldId) }.map { it.oldId }
        if (undoable.isEmpty()) {
            if (failure != null) toasts.showError(failure) else toasts.showToast(message)
            return
        }
        toasts.showToast(failure ?: message, strings.get(R.string.common_actions_undo)) { undo(undoable, reopen) }
    }

    private fun reason(e: Throwable) = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName

    /** Desktop undoMoves: back where they were, then "Restored" with the count; one restored message opens again if it was open. */
    fun undo(oldIds: List<String>, reopen: Boolean) {
        scope.launch {
            try {
                val result = mail.undoMove(oldIds)
                result.failed.firstOrNull()?.let { toasts.showError(it.error.ifEmpty { strings.get(R.string.errors_undo_expired) }) }
                val back = result.restored
                if (reopen && back.size == 1) host.reopen(back[0])
                if (back.isNotEmpty()) {
                    toasts.showToast(if (back.size == 1) strings.get(R.string.mailbox_undo_restored) else strings.plural(R.plurals.mailbox_undo_restored_count, back.size, back.size))
                }
            } catch (e: Exception) {
                error(e)
            }
        }
    }

    /** Desktop removeMessages: Trash first and undoable; permanent deletes ask, the account without a Trash asks again. */
    fun delete(input: List<MessageSummary>) {
        val list = input.distinctBy { it.id }
        if (list.isEmpty()) return
        scope.launch {
            val permanent = list.filter { it.role == FolderRole.TRASH }
            if (permanent.isNotEmpty()) {
                val ok = confirm(
                    strings.get(R.string.mailbox_delete_title),
                    if (permanent.size == 1) strings.get(R.string.mailbox_delete_one) else strings.plural(R.plurals.mailbox_delete_permanent_count, permanent.size, permanent.size),
                    strings.get(R.string.common_actions_delete),
                    danger = true,
                )
                if (!ok) return@launch
            }
            val reopen = host.detach(list.map { it.id })
            val moved = mutableListOf<Moved>()
            var deleted = 0
            var failed: String? = null
            // What a delete did: the ones moved to Trash can be undone, the ones the server refused are back in
            // the list (the engine puts them back), only the rest are gone for good.
            fun count(ids: List<String>, result: DeleteResult) {
                moved += result.move.moved
                val notGone = result.move.moved.map { it.oldId }.toSet() + result.move.failed.map { it.id }
                deleted += ids.count { it !in notGone }
                if (failed == null) failed = result.move.failed.firstOrNull()?.error
            }
            try {
                if (permanent.isNotEmpty()) {
                    val ids = permanent.map { it.id }
                    count(ids, mail.delete(ids, force = true))
                }
                val rest = list.filter { it.role != FolderRole.TRASH }
                if (rest.isNotEmpty()) {
                    val ids = rest.map { it.id }
                    val result = mail.delete(ids)
                    when (result.outcome) {
                        DeleteOutcome.TRASHED, DeleteOutcome.DELETED -> count(ids, result)
                        DeleteOutcome.NEEDS_CONFIRM -> {
                            // Only the ones that would go for good are counted in the question (desktop asks per message).
                            val forever = rest.filter { mail.folders.value[it.accountId]?.none { f -> f.role == FolderRole.TRASH } != false }
                            val n = forever.size.coerceAtLeast(1)
                            val ok = confirm(
                                strings.get(R.string.mailbox_delete_title),
                                if (n == 1) strings.get(R.string.mailbox_delete_no_trash) else strings.plural(R.plurals.mailbox_delete_no_trash_count, n, n),
                                strings.get(R.string.common_actions_delete),
                                danger = true,
                            )
                            if (ok) count(ids, mail.delete(ids, force = true))
                        }
                    }
                }
            } catch (e: Exception) {
                if (failed == null) failed = reason(e)
            }
            // One toast at a time: a failure wins over "Deleted", and keeps the Undo of what went to Trash.
            val failure = failed
            when {
                moved.isNotEmpty() -> offerUndo(
                    moved,
                    if (moved.size == 1) strings.get(R.string.mailbox_delete_moved_one) else strings.plural(R.plurals.mailbox_delete_moved_count, moved.size, moved.size),
                    reopen,
                    failure,
                )
                failure != null -> toasts.showError(failure)
                deleted > 0 -> toasts.showToast(if (deleted == 1) strings.get(R.string.mailbox_delete_deleted_one) else strings.plural(R.plurals.mailbox_delete_deleted_count, deleted, deleted))
            }
        }
    }

    /** Where a message goes for a [role] target: the account's folder with that role (Archive: its archive folder). */
    private fun destination(m: MessageSummary, role: FolderRole): String? =
        if (role == FolderRole.ARCHIVE) mail.archiveFolder(m.accountId) else mail.folders.value[m.accountId]?.firstOrNull { it.role == role }?.path

    /** Archive: the account's archive folder (Gmail's All Mail). */
    fun archive(list: List<MessageSummary>) = moveTo(list, label = strings.get(R.string.mailbox_folders_archive), archive = true) { destination(it, FolderRole.ARCHIVE) }

    /**
     * A target picked in the move sheet: a folder of one account, or (several accounts) a role each
     * message's account resolves. Trash goes through [delete], so deleting from Trash still asks.
     */
    fun move(list: List<MessageSummary>, target: MoveTarget) {
        if (target.role == FolderRole.TRASH) return delete(list)
        val byRole = target.path == null
        moveTo(list, target.label, archive = byRole && target.role == FolderRole.ARCHIVE) { m ->
            if (byRole) target.role?.let { destination(m, it) } else target.path.takeIf { m.accountId == target.accountId }
        }
    }

    private fun moveTo(input: List<MessageSummary>, label: String, archive: Boolean, where: (MessageSummary) -> String?) {
        val plan = input.distinctBy { it.id }.mapNotNull { m -> where(m)?.takeIf { it != m.folder }?.let { m to it } }
        if (plan.isEmpty()) {
            toasts.showToast(strings.get(if (archive) R.string.mailbox_move_no_archive else R.string.mailbox_move_already_there))
            return
        }
        scope.launch {
            val reopen = host.detach(plan.map { it.first.id })
            val moved = mutableListOf<Moved>()
            var failure: String? = null
            for ((path, group) in plan.groupBy({ it.second }, { it.first })) {
                try {
                    val result = if (archive) mail.archive(group.map { it.id }) else mail.move(group.map { it.id }, path)
                    moved += result.moved
                    if (failure == null) failure = result.failed.firstOrNull()?.error
                } catch (e: Exception) {
                    if (failure == null) failure = reason(e)
                }
            }
            when {
                moved.isNotEmpty() -> offerUndo(
                    moved,
                    if (moved.size == 1) strings.get(R.string.mailbox_move_one, label) else strings.plural(R.plurals.mailbox_move_count, moved.size, moved.size, label),
                    reopen,
                    failure,
                )
                failure != null -> toasts.showError(failure!!)
            }
        }
    }

    /** Messages waiting for a category from the category sheet, and the category they all share, if they do. */
    var categorizing: Pair<List<MessageSummary>, String?>? by mutableStateOf(null)
        private set

    /** The inbox category of each of [list] by id; empty while categories are off. */
    fun categoriesOf(list: List<MessageSummary>): Map<String, String> = categories?.of(mail.accounts.value, list).orEmpty()

    /** Move to category (desktop's moveToCategory): only inbox mail has a category; the sheet preselects a shared one. */
    fun pickCategory(input: List<MessageSummary>) {
        val of = categoriesOf(input)
        val list = input.distinctBy { it.id }.filter { it.id in of }
        if (list.isEmpty()) return
        val current = list.map { of[it.id] }.distinct().singleOrNull()
        categorizing = list to current
    }

    fun closeCategoryPicker() {
        categorizing = null
    }

    /**
     * Puts the picked emails in category [id]. Nothing changes on the mail server; the toast offers to do the same for
     * their senders' later mail.
     */
    fun moveToCategory(id: String) {
        val cats = categories ?: return
        val list = categorizing?.first ?: return
        categorizing = null
        try {
            cats.move(list, id)
        } catch (e: Exception) {
            return toasts.showError(strings.get(R.string.settings_error_generic))
        }
        val name = cats.state.value.categories.firstOrNull { it.id == id }?.name.orEmpty()
        val senders = list.map { it.from.address.lowercase() }.filter { it.isNotEmpty() }.toSet()
        toasts.showToast(strings.get(R.string.mailbox_categories_moved, name), strings.get(R.string.mailbox_categories_always)) {
            try {
                cats.move(list, id, sender = true)
            } catch (e: Exception) {
                return@showToast toasts.showError(strings.get(R.string.settings_error_generic))
            }
            toasts.showToast(
                if (senders.size == 1) {
                    strings.get(R.string.mailbox_categories_always_done, ListModel.person(list[0].from), name)
                } else {
                    strings.get(R.string.mailbox_categories_always_done_many, senders.size, name)
                },
            )
        }
    }

    /** Opens the move sheet for [list]. */
    fun pickFolder(list: List<MessageSummary>) {
        moving = list.distinctBy { it.id }.takeIf { it.isNotEmpty() }
    }

    fun closePicker() {
        moving = null
    }

    /**
     * The move sheet's choices (app.js pickFolder): one account offers its folders except Drafts and Sent
     * (and the folder the messages are in); several accounts offer the roles Inbox, Archive, Spam and Trash.
     */
    fun moveTargets(list: List<MessageSummary>): List<MoveTarget> {
        val accounts = list.map { it.accountId }.distinct()
        val here = list.map { it.folder }.toSet()
        if (accounts.size == 1) {
            val folders = mail.folders.value[accounts[0]].orEmpty()
            return folders
                .filter { it.role !in HIDDEN && !(here.size == 1 && it.path in here) }
                .sortedWith(compareBy({ ROLE_ORDER.indexOf(it.role).let { i -> if (i < 0) ROLE_ORDER.size else i } }, { it.name.lowercase() }))
                .map { f ->
                    if (f.role == FolderRole.NONE) MoveTarget(folderLabel(f, f.path), path = f.path, accountId = f.accountId)
                    else MoveTarget(folderLabel(f, f.path), role = f.role, path = f.path, accountId = f.accountId)
                }
        }
        return listOf(FolderRole.INBOX, FolderRole.ARCHIVE, FolderRole.JUNK, FolderRole.TRASH).map { MoveTarget(roleLabel(it)!!, role = it) }
    }

    fun pick(target: MoveTarget) {
        val list = moving ?: return
        moving = null
        move(list, target)
    }

    /** Desktop unsubscribe(m): confirm, then one-click done, a page in the browser, or an email in the composer. */
    fun unsubscribe(m: MessageSummary, oneClickOrLink: Boolean) {
        scope.launch {
            val sender = ListModel.person(m.from).ifEmpty { strings.get(R.string.reader_unsubscribe_unknown_sender) }
            val ok = confirm(
                strings.get(R.string.reader_unsubscribe_title, sender),
                strings.get(if (oneClickOrLink) R.string.reader_unsubscribe_link_help else R.string.reader_unsubscribe_mail_help),
                strings.get(R.string.reader_unsubscribe_action),
            )
            if (!ok) return@launch
            try {
                when (val result = mail.unsubscribe(m.id)) {
                    UnsubscribeResult.Done -> toasts.showToast(strings.get(R.string.reader_unsubscribe_done, sender))
                    is UnsubscribeResult.OpenPage -> {
                        host.openUrl(result.url)
                        toasts.showToast(strings.get(R.string.reader_unsubscribe_opened))
                    }
                    is UnsubscribeResult.SendEmail -> {
                        val fields = Mailto.parse(if (Mailto.isMailto(result.to)) result.to else "mailto:${result.to}")
                        host.composeMailto(
                            fields.copy(
                                subject = result.subject.ifEmpty { fields.subject.ifEmpty { strings.get(R.string.reader_unsubscribe_subject) } },
                                body = result.body.ifEmpty { fields.body },
                            ),
                        )
                    }
                    UnsubscribeResult.Unavailable -> toasts.showError(strings.get(R.string.errors_unsubscribe_missing))
                }
            } catch (e: Exception) {
                error(e)
            }
        }
    }

    /** Desktop newFolder: ask for a name, make it, say so, show it. */
    fun newFolder(accountId: String) {
        scope.launch {
            val answer = ask(
                DialogRequest(
                    title = strings.get(R.string.mailbox_folders_new),
                    message = null,
                    confirmLabel = strings.get(R.string.common_actions_add),
                    cancelLabel = strings.get(R.string.common_actions_cancel),
                    input = "",
                    inputPlaceholder = strings.get(R.string.mailbox_folders_name),
                ),
            )
            val name = answer.text.trim()
            if (answer.choice != DialogChoice.CONFIRM || name.isEmpty()) return@launch
            try {
                val path = mail.createFolder(accountId, name)
                toasts.showToast(strings.get(R.string.mailbox_folders_created, name))
                host.showFolder(accountId, path)
            } catch (e: Exception) {
                error(e)
            }
        }
    }

    companion object {
        // Gmail's Starred and Important are labels Rukoo hides; they are no place to move mail to.
        private val HIDDEN = setOf(FolderRole.DRAFTS, FolderRole.SENT, FolderRole.FLAGGED, FolderRole.IMPORTANT)
        private val ROLE_ORDER = listOf(FolderRole.INBOX, FolderRole.ARCHIVE, FolderRole.ALL, FolderRole.JUNK, FolderRole.TRASH)
    }
}

/** A place in the move sheet: a folder ([path] of [accountId]) or a role that each message's account resolves. */
data class MoveTarget(val label: String, val role: FolderRole? = null, val path: String? = null, val accountId: String? = null)
