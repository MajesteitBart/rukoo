package nl.bvdm.rukoo.agents.adapters

// The pure parts of desktop's hermes.js: model names, the model menu, approval cards, run failures and the
// final-output rule. Kept apart from the HTTP flow so they can be checked against desktop's outputs.

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import nl.bvdm.rukoo.agents.model.ApprovalChoice
import nl.bvdm.rukoo.agents.model.ApprovalField
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.ApprovalTool
import nl.bvdm.rukoo.agents.model.ChoiceKind
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.ModelOption
import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.ToolKind
import nl.bvdm.rukoo.core.Unsafe

internal object HermesWire {
    /** The effort levels a run's model_options.reasoning.effort takes; minimal and ultra are never sent. */
    val EFFORTS = listOf("low", "medium", "high", "xhigh", "max")

    // An aggregator such as OpenRouter lists hundreds of models; the menu keeps this many.
    const val MAX_MODELS = 300
    const val MAX_PER_PROVIDER = 60

    // Skills one message can start, and the longest instructions that go along in the message.
    const val SKILLS_PER_TURN = 3
    const val SKILL_BODY_MAX = 16_000

    private val PROVIDER = Regex("^[A-Za-z0-9_.:-]{2,80}$")

    data class Split(val provider: String, val model: String)

    /** `provider::model`, the way Hermes names a model of a provider other than its current one (hermes.js splitModel). */
    fun splitModel(value: String?): Split {
        val text = (value ?: "").trim()
        val at = text.indexOf("::")
        if (at > 0 && PROVIDER.matches(text.substring(0, at)) && text.substring(at + 2).trim().isNotEmpty()) {
            return Split(text.substring(0, at), text.substring(at + 2).trim())
        }
        return Split("", text)
    }

    /**
     * The part of a run's final output the transcript doesn't show yet (hermes.js missingText). [streamed] is all
     * text the run streamed; [segment] the text since the last tool call; [lost] whether the stream broke off
     * before the run ended, so its later events never arrived.
     */
    fun missingText(streamed: String, segment: String, output: String?, lost: Boolean = false): String {
        val out = (output ?: "").trimStart().trimEnd()
        val all = streamed.trimEnd()
        if (out.isEmpty() || all.endsWith(out) || segment.startsWith(out)) return ""
        // The answer was cut off part-way: add the rest.
        if (segment.isNotEmpty() && out.startsWith(segment)) return out.substring(segment.length)
        // Nothing streamed since the last tool call: the final answer never came through.
        if (segment.isEmpty()) return out
        // Other text streamed last. With the whole stream that is the answer worded differently; after a lost
        // stream it can be text from before a tool call the stream never reported, and the final answer follows.
        return if (lost) "\n\n$out" else ""
    }

    /** What a failed or interrupted run says (hermes.js failure). [fallback] is "The run failed" in the user's language. */
    fun failure(data: JsonObject, fallback: String): Pair<String, String> {
        val reason = listOf("error", "message", "turn_exit_reason").firstNotNullOfOrNull { k -> data[k]?.takeIf { it.truthy() }?.let(::jsText) }
        val detail = clip(reason ?: fallback, 200)
        val code = when {
            RATE_LIMIT.containsMatchIn(detail) -> ErrorCodes.RATE_LIMITED
            data.str("event") == "run.interrupted" || data.str("status") == "interrupted" -> ErrorCodes.OFFLINE
            else -> ErrorCodes.UNKNOWN
        }
        return code to detail
    }

    val RATE_LIMIT = Regex("\\b429\\b|rate.?limit", RegexOption.IGNORE_CASE)

    /** A value as JavaScript's String() would show it in a template: strings as they are, the rest as JSON. */
    fun jsText(v: JsonElement): String = if (v is JsonPrimitive && v.isString) v.content else v.toString()

    /** The model menu from `/api/model/options` and `/v1/models` (hermes.js models). Either may be null. */
    fun models(routes: JsonObject?, options: JsonObject?): Triple<List<ModelOption>, List<String>, List<String>> {
        val models = mutableListOf<ModelOption>()
        fun add(m: ModelOption) {
            if (models.size < MAX_MODELS && models.none { it.id == m.id }) models.add(m)
        }
        var current: String? = null
        if (options != null) {
            for (row in (options["providers"] as? JsonArray).orEmpty()) {
                val r = row as? JsonObject ?: continue
                val slug = r.str("slug")?.trim().orEmpty()
                if (!PROVIDER.matches(slug)) continue
                val caps = r["capabilities"] as? JsonObject
                // An aggregator's shortlist (the newest few per lab) instead of its whole catalog.
                val featured = (r["featured_models"] as? JsonArray)?.takeIf { it.isNotEmpty() }
                val ids = (featured ?: (r["models"] as? JsonArray).orEmpty())
                    .mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
                    .filter { it.isNotBlank() && it.length <= 150 }
                val group = r["name"]?.takeIf { it.truthy() }?.let(::jsText) ?: slug
                for (id in ids.take(MAX_PER_PROVIDER)) {
                    val noReasoning = (caps?.get(id) as? JsonObject)?.bool("reasoning") == false
                    add(ModelOption(id = "$slug::$id", label = id, group = group, efforts = if (noReasoning) emptyList() else EFFORTS))
                }
            }
            val model = options.str("model")
            if (!model.isNullOrEmpty()) {
                val provider = options.str("provider")
                current = if (!provider.isNullOrEmpty()) "$provider::$model" else model
            }
        }
        if (routes != null) {
            // The first entry is the profile itself, which stands for Hermes' own default; the rest are aliases.
            for (entry in (routes["data"] as? JsonArray).orEmpty()) {
                val m = entry as? JsonObject ?: continue
                val id = m.str("id")
                if (id.isNullOrEmpty() || !m["parent"].truthy()) continue
                val root = m.str("root")
                add(ModelOption(id = id, label = id, tag = if (root != null && root != id) root else "", route = true, efforts = EFFORTS))
            }
        }
        val own = current?.let { c -> models.indexOfFirst { it.id == c } }?.takeIf { it >= 0 }
        if (own != null) models[own] = models[own].copy(isDefault = true)
        return Triple(models, if (own != null) models[own].efforts else EFFORTS, EFFORTS)
    }

    /** `GET /v1/skills` (`{data: [...]}`, or a bare list on some versions) as the `$` menu lists them. */
    fun skills(data: JsonElement?): List<OwnSkill> {
        val list = (data as? JsonObject)?.get("data") as? JsonArray ?: data as? JsonArray ?: JsonArray(emptyList())
        return list.mapNotNull { e ->
            val k = e as? JsonObject ?: return@mapNotNull null
            val name = k.str("name") ?: return@mapNotNull null
            OwnSkill(name = name, description = k.str("description").orEmpty(), scope = k.str("category")?.takeIf { it.isNotEmpty() })
        }
    }

    /** What desktop puts in the message for a `$name` skill: a line that says so, then SKILL.md (hermes.js skillBlocks). */
    fun skillBlock(name: String, body: String?): String {
        val intro = "[The user invoked the \"$name\" skill, so they want you to follow its instructions."
        return if (!body.isNullOrEmpty() && body.length <= SKILL_BODY_MAX) {
            "$intro The full skill content is loaded below.]\n\n$body"
        } else {
            "$intro Load it with skill_view (name \"$name\") and follow it.]"
        }
    }

    const val SKILL_BLOCK_START = "[The user invoked the \""

    private val CHOICES = mapOf(
        "once" to ApprovalChoice("once", "Allow once", ChoiceKind.PRIMARY),
        "session" to ApprovalChoice("session", "Allow for this turn", ChoiceKind.DEFAULT),
        "always" to ApprovalChoice("always", "Always allow", ChoiceKind.DEFAULT),
        "deny" to ApprovalChoice("deny", "Deny", ChoiceKind.DANGER),
    )

    private val MCP_GATE = Regex("MCP tool '([^']+)' on (?:UNTRUSTED )?server '([^']+)'", RegexOption.IGNORE_CASE)

    /**
     * The card for an `approval.request` (hermes.js approval). Titles, labels and choices are desktop's English:
     * the chat UI words them in the user's language by tool kind, field key and choice id. [name] is the agent's
     * display name, [source] its id.
     */
    fun approval(name: String, source: String, data: JsonObject): ApprovalRequest {
        val ids = (data["choices"] as? JsonArray)?.takeIf { it.isNotEmpty() }?.map { jsText(it) } ?: listOf("once", "deny")
        val choices = ids.mapNotNull { CHOICES[it.lowercase()] }.toMutableList()
        if (choices.none { it.id == "deny" }) choices.add(CHOICES.getValue("deny"))
        // The MCP trust gate reuses the command approval: "MCP tool '<t>' on UNTRUSTED server '<s>' wants to run…".
        val command = data.str("command").orEmpty()
        var tool = ApprovalTool("terminal", ToolKind.COMMAND)
        val fields = mutableListOf<ApprovalField>()
        if (data.str("pattern_key") == "mcp_elicitation") {
            val m = MCP_GATE.find(command)
            tool = if (m != null) {
                val (t, server) = m.destructured
                ApprovalTool("mcp__${server}__$t", ToolKind.MCP, server = server, tool = t)
            } else {
                ApprovalTool("mcp", ToolKind.OTHER)
            }
            if (command.isNotEmpty()) fields.add(ApprovalField(label = "Tool", value = command, key = "input"))
        } else if (command.isNotEmpty()) {
            // Whole: in ask mode this card is the only thing between the agent and the command.
            fields.add(ApprovalField(label = "Command", value = command, key = "command"))
        }
        val description = data.str("description").orEmpty()
        val detail = if (description.isNotEmpty() && fields.any { it.value == description }) "" else description
        val requestId = data["request_id"]?.takeIf { it.truthy() }?.let(::jsText).orEmpty()
        return ApprovalRequest(
            title = approvalTitle(name, tool, "a tool"),
            detail = clip(detail, 2000),
            fields = fields,
            choices = choices,
            source = source,
            key = requestId.ifEmpty { null },
            tool = tool,
        )
    }

    private val ASKS = mapOf(
        ToolKind.COMMAND to "run a command",
        ToolKind.READ_FILE to "read a file",
        ToolKind.CHANGE_FILES to "change files",
        ToolKind.WEB to "open a web page",
    )

    /** proc.js approvalTitle: the English fallback the UI replaces by tool kind. */
    fun approvalTitle(agent: String, tool: ApprovalTool, fallback: String?): String {
        if (tool.kind == ToolKind.MCP && !tool.server.isNullOrEmpty()) {
            return "$agent wants to use ${if (!tool.tool.isNullOrEmpty()) "${tool.server} · ${tool.tool}" else tool.server}"
        }
        if (tool.kind == ToolKind.PERMISSIONS) return "$agent wants more permissions"
        ASKS[tool.kind]?.let { return "$agent wants to $it" }
        return "$agent wants to use ${fallback ?: tool.name.ifEmpty { "a tool" }}"
    }

    /** A tool chip's detail from a Hermes preview: tags the agent copied from a tool result go (Unsafe.untag). */
    fun preview(text: String?): String = clip(Unsafe.untag(text), 200)
}

private fun JsonArray?.orEmpty(): List<JsonElement> = this ?: emptyList()
