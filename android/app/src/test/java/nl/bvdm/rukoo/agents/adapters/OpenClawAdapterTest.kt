package nl.bvdm.rukoo.agents.adapters

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import nl.bvdm.rukoo.agents.OpenClawSettings
import nl.bvdm.rukoo.agents.model.AdapterEvent
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.TurnStatus
import nl.bvdm.rukoo.core.RukooJson
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class OpenClawAdapterTest {
    private lateinit var server: MockWebServer
    private val scope = testScope()
    private var settings = OpenClawSettings(url = "", token = "gw-token", agentId = "mail", model = "")

    @Before
    fun start() {
        server = MockWebServer()
        server.start()
        settings = settings.copy(url = server.url("/").toString())
    }

    @After
    fun stop() {
        runCatching { server.shutdown() }
    }

    private fun adapter(timing: OpenClawAdapter.Timing = OpenClawAdapter.Timing(headers = 2_000, errorBody = 500)) =
        OpenClawAdapter({ settings }, OkHttpClient(), scope, XmlTexts(), timing = timing)

    private fun chunk(content: String?, finish: String? = null): String {
        val delta = if (content != null) "{\"content\":${kotlinx.serialization.json.JsonPrimitive(content)}}" else "{}"
        return "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":$delta,\"finish_reason\":${finish?.let { "\"$it\"" } ?: "null"}}]}\n\n"
    }

    /**
     * A first chunk padded with a comment line: MockWebServer's throttle also paces reading the request, and a first
     * period longer than the request lets the request through whole, then pauses the answer after this chunk.
     */
    private fun slow(content: String) = chunk(content) + ":" + " ".repeat(4_000) + "\n\n"

    private fun stream(body: String) = MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body)

    @Test
    fun aTurnStreamsTheAnswerUntilDone() = runBlocking {
        server.enqueue(stream(chunk("\n\nHello") + chunk(" world") + chunk(null, "stop") + "data: [DONE]\n\n"))
        val turn = RecordingTurn(conversation = Conversation(id = "c_mgx1_abc123", agent = "openclaw"), model = "anthropic/claude-opus-5-5")
        val result = withTimeout(10_000) { adapter().runTurn(turn) }
        assertEquals(TurnStatus.DONE, result.status)
        assertEquals(listOf(AdapterEvent.Text("Hello"), AdapterEvent.Text(" world")), turn.events.toList())
        assertEquals(1, turn.accepted)
        assertEquals(listOf(mapOf("agent" to "mail", "sessionUser" to "rukoo:c_mgx1_abc123")), turn.providers.toList())
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/chat/completions", request.path)
        assertEquals("Bearer gw-token", request.getHeader("Authorization"))
        assertEquals("text/event-stream", request.getHeader("Accept"))
        assertEquals("anthropic/claude-opus-5-5", request.getHeader("x-openclaw-model"))
        val body = RukooJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("openclaw/mail", body["model"]!!.jsonPrimitive.content)
        assertEquals("rukoo:c_mgx1_abc123", body["user"]!!.jsonPrimitive.content)
        assertEquals("true", body["stream"].toString())
        val messages = body["messages"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("system" to "INSTRUCTIONS", "user" to turn.input), messages.map { it["role"]!!.jsonPrimitive.content to it["content"]!!.jsonPrimitive.content })
    }

    @Test
    fun aChatKeepsItsAgentAndSessionAndNeedsNoModelHeader() = runBlocking {
        server.enqueue(stream(chunk("ok", "stop")))
        val turn = RecordingTurn(conversation = Conversation(id = "c2", agent = "openclaw", provider = mapOf("agent" to "older", "sessionUser" to "rukoo:c-old")))
        val result = adapter().runTurn(turn)
        // A finish_reason without [DONE] still counts as done.
        assertEquals(TurnStatus.DONE, result.status)
        assertTrue(turn.providers.isEmpty())
        val request = server.takeRequest()
        assertEquals(null, request.getHeader("x-openclaw-model"))
        val body = RukooJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("openclaw/older", body["model"]!!.jsonPrimitive.content)
        assertEquals("rukoo:c-old", body["user"]!!.jsonPrimitive.content)
    }

    @Test
    fun errorStatusesBeforeTheStream() = runBlocking {
        val cases = listOf(
            MockResponse().setResponseCode(404).setBody("Not Found") to (ErrorCodes.NOT_CONFIGURED to "The gateway has no Chat Completions endpoint. Turn on gateway.http.endpoints.chatCompletions.enabled in the OpenClaw config"),
            MockResponse().setResponseCode(409).setBody("{\"error\":{\"message\":\"Session is archived\"}}") to (ErrorCodes.UNKNOWN to "Session is archived. Restore the session in OpenClaw’s Control UI, or start a new chat."),
            MockResponse().setResponseCode(409) to (ErrorCodes.UNKNOWN to "OpenClaw archived this chat’s session. Restore the session in OpenClaw’s Control UI, or start a new chat."),
            MockResponse().setResponseCode(401).setBody("{\"error\":{\"message\":\"Unauthorized\"}}") to (ErrorCodes.UNAUTHORIZED to "HTTP 401: Unauthorized"),
            MockResponse().setResponseCode(503).setBody("starting") to (ErrorCodes.OFFLINE to "HTTP 503: starting"),
            MockResponse().setResponseCode(429) to (ErrorCodes.RATE_LIMITED to "HTTP 429"),
            MockResponse().setResponseCode(400).setBody("{\"error\":\"bad\"}") to (ErrorCodes.PROTOCOL to "HTTP 400: bad"),
        )
        for ((response, expected) in cases) {
            server.enqueue(response)
            val turn = RecordingTurn(conversation = Conversation(id = "c3", agent = "openclaw"))
            val result = adapter().runTurn(turn)
            assertEquals(TurnStatus.ERROR, result.status)
            assertEquals(expected, result.error!!.code to result.error!!.detail)
            assertEquals(0, turn.accepted)
        }
    }

    @Test
    fun errorsInsideTheStream() = runBlocking {
        server.enqueue(stream(chunk("Part") + "data: {\"error\":{\"message\":\"Provider 429: rate limit\"}}\n\ndata: [DONE]\n\n"))
        val turn = RecordingTurn(conversation = Conversation(id = "c4", agent = "openclaw"))
        val result = adapter().runTurn(turn)
        assertEquals(ErrorCodes.RATE_LIMITED, result.error?.code)
        assertEquals(AdapterEvent.Error(ErrorCodes.RATE_LIMITED, "Provider 429: rate limit"), turn.events.last())

        server.enqueue(stream("data: {\"error\":{\"message\":\"Session was archived\"}}\n\n"))
        val archived = adapter().runTurn(RecordingTurn(conversation = Conversation(id = "c5", agent = "openclaw")))
        assertEquals(ErrorCodes.UNKNOWN to "Session was archived. Restore the session in OpenClaw’s Control UI, or start a new chat.", archived.error?.code to archived.error?.detail)
    }

    @Test
    fun aStreamThatEndsEarlyOrGoesSilentFails() = runBlocking {
        server.enqueue(stream(chunk("Half")))
        val early = adapter().runTurn(RecordingTurn(conversation = Conversation(id = "c6", agent = "openclaw")))
        assertEquals(ErrorCodes.OFFLINE to "The connection to OpenClaw closed before the answer was complete", early.error?.code to early.error?.detail)

        val first = slow("Thinking")
        server.enqueue(stream(first + chunk(" more")).throttleBody(first.length.toLong(), 5, TimeUnit.SECONDS))
        val quiet = adapter(OpenClawAdapter.Timing(headers = 2_000, silence = 300))
        val result = withTimeout(10_000) { quiet.runTurn(RecordingTurn(conversation = Conversation(id = "c7", agent = "openclaw"))) }
        // The minutes are rounded, as desktop does; this test's silence rounds to none.
        assertEquals(ErrorCodes.TIMEOUT to "OpenClaw sent nothing for 0 minutes; Rukoo closed the connection, which stops the run", result.error?.code to result.error?.detail)
    }

    @Test
    fun stopCancelsTheCall() = runBlocking {
        val first = slow("Working")
        server.enqueue(stream(first + chunk(" on it")).throttleBody(first.length.toLong(), 5, TimeUnit.SECONDS))
        val turn = RecordingTurn(conversation = Conversation(id = "c8", agent = "openclaw"))
        val job = async { adapter().runTurn(turn) }
        eventually { turn.text() == "Working" }
        val started = System.nanoTime()
        job.cancel()
        try {
            job.await()
            fail("cancelled")
        } catch (_: CancellationException) {
        }
        // Closing the connection is the stop; nothing waits for the throttled body.
        assertTrue((System.nanoTime() - started) / 1_000_000 < 2_000)
    }

    @Test
    fun statusChecksTheTokenTheEndpointAndTheAgent() = runBlocking {
        val a = adapter()
        server.enqueue(MockResponse().setBody("""{"object":"list","data":[{"id":"openclaw/default"},{"id":"openclaw/Mail"}]}"""))
        assertEquals(AgentStatus(AgentState.READY, "OpenClaw gateway, agent mail"), a.status(false))
        assertEquals("Bearer gw-token", server.takeRequest().getHeader("Authorization"))
        // Cached.
        assertEquals(AgentState.READY, a.status(false).state)
        assertEquals(1, server.requestCount)

        server.enqueue(MockResponse().setResponseCode(401))
        assertEquals(AgentStatus(AgentState.UNAUTHORIZED, "The gateway refused the token"), a.status(true))
        server.enqueue(MockResponse().setResponseCode(404))
        assertEquals(AgentState.UNKNOWN, a.status(true).state)
        server.enqueue(MockResponse().setResponseCode(502))
        assertEquals(AgentStatus(AgentState.OFFLINE, "HTTP 502"), a.status(true))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        assertEquals(AgentStatus(AgentState.UNKNOWN, "The server at this address is not an OpenClaw gateway"), a.status(true))
        server.enqueue(MockResponse().setBody("""{"data":[{"id":"openclaw/default"}]}"""))
        assertEquals(AgentStatus(AgentState.UNKNOWN, "The gateway has no agent \"mail\""), a.status(true))

        settings = settings.copy(token = "")
        assertEquals(AgentStatus(AgentState.UNCONFIGURED, "No gateway token"), a.status(false))
        settings = settings.copy(enabled = false)
        assertEquals(AgentStatus(AgentState.DISABLED, ""), a.status(false))
    }

    @Test
    fun modelsAndSkillsAreEmptyMenus() = runBlocking {
        settings = settings.copy(model = "gpt-6-luna")
        val m = adapter().models()
        assertEquals(emptyList<Any>(), m.models)
        assertEquals(emptyList<String>(), m.efforts)
        assertEquals("gpt-6-luna", m.defaultModel)
        assertEquals(emptyList<Any>(), adapter().skills())
        assertEquals(0, server.requestCount)
    }
}
