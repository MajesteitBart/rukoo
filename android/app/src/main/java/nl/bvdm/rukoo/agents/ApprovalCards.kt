package nl.bvdm.rukoo.agents

import nl.bvdm.rukoo.agents.model.ApprovalChoice
import nl.bvdm.rukoo.agents.model.ApprovalField
import nl.bvdm.rukoo.agents.model.ApprovalTool
import nl.bvdm.rukoo.agents.model.ChoiceKind
import nl.bvdm.rukoo.agents.model.ToolKind

/**
 * What an approval card shows, cleaned like desktop's approvalCard() (hub.js:2305-2367): at most 6 choices
 * (Allow and Deny when the agent gave none), fields folded to 12 and each kept whole up to 20,000
 * characters. [refusal] is the choice Rukoo answers with at once when a field had to be cut: the user
 * approves what the card shows, so a card that can't show all of its input is declined without asking.
 */
data class ApprovalCardContent(
    val title: String,
    val detail: String,
    val fields: List<ApprovalField>,
    val tool: ApprovalTool?,
    val choices: List<ApprovalChoice>,
    val refusal: ApprovalChoice?,
)

object ApprovalCards {
    const val FIELD_MAX = 20000
    const val MAX_FIELDS = 12
    const val MAX_CHOICES = 6

    /** Choice ids that decline, whatever their kind (hub.js DENY_IDS). */
    val DENY_IDS = setOf("deny", "decline", "cancel")
    private val FIELD_KEYS = setOf("command", "folder", "file", "path", "url", "query", "pattern", "content", "before", "after", "diff", "reason", "input")

    val DEFAULT_CHOICES = listOf(ApprovalChoice("allow", "Allow", ChoiceKind.PRIMARY), ApprovalChoice("deny", "Deny", ChoiceKind.DANGER))

    /** Whether choosing [choice] declines (hub.js decide()). */
    fun denies(choice: ApprovalChoice): Boolean = choice.kind == ChoiceKind.DANGER || choice.id in DENY_IDS

    /** Past 12 fields the rest folds into one "Other input" field instead of being cut. */
    fun foldFields(fields: List<ApprovalField>): List<ApprovalField> {
        if (fields.size <= MAX_FIELDS) return fields
        val rest = fields.drop(MAX_FIELDS - 1).joinToString("\n") { f -> "${f.label.ifEmpty { f.key.orEmpty().ifEmpty { "input" } }}: ${f.value}" }
        return fields.take(MAX_FIELDS - 1) + ApprovalField(label = "Other input", value = rest, key = "input")
    }

    private fun field(f: ApprovalField): ApprovalField {
        val value = f.value
        return ApprovalField(
            label = f.label.take(80),
            value = value.take(FIELD_MAX),
            key = f.key?.takeIf { it in FIELD_KEYS },
            // A card a computer host relays was cut there already: its count stays, and so does the refusal.
            truncated = if (value.length > FIELD_MAX) value.length - FIELD_MAX else f.truncated?.takeIf { it > 0 },
        )
    }

    private fun tool(t: ApprovalTool?): ApprovalTool? {
        if (t == null) return null
        val name = t.name.take(200)
        return if (t.kind == ToolKind.MCP) ApprovalTool(name, ToolKind.MCP, t.server.orEmpty().take(120), t.tool.orEmpty().take(200)) else ApprovalTool(name, t.kind)
    }

    fun card(title: String, detail: String, fields: List<ApprovalField>, choices: List<ApprovalChoice>, tool: ApprovalTool?): ApprovalCardContent {
        val clean = choices.filter { it.id.isNotEmpty() }.take(MAX_CHOICES).map { ApprovalChoice(it.id.take(60), it.label.ifEmpty { it.id }.take(60), it.kind) }
        val shown = clean.ifEmpty { DEFAULT_CHOICES }
        val shownFields = foldFields(fields).map(::field)
        // The agent gets its own deny choice: cancel would end a Codex turn and leave Hermes unanswered.
        val refusal = if (shownFields.any { it.truncated != null }) {
            shown.firstOrNull { it.id != "cancel" && it.id in DENY_IDS } ?: shown.firstOrNull { it.kind == ChoiceKind.DANGER } ?: ApprovalChoice("cancel", "cancel")
        } else {
            null
        }
        return ApprovalCardContent(
            title = title.ifEmpty { "Approval needed" }.take(200),
            detail = detail.take(2000),
            fields = shownFields,
            tool = tool(tool),
            choices = shown,
            refusal = refusal,
        )
    }
}
