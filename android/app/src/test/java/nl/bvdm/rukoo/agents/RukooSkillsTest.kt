package nl.bvdm.rukoo.agents

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import nl.bvdm.rukoo.agents.model.RukooSkill
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Rukoo's skills against desktop skills.js reading the same folders. */
class RukooSkillsTest {
    private val fixtures = Fixtures.json("skills-fixtures.json")
    private val skills = RukooSkills(FileSkillTree(Fixtures.bundledSkills), FileSkillTree(Fixtures.dir("user-skills")))

    private fun skill(o: JsonObject) = RukooSkill(Fixtures.str(o["name"])!!, Fixtures.str(o["description"]).orEmpty(), Fixtures.str(o["source"]).orEmpty(), Fixtures.str(o["body"]).orEmpty())

    @Test
    fun listsTheSameSkillsAsDesktop() {
        val expected = fixtures["listed"]!!.jsonArray.map { skill(it.jsonObject) }
        assertEquals(expected, skills.models())
        // A user skill replaces Rukoo's with the same name.
        assertEquals("user", skills.get("data-deletion-request")!!.source)
        assertTrue(skills.models().any { it.name == "unsubscribe-via-browser" && it.source == "rukoo" })
    }

    @Test
    fun readSkillAnswersLikeDesktop() {
        for (raw in fixtures["reads"]!!.jsonArray) {
            val args = raw.jsonObject["args"]!!.jsonObject
            val result = raw.jsonObject["result"]!!.jsonObject
            val name = Fixtures.str(args["name"])
            val file = Fixtures.str(args["file"])
            val error = Fixtures.str(result["error"])
            if (error != null) {
                try {
                    skills.read(name, file)
                    fail("$args should fail with: $error")
                } catch (e: SkillException) {
                    assertEquals(args.toString(), error, e.message)
                }
                continue
            }
            assertEquals(args.toString(), result["ok"], skills.read(name, file))
        }
    }

    @Test
    fun skillListsFitTheSameRoomAsDesktop() {
        for (raw in fixtures["instructions"]!!.jsonArray) {
            val c = raw.jsonObject
            val list = c["list"]!!.jsonArray.map { skill(it.jsonObject) }
            val room = c["room"]!!.jsonPrimitive.long.toInt()
            assertEquals("room $room", Fixtures.str(c["expected"]), RukooSkills.instructions(list, room))
        }
        for (raw in fixtures["toolDescriptions"]!!.jsonArray) {
            val c = raw.jsonObject
            assertEquals(Fixtures.str(c["expected"]), RukooSkills.toolDescription(c["list"]!!.jsonArray.map { skill(it.jsonObject) }))
        }
    }

    @Test
    fun frontmatterParsesLikeDesktop() {
        for (raw in fixtures["frontmatter"]!!.jsonArray) {
            val c = raw.jsonObject
            val text = Fixtures.str(c["text"])!!
            val error = Fixtures.str(c["error"])
            if (error != null) {
                try {
                    SkillFrontmatter.parse(text)
                    fail("should fail: $text")
                } catch (e: SkillException) {
                    assertEquals(error, e.message)
                }
                continue
            }
            val parsed = SkillFrontmatter.parse(text)
            val data = c["data"]!!.jsonObject
            assertEquals(text, data.keys, parsed.data.keys)
            for ((k, v) in data) {
                val got = parsed.data[k]
                if (v is JsonNull) assertEquals(text, SkillFrontmatter.Nested, got) else assertEquals("$text: $k", v.jsonPrimitive.content, got)
            }
            assertEquals(Fixtures.str(c["body"]), parsed.body)
        }
    }

    @Test
    fun theBundledSkillsLoad() {
        val bundled = RukooSkills(FileSkillTree(Fixtures.bundledSkills), null).models()
        assertEquals(listOf("data-deletion-request", "unsubscribe-via-browser"), bundled.map { it.name })
        assertTrue(bundled.all { it.description.isNotEmpty() && it.body.isNotEmpty() && it.source == "rukoo" })
    }
}
