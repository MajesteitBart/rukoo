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
import nl.bvdm.rukoo.core.Ids
import nl.bvdm.rukoo.core.JsonFiles
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.OutgoingAttachment
import nl.bvdm.rukoo.mail.model.ReplyKind

/**
 * The composer's content. [id] is the composer key a draft card refers to; it stays the same while
 * the composer is open. [body] is plain text without the quote; [quote] is the quoted original for
 * replies and forwards. [draftedBy] names the agent that wrote the current text, null when the user did.
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
)

/**
 * The single composer, shared by the UI and the agent tools (write_draft, get_draft): an open draft
 * survives folding, the chat taking the screen, and the activity going away. With a [file] it also
 * survives the process: the draft is written there shortly after each change and removed on close.
 */
class ComposerController(
    private val file: File? = null,
    scope: CoroutineScope? = null,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val _state = MutableStateFlow(file?.let { restore(it) })
    val state: StateFlow<ComposerState?> = _state.asStateFlow()

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
        _state.value = draft
        return draft.id
    }

    /** Changes the open draft; does nothing while the composer is closed. */
    fun update(transform: (ComposerState) -> ComposerState) = _state.update { it?.let(transform) }

    fun close() {
        _state.value = null
    }

    companion object {
        const val FILE_NAME = "composer.json"
        private const val SAVE_DELAY_MS = 400L
        private const val TAG = "Composer"
    }
}
