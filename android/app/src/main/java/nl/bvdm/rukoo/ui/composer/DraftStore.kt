package nl.bvdm.rukoo.ui.composer

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.JsonFiles
import nl.bvdm.rukoo.ui.ComposerState

/**
 * Drafts kept on this phone. Server drafts are out of scope for v1, so "Save draft" parks the composer
 * here; the Drafts view lists these above the account's own drafts and a tap opens one again. Newest
 * first, by [ComposerState.id].
 */
class DraftStore(
    private val file: File?,
    scope: CoroutineScope? = null,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _drafts = MutableStateFlow(file?.let(::restore).orEmpty())
    val drafts: StateFlow<List<ComposerState>> = _drafts.asStateFlow()

    init {
        if (file != null && scope != null) {
            scope.launch {
                _drafts.drop(1).collect { list ->
                    try {
                        withContext(io) { JsonFiles.write(file, SERIALIZER, list) }
                    } catch (e: IOException) {
                        AppLog.w(TAG, "could not save the drafts", e)
                    }
                }
            }
        }
    }

    private fun restore(file: File): List<ComposerState> =
        runCatching { JsonFiles.read(file, SERIALIZER, emptyList()) }.getOrDefault(emptyList())

    fun get(id: String): ComposerState? = _drafts.value.firstOrNull { it.id == id }

    fun contains(id: String): Boolean = get(id) != null

    /** Keeps [draft], replacing an earlier save of the same composer, and puts it on top. */
    fun save(draft: ComposerState) {
        val kept = draft.copy(dirty = false, savedAt = now())
        _drafts.value = listOf(kept) + _drafts.value.filterNot { it.id == draft.id }
    }

    fun remove(id: String) {
        _drafts.value = _drafts.value.filterNot { it.id == id }
    }

    companion object {
        const val FILE_NAME = "drafts.json"

        /** For fakes and previews: nothing is written. */
        val InMemory: DraftStore by lazy { DraftStore(null) }
        private const val TAG = "Drafts"
        private val SERIALIZER = ListSerializer(ComposerState.serializer())
    }
}
