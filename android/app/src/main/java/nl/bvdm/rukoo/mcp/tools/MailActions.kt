package nl.bvdm.rukoo.mcp.tools

import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.agents.ApprovalTicket
import nl.bvdm.rukoo.agents.model.ApprovalChoice
import nl.bvdm.rukoo.agents.model.ApprovalField
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.ChoiceKind
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MailApproval
import nl.bvdm.rukoo.agents.model.NoticeMail
import nl.bvdm.rukoo.agents.model.NoticeUndo
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.core.Unsafe
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.DeleteOutcome
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.MessagePin
import nl.bvdm.rukoo.mail.model.MoveResult
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.mail.model.UnsubscribeResult
import nl.bvdm.rukoo.ui.ComposerState

/** What a mail action did (desktop executeMail's return): ids done, failures, moves that can be undone, a summary. */
data class MailOutcome(val done: List<String>, val failed: List<Pair<String, String>>, val undo: List<String>, val text: String)

/**
 * mail_action (tools.js:1250-1525). Archive, move and mark run at once when the user turned that on; deleting,
 * unsubscribing and a move into Trash always ask. An approval card returns at once; when the user decides, the
 * action runs here and its outcome goes into the agent's next message as a note (desktop onMailDecision).
 * Mail work for one chat runs in order, on its own chain.
 */
internal class MailActions(private val d: ToolDeps, private val lookup: MailLookup) {
    private val chains = ConcurrentHashMap<String, Mutex>()

    suspend fun request(args: JsonObject, call: ToolCall): JsonObject {
        val action = args.str("action").orEmpty()
        val ids = mutableListOf<String>()
        val bad = mutableListOf<String>()
        for (v in args.list("message_ids").orEmpty().map { (it as JsonPrimitive).content }.distinct()) {
            try {
                ids += resolve(v)
            } catch (e: ToolError) {
                // An email in more than one account is not unknown: say which accounts have it.
                if (e.ambiguous) throw e
                bad += v
            }
        }
        if (bad.isNotEmpty()) {
            throw ToolError("Unknown message ids: ${bad.joinToString(", ") { Unsafe.value(it) }}. Ids change when mail moves; use search_mail for current ids.")
        }
        val accounts = ids.mapNotNull { MessageIds.decode(it)?.accountId }.distinct().mapNotNull { lookup.account(it) }
        val folder = args.str("folder")
        if (action == "move") {
            if (folder.isNullOrEmpty()) throw ToolError("folder is required for move.")
            val missing = accounts.filter { lookup.resolveFolder(it, folder) == null }
            if (missing.isNotEmpty()) throw ToolError("No folder ${Unsafe.value(folder)}. Folders: ${lookup.folderList(missing)}.")
        }
        if (action == "archive") {
            val none = accounts.filter { d.mail.archiveFolder(it.id) == null }
            if (none.isNotEmpty()) throw ToolError("${none.joinToString(", ") { it.email }} has no archive folder. Use move instead.")
        }
        val c = ensureConversation(d, lookup, call)
        val spec = MailApproval(action, ids, if (action == "move") folder else null, ids.map { d.mail.pinOf(it) ?: MessagePin() })
        val senders = ids.associateWith { senderName(it) }
        val title = title(spec, senders)
        // The setting covers archive, move and mark. Deleting and unsubscribing always ask, and so does a move that
        // lands in Trash, which is a delete by another name.
        val intoTrash = action == "move" && accounts.any { a ->
            val target = lookup.resolveFolder(a, folder)
            lookup.publicFolders(a.id).any { it.path == target && it.role == "trash" }
        }
        if (d.agentSettings().autoMailActions && action != "unsubscribe" && action != "trash" && !intoTrash) {
            return runNow(c.id, spec, title, senders)
        }
        val fields = ids.take(6).map { id ->
            val m = d.mail.summary(id)
            ApprovalField(m?.from?.let { it.name.ifEmpty { it.address } }.orEmpty(), m?.subject?.ifEmpty { null } ?: "(no subject)")
        }.toMutableList()
        if (ids.size > 6) fields += ApprovalField("", "and ${ids.size - 6} more")
        val ticket = d.hub.requestApproval(
            c.id,
            ApprovalRequest(
                title = title,
                detail = "",
                fields = fields,
                choices = listOf(ApprovalChoice("approve", VERBS.getValue(action).first, ChoiceKind.PRIMARY), ApprovalChoice("decline", "Cancel", ChoiceKind.DEFAULT)),
                source = "rukoo",
                kind = ApprovalKind.MAIL,
                mail = spec,
            ),
        )
        watch(c.id, ticket, title, spec)
        return buildJsonObject {
            put("conversation_id", c.id)
            put("proposal_id", ticket.itemId)
            put("status", "waiting_for_user")
            put("note", "Rukoo is asking the user. Do not repeat the request; you will be told the outcome in your next message.")
        }
    }

    private suspend fun resolve(v: String): String {
        // mail_action never touches a copy saved on a device.
        return lookup.resolveId(v)
    }

    /**
     * The call waits for the work, but its client gives up after 120 s and a slow IMAP server can take longer. Then
     * the call answers that the work goes on, and the outcome comes with the agent's next message as a note.
     */
    private suspend fun runNow(cid: String, spec: MailApproval, title: String, senders: Map<String, String>): JsonObject {
        val outcome = CompletableDeferred<Result<MailOutcome>>()
        val lock = Any()
        var late = false
        settle(cid) {
            val r = try {
                Result.success(execute(cid, spec, senders))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Result.failure(e)
            }
            val report = synchronized(lock) {
                if (late) true else {
                    outcome.complete(r)
                    false
                }
            }
            if (report) {
                val action = Unsafe.inline(title, "mail action")
                d.hub.addNote(
                    cid,
                    r.fold(
                        { "Rukoo finished $action: ${Unsafe.inline(it.text, "mail result")}." },
                        { "Rukoo could not finish $action: ${Unsafe.inline(it.message ?: it.javaClass.simpleName, "mail result")}. Part of it may be done; check the mail before you try again." },
                    ),
                )
            }
        }
        val got = withTimeoutOrNull(d.mailWaitMs) { outcome.await() } ?: synchronized(lock) {
            if (outcome.isCompleted) outcome.getCompleted() else null.also { late = true }
        }
        if (got == null) {
            return buildJsonObject {
                put("conversation_id", cid)
                put("status", "in_progress")
                put("note", "Rukoo is still doing this. You will be told the outcome in your next message; do not repeat the request.")
            }
        }
        val result = got.getOrThrow()
        return buildJsonObject {
            put("conversation_id", cid)
            put("status", "done")
            put("done", result.done.size)
            put(
                "failed",
                buildJsonArray {
                    for ((id, error) in result.failed) {
                        add(
                            buildJsonObject {
                                put("id", id)
                                put("error", error)
                            },
                        )
                    }
                },
            )
            put("undoable", result.undo.isNotEmpty())
            put("summary", result.text)
        }
    }

    // Waits for the user's decision on a card this call showed. "cancel" is an expired card: no outcome to report.
    private fun watch(cid: String, ticket: ApprovalTicket, title: String, spec: MailApproval) {
        d.scope.launch(d.hubContext) {
            val choice = try {
                ticket.choice.await()
            } catch (_: CancellationException) {
                return@launch
            }
            if (choice == "cancel") return@launch
            val item = d.hub.get(cid)?.items?.firstOrNull { it.id == ticket.itemId } as? Item.Approval
            // The hub refused the card itself (too long to show) and told the agent so.
            if (item?.declinedBy == "rukoo") return@launch
            decide(cid, title, spec, approved = choice == "approve")
        }
    }

    /** A decision on a card whose watcher is gone (the app restarted since it was shown). */
    fun decided(cid: String, item: Item.Approval, approved: Boolean) {
        val spec = item.mail ?: return
        d.scope.launch(d.hubContext) { decide(cid, item.title, spec, approved) }
    }

    // Mail titles and results hold sender names and subjects, which come from the email: tagged as unsafe content.
    private fun decide(cid: String, title: String, spec: MailApproval, approved: Boolean) {
        settle(cid) {
            if (!approved) {
                d.hub.addNote(cid, "The user declined: ${Unsafe.inline(title, "mail action")}.")
                return@settle
            }
            val result = execute(cid, spec, spec.ids.associateWith { senderName(it) })
            d.hub.addNote(cid, "The user approved: ${Unsafe.inline(title, "mail action")}. Rukoo: ${Unsafe.inline(result.text, "mail result")}.")
        }
    }

    /** Runs [work] after the chat's earlier mail work; a failure shows as a notice in the chat. */
    private fun settle(cid: String, work: suspend () -> Unit) {
        val chain = chains.getOrPut(cid) { Mutex() }
        d.scope.launch(d.hubContext) {
            chain.withLock {
                try {
                    work()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    runCatching { d.hub.addItem(cid, Item.Notice("", 0, e.message ?: "Something went wrong.", tone = Tone.ERROR, code = "unknown")) }
                }
            }
        }
    }

    // From the email, so one line and short: it ends up in card titles and in the agent's notes.
    private suspend fun senderName(id: String): String {
        val m = d.mail.summary(id)
        val name = m?.from?.let { it.name.ifEmpty { it.address } }.orEmpty()
        return name.replace(Regex("\\s+"), " ").trim().take(80).ifEmpty { "this sender" }
    }

    private fun title(spec: MailApproval, senders: Map<String, String>): String {
        val n = spec.ids.size
        return when (spec.action) {
            "move" -> "Move ${emails(n)} to ${spec.folder}"
            "trash" -> "Delete ${emails(n)}"
            "mark_read" -> "Mark ${emails(n)} as read"
            "mark_unread" -> "Mark ${emails(n)} as unread"
            "unsubscribe" -> {
                val names = spec.ids.map { senders[it] ?: "this sender" }.distinct()
                if (names.size == 1) "Unsubscribe from ${names[0]}" else "Unsubscribe from ${names.size} senders"
            }
            else -> "${VERBS.getValue(spec.action).first} ${emails(n)}"
        }
    }

    /** Runs an approved (or auto-approved) action, adds a notice to the chat and returns what happened. */
    suspend fun execute(cid: String, spec: MailApproval, senders: Map<String, String>): MailOutcome {
        val action = spec.action
        val done = mutableListOf<String>()
        val failed = mutableListOf<Pair<String, String>>()
        val undo = mutableListOf<String>()
        // Unsubscribes by what Rukoo could do: done (one-click), the page opened, or an email opened to send.
        val unsubscribed = mutableListOf<String>()
        val opened = mutableListOf<String>()
        val mailed = mutableListOf<String>()
        for ((i, id) in spec.ids.withIndex()) {
            try {
                val cached = d.mail.summary(id)
                if (cached == null || !samePin(spec.pins.getOrNull(i), d.mail.pinOf(id))) throw Fail("The email is no longer there (it may have moved).")
                val key = MessageIds.decode(id) ?: throw Fail("The email is no longer there (it may have moved).")
                val acc = lookup.account(key.accountId)
                val email = acc?.email ?: key.accountId
                when (action) {
                    "archive" -> check(d.mail.archive(listOf(id)))
                    "trash" -> {
                        val trash = d.mail.folders.value[key.accountId].orEmpty().firstOrNull { it.role == FolderRole.TRASH }
                        // Never delete for good: mail that is already in the trash stays there.
                        if (trash?.path != key.folder) {
                            val r = d.mail.delete(listOf(id))
                            if (r.outcome == DeleteOutcome.NEEDS_CONFIRM) throw Fail("$email has no Trash folder.")
                            check(r.move)
                        }
                    }
                    "move" -> {
                        // The folder was there when the action was asked for. Its name came from the agent and may be a
                        // sender's text, and this message reaches the agent, so it does not repeat the name.
                        val dest = try {
                            acc?.let { lookup.resolveFolder(it, spec.folder) }
                        } catch (_: ToolError) {
                            throw Fail("More than one folder in $email has the destination's name now. Ask again with its full path.")
                        } ?: throw Fail("The destination folder is no longer in $email.")
                        check(d.mail.move(listOf(id), dest))
                    }
                    "mark_read" -> d.mail.setFlags(listOf(id), unread = false)
                    "mark_unread" -> d.mail.setFlags(listOf(id), unread = true)
                    "star" -> d.mail.setFlags(listOf(id), starred = true)
                    "unstar" -> d.mail.setFlags(listOf(id), starred = false)
                    "unsubscribe" -> when (val r = d.mail.unsubscribe(id)) {
                        UnsubscribeResult.Done -> unsubscribed += id
                        is UnsubscribeResult.OpenPage -> {
                            if (!d.opener.openPage(r.url)) throw Fail("Rukoo could not open the unsubscribe page on the phone.")
                            opened += id
                        }
                        // The sender only takes requests by email: open it, filled in, like the reader's Unsubscribe
                        // button does. The user sends it; Rukoo never does.
                        is UnsubscribeResult.SendEmail -> mailed += openUnsubscribeEmail(key.accountId, r)
                        UnsubscribeResult.Unavailable -> throw Fail("This email has no unsubscribe link.")
                    }
                    else -> throw Fail("Unknown action.")
                }
                done += id
                if (action in MOVES && d.mail.canUndo(id)) undo += id
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed += id to (e.message ?: e.javaClass.simpleName)
            }
        }
        val folder = spec.folder
        var text = when {
            action == "unsubscribe" -> {
                // Only a one-click unsubscribe is done. A page may still ask to confirm, and Rukoo can't see whether it worked.
                val parts = mutableListOf<String>()
                if (unsubscribed.isNotEmpty()) {
                    val names = unsubscribed.map { senders[it] ?: "this sender" }.distinct()
                    parts += if (names.size == 1) "Unsubscribed from ${names[0]}" else "Unsubscribed from ${names.size} senders"
                }
                if (opened.isNotEmpty()) {
                    parts += if (opened.size == 1) {
                        "Opened the unsubscribe page for ${senders[opened[0]] ?: "this sender"} in the browser. Finish there; Rukoo cannot tell whether it worked"
                    } else {
                        "Opened ${opened.size} unsubscribe pages in the browser. Finish there; Rukoo cannot tell whether they worked"
                    }
                }
                if (mailed.isNotEmpty()) parts += if (mailed.size == 1) "Opened an unsubscribe email to ${mailed[0]}. Send it to finish" else "Opened ${mailed.size} unsubscribe emails. Send them to finish"
                parts.joinToString(". ")
            }
            action == "move" -> "Moved ${emails(done.size)} to $folder"
            else -> "${VERBS.getValue(action).second} ${emails(done.size)}"
        }
        if (done.isEmpty()) text = "Could not ${VERBS.getValue(action).first.lowercase()} ${emails(spec.ids.size)}"
        if (failed.isNotEmpty()) text += ". ${failed.size} failed: ${failed[0].second}"
        d.hub.addItem(
            cid,
            Item.Notice(
                id = "",
                at = 0,
                text = text,
                tone = if (done.isNotEmpty()) Tone.SUCCESS else Tone.ERROR,
                code = null,
                undo = if (undo.isNotEmpty()) NoticeUndo("move", undo) else null,
                // An unsubscribe that still needs sending, or finishing in the browser, is not "Unsubscribed".
                mail = NoticeMail(
                    action = if (mailed.isNotEmpty()) "unsubscribe_email" else if (opened.isNotEmpty()) "unsubscribe_page" else action,
                    count = done.size,
                    failed = failed.size,
                    folder = folder,
                    mailed = mailed.size,
                    to = if (mailed.size == 1) mailed[0].take(320) else null,
                    opened = opened.size,
                    sender = if (opened.size == 1) senders[opened[0]] else null,
                ),
            ),
        )
        return MailOutcome(done, failed, undo, text)
    }

    // The phone has one composer: the unsubscribe email takes it unless the user is writing there.
    private fun openUnsubscribeEmail(accountId: String, r: UnsubscribeResult.SendEmail): String {
        val to = DraftWriter.people(listOf(JsonPrimitive(r.to)), "to")?.firstOrNull()?.address
            ?: throw Fail("This sender only takes unsubscribe requests by email.")
        val open = d.composer.current()
        if (open != null && open.draftedBy == null && (open.dirty || open.body.isNotBlank())) {
            throw Fail("The user is writing another email in Rukoo's composer, so the unsubscribe email was not opened.")
        }
        val identity = d.mail.identities(accountId).let { ids -> ids.firstOrNull { it.primary } ?: ids.firstOrNull() }
        d.composer.open(
            ComposerState(
                accountId = accountId,
                from = identity?.let { Address(it.name, it.address) },
                to = listOf(Address("", to)),
                subject = r.subject,
                body = r.body,
                replyKind = ReplyKind.NEW,
            ),
        )
        return to.take(320)
    }

    private fun check(r: MoveResult) {
        r.failed.firstOrNull()?.let { throw Fail(it.error) }
    }

    private fun samePin(pin: MessagePin?, now: MessagePin?): Boolean = pin == null || pin.matches(now ?: MessagePin())

    private class Fail(message: String) : Exception(message)

    companion object {
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
        private val MOVES = setOf("archive", "trash", "move")

        fun emails(n: Int) = "$n email${if (n == 1) "" else "s"}"
    }
}
