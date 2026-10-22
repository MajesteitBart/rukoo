package nl.bvdm.rukoo.mcp

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import nl.bvdm.rukoo.agents.RukooSkills
import nl.bvdm.rukoo.agents.model.RukooSkill
import nl.bvdm.rukoo.mcp.tools.ToolList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Clark's bridge caches one tool list for every device it finds, so the phone's list must be the desktop's to the
 * byte, key order included. The fixture is desktop's `tools.list(null)`. How skill lists fit their room is
 * RukooSkillsTest's, against desktop's skills.js.
 */
class ToolListTest {
    private val json = Json { prettyPrint = false }

    private fun desktop(): JsonArray =
        Json.parseToJsonElement(javaClass.classLoader!!.getResource("mcp/desktop-tools-list.json")!!.readText()).jsonObject["tools"]!!.jsonArray

    private fun encode(e: JsonElement) = json.encodeToString(JsonElement.serializer(), e)

    // The skills sentence at the end of read_skill's description depends on the skills there are.
    private fun normalized(tools: JsonArray): JsonArray = JsonArray(
        tools.map { t ->
            val o = t.jsonObject
            if (o["name"]!!.jsonPrimitive.content != "read_skill") o
            else JsonObject(o.toMutableMap().apply { put("description", JsonPrimitive(RukooSkills.toolDescription(emptyList()))) })
        },
    )

    @Test
    fun isTheDesktopListByteForByte() {
        assertEquals(encode(desktop()), encode(ToolList.list { RukooSkills.toolDescription(emptyList()) }))
    }

    @Test
    fun isTheDesktopListWithSkills() {
        val withSkills = ToolList.list { RukooSkills.toolDescription(listOf(RukooSkill("data-deletion-request", "Draft a GDPR request.", "rukoo", ""))) }
        assertEquals(encode(desktop()), encode(normalized(withSkills)))
        val description = withSkills.first { it.jsonObject["name"]!!.jsonPrimitive.content == "read_skill" }.jsonObject["description"]!!.jsonPrimitive.content
        assertTrue(description.endsWith(" Skills:\n- data-deletion-request: Draft a GDPR request."))
    }

    @Test
    fun keepsTheStaticDescriptionWhenSkillsFail() {
        assertEquals(encode(desktop()), encode(ToolList.list { error("unreadable") }))
    }

    @Test
    fun acceptsPrefixedNames() {
        assertEquals("search_mail", ToolList.bareName("mcp__rukoo__search_mail"))
        assertEquals("search_mail", ToolList.bareName("mcp_rukoo_search_mail"))
        assertEquals("search_mail", ToolList.bareName("rukoo.search_mail"))
        assertEquals("search_mail", ToolList.bareName("search_mail"))
    }
}
