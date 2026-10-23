package nl.bvdm.rukoo.agents

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalStatus
import nl.bvdm.rukoo.agents.model.AssistantStatus
import nl.bvdm.rukoo.agents.model.ChatFile
import nl.bvdm.rukoo.agents.model.ContinuedRef
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.ConversationStatus
import nl.bvdm.rukoo.agents.model.ConversationsFile
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.Origin
import nl.bvdm.rukoo.agents.model.ThinkingStatus
import nl.bvdm.rukoo.agents.model.ToolStatus
import nl.bvdm.rukoo.agents.model.Unread
import nl.bvdm.rukoo.agents.model.UnreadSerializer
import nl.bvdm.rukoo.core.RukooJson

/**
 * Reading and writing conversations.json in desktop's shape `{version: 1, conversations: [...]}`, with
 * desktop's load rules (hub.js:427-483): entries that aren't chats are skipped, missing fields get their
 * defaults, and whatever a turn left open is closed, since no turn survives a restart.
 */
object ConversationStore {
    const val FILE_NAME = "conversations.json"

    /**
     * [unreadable]: nothing could be used, so the file moves aside. [partial]: some entries were skipped, so
     * a copy stays aside and nothing is lost when the next save writes the rest.
     */
    data class Decoded(val conversations: List<Conversation>, val unreadable: Boolean = false, val partial: Boolean = false)

    fun decode(text: String): Decoded {
        val root = try {
            RukooJson.parseToJsonElement(text)
        } catch (_: Exception) {
            return Decoded(emptyList(), unreadable = true)
        }
        // Valid JSON is not yet a store: {"conversations": null} would load as no chats at all.
        val list = (root as? JsonObject)?.get("conversations") as? JsonArray ?: return Decoded(emptyList(), unreadable = true)
        val out = mutableListOf<Conversation>()
        var partial = false
        for (entry in list) {
            val c = decodeOne(entry)
            if (c == null) {
                partial = true
                continue
            }
            if (c.second) partial = true
            out += c.first
        }
        return Decoded(out, partial = partial)
    }

    fun encode(conversations: Collection<Conversation>): String =
        RukooJson.encodeToString(ConversationsFile.serializer(), ConversationsFile(1, conversations.sortedByDescending { it.updatedAt }))

    private fun str(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun num(e: JsonElement?): Long? = (e as? JsonPrimitive)?.takeIf { !it.isString }?.let { it.longOrNull ?: it.content.toDoubleOrNull()?.toLong() }

    private fun bool(e: JsonElement?): Boolean? = (e as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    private inline fun <T> orNull(block: () -> T): T? = try {
        block()
    } catch (_: Exception) {
        null
    }

    /** One chat normalized, and whether any of its items had to be dropped; null when the entry isn't a chat. */
    private fun decodeOne(entry: JsonElement): Pair<Conversation, Boolean>? {
        val o = entry as? JsonObject ?: return null
        val id = str(o["id"]) ?: return null
        val agent = str(o["agent"]) ?: return null
        val rawItems = o["items"] as? JsonArray ?: return null
        if (!AgentIds.isKnown(agent)) return null
        var dropped = false
        val createdAt = num(o["createdAt"]) ?: 0
        val updatedAt = num(o["updatedAt"]) ?: createdAt
        val items = rawItems.mapNotNull { raw ->
            orNull { RukooJson.decodeFromJsonElement(Item.serializer(), raw) }.also { if (it == null) dropped = true }
        }.map { close(it, updatedAt) }
        val provider = (o["provider"] as? JsonObject)?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.takeIf { it !is JsonNull }?.let { k to it.content } }?.toMap().orEmpty()
        val notes = (o["notes"] as? JsonArray)?.mapNotNull { str(it) }.orEmpty()
        val continued = (o["continued"] as? JsonArray)?.mapNotNull { e ->
            val obj = e as? JsonObject ?: return@mapNotNull null
            if (str(obj["id"]).isNullOrEmpty()) return@mapNotNull null
            // Desktop keeps the entry and coerces pending to `=== true`.
            val ref = JsonObject(obj - "pending")
            orNull { RukooJson.decodeFromJsonElement(ContinuedRef.serializer(), ref) }?.copy(pending = bool(obj["pending"]) == true)
        }.orEmpty()
        val files = (o["files"] as? JsonArray)?.mapNotNull { e ->
            val obj = e as? JsonObject ?: return@mapNotNull null
            if (str(obj["id"]) == null || str(obj["file"]) == null) return@mapNotNull null
            orNull { RukooJson.decodeFromJsonElement(ChatFile.serializer(), obj) }
        }.orEmpty()
        val message = (o["message"] as? JsonObject)?.takeIf { str(it["id"]) != null }?.let { orNull { RukooJson.decodeFromJsonElement(MessageRef.serializer(), it) } }
        val model = str(o["model"])?.takeIf { it.isNotEmpty() }
        val effort = str(o["effort"])?.takeIf { it in ModelOptions.EFFORTS }
        val unread = o["unread"]?.let { orNull { RukooJson.decodeFromJsonElement(UnreadSerializer, it) } } ?: Unread.NONE
        val c = Conversation(
            id = id,
            agent = agent,
            title = str(o["title"]).orEmpty(),
            message = message,
            origin = if (str(o["origin"]) == "external") Origin.EXTERNAL else Origin.PANEL,
            createdAt = createdAt,
            updatedAt = updatedAt,
            status = ConversationStatus.IDLE,
            model = model,
            effort = effort,
            provider = provider,
            notes = notes,
            // Saved before Rukoo tracked this: a chat with a message the agent answered has had its first turn.
            delivered = bool(o["delivered"]) ?: items.any { it is Item.Assistant },
            needsRecap = bool(o["needsRecap"]) == true,
            unread = unread,
            continued = continued,
            files = files,
            items = items,
        )
        return c to dropped
    }

    /** A turn can't survive a restart: close whatever it left open. Proposals and mail cards stay decidable. */
    fun close(item: Item, updatedAt: Long): Item = when {
        item is Item.Assistant && item.status == AssistantStatus.STREAMING -> item.copy(status = AssistantStatus.STOPPED)
        item is Item.Thinking && item.status == ThinkingStatus.RUNNING -> item.copy(status = ThinkingStatus.DONE, endedAt = item.endedAt ?: updatedAt)
        item is Item.Tool && item.status == ToolStatus.RUNNING -> item.copy(status = ToolStatus.DONE, endedAt = item.endedAt ?: updatedAt)
        item is Item.Approval && item.status == ApprovalStatus.PENDING && item.kind == ApprovalKind.RUNTIME -> item.copy(status = ApprovalStatus.EXPIRED)
        // The mail engine keeps what Undo needs in memory only, so a notice's Undo ends with the app as well.
        item is Item.Notice && item.undo != null -> item.copy(undo = null)
        else -> item
    }
}
