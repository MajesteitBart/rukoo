package nl.bvdm.rukoo.agents.adapters

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import nl.bvdm.rukoo.agents.AgentException
import nl.bvdm.rukoo.agents.ClarkSettings
import nl.bvdm.rukoo.agents.model.AdapterEvent
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.agents.model.TurnStatus
import nl.bvdm.rukoo.core.RukooJson
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class HermesAdapterTest {
    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val bodies = CopyOnWriteArrayList<Pair<String, String>>()

    /** path (without query) -> answers, one per call; the last one repeats. */
    private val routes = HashMap<String, MutableList<(RecordedRequest) -> MockResponse>>()

    private val scope = testScope()
    private val texts = XmlTexts()
    private var settings = ClarkSettings(name = "Clark", url = "", key = "secret-key")

    private val fast = HermesAdapter.Timing(backoff = 10, pollEvery = 20, pollMisses = 3, stopRetry = 50, stopWait = 300, errorBody = 500, silence = 2_000, connect = 2_000, submit = 2_000)

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests.add(request)
                val path = request.path!!.substringBefore('?')
                bodies.add("${request.method} $path" to request.body.readUtf8())
                val list = synchronized(routes) { routes["${request.method} $path"] } ?: return MockResponse().setResponseCode(404)
                val answer = synchronized(list) { if (list.size > 1) list.removeAt(0) else list[0] }
                return answer(request)
            }
        }
        server.start()
        settings = settings.copy(url = server.url("/").toString())
    }

    @After
    fun stop() {
        runCatching { server.shutdown() }
    }

    private fun on(route: String, vararg answers: (RecordedRequest) -> MockResponse) {
        synchronized(routes) { routes[route] = answers.toMutableList() }
    }

    private fun json(body: String, code: Int = 200) = { _: RecordedRequest -> MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body) }

    private fun sse(vararg frames: String) = { _: RecordedRequest ->
        MockResponse().setHeader("Content-Type", "text/event-stream").setBody(": keepalive\n\n" + frames.joinToString("") { "data: $it\n\n" })
    }

    private fun adapter(timing: HermesAdapter.Timing = fast) = HermesAdapter({ settings }, OkHttpClient(), scope, texts, timing = timing)

    private fun bodyOf(route: String): JsonObject = RukooJson.parseToJsonElement(bodies.first { it.first == route }.second).jsonObject

    private fun count(route: String) = bodies.count { it.first == route }

    private fun standardRun() {
        on("POST /api/sessions", json("""{"session":{"id":"s1"}}"""))
        on("POST /v1/runs", json("""{"run_id":"r1","status":"queued"}""", 202))
    }

    @Test
    fun aTurnCreatesASessionStartsARunAndStreamsItsEvents() = runBlocking {
        standardRun()
        on(
            "GET /v1/runs/r1/events",
            sse(
                """{"event":"message.delta","seq":1,"delta":"\n\nHello"}""",
                """{"event":"tool.started","seq":2,"tool":"terminal","preview":"ls <unsafe_content source=\"email\">x</unsafe_content>"}""",
                """{"event":"tool.completed","seq":3,"tool":"terminal"}""",
                """{"event":"message.interim","seq":4,"text":"  Checking.  "}""",
                """{"event":"subagent.start","seq":5,"subagent_id":"a1","goal":"Look it up"}""",
                """{"event":"subagent.complete","seq":6,"subagent_id":"a1","status":"failed"}""",
                """{"event":"message.delta","seq":7,"delta":" world"}""",
                """{"event":"reasoning.available","seq":8,"text":"ignored"}""",
                """{"event":"run.completed","seq":9,"output":"Hello world","usage":{"input_tokens":3}}""",
            ),
        )
        val turn = RecordingTurn(model = "openrouter::openai/gpt-6-astra", effort = "high")
        val result = withTimeout(10_000) { adapter().runTurn(turn) }
        assertEquals(TurnStatus.DONE, result.status)
        assertEquals(
            listOf(
                AdapterEvent.Text("Hello"),
                AdapterEvent.ToolStart("terminal#1", "terminal", "ls x"),
                AdapterEvent.ToolEnd("terminal#1", false, null),
                AdapterEvent.Commentary("Checking."),
                AdapterEvent.ToolStart("subagent:a1", "subagent", "Look it up"),
                AdapterEvent.ToolEnd("subagent:a1", true, null),
                AdapterEvent.Text("world"),
                AdapterEvent.Usage,
            ),
            turn.events.toList(),
        )
        assertEquals(listOf(mapOf("sessionId" to "s1")), turn.providers.toList())
        assertEquals(1, turn.accepted)
        assertEquals("Rukoo: Invoice", bodyOf("POST /api/sessions")["title"]!!.jsonPrimitive.content)
        val run = bodyOf("POST /v1/runs")
        assertEquals(turn.input, run["input"]!!.jsonPrimitive.content)
        assertEquals("s1", run["session_id"]!!.jsonPrimitive.content)
        assertEquals("INSTRUCTIONS", run["instructions"]!!.jsonPrimitive.content)
        assertEquals("openai/gpt-6-astra", run["model"]!!.jsonPrimitive.content)
        assertEquals("openrouter", run["provider"]!!.jsonPrimitive.content)
        assertEquals("""{"reasoning":{"effort":"high"}}""", run["model_options"].toString())
        val post = requests.first { it.path == "/v1/runs" }
        assertEquals("rukoo-t_abcdefghij", post.getHeader("Idempotency-Key"))
        assertEquals("Bearer secret-key", post.getHeader("Authorization"))
        assertEquals("text/event-stream", requests.first { it.path!!.endsWith("/events") }.getHeader("Accept"))
    }

    @Test
    fun theSettingsModelIsUsedAndUnknownEffortsAreNotSent() = runBlocking {
        settings = settings.copy(model = "quick")
        standardRun()
        on("GET /v1/runs/r1/events", sse("""{"event":"run.completed","seq":1,"output":""}"""))
        adapter().runTurn(RecordingTurn(effort = "ultra"))
        val run = bodyOf("POST /v1/runs")
        assertEquals("quick", run["model"]!!.jsonPrimitive.content)
        assertFalse("provider" in run)
        assertFalse("model_options" in run)
    }

    @Test
    fun aDroppedStreamResumesAfterTheLastSeqWithoutRepeats() = runBlocking {
        standardRun()
        on(
            "GET /v1/runs/r1/events",
            sse("""{"event":"message.delta","seq":1,"delta":"One "}""", """{"event":"message.delta","seq":2,"delta":"two "}"""),
            sse(
                """{"event":"message.delta","seq":2,"delta":"two "}""",
                """{"event":"message.delta","seq":3,"delta":"three"}""",
                """{"event":"run.completed","seq":4,"output":"One two three"}""",
            ),
        )
        val turn = RecordingTurn()
        val result = withTimeout(10_000) { adapter().runTurn(turn) }
        assertEquals(TurnStatus.DONE, result.status)
        assertEquals("One two three", turn.text())
        val resumed = requests.filter { it.path!!.startsWith("/v1/runs/r1/events") }[1]
        assertEquals("/v1/runs/r1/events?last_seq=2", resumed.path)
        assertEquals("2", resumed.getHeader("Last-Event-ID"))
    }

    @Test
    fun aMissingEndIsAddedFromTheFinalOutput() = runBlocking {
        standardRun()
        on("GET /v1/runs/r1/events", sse("""{"event":"message.delta","seq":1,"delta":"Hello"}""", """{"event":"run.completed","seq":2,"output":"Hello world"}"""))
        val turn = RecordingTurn()
        adapter().runTurn(turn)
        assertEquals("Hello world", turn.text())
    }

    @Test
    fun stopDuringAStalledErrorBodyIsNotHeldUp() = runBlocking {
        standardRun()
        val asked = CountDownLatch(1)
        val stopped = CountDownLatch(1)
        on("POST /v1/runs/r1/stop", { _ -> stopped.countDown(); MockResponse().setBody("{}") })
        on("GET /v1/runs/r1/events", { _ ->
            asked.countDown()
            // A 500 whose body stops half-way: reading it waits on the socket.
            MockResponse().setResponseCode(500).setBody("x".repeat(2_000)).throttleBody(1_000, 5, TimeUnit.SECONDS)
        })
        val job = async { adapter(fast.copy(errorBody = 4_000)).runTurn(RecordingTurn()) }
        // Suspending waits only: runBlocking's one thread also runs the turn.
        eventually { asked.count == 0L }
        kotlinx.coroutines.delay(300)
        assertTrue("the turn is reading the error body", job.isActive)
        val started = System.nanoTime()
        job.cancel()
        try {
            job.await()
            fail("cancelled")
        } catch (_: CancellationException) {
        }
        assertTrue((System.nanoTime() - started) / 1_000_000 < 1_500)
        assertTrue("stop was sent; requests: ${bodies.map { it.first }}", stopped.await(5, TimeUnit.SECONDS))
    }

    @Test
    fun aKeyTheServerEchoesIsRedacted() = runBlocking {
        on("POST /api/sessions", json("""{"session":{"id":"s1"}}"""))
        // JSON-escaped, so only the decoded text shows the key.
        on("POST /v1/runs", json("""{"error":"Rejected Bearer secret-key for this profile"}""", 400))
        val result = adapter().runTurn(RecordingTurn())
        assertEquals("HTTP 400: Rejected Bearer [redacted] for this profile", result.error?.detail)
        on("POST /v1/runs", json("""{"run_id":"r1"}""", 202))
        on(
            "GET /v1/runs/r1/events",
            sse("""{"event":"tool.started","seq":1,"tool":"terminal","preview":"curl -H 'Bearer secret-key'"}""", """{"event":"run.failed","seq":2,"error":"auth secret-key expired"}"""),
        )
        val turn = RecordingTurn()
        assertEquals("auth [redacted] expired", adapter().runTurn(turn).error?.detail)
        assertEquals("curl -H 'Bearer [redacted]'", turn.events.filterIsInstance<AdapterEvent.ToolStart>().single().detail)
        assertEquals("auth [redacted] expired", turn.events.filterIsInstance<AdapterEvent.Error>().single().detail)

        // Where the 200-character clip would cut the key in half.
        val long = "x".repeat(190)
        on("POST /v1/runs", json("""{"error":"${long}secret-key!"}""", 400))
        val clipped = adapter().runTurn(RecordingTurn()).error!!.detail
        assertFalse(clipped, clipped.contains("secret-k"))
        on("POST /v1/runs", json("""{"run_id":"r1"}""", 202))
        on("GET /v1/runs/r1/events", sse("""{"event":"tool.started","seq":1,"tool":"terminal","preview":"${long}secret-key"}""", """{"event":"run.cancelled","seq":2}"""))
        val previewed = RecordingTurn()
        adapter().runTurn(previewed)
        val preview = previewed.events.filterIsInstance<AdapterEvent.ToolStart>().single().detail
        assertFalse(preview, preview.contains("secret-k"))

        on("GET /v1/models", json("""{"error":"no models for secret-key"}""", 400))
        on("GET /api/model/options", json("{}", 500))
        try {
            adapter().models()
            fail("both lists failed")
        } catch (e: AgentException) {
            assertEquals("HTTP 400: no models for [redacted]", e.detail)
        }
    }

    @Test
    fun aKeyInsideProtocolDataIsLeftAlone() = runBlocking {
        // A short key that also occurs in the session and run ids: redaction must not touch what the adapter parses.
        settings = settings.copy(key = "r1")
        on("POST /api/sessions", json("""{"session":{"id":"sr1"}}"""))
        on("POST /v1/runs", json("""{"run_id":"r1"}""", 202))
        on("GET /v1/runs/r1/events", sse("""{"event":"message.delta","seq":1,"delta":"Fine"}""", """{"event":"run.completed","seq":2,"output":"Fine"}"""))
        val turn = RecordingTurn()
        assertEquals(TurnStatus.DONE, adapter().runTurn(turn).status)
        assertEquals("Fine", turn.text())
        assertEquals(mapOf("sessionId" to "sr1"), turn.providers.single())
        assertEquals("sr1", bodyOf("POST /v1/runs")["session_id"]!!.jsonPrimitive.content)
    }

    @Test
    fun aStreamLeftOpenAfterTheEndDoesNotHoldTheTurn() = runBlocking {
        standardRun()
        val end = "data: {\"event\":\"run.completed\",\"seq\":1,\"output\":\"ok\"}\n\n"
        on("GET /v1/runs/r1/events", { _ ->
            MockResponse().setHeader("Content-Type", "text/event-stream").setBody("$end: keepalive\n\n").throttleBody(end.length.toLong(), 5, TimeUnit.SECONDS)
        })
        val started = System.nanoTime()
        val turn = RecordingTurn()
        assertEquals(TurnStatus.DONE, withTimeout(10_000) { adapter().runTurn(turn) }.status)
        assertTrue((System.nanoTime() - started) / 1_000_000 < 3_000)
        assertEquals("ok", turn.text())
    }

    @Test
    fun aLostSessionStartsANewOneWithANoticeAndARecap() = runBlocking {
        on("GET /api/sessions/old%20one", json("""{"error":"not found"}""", 404))
        on("POST /api/sessions", json("""{"error":"title exists"}""", 400), json("""{"session":{"id":"s2"}}"""))
        on("POST /v1/runs", json("""{"run_id":"r1"}""", 202))
        on("GET /v1/runs/r1/events", sse("""{"event":"run.completed","seq":1,"output":"ok"}"""))
        val turn = RecordingTurn(conversation = Conversation(id = "c_mgx1_abc123", agent = "clark", title = "Invoice", provider = mapOf("sessionId" to "old one")))
        val result = adapter().runTurn(turn)
        assertEquals(TurnStatus.DONE, result.status)
        val titles = bodies.filter { it.first == "POST /api/sessions" }.map { RukooJson.parseToJsonElement(it.second).jsonObject["title"]?.jsonPrimitive?.content }
        assertEquals(listOf("Rukoo: Invoice", "Rukoo: Invoice (abc123)"), titles)
        assertEquals(mapOf("sessionId" to "s2"), turn.providers.single())
        assertEquals(AdapterEvent.Notice("Clark started a new session", Tone.INFO, "new-session"), turn.events.first())
        assertEquals(1, turn.startOvers)
        assertEquals("RECAP INPUT", bodyOf("POST /v1/runs")["input"]!!.jsonPrimitive.content)
    }

    @Test
    fun aKnownSessionIsReused() = runBlocking {
        on("GET /api/sessions/s9", json("""{"session":{"id":"s9"}}"""))
        on("POST /v1/runs", json("""{"run_id":"r1"}""", 202))
        on("GET /v1/runs/r1/events", sse("""{"event":"run.completed","seq":1,"output":""}"""))
        val turn = RecordingTurn(conversation = Conversation(id = "c1", agent = "clark", provider = mapOf("sessionId" to "s9")))
        adapter().runTurn(turn)
        assertEquals(0, count("POST /api/sessions"))
        assertEquals("s9", bodyOf("POST /v1/runs")["session_id"]!!.jsonPrimitive.content)
        assertTrue(turn.providers.isEmpty())
    }

    @Test
    fun anApprovalIsAskedAndAnswered() = runBlocking {
        standardRun()
        val answered = CountDownLatch(1)
        on("POST /v1/runs/r1/approval", { _ -> answered.countDown(); MockResponse().setBody("{}") })
        on(
            "GET /v1/runs/r1/events",
            sse("""{"event":"approval.request","seq":1,"request_id":"req1","choices":["once","session","always","deny"],"command":"td add x","description":"Add a task"}"""),
            { r ->
                // The run goes on once Hermes has the answer.
                answered.await(5, TimeUnit.SECONDS)
                sse("""{"event":"message.delta","seq":2,"delta":"Added."}""", """{"event":"run.completed","seq":3,"output":"Added."}""")(r)
            },
        )
        val turn = RecordingTurn(choose = { "session" })
        val result = withTimeout(10_000) { adapter().runTurn(turn) }
        assertEquals(TurnStatus.DONE, result.status)
        val card = turn.approvals.single()
        assertEquals("Clark wants to run a command", card.title)
        assertEquals("Add a task", card.detail)
        assertEquals("req1", card.key)
        assertEquals("clark", card.source)
        assertEquals("""{"choice":"session","request_id":"req1"}""", bodyOf("POST /v1/runs/r1/approval").toString())
        assertEquals("Added.", turn.text())
    }

    @Test
    fun anApprovalAnsweredElsewhereExpiresTheCard() = runBlocking {
        standardRun()
        on(
            "GET /v1/runs/r1/events",
            sse(
                """{"event":"approval.request","seq":1,"request_id":"req1","command":"x"}""",
                """{"event":"approval.responded","seq":2,"request_id":"req1"}""",
                """{"event":"run.completed","seq":3,"output":"done"}""",
            ),
        )
        val turn = RecordingTurn(choose = { awaitCancellation() })
        val result = withTimeout(10_000) { adapter().runTurn(turn) }
        assertEquals(TurnStatus.DONE, result.status)
        eventually { turn.expired.isNotEmpty() }
        assertEquals(listOf("req1"), turn.expired.toList())
        assertEquals(0, count("POST /v1/runs/r1/approval"))
    }

    @Test
    fun anAnswerThatDoesNotGetThroughStopsTheRun() = runBlocking {
        standardRun()
        val stopped = CountDownLatch(1)
        on("POST /v1/runs/r1/approval", json("""{"error":"bad choice"}""", 400))
        on("POST /v1/runs/r1/stop", { _ -> stopped.countDown(); MockResponse().setBody("{}") })
        on(
            "GET /v1/runs/r1/events",
            sse("""{"event":"approval.request","seq":1,"request_id":"req1","command":"x"}"""),
            { r ->
                stopped.await(5, TimeUnit.SECONDS)
                sse("""{"event":"run.cancelled","seq":2}""")(r)
            },
        )
        val turn = RecordingTurn(choose = { "once" })
        val result = withTimeout(10_000) { adapter().runTurn(turn) }
        assertEquals(TurnStatus.STOPPED, result.status)
        val error = turn.events.filterIsInstance<AdapterEvent.Error>().single()
        assertEquals(ErrorCodes.PROTOCOL, error.code)
        assertEquals("HTTP 400: bad choice. Your answer did not reach Hermes, so Rukoo is asking it to stop the run.", error.detail)
        assertEquals(1, count("POST /v1/runs/r1/approval"))
    }

    @Test
    fun cancellingTheTurnAsksHermesToStopTheRun() = runBlocking {
        standardRun()
        val stopped = CountDownLatch(1)
        on("POST /v1/runs/r1/stop", { _ -> stopped.countDown(); MockResponse().setBody("{}") })
        val first = "data: {\"event\":\"message.delta\",\"seq\":1,\"delta\":\"Working\"}\n\n"
        on("GET /v1/runs/r1/events", { _ ->
            // One delta, then the run works quietly for a long time.
            MockResponse().setHeader("Content-Type", "text/event-stream").setBody("$first: keepalive\n\n").throttleBody(first.length.toLong(), 5, TimeUnit.SECONDS)
        })
        val turn = RecordingTurn()
        val job = async { adapter().runTurn(turn) }
        eventually { turn.text() == "Working" }
        job.cancel()
        try {
            job.await()
            fail("the turn should be cancelled")
        } catch (_: CancellationException) {
        }
        assertTrue("stop was sent", stopped.await(5, TimeUnit.SECONDS))
    }

    @Test
    fun aGoneStreamIsFollowedByPollingAndTheOutputIsShown() = runBlocking {
        standardRun()
        on("GET /v1/runs/r1/events", json("""{"error":"no stream"}""", 404))
        on("GET /v1/runs/r1", json("""{"status":"running"}"""), json("""{"status":"waiting_for_approval"}"""), json("""{"status":"completed","output":"Final answer"}"""))
        val turn = RecordingTurn()
        val result = withTimeout(10_000) { adapter().runTurn(turn) }
        assertEquals(TurnStatus.DONE, result.status)
        assertEquals("Final answer", turn.text())
        assertEquals(3, count("GET /v1/runs/r1"))
    }

    @Test
    fun aServerThatStopsAnsweringIsAskedToStopAndTheTurnFails() = runBlocking {
        standardRun()
        on("GET /v1/runs/r1/events", json("{}", 404))
        on("GET /v1/runs/r1", json("{}", 502))
        on("POST /v1/runs/r1/stop", json("{}"))
        val result = withTimeout(10_000) { adapter().runTurn(RecordingTurn()) }
        assertEquals(TurnStatus.ERROR, result.status)
        assertEquals(ErrorCodes.OFFLINE, result.error?.code)
        assertEquals("Lost the connection to Clark during the turn; Rukoo stopped the run", result.error?.detail)
        assertEquals(1, count("POST /v1/runs/r1/stop"))
    }

    @Test
    fun aFailedRunEndsWithItsError() = runBlocking {
        standardRun()
        on("GET /v1/runs/r1/events", sse("""{"event":"tool.started","seq":1,"tool":"web"}""", """{"event":"run.failed","seq":2,"error":"Provider said 429: rate limit"}"""))
        val turn = RecordingTurn()
        val result = adapter().runTurn(turn)
        assertEquals(TurnStatus.ERROR, result.status)
        assertEquals(ErrorCodes.RATE_LIMITED, result.error?.code)
        // The open tool is closed first, then the error.
        assertEquals(listOf(AdapterEvent.ToolStart("web#1", "web", ""), AdapterEvent.ToolEnd("web#1", false), AdapterEvent.Error(ErrorCodes.RATE_LIMITED, "Provider said 429: rate limit")), turn.events.toList())
    }

    @Test
    fun aRunStartIsRetriedWithTheSameKeyButARateLimitIsNot() = runBlocking {
        on("POST /api/sessions", json("""{"session":{"id":"s1"}}"""))
        on("POST /v1/runs", json("""{"error":"busy"}""", 503), json("""{"run_id":"r1"}""", 202))
        on("GET /v1/runs/r1/events", sse("""{"event":"run.completed","seq":1,"output":""}"""))
        assertEquals(TurnStatus.DONE, adapter().runTurn(RecordingTurn()).status)
        val keys = requests.filter { it.path == "/v1/runs" }.map { it.getHeader("Idempotency-Key") }
        assertEquals(listOf("rukoo-t_abcdefghij", "rukoo-t_abcdefghij"), keys)

        requests.clear()
        bodies.clear()
        on("POST /v1/runs", json("""{"error":{"message":"Too many runs"}}""", 429))
        val limited = adapter().runTurn(RecordingTurn())
        assertEquals(ErrorCodes.RATE_LIMITED to "HTTP 429: Too many runs", limited.error?.code to limited.error?.detail)
        assertEquals(1, count("POST /v1/runs"))
    }

    @Test
    fun aRunWithoutAnIdIsAProtocolError() = runBlocking {
        on("POST /api/sessions", json("""{"session":{"id":"s1"}}"""))
        on("POST /v1/runs", json("""{"status":"queued"}""", 202))
        val result = adapter().runTurn(RecordingTurn())
        assertEquals(ErrorCodes.PROTOCOL to "The server did not return a run id", result.error?.code to result.error?.detail)
    }

    @Test
    fun skillMentionsGoAlongInTheRunUnlessTheHubAlreadyAddedThem() = runBlocking {
        standardRun()
        on("GET /v1/skills/meeting-prep", json("""{"name":"meeting-prep","body":"  Prepare the meeting.  "}"""))
        on("GET /v1/skills/missing", json("{}", 404))
        on("GET /v1/runs/r1/events", sse("""{"event":"run.completed","seq":1,"output":""}"""))
        adapter().runTurn(RecordingTurn(input = "INPUT", skills = listOf("meeting-prep", "missing")))
        assertEquals(
            "[The user invoked the \"meeting-prep\" skill, so they want you to follow its instructions. The full skill content is loaded below.]\n\nPrepare the meeting.\n\n" +
                "[The user invoked the \"missing\" skill, so they want you to follow its instructions. Load it with skill_view (name \"missing\") and follow it.]\n\nINPUT",
            bodyOf("POST /v1/runs")["input"]!!.jsonPrimitive.content,
        )

        bodies.clear()
        val inlined = adapter().skillBlocks(listOf("meeting-prep")).single() + "\n\nINPUT"
        bodies.clear()
        adapter().runTurn(RecordingTurn(input = inlined, skills = listOf("meeting-prep")))
        assertEquals(0, count("GET /v1/skills/meeting-prep"))
        assertEquals(inlined, bodyOf("POST /v1/runs")["input"]!!.jsonPrimitive.content)
    }

    @Test
    fun statusChecksHealthThenTheKeyAndIsCached() = runBlocking {
        on("GET /health", json("""{"status":"ok","version":"0.21.0"}"""))
        on("GET /v1/capabilities", json("""{"features":{"run_submission":true,"run_events_sse":true}}"""))
        val a = adapter()
        assertEquals(AgentState.READY to "Hermes 0.21.0", a.status(false).let { it.state to it.detail })
        assertEquals(AgentState.READY, a.status(false).state)
        assertEquals(1, count("GET /health"))
        assertEquals(null, requests.first { it.path == "/health" }.getHeader("Authorization"))
        a.status(true)
        assertEquals(2, count("GET /health"))

        on("GET /v1/capabilities", json("{}", 401))
        assertEquals(AgentStatus(AgentState.UNAUTHORIZED, "The server refused the API key"), a.status(true))
        on("GET /v1/capabilities", json("""{"features":{"run_submission":false}}"""))
        assertEquals(AgentStatus(AgentState.UNKNOWN, "This Hermes version has no Runs API"), a.status(true))
        on("GET /health", json("{}", 503))
        assertEquals(AgentStatus(AgentState.OFFLINE, "Health check answered HTTP 503"), a.status(true))
    }

    @Test
    fun statusWithoutSettingsSaysWhatIsMissing() = runBlocking {
        settings = ClarkSettings(name = "Clark")
        assertEquals(AgentStatus(AgentState.UNCONFIGURED, "No server URL"), adapter().status(false))
        settings = settings.copy(url = server.url("/").toString())
        assertEquals(AgentStatus(AgentState.UNCONFIGURED, "No API key"), adapter().status(false))
        settings = settings.copy(enabled = false)
        assertEquals(AgentStatus(AgentState.DISABLED, ""), adapter().status(false))
        val result = adapter().runTurn(RecordingTurn())
        assertEquals(ErrorCodes.DISABLED to "Clark is turned off", result.error?.code to result.error?.detail)
    }

    @Test
    fun anUnreachableServerIsOffline() = runBlocking {
        val url = server.url("/").toString()
        server.shutdown()
        settings = settings.copy(url = url)
        val status = adapter().status(true)
        assertEquals(AgentState.OFFLINE, status.state)
        val result = adapter().runTurn(RecordingTurn())
        assertEquals(ErrorCodes.OFFLINE, result.error?.code)
    }

    @Test
    fun modelsComeFromBothListsAndOneIsEnough() = runBlocking {
        on("GET /v1/models", json("""{"data":[{"id":"clark"},{"id":"quick","parent":"clark","root":"mistral/small-4"}]}"""))
        on("GET /api/model/options", json("""{"model":"m1","provider":"anthropic","providers":[{"slug":"anthropic","name":"Anthropic","models":["m1"]}]}"""))
        settings = settings.copy(model = "anthropic::m1")
        val options = adapter().models()
        assertEquals(listOf("anthropic::m1", "quick"), options.models.map { it.id })
        assertEquals("clark", options.agent)
        assertEquals("anthropic::m1", options.defaultModel)
        assertEquals("include_unconfigured=false", requests.first { it.path!!.startsWith("/api/model/options") }.requestUrl!!.query)

        on("GET /api/model/options", json("{}", 500))
        assertEquals(listOf("quick"), adapter().models().models.map { it.id })

        on("GET /v1/models", json("""{"error":"nope"}""", 401))
        try {
            adapter().models()
            fail("both lists failed")
        } catch (e: AgentException) {
            assertEquals(ErrorCodes.UNAUTHORIZED, e.code)
        }
    }

    @Test
    fun skillsAnswerEmptyOnOldServersAndDoNotHammerA500() = runBlocking {
        on("GET /v1/skills", json("""{"data":[{"name":"meeting-prep","description":"Prep","category":"productivity"}]}"""))
        val a = adapter()
        assertEquals(listOf("meeting-prep"), a.skills().map { it.name })
        on("GET /v1/skills", json("{}", 404))
        assertEquals(emptyList<Any>(), a.skills())
        on("GET /v1/skills", json("""{"error":"boom"}""", 500))
        repeat(3) {
            try {
                a.skills()
                fail("500")
            } catch (e: AgentException) {
                assertEquals(ErrorCodes.PROTOCOL, e.code)
            }
        }
        assertEquals(3, count("GET /v1/skills"))
    }
}
