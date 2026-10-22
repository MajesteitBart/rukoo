package nl.bvdm.rukoo.ui

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.nullable
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.Ids
import nl.bvdm.rukoo.core.JsonFiles
import nl.bvdm.rukoo.mail.compose.RichDoc
import nl.bvdm.rukoo.mail.compose.RichText
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.OutgoingAttachment
import nl.bvdm.rukoo.mail.model.ReplyKind

/**
 * The composer's content. [id] is the composer key a draft card refers to; it stays the same while
 * the composer is open. [body] is the plain text the user (or an agent) wrote, without the signature
 * and without the quote: the engine adds the account's signature under it when the mail goes, unless
 * [signatureExcluded]. [bodyHtml] is the same text with its formatting, null while it has none; [body] stays
 * its plain projection (RichText.plain), so everything that reads text keeps working. [quote] is the quoted
 * original of a reply or forward as desktop's HTML block (mail.compose.Quote). [draftedBy] names the agent that
 * wrote the current text, null when the user did.
 */
@Serializable
data class ComposerState(
    val id: String = Ids.uuid(),
    val accountId: String? = null,
    val from: Address? = null,
    val to: List<Address> = emptyList(),
    val cc: List<Address> = emptyList(),
    val bcc: List<Address> = emptyList(),
    val subject: String = "",
    val body: String = "",
    val quote: String = "",
    val replyKind: ReplyKind = ReplyKind.NEW,
    val sourceMessageId: String? = null,
    val inReplyTo: String? = null,
    val references: List<String> = emptyList(),
    val attachments: List<OutgoingAttachment> = emptyList(),
    val draftedBy: String? = null,
    /** Changed since it was opened or last saved. */
    val dirty: Boolean = false,
    /**
     * The chat whose agent wrote the current text (write_draft), null when the user did. The UI clears it
     * together with [draftedBy] when the user edits, so a background chat never overwrites the user's words.
     */
    val draftedIn: String? = null,
    /** The user left the quoted original out ("Exclude from message"). */
    val quoteExcluded: Boolean = false,
    /** The agent whose draft the user has since changed: the "Drafted by {name} · edited" mark. [draftedBy] is then null. */
    val editedAgent: String? = null,
    /** When it was last kept as a draft on this phone (the Drafts list's date); 0 while it never was. */
    val savedAt: Long = 0,
    /**
     * Recipient text typed in "to", "cc" or "bcc" that isn't a recipient yet (no comma or Enter so far). It is
     * part of the draft so it is saved with it; Send and Save turn it into recipients first.
     */
    val typed: Map<String, String> = emptyMap(),
    /** The user took the signature off this message. */
    val signatureExcluded: Boolean = false,
    /**
     * The Rukoo id of the draft in the account's Drafts folder that this composer edits (a draft reopened from
     * the server, or saved there since). Sending deletes it; saving again replaces it.
     */
    val draftId: String? = null,
    /** Attachments that still point at a stored copy a save replaced; settled before the next save or Send. */
    val rebind: PendingRebind? = null,
    /** [body] with its formatting in the composer's HTML subset (mail.compose.RichText); null for plain text. */
    val bodyHtml: String? = null,
) {
    /**
     * [bodyHtml] while it still holds [body]'s words, else null. Code that only sets [body] (an Undo back to
     * nothing, a plain text from a mailto link) leaves an older HTML behind; that one must not be sent or shown.
     */
    fun richHtml(): String? = bodyHtml?.takeIf { RichText.sameText(RichText.plain(RichText.parse(it)), body) }

    /** The text as the editor shows it: [richHtml] read back, or [body] as plain text. */
    fun richDoc(): RichDoc = richHtml()?.let(RichText::parse) ?: RichText.fromText(body)
}

/**
 * A save replaced the stored draft [from] with [to], but the attachments that came from [from] couldn't be
 * pointed at [to] yet. [saved] is the attachment list as it was saved: [to] lists them in that order.
 */
@Serializable
data class PendingRebind(val from: String, val to: String, val saved: List<OutgoingAttachment>)

/**
 * The single composer, shared by the UI and the agent tools (write_draft, get_draft): an open draft
 * survives folding, the chat taking the screen, and the activity going away. With a [file] it also
 * survives the process: the draft is written there shortly after each change and removed on close.
 */
class ComposerController(
    private val file: File? = null,
    scope: CoroutineScope? = null,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    /** The hub's clock: [undoAgentDraftSince] compares its snapshot time with the draft cards' times. */
    private val clock: Clock = Clock.System,
) {
    private val _state = MutableStateFlow(file?.let { restore(it) })
    val state: StateFlow<ComposerState?> = _state.asStateFlow()

    private val _savedAt = MutableStateFlow<Long?>(null)

    /** When the open draft was last written to this phone's storage; null until then and after closing. */
    val savedAt: StateFlow<Long?> = _savedAt.asStateFlow()

    // What the composer held right before an agent's draft replaced it, for "Drafted by … · Undo". Keyed by
    // the agent draft's composer id, so an Undo never restores over a different draft.
    private var beforeAgent: Pair<String, ComposerState?>? = null

    // When that snapshot was taken. The agent's writes since then are the ones an Undo takes back; an earlier write
    // the user then edited stays part of what Undo restores (desktop resets its covered writes after user edits).
    private var beforeAgentAt = 0L

    init {
        if (file != null && scope != null) {
            scope.launch {
                // The latest state wins; typing doesn't write on every key, closing removes the file at once.
                // collectLatest lets a running write finish before the next state is handled, so a close
                // during a write still deletes the file afterwards.
                _state.collectLatest { draft ->
                    if (draft != null) delay(SAVE_DELAY_MS)
                    try {
                        withContext(io) {
                            if (draft == null) file.delete() else JsonFiles.write(file, ComposerState.serializer(), draft)
                        }
                        _savedAt.value = if (draft == null) null else System.currentTimeMillis()
                    } catch (e: IOException) {
                        // A full disk must not take the app down; the draft stays in memory.
                        AppLog.w(TAG, "could not save the open draft", e)
                    }
                }
            }
        }
    }

    private fun restore(file: File): ComposerState? =
        runCatching { JsonFiles.read(file, ComposerState.serializer().nullable, null) }.getOrNull()

    fun current(): ComposerState? = _state.value

    val isOpen: Boolean get() = _state.value != null

    /** Opens [draft], replacing what was open. Returns the composer key. */
    fun open(draft: ComposerState = ComposerState()): String {
        val before = _state.value
        remember(before, draft)
        _state.value = draft
        return draft.id
    }

    /** Changes the open draft; does nothing while the composer is closed. */
    fun update(transform: (ComposerState) -> ComposerState) {
        var before: ComposerState? = null
        var after: ComposerState? = null
        _state.update { current ->
            before = current
            current?.let(transform).also { after = it }
        }
        after?.let { remember(before, it) }
    }

    // An agent's text arriving keeps what the composer held before it. When the agent rewrites its own
    // draft, the first snapshot stays: Undo goes back to before the agent, not to its earlier version.
    private fun remember(before: ComposerState?, after: ComposerState) {
        if (after.draftedBy == null) return
        val agentsOwn = before != null && before.id == after.id && before.draftedBy != null
        if (agentsOwn && (beforeAgent?.first == after.id || (before!!.body == after.body && before.bodyHtml == after.bodyHtml))) return
        beforeAgent = after.id to before
        beforeAgentAt = clock.now()
    }

    /**
     * Takes the agent's draft out again (the composer's Undo): back to what the composer held before it, or,
     * when the agent opened the composer, to the same fields without the agent's text. Returns false when
     * there is no agent draft to undo.
     */
    fun undoAgentDraft(): Boolean = undoAgentDraftSince() != null

    /**
     * [undoAgentDraft], returning when the writes it took back started: the draft cards written at or after that
     * time are the undone ones. 0 when there was no snapshot (a draft restored after a restart): every write then.
     * Null when there was nothing to undo.
     */
    fun undoAgentDraftSince(): Long? {
        val current = _state.value ?: return null
        if (current.draftedBy == null && current.editedAgent == null) return null
        val snapshot = beforeAgent?.takeIf { it.first == current.id }
        val since = if (snapshot != null) beforeAgentAt else 0L
        beforeAgent = null
        _state.value = snapshot?.second ?: current.copy(body = "", bodyHtml = null, draftedBy = null, editedAgent = null, dirty = true)
        return since
    }

    fun close() {
        beforeAgent = null
        _state.value = null
    }

    companion object {
        const val FILE_NAME = "composer.json"
        private const val SAVE_DELAY_MS = 400L
        private const val TAG = "Composer"
    }
}
