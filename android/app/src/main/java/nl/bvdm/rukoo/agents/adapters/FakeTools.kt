package nl.bvdm.rukoo.agents.adapters

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.ToolIdentity
import nl.bvdm.rukoo.agents.model.ApprovalChoice
import nl.bvdm.rukoo.agents.model.ApprovalField
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.ChoiceKind
import nl.bvdm.rukoo.agents.model.DraftMode
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MailApproval
import nl.bvdm.rukoo.agents.model.PlanTask
import nl.bvdm.rukoo.agents.model.SourceRef
import nl.bvdm.rukoo.agents.model.TaskStatus
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.core.Unsafe

/**
 * How the fake agent calls Rukoo's tools, like desktop's fake.js through hub.callTool. The answer is a tools/call
 * result, `{content, structuredContent?, isError?}`. The phone's MCP tool handler can stand in for this; without it
 * [HubFakeTools] runs the tools that only touch the chat.
 */
fun interface FakeTools {
    suspend fun call(identity: ToolIdentity, name: String, args: JsonObject): JsonObject
}

/** A tools/call result with [structured] content, or an error with [text]. */
internal fun toolResult(structured: JsonObject? = null, error: String? = null): JsonObject = buildJsonObject {
    putJsonArray("content") {
        addJsonObject {
            put("type", "text")
            put("text", error ?: structured?.toString() ?: "{}")
        }
    }
    if (structured != null) put("structuredContent", structured)
    if (error != null) put("isError", true)
}

/**
 * The fake agent's tools when the MCP handler isn't wired in: the chat's own tools (show_plan, show_sources,
 * propose_action, mail_action, write_draft as a card, read_skill) through the hub, and get_context from the chat's
 * email. Mail search and reading come back empty or as errors: debug builds use this for screens, not for mail.
 */
class HubFakeTools(private val hub: () -> AgentHub?) : FakeTools {
    override suspend fun call(identity: ToolIdentity, name: String, args: JsonObject): JsonObject {
        val h = hub() ?: return toolResult(error = "Rukoo's tools are not connected to the fake agent")
        val cid = identity.conversationId ?: args.str("conversation_id")
        val c = cid?.let { h.get(it) } ?: return toolResult(error = "No chat for this call")
        return when (name) {
            "get_context" -> toolResult(buildJsonObject {
                val m = c.message
                if (m != null) {
                    putJsonObject("chat_message") {
                        put("id", m.id)
                        put("subject", Unsafe.value(m.subject))
                        m.messageId?.let { put("message_id_header", it) }
                        putJsonObject("from") {
                            put("name", Unsafe.value(m.from?.name))
                            put("address", Unsafe.value(m.from?.address))
                        }
                    }
                }
            })
            "search_mail" -> toolResult(buildJsonObject { putJsonArray("results") {} })
            "show_plan" -> showPlan(h, c.id, args)
            "show_sources" -> {
                val sources = (args["sources"] as? JsonArray).orEmpty().mapNotNull { e ->
                    val s = e as? JsonObject ?: return@mapNotNull null
                    SourceRef(
                        title = s.str("title").orEmpty(),
                        source = s.str("source") ?: if (s.str("message_id") != null) "Email" else "",
                        snippet = s.str("snippet").orEmpty(),
                        url = s.str("url"),
                        messageId = s.str("message_id"),
                    )
                }
                h.addItem(c.id, Item.Sources(id = "", at = 0, title = args.str("title").orEmpty(), sources = sources))
                toolResult(buildJsonObject {
                    put("ok", true)
                    put("conversation_id", c.id)
                    put("shown", sources.size)
                })
            }
            "propose_action" -> {
                val ticket = h.requestApproval(
                    c.id,
                    ApprovalRequest(
                        title = args.str("title").orEmpty(),
                        detail = args.str("detail").orEmpty(),
                        fields = (args["fields"] as? JsonArray).orEmpty().mapNotNull { f ->
                            (f as? JsonObject)?.let { ApprovalField(label = it.str("label").orEmpty(), value = it.str("value").orEmpty()) }
                        },
                        choices = listOf(
                            ApprovalChoice("approve", args.str("confirm_label") ?: "Approve", ChoiceKind.PRIMARY),
                            ApprovalChoice("decline", "Decline", ChoiceKind.DEFAULT),
                        ),
                        source = identity.agent,
                        kind = ApprovalKind.PROPOSAL,
                    ),
                )
                toolResult(buildJsonObject {
                    put("conversation_id", c.id)
                    put("proposal_id", ticket.itemId)
                    put("status", "waiting_for_user")
                })
            }
            "mail_action" -> {
                val action = args.str("action").orEmpty()
                val ids = (args["message_ids"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.content }
                if (ids.isEmpty()) return toolResult(error = "message_ids is empty")
                val sender = c.message?.from?.let { it.name.ifEmpty { it.address } }?.ifEmpty { null } ?: "this sender"
                val ticket = h.requestApproval(
                    c.id,
                    ApprovalRequest(
                        title = if (action == "unsubscribe") "Unsubscribe from $sender" else "${action.replaceFirstChar { it.uppercase() }} ${ids.size} email${if (ids.size == 1) "" else "s"}",
                        choices = listOf(
                            ApprovalChoice("approve", if (action == "unsubscribe") "Unsubscribe" else "Approve", ChoiceKind.PRIMARY),
                            ApprovalChoice("decline", "Decline", ChoiceKind.DEFAULT),
                        ),
                        source = identity.agent,
                        kind = ApprovalKind.MAIL,
                        mail = MailApproval(action = action, ids = ids),
                    ),
                )
                toolResult(buildJsonObject {
                    put("conversation_id", c.id)
                    put("approval_id", ticket.itemId)
                    put("status", "waiting_for_user")
                })
            }
            "write_draft" -> {
                val body = args.str("body").orEmpty()
                val m = c.message
                h.addItem(
                    c.id,
                    Item.Draft(
                        id = "",
                        at = 0,
                        mode = if (m != null) DraftMode.REPLY else DraftMode.NEW,
                        to = listOfNotNull(m?.from),
                        subject = m?.subject?.let { if (it.startsWith("Re:", ignoreCase = true)) it else "Re: $it" }.orEmpty(),
                        summary = body.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() && !it.startsWith("Hi") }.orEmpty().take(200),
                        messageRef = m?.id,
                    ),
                )
                toolResult(buildJsonObject {
                    put("ok", true)
                    put("conversation_id", c.id)
                })
            }
            "read_skill" -> {
                val skill = h.skills().firstOrNull { it.name == args.str("name") } ?: return toolResult(error = "No skill named ${args.str("name")}")
                toolResult(buildJsonObject {
                    put("name", skill.name)
                    put("skill_md", "---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}")
                })
            }
            else -> toolResult(error = "$name is not available to the fake agent without Rukoo's tools")
        }
    }

    /** show_plan as tools.js does it, for new plans and updates by plan_id or task ids. */
    private fun showPlan(h: AgentHub, cid: String, args: JsonObject): JsonObject {
        val c = h.get(cid) ?: return toolResult(error = "No chat for this call")
        val tasks = (args["tasks"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val plans = c.items.filterIsInstance<Item.Plan>()
        val planId = args.str("plan_id")
        var item = planId?.let { id -> plans.firstOrNull { it.planId == id } }
        if (item == null && planId == null) {
            val latest = plans.lastOrNull()
            if (latest != null && tasks.all { t -> t.str("id")?.let { id -> latest.tasks.any { it.id == id } } == true }) item = latest
        }
        val found = item
        val isNew = found == null
        for (t in tasks) {
            val known = found != null && t.str("id")?.let { id -> found.tasks.any { it.id == id } } == true
            if (!known && t.str("title").isNullOrEmpty()) return toolResult(error = "Task ${t.str("id") ?: "(no id)"} is new and needs a title.")
        }
        var plan = found ?: Item.Plan(id = "", at = 0, planId = planId ?: nextPlanId(plans), title = args.str("title").orEmpty())
        if (!isNew && args.str("title") != null) plan = plan.copy(title = args.str("title").orEmpty())
        val list = plan.tasks.toMutableList()
        for (t in tasks) {
            val at = t.str("id")?.let { id -> list.indexOfFirst { it.id == id } } ?: -1
            var task = if (at >= 0) list[at] else PlanTask(id = t.str("id") ?: nextTaskId(list))
            t.str("title")?.let { task = task.copy(title = it) }
            t.str("detail")?.let { task = task.copy(detail = it) }
            t.str("system")?.let { task = task.copy(system = it) }
            t.str("owner")?.let { task = task.copy(owner = it) }
            t.str("due")?.let { task = task.copy(due = it) }
            t.str("status")?.let { s -> runCatching { RukooJson.decodeFromJsonElement(TaskStatus.serializer(), JsonPrimitive(s)) }.getOrNull()?.let { task = task.copy(status = it) } }
            if (t.containsKey("url")) task = task.copy(url = t.str("url")?.trim()?.takeIf { SAFE_URL.containsMatchIn(it) })
            if (at >= 0) list[at] = task else list.add(task)
        }
        plan = plan.copy(tasks = list)
        val stored = if (isNew) h.addItem(cid, plan) as Item.Plan else plan.also { h.updateItem(cid, it) }
        return toolResult(buildJsonObject {
            put("conversation_id", cid)
            put("plan_id", stored.planId)
            putJsonArray("tasks") {
                for (t in stored.tasks) {
                    addJsonObject {
                        put("id", t.id)
                        put("title", t.title)
                        put("status", RukooJson.encodeToJsonElement(TaskStatus.serializer(), t.status))
                    }
                }
            }
        })
    }

    private fun nextPlanId(plans: List<Item.Plan>): String {
        var n = plans.size + 1
        while (plans.any { it.planId == "p$n" }) n++
        return "p$n"
    }

    private fun nextTaskId(tasks: List<PlanTask>): String {
        var n = tasks.size + 1
        while (tasks.any { it.id == "t$n" }) n++
        return "t$n"
    }

    private companion object {
        val SAFE_URL = Regex("^(https?://|mailto:|obsidian://)", RegexOption.IGNORE_CASE)
    }
}

private fun JsonArray?.orEmpty(): List<kotlinx.serialization.json.JsonElement> = this ?: emptyList()

/** Builds tool arguments in the fake's scripts. */
internal fun args(vararg pairs: Pair<String, Any?>): JsonObject = buildJsonObject {
    for ((k, v) in pairs) {
        when (v) {
            null -> Unit
            is String -> put(k, v)
            is Number -> put(k, v)
            is Boolean -> put(k, v)
            is JsonObject -> put(k, v)
            is JsonArray -> put(k, v)
            is List<*> -> putJsonArray(k) {
                for (x in v) {
                    when (x) {
                        is JsonObject -> add(x)
                        is String -> add(x)
                        else -> Unit
                    }
                }
            }
            else -> put(k, v.toString())
        }
    }
}
