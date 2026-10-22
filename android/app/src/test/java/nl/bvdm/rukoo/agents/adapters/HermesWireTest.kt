package nl.bvdm.rukoo.agents.adapters

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import nl.bvdm.rukoo.agents.model.ChoiceKind
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.ToolKind
import nl.bvdm.rukoo.core.RukooJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HermesWireTest {
    private fun obj(json: String) = RukooJson.parseToJsonElement(json) as JsonObject

    @Test
    fun jsTextShowsValuesAsJavaScriptsStringDoes() {
        // What String(v) gives in node for each value.
        fun text(json: String) = HermesWire.jsText(RukooJson.parseToJsonElement(json))
        assertEquals("abc", text("\"abc\""))
        assertEquals("2.5", text("2.5"))
        assertEquals("[object Object]", text("{\"a\":1}"))
        assertEquals("1,2,3,4", text("[1,[2,3],4]"))
        assertEquals(",1", text("[[],1]"))
        assertEquals("true,,2.5", text("[true,null,2.5]"))
        assertEquals("[object Object],x", text("[{\"a\":1},\"x\"]"))
        assertEquals("", text("[[[[]]]]"))
    }

    @Test
    fun jsTextTakesAServersDeepestNestingOnASmallStack() {
        var objects: JsonElement = JsonPrimitive(1)
        var arrays: JsonElement = JsonPrimitive(1)
        repeat(100_000) {
            objects = JsonObject(mapOf("a" to objects))
            arrays = JsonArray(listOf(arrays))
        }
        // JSON text recurses once per level, which is what the version from /health and the like used to go through.
        assertTrue(onSmallStack { runCatching { objects.toString() }.exceptionOrNull() } is StackOverflowError)
        assertEquals("[object Object]", onSmallStack { HermesWire.jsText(objects) })
        assertEquals("1", onSmallStack { HermesWire.jsText(arrays) })
    }

    private fun <T> onSmallStack(block: () -> T): T {
        var result: Result<T>? = null
        val thread = Thread(null, { result = runCatching(block) }, "small-stack", 256L * 1024)
        thread.start()
        thread.join()
        return result!!.getOrThrow()
    }

    @Test
    fun splitModelNamesAProviderOnlyWhenItLooksLikeOne() {
        assertEquals(HermesWire.Split("openrouter", "openai/gpt-6-astra"), HermesWire.splitModel(" openrouter::openai/gpt-6-astra "))
        assertEquals(HermesWire.Split("", "quick"), HermesWire.splitModel("quick"))
        assertEquals(HermesWire.Split("", "::x"), HermesWire.splitModel("::x"))
        assertEquals(HermesWire.Split("", "a::"), HermesWire.splitModel("a::"))
        assertEquals(HermesWire.Split("", "bad slug::m"), HermesWire.splitModel("bad slug::m"))
    }

    @Test
    fun missingTextMatchesDesktop() {
        // The cases of hermes.js missingText, one per branch.
        assertEquals("", HermesWire.missingText("Hello world", "Hello world", "Hello world"))
        assertEquals("", HermesWire.missingText("", "", "  "))
        assertEquals(" world", HermesWire.missingText("Hello", "Hello", "Hello world"))
        assertEquals("Final", HermesWire.missingText("Before the tool", "", "\n Final"))
        assertEquals("", HermesWire.missingText("Other words", "Other words", "The answer"))
        assertEquals("\n\nThe answer", HermesWire.missingText("Other words", "Other words", "The answer", lost = true))
        assertEquals("", HermesWire.missingText("abc", "abcdef", "abc"))
    }

    @Test
    fun failureMapsRateLimitsAndInterruptions() {
        assertEquals(ErrorCodes.RATE_LIMITED to "429 Too Many Requests", HermesWire.failure(obj("""{"error":"429 Too Many Requests"}"""), "The run failed"))
        assertEquals(ErrorCodes.OFFLINE to "worker died", HermesWire.failure(obj("""{"message":"worker died","event":"run.interrupted"}"""), "The run failed"))
        assertEquals(ErrorCodes.OFFLINE to "The run failed", HermesWire.failure(obj("""{"status":"interrupted"}"""), "The run failed"))
        assertEquals(ErrorCodes.UNKNOWN to "max_turns", HermesWire.failure(obj("""{"turn_exit_reason":"max_turns"}"""), "The run failed"))
    }

    @Test
    fun modelMenuMergesProvidersAndRoutes() {
        val options = obj(
            """{"model":"claude-opus-5-5","provider":"anthropic","providers":[
                {"slug":"anthropic","name":"Anthropic","models":["claude-opus-5-5","claude-haiku-5-5",""],"capabilities":{"claude-haiku-5-5":{"reasoning":false}}},
                {"slug":"openrouter","name":"OpenRouter","models":["a","b"],"featured_models":["openai/gpt-6-astra"]},
                {"slug":"x","models":["skipped: slug too short"]}]}""",
        )
        val routes = obj("""{"data":[{"id":"clark"},{"id":"quick","parent":"clark","root":"mistral/small-4"},{"id":"same","parent":"clark","root":"same"}]}""")
        val (models, efforts, custom) = HermesWire.models(routes, options)
        assertEquals(listOf("anthropic::claude-opus-5-5", "anthropic::claude-haiku-5-5", "openrouter::openai/gpt-6-astra", "quick", "same"), models.map { it.id })
        val opus = models[0]
        assertTrue(opus.isDefault)
        assertEquals("Anthropic", opus.group)
        assertEquals("claude-opus-5-5", opus.label)
        assertEquals(HermesWire.EFFORTS, opus.efforts)
        assertEquals(emptyList<String>(), models[1].efforts)
        val quick = models[3]
        assertTrue(quick.route)
        assertEquals("mistral/small-4", quick.tag)
        assertEquals("", models[4].tag)
        assertEquals(HermesWire.EFFORTS, efforts)
        assertEquals(HermesWire.EFFORTS, custom)
    }

    @Test
    fun modelMenuTakesTheCurrentModelsEffortsAndLimitsPerProvider() {
        val many = (1..80).joinToString(",") { "\"m$it\"" }
        val options = obj("""{"model":"m1","provider":"big","providers":[{"slug":"big","models":[$many],"capabilities":{"m1":{"reasoning":false}}}]}""")
        val (models, efforts) = HermesWire.models(null, options)
        assertEquals(HermesWire.MAX_PER_PROVIDER, models.size)
        assertEquals(emptyList<String>(), efforts)
        assertEquals("big", models[0].group)
    }

    @Test
    fun approvalCardsForCommandsAndTheMcpGate() {
        val command = HermesWire.approval(
            "Clark",
            "clark",
            obj("""{"request_id":"req1","choices":["ONCE","session","always","nonsense"],"command":"rm -rf build","description":"rm -rf build"}"""),
        )
        assertEquals("Clark wants to run a command", command.title)
        assertEquals(listOf("once", "session", "always", "deny"), command.choices.map { it.id })
        assertEquals(listOf("Allow once", "Allow for this turn", "Always allow", "Deny"), command.choices.map { it.label })
        assertEquals(ChoiceKind.DANGER, command.choices.last().kind)
        assertEquals("command" to "rm -rf build", command.fields.single().key to command.fields.single().value)
        // The description only repeated the command.
        assertEquals("", command.detail)
        assertEquals("req1", command.key)
        assertEquals(ToolKind.COMMAND, command.tool?.kind)

        val gate = HermesWire.approval(
            "Clark",
            "clark",
            obj("""{"pattern_key":"mcp_elicitation","command":"MCP tool 'search_mail' on UNTRUSTED server 'rukoo' wants to run","description":"Allow?"}"""),
        )
        assertEquals("Clark wants to use rukoo · search_mail", gate.title)
        assertEquals("mcp__rukoo__search_mail", gate.tool?.name)
        assertEquals(listOf("once", "deny"), gate.choices.map { it.id })
        assertEquals("input" to "Tool", gate.fields.single().key to gate.fields.single().label)
        assertEquals("Allow?", gate.detail)
        assertNull(gate.key)

        val unknown = HermesWire.approval("Clark", "clark", obj("""{"pattern_key":"mcp_elicitation","command":"something else"}"""))
        assertEquals("Clark wants to use a tool", unknown.title)
        assertEquals(ToolKind.OTHER, unknown.tool?.kind)
    }

    @Test
    fun skillBlocksCarryTheBodyOrPointToSkillView() {
        assertEquals(
            "[The user invoked the \"meeting-prep\" skill, so they want you to follow its instructions. The full skill content is loaded below.]\n\nDo it.",
            HermesWire.skillBlock("meeting-prep", "Do it."),
        )
        val long = HermesWire.skillBlock("big", "x".repeat(HermesWire.SKILL_BODY_MAX + 1))
        assertEquals("[The user invoked the \"big\" skill, so they want you to follow its instructions. Load it with skill_view (name \"big\") and follow it.]", long)
        assertTrue(long.startsWith(HermesWire.SKILL_BLOCK_START))
    }

    @Test
    fun skillListReadsBothShapes() {
        val wrapped = HermesWire.skills(RukooJson.parseToJsonElement("""{"data":[{"name":"a","description":"A","category":"cat"},{"name":"b"},{"description":"no name"}]}"""))
        assertEquals(listOf("a", "b"), wrapped.map { it.name })
        assertEquals("cat", wrapped[0].scope)
        assertNull(wrapped[1].scope)
        assertEquals(listOf("c"), HermesWire.skills(RukooJson.parseToJsonElement("""[{"name":"c"}]""")).map { it.name })
    }
}
