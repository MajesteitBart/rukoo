package nl.bvdm.rukoo.ui.composer

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.JsonFiles
import nl.bvdm.rukoo.ui.ComposerState

/**
 * Drafts kept on this phone. Server drafts are out of scope for v1, so "Save draft" parks the composer
 * here; the Drafts view lists these above the account's own drafts and a tap opens one again. Newest
 * first, by [ComposerState.id]. A save returns only once the file is written, so a caller never closes
 * the composer (and its own recovery copy) on a save that didn't happen.
 */
class DraftStore(
    private val file: File?,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _drafts = MutableStateFlow(file?.let(::restore).orEmpty())
    val drafts: StateFlow<List<ComposerState>> = _drafts.asStateFlow()

    private val writes = Mutex()

    private fun restore(file: File): List<ComposerState> =
        runCatching { JsonFiles.read(file, SERIALIZER, emptyList()) }.getOrDefault(emptyList())

    fun get(id: String): ComposerState? = _drafts.value.firstOrNull { it.id == id }

    fun contains(id: String): Boolean = get(id) != null

    // Writes the new list first and shows it after, so the list on screen is never ahead of the file. The
    // change is worked out under the lock too, so a remove can't slip past a save that is still writing.
    private suspend fun commit(next: (List<ComposerState>) -> List<ComposerState>): Boolean = writes.withLock {
        val list = next(_drafts.value)
        if (list == _drafts.value) return@withLock true
        if (file != null) {
            try {
                withContext(io) { JsonFiles.write(file, SERIALIZER, list) }
            } catch (e: IOException) {
                AppLog.w(TAG, "could not save the drafts", e)
                return@withLock false
            }
        }
        _drafts.value = list
        true
    }

    /** Keeps [draft], replacing an earlier save of the same composer, and puts it on top. False when it couldn't be written. */
    suspend fun save(draft: ComposerState): Boolean {
        val kept = draft.copy(dirty = false, savedAt = now())
        return commit { list -> listOf(kept) + list.filterNot { it.id == draft.id } }
    }

    suspend fun remove(id: String): Boolean = commit { list -> list.filterNot { it.id == id } }

    companion object {
        const val FILE_NAME = "drafts.json"

        /** For fakes and previews: nothing is written. */
        val InMemory: DraftStore by lazy { DraftStore(null) }

        private const val TAG = "Drafts"
        private val SERIALIZER = ListSerializer(ComposerState.serializer())
    }
}
