package nl.bvdm.rukoo.agents.adapters

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import nl.bvdm.rukoo.agents.ToolIdentity

/**
 * How the fake agent calls Rukoo's tools, like desktop's fake.js through hub.callTool. The answer is a tools/call
 * result, `{content, structuredContent?, isError?}`. The app passes the phone's MCP tool handler, so the fake agent
 * runs the same tools as a real one: its plans, sources, cards, drafts and mail actions are the real thing.
 */
fun interface FakeTools {
    suspend fun call(identity: ToolIdentity, name: String, args: JsonObject): JsonObject

    /** No tools: every call says so. */
    object None : FakeTools {
        override suspend fun call(identity: ToolIdentity, name: String, args: JsonObject): JsonObject =
            toolResult(error = "Rukoo's tools are not connected to the fake agent")
    }
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
