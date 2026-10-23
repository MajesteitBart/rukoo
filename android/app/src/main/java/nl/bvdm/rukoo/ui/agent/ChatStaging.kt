package nl.bvdm.rukoo.ui.agent

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.ChatFiles
import nl.bvdm.rukoo.agents.FileSource
import nl.bvdm.rukoo.agents.StageResult
import nl.bvdm.rukoo.core.AppLog

/**
 * Picked files on their way into the chat input (panel.js `P.adding` and pickFiles). It belongs to the activity, not
 * to the chat pane: a copy still under way when the pane leaves the screen (the chat closed, or the phone folded across
 * the two-pane width) finishes here, and its files wait in [results] until a chat input takes them. Otherwise the hub
 * would keep a staged copy that no chip names until it expired.
 */
class ChatStaging(private val hub: () -> AgentHub, private val io: CoroutineDispatcher = Dispatchers.IO) : ViewModel() {
    private val _adding = MutableStateFlow<List<AddingFile>>(emptyList())
    private val _picking = MutableStateFlow(0)
    private val _results = MutableStateFlow<List<StageResult>>(emptyList())

    /** Files being copied in: pending chips. */
    val adding: StateFlow<List<AddingFile>> = _adding.asStateFlow()

    /** Picks whose names are still being looked up, before they show as pending chips. */
    val picking: StateFlow<Int> = _picking.asStateFlow()

    /** What the hub staged or refused, for the chat input to take ([take]). */
    val results: StateFlow<List<StageResult>> = _results.asStateFlow()

    /**
     * A file is on its way: nothing is sent or started until it is in. That includes files the hub has but the input
     * hasn't taken yet, so a message sent in between can't go without them.
     */
    fun holding(): Boolean = _adding.value.isNotEmpty() || _picking.value > 0 || _results.value.isNotEmpty()

    /**
     * Copies the picked files in, at most [room] of them less the ones on their way already. [sources] reads the
     * picker's names and sizes; it runs off the main thread.
     */
    fun stage(room: Int, sources: () -> List<FileSource>) {
        _picking.update { it + 1 }
        viewModelScope.launch {
            var counted = true
            var pending = emptyList<AddingFile>()
            try {
                val list = withContext(io) { sources() }
                val left = (room - _adding.value.size).coerceAtLeast(0)
                pending = list.take(left).map { AddingFile(ChatFiles.cleanName(it.name), it.claimedSize) }
                _adding.update { it + pending }
                _picking.update { it - 1 }
                counted = false
                val staged = hub().stageFiles(list, left)
                // The pending chips give way to the files the hub has, all at once, so none blinks out in between.
                _results.update { it + staged }
                _adding.update { now -> now.filterNot { a -> pending.any { it === a } } }
                pending = emptyList()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                AppLog.w(TAG, "staging picked files failed", e)
            } finally {
                if (counted) _picking.update { it - 1 }
                if (pending.isNotEmpty()) _adding.update { now -> now.filterNot { a -> pending.any { it === a } } }
            }
        }
    }

    /** The results that wait, taken once. */
    fun take(): List<StageResult> = _results.getAndUpdate { emptyList() }

    private companion object {
        const val TAG = "ChatStaging"
    }
}
