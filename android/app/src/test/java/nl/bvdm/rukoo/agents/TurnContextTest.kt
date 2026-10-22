package nl.bvdm.rukoo.agents

import java.time.ZoneId
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import nl.bvdm.rukoo.agents.model.AttachedEmail
import nl.bvdm.rukoo.agents.model.ContinuedRef
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.RukooSkill
import nl.bvdm.rukoo.core.RukooJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The turn text against desktop context.js's own output for the same input. */
class TurnContextTest {
    private val fixtures = Fixtures.json("context-fixtures.json")
    private val zone = ZoneId.of(fixtures["zone"]!!.jsonPrimitive.content)

    private fun items(e: kotlinx.serialization.json.JsonElement?): List<Item>? =
        (e as? JsonArray)?.map { RukooJson.decodeFromJsonElement(Item.serializer(), it) }

    @Test
    fun turnTextMatchesDesktop() {
        val cases = fixtures["turnText"]!!.jsonArray
        assertTrue(cases.size >= 10)
        // The attached files' lines are among the cases: one file, several, an image alone, a file and an email.
        assertTrue(cases.count { (it.jsonObject["files"] as? JsonArray)?.isNotEmpty() == true } >= 4)
        for (raw in cases) {
            val c = raw.jsonObject
            val conversation = c["conversation"]!!.jsonObject
            val message = (c["message"] as? JsonObject)?.let {
                LoadedEmail(Fixtures.full(it["full"])!!, Fixtures.str(it["account"]).orEmpty(), Fixtures.str(it["folder"]).orEmpty())
            }
            val newer = (c["newer"] as? JsonArray)?.map {
                val n = it.jsonObject
                NewerEmail(
                    RukooJson.decodeFromJsonElement(ContinuedRef.serializer(), n["ref"]!!),
                    Fixtures.full(n["full"]),
                    Fixtures.str(n["account"]).orEmpty(),
                    Fixtures.str(n["folder"]).orEmpty(),
                    n["open"]!!.jsonPrimitive.booleanOrNull == true,
                )
            }.orEmpty()
            val open = (c["openMessage"] as? JsonObject)?.let { OpenEmail(Fixtures.str(it["id"])!!, Fixtures.str(it["subject"]).orEmpty()) }
            val emails = (c["emails"] as? JsonArray)?.map { RukooJson.decodeFromJsonElement(AttachedEmail.serializer(), it) }.orEmpty()
            // Files as desktop's chatfiles.forTurn hands them to turnText.
            val files = (c["files"] as? JsonArray)?.map { RukooJson.decodeFromJsonElement(AttachedFile.serializer(), it) }.orEmpty()
            val actual = TurnContext.turnText(
                conversationId = Fixtures.str(conversation["id"])!!,
                chatEmail = (conversation["message"] as? JsonObject)?.let { RukooJson.decodeFromJsonElement(MessageRef.serializer(), it) },
                text = Fixtures.str(c["text"]).orEmpty(),
                firstTurn = c["firstTurn"]!!.jsonPrimitive.booleanOrNull == true,
                notes = (c["notes"] as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty(),
                message = message,
                openMessage = open,
                newer = newer,
                earlier = items(c["earlier"]),
                files = files,
                emails = emails,
                now = c["now"]!!.jsonPrimitive.long,
                zone = zone,
            )
            assertEquals(Fixtures.str(c["name"]), Fixtures.str(c["expected"]), actual)
        }
    }

    @Test
    fun recapMatchesDesktop() {
        for (raw in fixtures["recap"]!!.jsonArray) {
            val c = raw.jsonObject
            val expected = c["expected"]!!.jsonObject
            val recap = TurnContext.recap(items(c["items"])!!)
            assertEquals(expected["entries"]!!.jsonArray.map { it.jsonPrimitive.content }, recap.entries)
            assertEquals(expected["left"]!!.jsonPrimitive.long.toInt(), recap.left)
        }
    }

    @Test
    fun skillTurnMatchesDesktop() {
        for (raw in fixtures["skillTurn"]!!.jsonArray) {
            val c = raw.jsonObject
            val skill = RukooSkill(Fixtures.str(c["name"])!!, "", "rukoo", Fixtures.str(c["body"]).orEmpty())
            assertEquals(Fixtures.str(c["expected"]), TurnContext.skillTurn(skill))
        }
    }

    @Test
    fun longDateMatchesDesktopAcrossDaylightSaving() {
        for (raw in fixtures["longDate"]!!.jsonArray) {
            val c = raw.jsonObject
            assertEquals(Fixtures.str(c["expected"]), TurnContext.longDate(c["ms"]!!.jsonPrimitive.long, zone))
        }
    }

    @Test
    fun instructionsDifferFromDesktopOnlyWhereThePhoneDoes() {
        val desktop = Fixtures.str(fixtures["instructions"])!!.split("\n")
        val phone = TurnContext.instructions().split("\n")
        assertEquals(desktop.size, phone.size)
        val changed = desktop.indices.filter { desktop[it] != phone[it] }
        assertEquals(listOf(0, desktop.indexOfFirst { it.startsWith("- Keep chat answers short") }), changed)
        assertTrue(phone[0].startsWith("You are working inside Rukoo Mail, the email app on the user's phone"))
        assertEquals("- Keep chat answers short and plain. The user reads them on a phone screen.", phone[changed[1]])
        assertFalse(TurnContext.instructions().contains("desktop"))
    }
}
