package nl.bvdm.rukoo.account

import java.math.BigDecimal
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * JSON text exactly as JavaScript's JSON.stringify writes it. Desktop Rukoo seals a record's JSON as Node writes it,
 * and settles two versions of a record by comparing `JSON.stringify([d, v])`, so the phone has to write the same
 * characters: the same number forms, the same escapes and the same key order.
 */
object JsJson {
    fun stringify(element: JsonElement?): String = StringBuilder().also { write(it, element ?: JsonNull) }.toString()

    private fun write(out: StringBuilder, e: JsonElement) {
        when (e) {
            is JsonNull -> out.append("null")
            is JsonPrimitive -> when {
                e.isString -> quote(out, e.content)
                e.content == "true" || e.content == "false" -> out.append(e.content)
                else -> out.append(number(e.content))
            }
            is JsonArray -> {
                out.append('[')
                e.forEachIndexed { i, item ->
                    if (i > 0) out.append(',')
                    write(out, item)
                }
                out.append(']')
            }
            is JsonObject -> {
                out.append('{')
                keyOrder(e.keys).forEachIndexed { i, key ->
                    if (i > 0) out.append(',')
                    quote(out, key)
                    out.append(':')
                    write(out, e.getValue(key))
                }
                out.append('}')
            }
        }
    }

    /** A JavaScript object lists keys that are array indexes first, in numeric order, then the rest as inserted. */
    private fun keyOrder(keys: Set<String>): List<String> {
        val (indexes, rest) = keys.partition(::isIndex)
        return indexes.sortedBy { it.toLong() } + rest
    }

    private fun isIndex(key: String): Boolean =
        key.isNotEmpty() && key.length <= 10 && key.all { it in '0'..'9' } && (key == "0" || key[0] != '0') && key.toLong() < 4294967295L

    private fun quote(out: StringBuilder, s: String) {
        out.append('"')
        var i = 0
        while (i < s.length) {
            val ch = s[i]
            when {
                ch == '"' -> out.append("\\\"")
                ch == '\\' -> out.append("\\\\")
                ch == '\b' -> out.append("\\b")
                ch == '\u000C' -> out.append("\\f")
                ch == '\n' -> out.append("\\n")
                ch == '\r' -> out.append("\\r")
                ch == '\t' -> out.append("\\t")
                ch < ' ' -> out.append("\\u").append("%04x".format(ch.code))
                // A surrogate without its pair is written as an escape, as JSON.stringify has done since ES2019.
                ch.isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate() -> {
                    out.append(ch).append(s[i + 1])
                    i++
                }
                ch.isSurrogate() -> out.append("\\u").append("%04x".format(ch.code))
                else -> out.append(ch)
            }
            i++
        }
        out.append('"')
    }

    /** A number as JavaScript's Number::toString writes it: no ".0" on whole numbers, exponents only far out. */
    fun number(text: String): String {
        val d = text.toDoubleOrNull() ?: return "null"
        if (d.isNaN() || d.isInfinite()) return "null"
        if (d == 0.0) return "0"
        if (d < 0) return "-" + number((-d).toString())
        // The shortest digits that read back as the same double, and where the decimal point goes.
        val exact = BigDecimal(d.toString()).stripTrailingZeros()
        val digits = exact.unscaledValue().toString()
        val k = digits.length
        val n = k - exact.scale()
        return when {
            n in k..21 -> digits + "0".repeat(n - k)
            n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
            n in -5..0 -> "0." + "0".repeat(-n) + digits
            else -> {
                val e = n - 1
                val exp = if (e < 0) "e$e" else "e+$e"
                if (k == 1) digits + exp else digits[0] + "." + digits.substring(1) + exp
            }
        }
    }
}
