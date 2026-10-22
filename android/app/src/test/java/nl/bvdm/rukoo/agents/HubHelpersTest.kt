package nl.bvdm.rukoo.agents

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import nl.bvdm.rukoo.agents.model.AgentErrorInfo
import nl.bvdm.rukoo.agents.model.ApprovalChoice
import nl.bvdm.rukoo.agents.model.ApprovalField
import nl.bvdm.rukoo.agents.model.ApprovalTool
import nl.bvdm.rukoo.agents.model.ChoiceKind
import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.ToolKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Tool labels, chip details, approval cards and the $skill rules against desktop hub.js and ownskills.js. */
class HubHelpersTest {
    private val hub = Fixtures.json("hub-fixtures.json")
    private val own = Fixtures.json("ownskills-fixtures.json")

    @Test
    fun toolLabelsMatchDesktop() {
        for (raw in hub["labels"]!!.jsonArray) {
            val c = raw.jsonObject
            assertEquals(Fixtures.str(c["name"]), Fixtures.str(c["label"]), ToolLabels.label(Fixtures.str(c["name"])))
        }
    }

    @Test
    fun chipDetailsMatchDesktop() {
        for (raw in hub["details"]!!.jsonArray) {
            val c = raw.jsonObject
            val value = Fixtures.str(c["value"])
            assertEquals(value, Fixtures.str(c["expected"]), ToolLabels.chipDetail(value))
        }
    }

    private fun kind(v: String?) = when (v) {
        "primary" -> ChoiceKind.PRIMARY
        "danger" -> ChoiceKind.DANGER
        else -> ChoiceKind.DEFAULT
    }

    private fun toolKind(v: String?) = ToolKind.entries.firstOrNull { it.name.replace("_", "").equals(v, ignoreCase = true) } ?: ToolKind.OTHER

    @Test
    fun approvalCardsMatchDesktop() {
        for (raw in hub["cards"]!!.jsonArray) {
            val input = raw.jsonObject["input"]!!.jsonObject
            val expected = raw.jsonObject["expected"]!!.jsonObject
            val card = ApprovalCards.card(
                Fixtures.str(input["title"]).orEmpty(),
                Fixtures.str(input["detail"]).orEmpty(),
                input["fields"]!!.jsonArray.map { f ->
                    val o = f.jsonObject
                    ApprovalField(Fixtures.str(o["label"]).orEmpty(), Fixtures.str(o["value"]).orEmpty(), Fixtures.str(o["key"]))
                },
                input["choices"]!!.jsonArray.map { ch ->
                    val o = ch.jsonObject
                    ApprovalChoice(Fixtures.str(o["id"]).orEmpty(), Fixtures.str(o["label"]).orEmpty(), kind(Fixtures.str(o["kind"])))
                },
                (input["tool"] as? JsonObject)?.let { ApprovalTool(Fixtures.str(it["name"]).orEmpty(), toolKind(Fixtures.str(it["kind"])), Fixtures.str(it["server"]), Fixtures.str(it["tool"])) },
            )
            val want = expected["card"]!!.jsonObject
            val title = Fixtures.str(want["title"])
            assertEquals(title, card.title)
            assertEquals(Fixtures.str(want["detail"]), card.detail)
            assertEquals(
                title,
                want["fields"]!!.jsonArray.map { f ->
                    val o = f.jsonObject
                    ApprovalField(Fixtures.str(o["label"]).orEmpty(), Fixtures.str(o["value"]).orEmpty(), Fixtures.str(o["key"]), (o["truncated"] as? JsonPrimitive)?.long?.toInt())
                },
                card.fields,
            )
            assertEquals(
                title,
                want["choices"]!!.jsonArray.map { ch ->
                    val o = ch.jsonObject
                    ApprovalChoice(Fixtures.str(o["id"])!!, Fixtures.str(o["label"])!!, kind(Fixtures.str(o["kind"])))
                },
                card.choices,
            )
            val tool = want["tool"] as? JsonObject
            assertEquals(title, tool?.let { ApprovalTool(Fixtures.str(it["name"])!!, toolKind(Fixtures.str(it["kind"])), Fixtures.str(it["server"]), Fixtures.str(it["tool"])) }, card.tool)
            assertEquals(title, (expected["refusal"] as? JsonObject)?.let { Fixtures.str(it["id"]) }, card.refusal?.id)
        }
    }

    @Test
    fun mentionsMatchDesktop() {
        for (raw in own["mentions"]!!.jsonArray) {
            val c = raw.jsonObject
            val names = c["names"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
            assertEquals(c["expected"]!!.jsonArray.map { it.jsonPrimitive.content }, OwnSkillMentions.mentionsIn(Fixtures.str(c["text"])!!, names))
        }
        assertEquals(false, OwnSkillMentions.mayMention("Costs 50 dollars"))
        assertEquals(true, OwnSkillMentions.mayMention("run \$pdf"))
    }

    @Test
    fun ownSkillListIsCleanedLikeDesktop() {
        val input = listOf(
            OwnSkill(" pdf ", "Read\n  PDFs", "tools"),
            OwnSkill("pdf", "again"),
            OwnSkill("123", "digits only"),
            OwnSkill("-bad", ""),
            OwnSkill("ok:name_1", "d".repeat(500), "s".repeat(50)),
            OwnSkill("x".repeat(121)),
            OwnSkill(""),
        )
        val expected = own["cleaned"]!!.jsonArray.map { e ->
            val o = e.jsonObject
            OwnSkill(Fixtures.str(o["name"])!!, Fixtures.str(o["description"]).orEmpty(), Fixtures.str(o["scope"]))
        }
        assertEquals(expected, OwnSkillMentions.cleanList(input))
    }

    @Test
    fun errorsKeepKnownCodesAndFoldTheRestIntoUnknown() {
        assertEquals(AgentErrorInfo("offline", "x"), Hub.toError(AgentErrorInfo("offline", "x")))
        assertEquals(AgentErrorInfo("unknown", "ECONNRESET"), Hub.toError(AgentErrorInfo("ECONNRESET", "")))
        assertEquals("unknown", Hub.toError(IllegalStateException("boom")).code)
        assertEquals("busy", Hub.toError(AgentException("busy", "a turn is running")).code)
        assertEquals(500, Hub.toError(AgentErrorInfo("timeout", "d".repeat(600))).detail.length)
    }

    @Test
    fun modelNamesAreCleanedLikeDesktop() {
        assertNull(Hub.cleanModel(null, strict = true))
        assertNull(Hub.cleanModel("", strict = true))
        assertEquals("opus", Hub.cleanModel("  opus ", strict = true))
        assertNull(Hub.cleanModel("bad\u0001", strict = false))
        assertNull(Hub.cleanModel("m".repeat(201), strict = false))
        try {
            Hub.cleanModel("   ", strict = true)
            error("a blank model must be refused")
        } catch (e: AgentException) {
            assertEquals("invalid", e.code)
        }
        assertEquals(listOf("low", "high", "max"), Hub.cleanEfforts(listOf("max", "bogus", "low", "high")))
    }
}
