package nl.bvdm.rukoo.mail.demo

import android.content.res.Resources
import androidx.annotation.StringRes
import java.io.File
import java.time.ZoneId
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.MailException
import nl.bvdm.rukoo.mail.compose.ComposeBody
import nl.bvdm.rukoo.mail.mime.MailText
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.AccountPatch
import nl.bvdm.rukoo.mail.model.AccountType
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.AttachmentContent
import nl.bvdm.rukoo.mail.model.AttachmentInfo
import nl.bvdm.rukoo.mail.model.AuthKind
import nl.bvdm.rukoo.mail.model.DeleteOutcome
import nl.bvdm.rukoo.mail.model.DeleteResult
import nl.bvdm.rukoo.mail.model.Failed
import nl.bvdm.rukoo.mail.model.Folder
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.GoogleClient
import nl.bvdm.rukoo.mail.model.GoogleTokens
import nl.bvdm.rukoo.mail.model.Identity
import nl.bvdm.rukoo.mail.model.ImapAccountInput
import nl.bvdm.rukoo.mail.model.ImportedAccount
import nl.bvdm.rukoo.mail.model.MailCounts
import nl.bvdm.rukoo.mail.model.MailEvent
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.MessagePin
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.model.MoveResult
import nl.bvdm.rukoo.mail.model.Moved
import nl.bvdm.rukoo.mail.model.OutgoingMessage
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.mail.model.Signature
import nl.bvdm.rukoo.mail.model.SortOrder
import nl.bvdm.rukoo.mail.model.SyncStatus
import nl.bvdm.rukoo.mail.model.UndoResult
import nl.bvdm.rukoo.mail.model.UnsubscribeResult
import nl.bvdm.rukoo.mail.model.ViewKind
import org.jsoup.Jsoup

/**
 * An in-memory [MailEngine] over the demo mailbox ([PreviewData]): flags, moves, undo and sending work,
 * nothing touches a server or disk except attachment files. The UI tracks build against it until the
 * real engine lands; debug builds keep it as the "preview" engine for screenshots.
 */
class PreviewMailEngine(
    private val clock: Clock = Clock.System,
    private val cacheDir: File? = null,
    zone: ZoneId = ZoneId.systemDefault(),
    /** For translated error messages; tests run without and get the English text. */
    private val resources: Resources? = null,
) : MailEngine {
    private fun text(@StringRes res: Int, english: String): String = resources?.getString(res) ?: english

    private data class Stored(val seed: PreviewData.Seeded, val unread: Boolean, val starred: Boolean, val answered: Boolean = false)

    private data class State(val boxes: Map<String, List<Stored>>, val nextUid: Long, val extraFolders: List<String> = emptyList())

    private val account = Account(
        id = PreviewData.ACCOUNT_ID,
        type = AccountType.DEMO,
        provider = "demo",
        auth = AuthKind.NONE,
        email = Account.DEMO_EMAIL,
        name = PreviewData.ME.name,
        label = Account.DEMO_EMAIL,
        color = Account.COLORS[0],
        createdAt = clock.now(),
    )

    private val seedZone = zone

    private fun seeded(): State = PreviewData.seed(clock.now(), seedZone).let { seeded ->
        val boxes = PreviewData.FOLDERS.associate { (path, _) -> path to emptyList<Stored>() }.toMutableMap()
        for (s in seeded) boxes[s.folder] = boxes.getValue(s.folder) + Stored(s, s.unread, s.starred)
        State(boxes, nextUid = seeded.maxOf { it.uid } + 1)
    }

    private val state = MutableStateFlow(seeded())

    // Old id → where it went and where it came from, for undo and findMoved.
    private data class MoveRecord(val newId: String, val fromFolder: String, val messageId: String)

    private val moves = mutableMapOf<String, MoveRecord>()

    private val _accounts = MutableStateFlow(listOf(account))
    override val accounts: StateFlow<List<Account>> = _accounts.asStateFlow()

    override val loaded: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

    private val _folders = MutableStateFlow(foldersOf(state.value))
    override val folders: StateFlow<Map<String, List<Folder>>> = _folders.asStateFlow()

    private val _sync = MutableStateFlow(SyncStatus(lastSync = mapOf(account.id to clock.now())))
    override val sync: StateFlow<SyncStatus> = _sync.asStateFlow()

    private val _unread = MutableStateFlow(unreadOf(state.value))
    override val unreadCount: StateFlow<Int> = _unread.asStateFlow()

    private val _events = MutableSharedFlow<MailEvent>(extraBufferCapacity = 16)
    override val events: SharedFlow<MailEvent> = _events

    private fun roleOf(path: String): FolderRole =
        PreviewData.FOLDERS.firstOrNull { it.first == path }?.second ?: FolderRole.NONE

    private fun foldersOf(s: State): Map<String, List<Folder>> =
        mapOf(
            account.id to s.boxes.map { (path, list) ->
                Folder(account.id, path, path, roleOf(path), "/", null, list.count { it.unread }, list.size)
            },
        )

    private fun unreadOf(s: State): Int = s.boxes["INBOX"].orEmpty().count { it.unread }

    private fun mutate(transform: (State) -> State) {
        state.update(transform)
        _folders.value = foldersOf(state.value)
        _unread.value = unreadOf(state.value)
    }

    private fun summaryOf(folder: String, m: Stored): MessageSummary {
        val s = m.seed
        return MessageSummary(
            id = MessageIds.encode(account.id, folder, s.uid),
            accountId = account.id,
            accountColor = account.color,
            folder = folder,
            role = roleOf(folder),
            uid = s.uid,
            messageId = s.messageId,
            inReplyTo = s.inReplyTo,
            subject = s.subject,
            from = s.from,
            to = s.to,
            cc = s.cc,
            date = s.date,
            preview = previewOf(s),
            unread = m.unread,
            starred = m.starred,
            answered = m.answered,
            hasAttachments = s.attachments.isNotEmpty(),
        )
    }

    private val previews = mutableMapOf<String, String>()

    private fun previewOf(s: PreviewData.Seeded): String = previews.getOrPut(s.messageId) {
        val text = s.text ?: s.html?.let { Jsoup.parse(it).text() } ?: ""
        text.replace(Regex("\\s+"), " ").trim().take(200)
    }

    private fun all(s: State): List<MessageSummary> = s.boxes.flatMap { (folder, list) -> list.map { summaryOf(folder, it) } }

    private fun inView(m: MessageSummary, view: MailView): Boolean {
        if (view.accountId != null && view.accountId != m.accountId) return false
        return when (view.kind) {
            ViewKind.INBOX -> m.role == FolderRole.INBOX
            ViewKind.UNREAD -> m.role == FolderRole.INBOX && m.unread
            ViewKind.VIP -> m.role == FolderRole.INBOX && m.vip
            ViewKind.STARRED -> m.starred && m.role != FolderRole.TRASH && m.role != FolderRole.JUNK
            ViewKind.DRAFTS -> m.role == FolderRole.DRAFTS
            ViewKind.SENT -> m.role == FolderRole.SENT
            ViewKind.ARCHIVE -> m.role == FolderRole.ARCHIVE || m.role == FolderRole.ALL
            ViewKind.JUNK -> m.role == FolderRole.JUNK
            ViewKind.TRASH -> m.role == FolderRole.TRASH
            ViewKind.FOLDER -> m.folder == view.folder
            ViewKind.EVERYTHING -> true
        }
    }

    // Desktop's search (engine.js:833-841): subject, preview, sender and every To, not Cc.
    private fun matches(m: MessageSummary, query: String): Boolean {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return true
        val hay = buildList {
            add(m.subject)
            add(m.preview)
            add(m.from.name)
            add(m.from.address)
            m.to.forEach { add("${it.name} ${it.address}") }
        }.joinToString(" ").lowercase()
        return q in hay
    }

    private fun sorted(list: List<MessageSummary>, sort: SortOrder): List<MessageSummary> = when (sort) {
        SortOrder.DATE_DESC -> list.sortedByDescending { it.date }
        SortOrder.DATE_ASC -> list.sortedBy { it.date }
        SortOrder.UNREAD -> list.sortedWith(compareByDescending<MessageSummary> { it.unread }.thenByDescending { it.date })
        SortOrder.SENDER -> list.sortedWith(
            compareBy<MessageSummary> { it.from.name.ifEmpty { it.from.address }.lowercase() }.thenByDescending { it.date },
        )
    }

    private fun select(s: State, view: MailView, query: String, sort: SortOrder) =
        sorted(all(s).filter { inView(it, view) && matches(it, query) }, sort)

    override fun messages(view: MailView, query: String, sort: SortOrder): Flow<List<MessageSummary>> =
        state.map { select(it, view, query, sort) }.distinctUntilChanged()

    override suspend fun listMessages(view: MailView, query: String, sort: SortOrder): List<MessageSummary> =
        select(state.value, view, query, sort)

    override fun counts(accountId: String?): Flow<MailCounts> = state.map { s ->
        val list = all(s).filter { accountId == null || it.accountId == accountId }
        val inbox = list.filter { it.role == FolderRole.INBOX }
        val unreadInbox = inbox.count { it.unread }
        MailCounts(
            accounts = mapOf(account.id to unreadInbox),
            all = unreadInbox,
            views = mapOf(
                ViewKind.INBOX to unreadInbox,
                ViewKind.UNREAD to unreadInbox,
                ViewKind.VIP to inbox.count { it.unread && it.vip },
                ViewKind.JUNK to list.count { it.role == FolderRole.JUNK && it.unread },
                ViewKind.ARCHIVE to list.count { it.role == FolderRole.ARCHIVE && it.unread },
                ViewKind.STARRED to list.count { it.starred && it.role != FolderRole.TRASH && it.role != FolderRole.JUNK },
                ViewKind.DRAFTS to list.count { it.role == FolderRole.DRAFTS },
                ViewKind.SENT to list.count { it.role == FolderRole.SENT },
                ViewKind.TRASH to list.count { it.role == FolderRole.TRASH },
            ),
            folders = if (accountId == null) emptyMap() else list.groupBy { it.folder }.mapValues { (_, v) -> v.count { it.unread } },
        )
    }.distinctUntilChanged()

    private fun find(id: String): Pair<String, Stored>? {
        val key = MessageIds.decode(id) ?: return null
        if (key.accountId != account.id) return null
        val stored = state.value.boxes[key.folder]?.firstOrNull { it.seed.uid == key.uid } ?: return null
        return key.folder to stored
    }

    private fun require(id: String): Pair<String, Stored> = find(id) ?: throw MailException(text(R.string.preview_error_message_missing, "Message not found."), "missing")

    override suspend fun summary(id: String): MessageSummary? = find(id)?.let { (folder, m) -> summaryOf(folder, m) }

    override suspend fun findByMessageId(messageId: String, accountId: String?): List<MessageSummary> {
        val key = MessageIds.headerKey(messageId)
        if (key.isEmpty()) return emptyList()
        return all(state.value).filter {
            (accountId == null || it.accountId == accountId) && MessageIds.headerKey(it.messageId) == key
        }
    }

    override suspend fun findMoved(accountId: String, messageId: String, fromFolder: String?): String? {
        val key = MessageIds.headerKey(messageId)
        val record = moves.values.lastOrNull {
            MessageIds.headerKey(it.messageId) == key && (fromFolder == null || it.fromFolder == fromFolder)
        } ?: return null
        return record.newId.takeIf { find(it) != null }
    }

    private fun textToHtml(text: String): String =
        text.split('\n').joinToString("") { line ->
            if (line.isEmpty()) "<div><br></div>" else "<div>${org.jsoup.nodes.Entities.escape(line)}</div>"
        }

    // Every demo folder has UIDVALIDITY 1, like desktop's demo server.
    override suspend fun pinOf(id: String): MessagePin? = find(id)?.let { (_, m) -> MessagePin(m.seed.messageId, "1") }

    override suspend fun fullMessage(id: String): FullMessage {
        val (folder, m) = require(id)
        val s = m.seed
        val text = s.text ?: s.html?.let { Jsoup.parse(it).wholeText().replace(Regex("\n{3,}"), "\n\n").trim() } ?: ""
        return FullMessage(
            summary = summaryOf(folder, m),
            bcc = s.bcc,
            references = s.references,
            html = s.html ?: textToHtml(s.text ?: ""),
            isHtml = s.html != null,
            text = text,
            unsubscribe = s.unsubscribe,
            attachments = s.attachments.mapIndexed { i, name -> AttachmentInfo(i, name, "application/pdf", PreviewData.PDF.size.toLong()) },
        )
    }

    override suspend fun rawSource(id: String): ByteArray {
        val full = fullMessage(id)
        return buildString {
            append("From: ${full.from.display()}\r\n")
            append("To: ${full.to.joinToString(", ") { it.display() }}\r\n")
            append("Subject: ${full.subject}\r\n")
            full.messageId?.let { append("Message-ID: $it\r\n") }
            append("\r\n")
            append(full.text)
        }.toByteArray(Charsets.UTF_8)
    }

    override suspend fun attachment(id: String, index: Int): AttachmentContent {
        val (_, m) = require(id)
        val name = m.seed.attachments.getOrNull(index) ?: throw MailException(text(R.string.preview_error_attachment_missing, "Attachment not found."), "missing")
        return AttachmentContent(name, "application/pdf", null, PreviewData.PDF)
    }

    override suspend fun attachmentFile(id: String, index: Int): File {
        val content = attachment(id, index)
        val dir = File(cacheDir ?: throw MailException(text(R.string.preview_error_attachment_missing, "Attachment not found."), "missing"), "attachments")
        dir.mkdirs()
        val file = File(dir, content.filename.replace(Regex("[\\\\/:*?\"<>|]"), "_"))
        file.writeBytes(content.bytes)
        return file
    }

    override suspend fun refresh(accountId: String?) {
        _sync.update { it.copy(running = setOf(account.id)) }
        delay(400)
        _sync.update { it.copy(running = emptySet(), lastSync = mapOf(account.id to clock.now())) }
    }

    override suspend fun openFolder(accountId: String, path: String) = Unit

    override suspend fun setFlags(ids: List<String>, unread: Boolean?, starred: Boolean?, answered: Boolean?) {
        val keys = ids.mapNotNull { MessageIds.decode(it) }.toSet()
        mutate { s ->
            s.copy(
                boxes = s.boxes.mapValues { (folder, list) ->
                    list.map { m ->
                        if (keys.none { it.folder == folder && it.uid == m.seed.uid }) {
                            m
                        } else {
                            m.copy(unread = unread ?: m.unread, starred = starred ?: m.starred, answered = answered ?: m.answered)
                        }
                    }
                },
            )
        }
    }

    override suspend fun markAllRead(view: MailView): Int {
        val ids = listMessages(view).filter { it.unread }.map { it.id }
        setFlags(ids, unread = false)
        return ids.size
    }

    private fun moveOne(id: String, target: String): Moved {
        val (from, m) = require(id)
        // Like desktop's move: already there is nothing to do, and nothing to undo.
        if (from == target) return Moved(id, id, undoable = false)
        if (target !in state.value.boxes) throw MailException(text(R.string.preview_error_folder_missing, "Folder not found."), "folder")
        var newUid = 0L
        mutate { s ->
            newUid = s.nextUid
            val moved = m.copy(seed = m.seed.copy(uid = newUid, folder = target))
            s.copy(
                boxes = s.boxes.mapValues { (path, list) ->
                    when (path) {
                        from -> list.filterNot { it.seed.uid == m.seed.uid }
                        target -> list + moved
                        else -> list
                    }
                },
                nextUid = s.nextUid + 1,
            )
        }
        val newId = MessageIds.encode(account.id, target, newUid)
        moves[id] = MoveRecord(newId, from, m.seed.messageId)
        return Moved(id, newId, undoable = true)
    }

    private fun moveAll(ids: List<String>, target: String): MoveResult {
        val moved = mutableListOf<Moved>()
        val failed = mutableListOf<Failed>()
        for (id in ids) {
            runCatching { moveOne(id, target) }
                .onSuccess { moved += it }
                .onFailure { failed += Failed(id, it.message ?: "") }
        }
        return MoveResult(moved, failed, target)
    }

    override suspend fun archive(ids: List<String>): MoveResult = moveAll(ids, "Archive")

    override suspend fun move(ids: List<String>, targetPath: String): MoveResult = moveAll(ids, targetPath)

    override suspend fun delete(ids: List<String>, force: Boolean): DeleteResult {
        val inTrash = ids.any { MessageIds.decode(it)?.folder == "Trash" }
        if (!inTrash) return DeleteResult(DeleteOutcome.TRASHED, moveAll(ids, "Trash"))
        if (!force) return DeleteResult(DeleteOutcome.NEEDS_CONFIRM)
        val keys = ids.mapNotNull { MessageIds.decode(it) }.toSet()
        mutate { s ->
            s.copy(boxes = s.boxes.mapValues { (folder, list) -> list.filterNot { m -> keys.any { it.folder == folder && it.uid == m.seed.uid } } })
        }
        return DeleteResult(DeleteOutcome.DELETED)
    }

    override fun canUndo(oldId: String): Boolean = moves[oldId]?.let { find(it.newId) != null } == true

    override suspend fun undoMove(oldIds: List<String>): UndoResult {
        val restored = mutableListOf<String>()
        val failed = mutableListOf<Failed>()
        for (old in oldIds) {
            val record = moves[old]
            if (record == null || find(record.newId) == null) {
                failed += Failed(old, text(R.string.preview_error_message_missing, "Message not found."))
                continue
            }
            val back = moveOne(record.newId, record.fromFolder)
            moves.remove(old)
            moves.remove(record.newId)
            back.newId?.let { restored += it }
        }
        return UndoResult(restored, failed)
    }

    override suspend fun createFolder(accountId: String, name: String): String {
        val path = name.trim()
        if (path.isEmpty() || path in state.value.boxes) throw MailException(text(R.string.preview_error_folder_exists, "There is already a folder with that name."), "exists")
        mutate { it.copy(boxes = it.boxes + (path to emptyList()), extraFolders = it.extraFolders + path) }
        return path
    }

    // The same body the real engine sends: the text, the signature, the quote. Returns the new message's id.
    private fun append(folder: String, message: OutgoingMessage, unread: Boolean): String {
        // Forwarded and draft attachments are fetched from their source, as the real engine does: a source that is
        // gone fails the same way.
        for (a in message.attachments) if (a.sourceMessageId != null) require(a.sourceMessageId)
        val body = ComposeBody.build(message.text, if (message.signature) signatureFor(message.accountId) else null, message.quote, message.html)
        var uid = 0L
        mutate { s ->
            uid = s.nextUid
            val seeded = PreviewData.Seeded(
                uid = s.nextUid, folder = folder, from = message.from, to = message.to, cc = message.cc,
                subject = message.subject, date = clock.now(), html = body.html, text = body.text,
                attachments = message.attachments.map { it.filename },
                messageId = "<demo-${clock.now()}-${s.nextUid}@example.com>", unread = unread, starred = false,
                inReplyTo = message.inReplyTo, references = message.references,
                bcc = if (folder == "Drafts") message.bcc else emptyList(),
            )
            s.copy(boxes = s.boxes + (folder to (s.boxes[folder].orEmpty() + Stored(seeded, unread, false))), nextUid = s.nextUid + 1)
        }
        return MessageIds.encode(account.id, folder, uid)
    }

    private fun drop(id: String) {
        val key = MessageIds.decode(id) ?: return
        mutate { s -> s.copy(boxes = s.boxes.mapValues { (folder, list) -> if (folder == key.folder) list.filterNot { it.seed.uid == key.uid } else list }) }
    }

    override suspend fun send(message: OutgoingMessage) {
        append("Sent", message, unread = false)
        // Like the desktop demo: mail to the demo address arrives in its inbox.
        val all = message.to + message.cc + message.bcc
        if (all.any { it.address.equals(Account.DEMO_EMAIL, ignoreCase = true) }) {
            append("INBOX", message, unread = true)
            _events.tryEmit(MailEvent.NewMail(listMessages(MailView.AllInboxes).take(1)))
        }
        message.draftId?.let(::drop)
        if (message.replyKind == ReplyKind.REPLY || message.replyKind == ReplyKind.REPLY_ALL) {
            message.sourceMessageId?.let { setFlags(listOf(it), answered = true) }
        }
    }

    // Stored first, then the old copy goes, as the real engine does: the new copy is made from the old one's attachments.
    override suspend fun saveDraft(message: OutgoingMessage): String? {
        val id = append("Drafts", message, unread = false)
        message.draftId?.let(::drop)
        return id
    }

    override suspend fun discardDraft(id: String) {
        require(id)
        drop(id)
    }

    override suspend fun unsubscribe(id: String): UnsubscribeResult =
        if (require(id).second.seed.unsubscribe != null) UnsubscribeResult.Done else UnsubscribeResult.Unavailable

    override fun archiveFolder(accountId: String): String? = "Archive"

    override fun identities(accountId: String): List<Identity> = listOf(Identity(account.email, account.name, primary = true))

    override fun signatureFor(accountId: String): Signature? {
        val acc = _accounts.value.firstOrNull { it.id == accountId } ?: return null
        val text = acc.signature.orEmpty()
        val html = acc.signatureHtml.orEmpty()
        if (text.isBlank() && html.isBlank()) return null
        return Signature(text, html.ifEmpty { MailText.esc(text).replace("\n", "<br>") })
    }

    override suspend fun contacts(): List<Address> {
        val score = mutableMapOf<String, Pair<Address, Int>>()
        fun add(a: Address, weight: Int) {
            val key = a.address.lowercase()
            if ('@' !in key || Regex("no-?reply|do-?not-?reply").containsMatchIn(key) || key == Account.DEMO_EMAIL) return
            val prev = score[key]
            score[key] = (prev?.first ?: a) to ((prev?.second ?: 0) + weight)
        }
        for (m in all(state.value)) {
            if (m.role == FolderRole.SENT) (m.to + m.cc).forEach { add(it, 3) } else add(m.from, 1)
        }
        return score.values.sortedByDescending { it.second }.map { it.first }
    }

    private fun unavailable(): Nothing = throw MailException(text(R.string.preview_error_accounts, "The preview mailbox can't add accounts."), "preview")

    override suspend fun addImapAccount(input: ImapAccountInput): Account = unavailable()

    override suspend fun addGoogleAccount(tokens: GoogleTokens): Account = unavailable()

    /** "Try the demo account" after it was removed: the demo mailbox comes back as it started. */
    override suspend fun addDemoAccount(): Account {
        _accounts.value.firstOrNull()?.let { return it }
        moves.clear()
        mutate { seeded() }
        _accounts.value = listOf(account)
        _sync.value = SyncStatus(lastSync = mapOf(account.id to clock.now()))
        return account
    }

    override suspend fun importAccounts(imported: List<ImportedAccount>, googleClient: GoogleClient?): List<Account> = unavailable()

    override suspend fun updateAccount(id: String, patch: AccountPatch): Account {
        val updated = (_accounts.value.firstOrNull() ?: account).let {
            it.copy(
                name = patch.name ?: it.name,
                label = patch.label ?: it.label,
                color = patch.color ?: it.color,
                signature = if (patch.signature != null) patch.signature.value else it.signature,
                signatureHtml = if (patch.signatureHtml != null) patch.signatureHtml.value else it.signatureHtml,
                defaultFrom = if (patch.defaultFrom != null) patch.defaultFrom.value else it.defaultFrom,
                aliases = patch.aliases ?: it.aliases,
            )
        }
        _accounts.value = listOf(updated)
        return updated
    }

    override suspend fun removeAccount(id: String) {
        _accounts.value = emptyList()
        mutate { it.copy(boxes = emptyMap()) }
        _events.tryEmit(MailEvent.AccountRemoved(id))
    }
}
