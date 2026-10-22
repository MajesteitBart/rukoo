package nl.bvdm.rukoo.ui.agent

import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalStatus
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.ToolStatus

/** One chip in a row of tool calls: calls in a row with the same label, status and kind share one ("×4"). */
data class ToolChipModel(
    val key: String,
    val label: ToolLabel,
    val status: ToolStatus,
    val kind: ToolChipKind,
    val rukoo: Boolean,
    val count: Int,
    /** The calls' details, one per line. */
    val detail: String,
)

/** What the transcript shows, in order. Tool items become rows of chips; everything else is one row per item. */
sealed interface TranscriptRow {
    val key: String

    data class Single(val item: Item) : TranscriptRow {
        override val key: String get() = item.id
    }

    data class Tools(override val key: String, val chips: List<ToolChipModel>) : TranscriptRow

    /** "Clark is working on it..." between the user's message and the agent's first sign of life. */
    data class Working(val since: Long) : TranscriptRow {
        override val key: String get() = "working"
    }
}

/** Desktop panel.js's addItem, drawRun and showPending, as a pure function of the items. */
object TranscriptModel {
    fun rows(items: List<Item>, running: Boolean): List<TranscriptRow> {
        val waitsFor = waitingTools(items)
        val approvals = items.filterIsInstance<Item.Approval>().associateBy { it.id }
        val out = ArrayList<TranscriptRow>(items.size + 1)
        var run = ArrayList<Item.Tool>()

        fun flush() {
            if (run.isEmpty()) return
            val visible = run.filterNot { tool ->
                ToolNames.cardToolDone(tool) || waitsFor[tool.id]?.let { approvals[it]?.status != ApprovalStatus.APPROVED } == true
            }
            val chips = fold(visible)
            if (chips.isNotEmpty()) out += TranscriptRow.Tools("tools:${run.first().id}", chips)
            run = ArrayList()
        }

        for (item in items) {
            if (item is Item.Tool) {
                run += item
            } else {
                flush()
                out += TranscriptRow.Single(item)
            }
        }
        flush()
        val last = items.lastOrNull()
        if (running && (last == null || last is Item.User)) out += TranscriptRow.Working(last?.at ?: 0L)
        return out
    }

    /**
     * A runtime approval right after a tool that was still running (or ended after the card came) is that tool
     * asking for permission: tool id to approval id. The card says what the tool will do, so the chip stays out
     * of sight until the user allows it.
     */
    fun waitingTools(items: List<Item>): Map<String, String> {
        val out = HashMap<String, String>()
        for (i in 1 until items.size) {
            val approval = items[i] as? Item.Approval ?: continue
            if (approval.kind != ApprovalKind.RUNTIME) continue
            val prev = items[i - 1] as? Item.Tool ?: continue
            val endedAfter = prev.endedAt != null && approval.at > 0 && prev.endedAt >= approval.at
            if (prev.status == ToolStatus.RUNNING || endedAfter) out[prev.id] = approval.id
        }
        return out
    }

    private fun fold(tools: List<Item.Tool>): List<ToolChipModel> {
        val out = ArrayList<ToolChipModel>()
        for (tool in tools) {
            val label = ToolNames.label(tool)
            val kind = ToolNames.kind(tool)
            val last = out.lastOrNull()
            if (last != null && last.label == label && last.status == tool.status && last.kind == kind) {
                val detail = listOf(last.detail, tool.detail).filter { it.isNotEmpty() }.joinToString("\n")
                out[out.lastIndex] = last.copy(count = last.count + 1, detail = detail)
            } else {
                out += ToolChipModel(tool.id, label, tool.status, kind, tool.rukoo || ToolNames.isRukoo(tool), 1, tool.detail)
            }
        }
        return out
    }
}
