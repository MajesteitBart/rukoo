package nl.bvdm.rukoo.mcp.tools

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import nl.bvdm.rukoo.core.Unsafe

/**
 * One input schema node, with the JSON agents get ([json], keys in desktop's order, so the bridge's cached tool
 * list is the same whichever Rukoo answered) and two marks agents never see (tools.js:32-41):
 * [untag] for values agents copy from tool results, which lose their `<unsafe_content>` tags, and [whole] for
 * what the user approves as shown, which fails past maxLength instead of being cut.
 */
class Schema internal constructor(
    val json: JsonObject,
    val type: String?,
    val properties: List<Pair<String, Schema>>,
    val required: List<String>,
    val items: Schema?,
    val anyOf: List<Schema>,
    val enum: List<String>?,
    val maxLength: Int?,
    val minimum: Long?,
    val maximum: Long?,
    val minItems: Int?,
    val maxItems: Int?,
    val untag: Boolean,
    val whole: Boolean,
)

/** Builds a [Schema]; the JSON keys come out in the order the calls are made, after `type`. */
class SchemaBuilder internal constructor(private val type: String?, private val untag: Boolean, private val whole: Boolean) {
    private val json = LinkedHashMap<String, JsonElement>()
    private var properties: List<Pair<String, Schema>> = emptyList()
    private var required: List<String> = emptyList()
    private var items: Schema? = null
    private var enum: List<String>? = null
    private var maxLength: Int? = null
    private var minimum: Long? = null
    private var maximum: Long? = null
    private var minItems: Int? = null
    private var maxItems: Int? = null

    init {
        if (type != null) json["type"] = JsonPrimitive(type)
    }

    fun description(text: String) {
        json["description"] = JsonPrimitive(text)
    }

    fun maxLength(n: Int) {
        json["maxLength"] = JsonPrimitive(n)
        maxLength = n
    }

    fun enumOf(values: List<String>) {
        json["enum"] = JsonArray(values.map(::JsonPrimitive))
        enum = values
    }

    fun minimum(n: Long) {
        json["minimum"] = JsonPrimitive(n)
        minimum = n
    }

    fun maximum(n: Long) {
        json["maximum"] = JsonPrimitive(n)
        maximum = n
    }

    fun minItems(n: Int) {
        json["minItems"] = JsonPrimitive(n)
        minItems = n
    }

    fun maxItems(n: Int) {
        json["maxItems"] = JsonPrimitive(n)
        maxItems = n
    }

    fun items(schema: Schema) {
        json["items"] = schema.json
        items = schema
    }

    fun properties(vararg props: Pair<String, Schema>) {
        json["properties"] = JsonObject(props.associateTo(LinkedHashMap()) { (k, v) -> k to v.json })
        properties = props.toList()
    }

    fun required(keys: List<String>) {
        json["required"] = JsonArray(keys.map(::JsonPrimitive))
        required = keys
    }

    internal fun build(anyOf: List<Schema> = emptyList()): Schema {
        if (anyOf.isNotEmpty()) json["anyOf"] = JsonArray(anyOf.map { it.json })
        return Schema(JsonObject(json), type, properties, required, items, anyOf, enum, maxLength, minimum, maximum, minItems, maxItems, untag, whole)
    }
}

fun str(untag: Boolean = false, whole: Boolean = false, block: SchemaBuilder.() -> Unit = {}): Schema =
    SchemaBuilder("string", untag, whole).apply(block).build()

fun integer(block: SchemaBuilder.() -> Unit = {}): Schema = SchemaBuilder("integer", false, false).apply(block).build()

fun bool(block: SchemaBuilder.() -> Unit = {}): Schema = SchemaBuilder("boolean", false, false).apply(block).build()

fun array(block: SchemaBuilder.() -> Unit): Schema = SchemaBuilder("array", false, false).apply(block).build()

fun obj(block: SchemaBuilder.() -> Unit): Schema = SchemaBuilder("object", false, false).apply(block).build()

fun anyOf(vararg options: Schema): Schema = SchemaBuilder(null, false, false).build(options.toList())

/** A failure the agent should read as it is; anything else becomes "Rukoo could not complete <tool>: ...". */
open class ToolError(message: String, val ambiguous: Boolean = false) : Exception(message)

/**
 * desktop validate() (tools.js:310-370): a small JSON Schema subset, lenient where models commonly slip:
 * numeric strings, "true"/"false", a single value where a list is expected, and text longer than allowed
 * (cut, not refused, except [Schema.whole] fields). Unknown keys are dropped and nulls skipped.
 */
object Validator {
    fun validate(s: Schema, value: JsonElement, where: String): JsonElement {
        if (s.anyOf.isNotEmpty()) {
            var last: ToolError? = null
            for (option in s.anyOf) {
                try {
                    return validate(option, value, where)
                } catch (e: ToolError) {
                    last = e
                }
            }
            throw last!!
        }
        return when (s.type) {
            "object" -> {
                if (value !is JsonObject) throw ToolError("$where must be an object.")
                val out = LinkedHashMap<String, JsonElement>()
                for ((key, sub) in s.properties) {
                    val v = value[key]
                    if (v == null || v is JsonNull) continue
                    out[key] = validate(sub, v, "$where.$key")
                }
                for (key in s.required) {
                    val v = out[key]
                    if (v == null || (v is JsonPrimitive && v.isString && v.content.isEmpty())) throw ToolError("$where.$key is required.")
                }
                JsonObject(out)
            }
            "string" -> {
                val raw = value as? JsonPrimitive
                if (raw == null || raw is JsonNull) throw ToolError("$where must be a string.")
                // Numbers and booleans are written as text, as JS String() does.
                var text = if (raw.isString) raw.content else jsString(raw)
                // A copied value loses its tags so lookups and the composer get the plain value. Errors that echo
                // it tag it again, because it may still be a sender's text.
                if (s.untag) text = Unsafe.untag(text)
                if (s.enum != null && text !in s.enum) throw ToolError("$where must be one of: ${s.enum.joinToString(", ")}.")
                val max = s.maxLength
                if (s.whole && max != null && text.length > max) {
                    throw ToolError("$where is ${text.length} characters; at most $max. The user approves what the card shows, so it is not cut: make it shorter.")
                }
                JsonPrimitive(if (max != null) Unsafe.clipTagged(text, max) else text)
            }
            "integer" -> {
                val raw = value as? JsonPrimitive
                val n: Long? = when {
                    raw == null || raw is JsonNull -> null
                    raw.isString -> raw.content.trim().takeIf { INT.matches(it) }?.toLongOrNull()
                    raw.booleanOrNull != null -> null
                    else -> raw.doubleOrNull?.takeIf { it.isFinite() && it == Math.floor(it) && Math.abs(it) < 9.0e15 }?.toLong()
                }
                if (n == null) throw ToolError("$where must be a whole number.")
                s.minimum?.let { if (n < it) throw ToolError("$where must be at least $it.") }
                s.maximum?.let { if (n > it) throw ToolError("$where must be at most $it.") }
                JsonPrimitive(n)
            }
            "boolean" -> {
                val raw = value as? JsonPrimitive
                when {
                    raw == null || raw is JsonNull -> throw ToolError("$where must be true or false.")
                    raw.isString && (raw.content == "true" || raw.content == "false") -> JsonPrimitive(raw.content == "true")
                    !raw.isString && raw.booleanOrNull != null -> JsonPrimitive(raw.booleanOrNull!!)
                    else -> throw ToolError("$where must be true or false.")
                }
            }
            "array" -> {
                val list = if (value is JsonArray) value.toList() else listOf(value)
                s.minItems?.let { if (list.size < it) throw ToolError("$where needs at least $it item(s).") }
                s.maxItems?.let { if (list.size > it) throw ToolError("$where takes at most $it items.") }
                val item = s.items
                JsonArray(list.mapIndexed { i, v -> if (item != null) validate(item, v, "$where[$i]") else v })
            }
            else -> value
        }
    }

    private val INT = Regex("^-?\\d+$")

    // JS String(n) for the numbers models send: 3 not 3.0.
    private fun jsString(p: JsonPrimitive): String {
        val d = p.doubleOrNull ?: return p.content
        return if (d.isFinite() && d == Math.floor(d) && Math.abs(d) < 1e21) d.toLong().toString() else p.content
    }
}
