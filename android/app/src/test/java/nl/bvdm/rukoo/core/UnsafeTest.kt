package nl.bvdm.rukoo.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/** unsafe-vectors.json holds outputs of desktop Rukoo's context.js for the same inputs. */
class UnsafeTest {
    private val cases: JsonArray =
        Json.parseToJsonElement(javaClass.getResource("/unsafe-vectors.json")!!.readText()).jsonArray

    private fun str(v: kotlinx.serialization.json.JsonElement) = (v as? JsonPrimitive)?.contentOrNull

    private fun fields(v: kotlinx.serialization.json.JsonElement): Map<String, Any?> =
        (v as JsonObject).mapValues { (_, value) -> if (value is JsonNull) null else str(value) }

    @Test
    fun matchesTheDesktopHelpers() {
        for (case in cases) {
            val c = case.jsonObject
            val args = c["args"]!!.jsonArray
            val expected = c["out"]!!.jsonPrimitive.content
            val actual = when (val fn = c["fn"]!!.jsonPrimitive.content) {
                "unsafeBlock" -> Unsafe.block(str(args[0]), fields(args[1]))
                "unsafeInline" -> when (args.size) {
                    1 -> Unsafe.inline(str(args[0]))
                    else -> Unsafe.inline(str(args[0]), str(args[1])!!, args[2].jsonPrimitive.int)
                }
                "unsafeValue" -> Unsafe.value(str(args[0]))
                "untag" -> Unsafe.untag(str(args[0]))
                "clipTagged" -> Unsafe.clipTagged(str(args[0]), args[1].jsonPrimitive.int)
                else -> error("unknown function $fn")
            }
            assertEquals("${c["fn"]} ${args}", expected, actual)
        }
    }

    @Test
    fun defangInsertsAZeroWidthSpaceAfterTheTagName() {
        assertEquals("<unsafe_content​ x>", Unsafe.defang("<unsafe_content x>"))
        assertEquals("</EMAIL​>", Unsafe.defang("</EMAIL>"))
        assertEquals("<emails>", Unsafe.defang("<emails>"))
    }
}
