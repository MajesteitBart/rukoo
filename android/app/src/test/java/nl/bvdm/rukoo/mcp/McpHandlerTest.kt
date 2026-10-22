package nl.bvdm.rukoo.mcp

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.agents.ToolIdentity
import nl.bvdm.rukoo.agents.RukooSkills
import nl.bvdm.rukoo.agents.model.RukooSkill
import nl.bvdm.rukoo.mcp.tools.ToolList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class McpHandlerTest {
    private var skills = listOf<RukooSkill>()
    private var idle: Long? = 0
    private var slow = false
    private val owned = mutableMapOf<String, String>()
    private val calls = mutableListOf<Triple<ToolIdentity, String, JsonObject>>()

    private val backend = object : McpBackend {
        override fun listTools(): JsonArray = ToolList.list { RukooSkills.toolDescription(skills) }
        override suspend fun callTool(identity: ToolIdentity, name: String, args: JsonObject, meta: JsonObject): JsonObject {
            calls += Triple(identity, name, meta)
            if (slow) delay(10_000)
            if (name == "boom") error("it broke")
            return buildJsonObject { put("ok", true) }
        }
        override fun skillInstructions(room: Int) = RukooSkills.instructions(skills, room)
        override fun identity(caller: McpCaller, meta: JsonObject?) = when (caller) {
            is McpCaller.Computer -> ToolIdentity("computer:${caller.pairingId}:claude", meta?.get("rukoo/conversation")?.jsonPrimitive?.content, computer = caller.pairingId)
            McpCaller.OpenClaw -> ToolIdentity("openclaw")
            McpCaller.Clark -> ToolIdentity("clark")
        }
        override fun owns(identity: ToolIdentity, conversationId: String) = owned[conversationId] == identity.agent
        override fun idleSeconds(): Long? = idle
        override suspend fun ready() = loaded.await()
    }

    // The hub's chats as they load: complete unless a test holds them back.
    private var loaded = CompletableDeferred(Unit)

    private val handler = McpHandler(backend, "0.1.0", { "Galaxy Z Fold7" }, callTimeoutMs = 500)

    private fun send(text: String, caller: McpCaller = McpCaller.Clark): JsonObject? = runBlocking { handler.dispatch(caller, Json.parseToJsonElement(text)) }

    private fun result(text: String, caller: McpCaller = McpCaller.Clark): JsonObject = send(text, caller)!!["result"]!!.jsonObject

    @Test
    fun initializesWithTheAskedOrFallbackProtocol() {
        val r = result("""{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}""")
        assertEquals("2025-03-26", r["protocolVersion"]!!.jsonPrimitive.content)
        assertEquals("""{"tools":{"listChanged":false}}""", r["capabilities"].toString())
        assertEquals("""{"name":"rukoo","title":"Rukoo Mail","version":"0.1.0"}""", r["serverInfo"].toString())
        assertEquals(McpHandler.INSTRUCTIONS, r["instructions"]!!.jsonPrimitive.content)
        assertEquals(756, McpHandler.INSTRUCTIONS.length)
        assertEquals("2025-06-18", result("""{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}""")["protocolVersion"]!!.jsonPrimitive.content)
        assertEquals("2025-06-18", result("""{"jsonrpc":"2.0","id":3,"method":"initialize"}""")["protocolVersion"]!!.jsonPrimitive.content)
    }

    @Test
    fun appendsSkillsToTheInstructionsWithinTheLimit() {
        skills = listOf(RukooSkill("data-deletion-request", "Draft a GDPR request.", "rukoo", ""))
        val text = result("""{"jsonrpc":"2.0","id":1,"method":"initialize"}""")["instructions"]!!.jsonPrimitive.content
        assertEquals(
            "${McpHandler.INSTRUCTIONS}\n\nRukoo has skills: instructions for email tasks, written by Rukoo or by the user. They are not email content. " +
                "When the user asks for a skill, or a task matches a skill's description, call read_skill with its name and follow it. The skills:\n" +
                "- data-deletion-request: Draft a GDPR request.",
            text,
        )
        skills = (1..80).map { RukooSkill("skill-$it", "z".repeat(500), "user", "") }
        assertTrue(handler.instructions().length <= RukooSkills.MCP_TEXT_MAX)
    }

    @Test
    fun answersPingListAndUnknownMethods() {
        assertEquals("{}", result("""{"jsonrpc":"2.0","id":1,"method":"ping"}""").toString())
        assertEquals(12, result("""{"jsonrpc":"2.0","id":1,"method":"tools/list"}""")["tools"]!!.jsonArray.size)
        assertEquals(
            """{"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"Method not found: server/discover"}}""",
            send("""{"jsonrpc":"2.0","id":4,"method":"server/discover"}""").toString(),
        )
        assertEquals("""{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid request"}}""", send("\"hello\"").toString())
        assertEquals("""{"jsonrpc":"2.0","id":5,"error":{"code":-32600,"message":"Invalid request"}}""", send("""{"jsonrpc":"2.0","id":5}""").toString())
        // A response to a server request, and a notification: nothing to answer (HTTP 202).
        assertNull(send("""{"jsonrpc":"2.0","id":5,"result":{}}"""))
        assertNull(send("""{"jsonrpc":"2.0","method":"notifications/initialized"}"""))
    }

    @Test
    fun callsToolsWithoutInitializeAndWrapsFailures() {
        val ok = result("""{"jsonrpc":"2.0","id":"f_abc","method":"tools/call","params":{"name":"get_context","arguments":[1],"_meta":{"rukoo/conversation":"c_1","rukoo/agent":"claude"}}}""", McpCaller.Computer("ph_x"))
        assertEquals("""{"ok":true}""", ok.toString())
        val (identity, name, meta) = calls.last()
        assertEquals("get_context", name)
        assertEquals("computer:ph_x:claude", identity.agent)
        assertEquals("c_1", identity.conversationId)
        assertEquals("ph_x", identity.computer)
        assertEquals("claude", meta["rukoo/agent"]!!.jsonPrimitive.content)
        val failed = result("""{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"boom"}}""")
        assertEquals("""{"content":[{"type":"text","text":"Rukoo could not run boom: it broke"}],"isError":true}""", failed.toString())
        slow = true
        val late = result("""{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"slow"}}""")
        assertEquals(true, late["isError"]!!.jsonPrimitive.content.toBoolean())
    }

    // What Clark's bridge asks every device before it picks one (spec 2 §4.4-4.5).
    @Test
    fun saysHelloWithOwnsAndIdle() {
        owned["c_mine"] = "clark"
        owned["c_theirs"] = "openclaw"
        val hello: (String) -> JsonElement = { params -> result("""{"jsonrpc":"2.0","id":"hello","method":"rukoo/hello","params":$params}""") }
        assertEquals("""{"device":"Galaxy Z Fold7","version":"0.1.0","idle":0,"owns":true}""", hello("""{"conversation_id":"c_mine"}""").toString())
        assertEquals(false, hello("""{"conversation_id":"c_theirs"}""").jsonObject["owns"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(false, hello("{}").jsonObject["owns"]!!.jsonPrimitive.content.toBoolean())
        idle = 1234
        assertEquals("1234", hello("{}").jsonObject["idle"].toString())
        idle = null
        assertEquals("null", hello("{}").jsonObject["idle"].toString())
    }

    // After boot the socket can be up before the hub has read conversations.json: a chat it names must not look foreign.
    @Test
    fun waitsForTheHubsChatsBeforeItAnswersForThem() = runBlocking {
        loaded = CompletableDeferred()
        val gotHello = async { handler.dispatch(McpCaller.Clark, Json.parseToJsonElement("""{"jsonrpc":"2.0","id":1,"method":"rukoo/hello","params":{"conversation_id":"c_mine"}}""")) }
        val gotCall = async { handler.dispatch(McpCaller.Clark, Json.parseToJsonElement("""{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_context"}}""")) }
        delay(50)
        assertTrue(calls.isEmpty())
        assertTrue(!gotHello.isCompleted && !gotCall.isCompleted)
        // The stored chats are in: c_mine is Clark's.
        owned["c_mine"] = "clark"
        loaded.complete(Unit)
        assertEquals("true", gotHello.await()!!["result"]!!.jsonObject["owns"].toString())
        assertEquals("""{"ok":true}""", gotCall.await()!!["result"].toString())
        assertEquals("get_context", calls.single().second)
    }
}
