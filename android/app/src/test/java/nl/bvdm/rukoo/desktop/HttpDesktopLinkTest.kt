package nl.bvdm.rukoo.desktop

import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import nl.bvdm.rukoo.agents.AgentSettingsStore
import nl.bvdm.rukoo.agents.PairedComputer
import nl.bvdm.rukoo.agents.model.AdapterEvent
import nl.bvdm.rukoo.agents.model.HostEvent
import nl.bvdm.rukoo.agents.model.TurnStatus
import nl.bvdm.rukoo.core.SecretCipher
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class HttpDesktopLinkTest {
    private lateinit var server: MockWebServer
    private lateinit var store: AgentSettingsStore
    private var now = 1_761_130_000_000L
    private lateinit var link: HttpDesktopLink

    private val plain = object : SecretCipher {
        override fun encrypt(plain: String) = plain
        override fun decrypt(blob: String) = blob
    }

    private val device = DeviceInfo(name = "Galaxy Z Fold7", model = "SM-F966B", appVersion = "0.1.0")

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val dir: File = Files.createTempDirectory("rukoo-desktop").toFile().apply { deleteOnExit() }
        store = AgentSettingsStore(File(dir, AgentSettingsStore.FILE_NAME), plain)
        link = HttpDesktopLink(store, OkHttpClient(), { device }, { now })
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private val address get() = "127.0.0.1:${server.port}"

    private fun json(status: Int, body: String, vararg headers: Pair<String, String>) =
        MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body).apply {
            for ((k, v) in headers) setHeader(k, v)
        }

    private fun pairAnswer(address: String = "127.0.0.1", port: Int = server.port, exportUntil: String = "1761130600000") =
        """{"pairingId":"ph_k3j9x0m2qa","token":"phone-token-123","desktop":{"name":"desktop-zolder","version":"1.4.0","platform":"win32","address":"$address","port":$port},"exportUntil":$exportUntil}"""

    private suspend fun paired(): PairedComputer {
        server.enqueue(json(200, pairAnswer()))
        val c = link.pair(address, "k7qm-2xpa")
        server.takeRequest()
        return c
    }

    private suspend fun failure(block: suspend () -> Unit): DesktopException {
        try {
            block()
        } catch (e: DesktopException) {
            return e
        }
        fail("expected a DesktopException")
        throw AssertionError()
    }

    // ---------- pair ----------

    @Test
    fun pairsAndStoresThePairing() = runBlocking {
        server.enqueue(json(200, pairAnswer()))
        val c = link.pair("http://$address", "k7qm-2xpa")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/phone/v1/pair", request.path)
        assertNull(request.getHeader("Authorization"))
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("K7QM-2XPA", body["code"]!!.jsonPrimitive.content)
        val sent = body["device"] as JsonObject
        assertEquals("Galaxy Z Fold7", sent["name"]!!.jsonPrimitive.content)
        assertEquals("android", sent["platform"]!!.jsonPrimitive.content)

        assertEquals("ph_k3j9x0m2qa", c.pairingId)
        assertEquals("desktop-zolder", c.name)
        assertEquals("127.0.0.1", c.address)
        assertEquals(server.port, c.port)
        assertEquals("phone-token-123", c.token)
        assertEquals(43, c.mcpToken.length)
        assertEquals(1_761_130_600_000L, c.exportUntil)
        assertEquals(now, c.lastSeenAt)
        assertEquals(listOf(c), store.current().computers)
    }

    @Test
    fun pairingKeepsTheTypedHostWhenTheComputerReportsNoAddress() = runBlocking {
        server.enqueue(json(200, pairAnswer(address = "", exportUntil = "null")))
        val c = link.pair("localhost:${server.port}", "K7QM2XPA")
        assertEquals("localhost", c.address)
        assertNull(c.exportUntil)
    }

    // The address that just worked is kept, except that a name gives way to the computer's Tailscale IP.
    @Test
    fun pairingKeepsATypedIpAddressWhateverTheComputerReports() = runBlocking {
        server.enqueue(json(200, pairAnswer(address = "100.71.32.55", port = 47800)))
        val c = link.pair("127.0.0.1:${server.port}", "K7QM-2XPA")
        assertEquals("127.0.0.1", c.address)
        assertEquals(server.port, c.port)
    }

    @Test
    fun pairingByNameStoresTheComputersTailscaleIp() = runBlocking {
        server.enqueue(json(200, pairAnswer(address = "100.71.32.55", port = 47800)))
        val c = link.pair("localhost:${server.port}", "K7QM-2XPA")
        assertEquals("100.71.32.55", c.address)
        assertEquals(47800, c.port)
    }

    @Test
    fun pairingByNameKeepsTheNameWhenTheComputerReportsAnAddressOutsideTheTailnet() = runBlocking {
        // A relay or NAT: the computer sees its own side of it, which the phone can't reach.
        server.enqueue(json(200, pairAnswer(address = "127.0.0.2", port = 47900)))
        val c = link.pair("localhost:${server.port}", "K7QM-2XPA")
        assertEquals("localhost", c.address)
        assertEquals(server.port, c.port)
    }

    @Test
    fun pairingTheSameComputerAgainReplacesTheOldPairing() = runBlocking {
        val first = paired()
        server.enqueue(json(200, pairAnswer().replace("ph_k3j9x0m2qa", "ph_aaaaaaaaaa").replace("phone-token-123", "second")))
        server.enqueue(json(200, """{"ok":true}"""))
        val second = link.pair(address, "K7QM-2XPA")
        server.takeRequest()
        // The old pairing is removed on the computer with its own token.
        val delete = server.takeRequest(2, TimeUnit.SECONDS)!!
        assertEquals("DELETE", delete.method)
        assertEquals("/phone/v1/pairing", delete.path)
        assertEquals("Bearer ${first.token}", delete.getHeader("Authorization"))
        assertEquals(listOf(second.pairingId), store.current().computers.map { it.pairingId })
        assertNotEquals(first.mcpToken, second.mcpToken)
    }

    @Test
    fun anotherComputerWithTheSameNameStaysPaired() = runBlocking {
        val first = paired()
        // Same host name, another address: a different computer, not a second pairing of the first.
        server.enqueue(json(200, pairAnswer(address = "localhost").replace("ph_k3j9x0m2qa", "ph_bbbbbbbbbb")))
        link.pair("localhost:${server.port}", "K7QM-2XPA")
        server.takeRequest()
        assertEquals(listOf(first.pairingId, "ph_bbbbbbbbbb"), store.current().computers.map { it.pairingId })
        assertNull(server.takeRequest(300, TimeUnit.MILLISECONDS))
    }

    @Test
    fun pairingFailuresCarryTheComputersCode() = runBlocking {
        val cases = listOf(
            json(401, """{"error":"wrong-code","detail":"That is not the code shown on the computer"}""") to DesktopErrors.WRONG_CODE,
            json(410, """{"error":"expired","detail":"Start pairing again"}""") to DesktopErrors.EXPIRED,
            json(409, """{"error":"full","detail":"20 phones"}""") to DesktopErrors.FULL,
            json(422, """{"error":"invalid","detail":"Send {code, device}"}""") to DesktopErrors.INVALID,
            json(404, """{"error":"not found"}""") to DesktopErrors.NOT_ENABLED,
            MockResponse().setResponseCode(404).setBody("<html>nope</html>") to DesktopErrors.NOT_ENABLED,
            json(200, """{"pairingId":"","token":""}""") to DesktopErrors.PROTOCOL,
            json(200, "not json") to DesktopErrors.PROTOCOL,
        )
        for ((response, code) in cases) {
            server.enqueue(response)
            val e = failure { link.pair(address, "K7QM-2XPA") }
            assertEquals(code, e.code)
        }
        assertTrue(store.current().computers.isEmpty())
    }

    @Test
    fun rateLimitedPairingSaysWhenToTryAgain() = runBlocking {
        server.enqueue(json(429, """{"error":"rate-limited","detail":"Too many tries. Wait a minute."}""", "Retry-After" to "42"))
        val e = failure { link.pair(address, "K7QM-2XPA") }
        assertEquals(DesktopErrors.RATE_LIMITED, e.code)
        assertEquals(429, e.status)
        assertEquals(42, e.retryAfterSeconds)
    }

    @Test
    fun badInputNeverReachesTheComputer() = runBlocking {
        assertEquals(DesktopErrors.INVALID_ADDRESS, failure { link.pair("https://x", "K7QM-2XPA") }.code)
        assertEquals(DesktopErrors.INVALID_CODE, failure { link.pair(address, "K7QM") }.code)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun anUnreachableComputerIsOffline() = runBlocking {
        server.shutdown()
        val e = failure { link.pair(address, "K7QM-2XPA") }
        assertEquals(DesktopErrors.OFFLINE, e.code)
        // The message names the failure, not the request.
        assertFalse("K7QM" in e.message.orEmpty())
    }

    // ---------- hello, export, forget ----------

    @Test
    fun helloSendsTheTokenAndKeepsTheExportWindow() = runBlocking {
        val c = paired()
        server.enqueue(
            json(
                200,
                """{"desktop":{"name":"desktop-zolder","version":"1.4.1"},"pairingId":"ph_k3j9x0m2qa","exportUntil":null,
                   "agents":{"claude":{"enabled":true,"state":"ready","detail":"","model":"opus","access":"ask"},
                             "codex":{"enabled":false,"state":"disabled","detail":"","model":"","access":"ask"}}}""",
            ),
        )
        now += 120_000
        val hello = link.hello(c.pairingId)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/phone/v1/hello", request.path)
        assertEquals("Bearer phone-token-123", request.getHeader("Authorization"))
        assertEquals("ready", hello.agents["claude"]!!.state)
        assertFalse(hello.agents["codex"]!!.enabled)
        val stored = store.current().computer(c.pairingId)!!
        assertNull(stored.exportUntil)
        assertEquals("1.4.1", stored.version)
        assertEquals(now, stored.lastSeenAt)
    }

    @Test
    fun aRemovedPhoneIsUnauthorized() = runBlocking {
        val c = paired()
        server.enqueue(json(401, """{"error":"unauthorized"}"""))
        assertEquals(DesktopErrors.UNAUTHORIZED, failure { link.hello(c.pairingId) }.code)
    }

    @Test
    fun anUnknownPairingIsRefusedHere() = runBlocking {
        assertEquals(DesktopErrors.UNKNOWN_COMPUTER, failure { link.hello("ph_nothere000") }.code)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun exportDecodesTheBundleAndClosesTheWindow() = runBlocking {
        val c = paired()
        server.enqueue(json(200, ExportFixtures.BUNDLE))
        val bundle = link.export(c.pairingId)
        assertEquals("/phone/v1/export", server.takeRequest().path)
        assertEquals(3, bundle.accounts.size)
        assertEquals("secret-pass", bundle.accounts[0].password)
        assertEquals("refresh-1", bundle.accounts[1].refreshToken)
        assertEquals("client-id.apps.googleusercontent.com", bundle.google!!.clientId)
        assertEquals("dark", bundle.settings.theme)
        assertEquals("hermes-key", bundle.agents.clark!!.key)
        assertNull(store.current().computer(c.pairingId)!!.exportUntil)
    }

    @Test
    fun aClosedExportSaysSo() = runBlocking {
        val c = paired()
        server.enqueue(json(403, """{"error":"export-closed","detail":"Open Settings > Agents > Phone on your computer and send your accounts again."}"""))
        val e = failure { link.export(c.pairingId) }
        assertEquals(DesktopErrors.EXPORT_CLOSED, e.code)
        assertNull(store.current().computer(c.pairingId)!!.exportUntil)
    }

    @Test
    fun forgetUnpairsOnTheComputerAndHere() = runBlocking {
        val c = paired()
        server.enqueue(json(200, """{"ok":true}"""))
        link.forget(c.pairingId)
        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/phone/v1/pairing", request.path)
        assertEquals("Bearer phone-token-123", request.getHeader("Authorization"))
        assertTrue(store.current().computers.isEmpty())
    }

    @Test
    fun forgetWorksWithoutTheComputer() = runBlocking {
        val c = paired()
        server.shutdown()
        link.forget(c.pairingId)
        assertTrue(store.current().computers.isEmpty())
    }

    // ---------- lists and turns ----------

    @Test
    fun modelsComeFromTheAgentsRoute() = runBlocking {
        val c = paired()
        server.enqueue(json(200, """{"agent":"claude","models":[{"id":"opus","label":"Opus","isDefault":true,"efforts":["low","high"],"defaultEffort":"high"}],"efforts":["low","high"],"custom":[],"defaultModel":"","error":null}"""))
        val models = link.models(c.pairingId, "claude", refresh = true)
        assertEquals("/phone/v1/agents/claude/models?refresh=1", server.takeRequest().path)
        assertEquals("opus", models.models.single().id)
        assertTrue(models.models.single().isDefault)
        assertEquals(DesktopErrors.INVALID, failure { link.models(c.pairingId, "hermes") }.code)
    }

    @Test
    fun aTurnStreamsItsLines() = runBlocking {
        val c = paired()
        val lines = listOf(
            """{"seq":1,"type":"started","turnId":"t_abcdefghijkl","conversationId":"c_m3x9a1_ab12cd","agent":"claude"}""",
            """{"type":"ping"}""",
            """{"seq":2,"type":"provider","patch":{"sessionId":"s-1"}}""",
            """{"seq":3,"type":"text","delta":"Hello"}""",
            "",
            """{"seq":4,"type":"some-future-event"}""",
            """{"seq":5,"type":"done","status":"done"}""",
        )
        server.enqueue(MockResponse().setHeader("Content-Type", "application/x-ndjson").setBody(lines.joinToString("\n", postfix = "\n")))
        val request = HostTurnRequest(
            agent = "claude",
            conversation = HostConversation("c_m3x9a1_ab12cd", "Re: invoice"),
            input = "input",
            text = "Summarize",
            firstTurn = true,
        )
        val got = link.startTurn(c.pairingId, request).toList()
        val sent = server.takeRequest()
        assertEquals("POST", sent.method)
        assertEquals("/phone/v1/turns", sent.path)
        assertEquals("Bearer phone-token-123", sent.getHeader("Authorization"))
        val body = Json.parseToJsonElement(sent.body.readUtf8()).jsonObject
        // Without an MCP address the phone sends no mcp, and the computer runs the agent without Rukoo's tools.
        assertFalse("mcp" in body)
        assertEquals("c_m3x9a1_ab12cd", (body["conversation"] as JsonObject)["id"]!!.jsonPrimitive.content)

        assertEquals(listOf(1L, null, 2L, 3L, 5L), got.map { it.seq })
        assertEquals("t_abcdefghijkl", (got[0].host as HostEvent.Started).turnId)
        assertEquals(HostEvent.Ping, got[1].host)
        assertEquals(mapOf("sessionId" to "s-1"), (got[2].host as HostEvent.Provider).patch)
        assertEquals("Hello", (got[3].event as AdapterEvent.Text).delta)
        assertEquals(TurnStatus.DONE, (got[4].host as HostEvent.Done).status)
    }

    // Seen live: a turn that went out on a connection the computer had just closed failed before it was sent, and
    // turns are never retried. Each turn now opens its own connection.
    @Test
    fun aTurnNeverReusesAPooledConnection() = runBlocking {
        val c = paired()
        server.enqueue(json(200, """{"desktop":{"name":"desktop-zolder","version":"1.4.0"},"pairingId":"${c.pairingId}","exportUntil":null,"agents":{}}"""))
        link.hello(c.pairingId)
        server.takeRequest()
        server.enqueue(MockResponse().setHeader("Content-Type", "application/x-ndjson").setBody("""{"seq":1,"type":"done","status":"done"}""" + "\n"))
        link.startTurn(c.pairingId, HostTurnRequest("claude", HostConversation("c_1"), "in", "t")).toList()
        // The first request on its connection, not one that hello's connection carried before.
        assertEquals(0, server.takeRequest().sequenceNumber)
    }

    @Test
    fun aRefusedTurnFailsTheFlow() = runBlocking {
        val c = paired()
        server.enqueue(json(409, """{"error":"busy","detail":"A turn of this chat is still running"}"""))
        val request = HostTurnRequest("codex", HostConversation("c_1"), "in", "text", mcp = HostMcp("http://100.64.0.3:47800/mcp", "mcp-token"))
        val e = failure { link.startTurn(c.pairingId, request).toList() }
        assertEquals(DesktopErrors.BUSY, e.code)
        val body = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("mcp-token", (body["mcp"] as JsonObject)["token"]!!.jsonPrimitive.content)
    }

    @Test
    fun aDroppedStreamEndsWithoutDone() = runBlocking {
        val c = paired()
        server.enqueue(
            MockResponse().setBody("""{"seq":1,"type":"started","turnId":"t_1"}""" + "\n" + """{"seq":2,"type":"text","delta":"Hel""")
                .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY),
        )
        val got = runCatching { link.startTurn(c.pairingId, HostTurnRequest("claude", HostConversation("c_1"), "in", "t")).toList() }
        // Either the first line arrived and the flow ended, or the drop surfaced as offline: never a done.
        got.exceptionOrNull()?.let { assertEquals(DesktopErrors.OFFLINE, (it as DesktopException).code) }
        assertTrue(got.getOrNull().orEmpty().none { it.host is HostEvent.Done })
    }

    @Test
    fun reattachAsksForWhatCameAfter() = runBlocking {
        val c = paired()
        server.enqueue(MockResponse().setBody("""{"type":"gap"}""" + "\n" + """{"seq":9,"type":"done","status":"stopped"}""" + "\n"))
        val got = link.reattach(c.pairingId, "t_abcdefghijkl", 7).toList()
        assertEquals("/phone/v1/turns/t_abcdefghijkl/events?after=7", server.takeRequest().path)
        assertEquals(HostEvent.Gap, got[0].host)
        assertEquals(TurnStatus.STOPPED, (got[1].host as HostEvent.Done).status)
    }

    @Test
    fun turnCallsUseTheirRoutes() = runBlocking {
        val c = paired()
        repeat(4) { server.enqueue(json(200, """{"ok":true}""")) }
        link.answerApproval(c.pairingId, "t_1", "a_2", "once")
        link.stopTurn(c.pairingId, "t_1")
        link.startOver(c.pairingId, "t_1", "r_3", "first turn again")
        link.forgetConversation(c.pairingId, "claude", "c_1")
        val approve = server.takeRequest()
        assertEquals("/phone/v1/turns/t_1/approvals/a_2", approve.path)
        assertEquals("""{"choice":"once"}""", approve.body.readUtf8())
        assertEquals("/phone/v1/turns/t_1/stop", server.takeRequest().path)
        val startOver = server.takeRequest()
        assertEquals("/phone/v1/turns/t_1/start-over/r_3", startOver.path)
        assertEquals("""{"input":"first turn again"}""", startOver.body.readUtf8())
        val forget = server.takeRequest()
        assertEquals("/phone/v1/conversations/forget", forget.path)
        assertEquals("""{"agent":"claude","conversationId":"c_1"}""", forget.body.readUtf8())
    }

    @Test
    fun stoppingAFinishedTurnIsFine() = runBlocking {
        val c = paired()
        server.enqueue(json(404, """{"error":"not-found","detail":"No such turn"}"""))
        link.stopTurn(c.pairingId, "t_gone")
    }

    @Test
    fun idsThatCouldLeaveTheRouteAreRefused() = runBlocking {
        val c = paired()
        assertEquals(DesktopErrors.INVALID, failure { link.answerApproval(c.pairingId, "../hello", "a_1", "once") }.code)
        assertEquals(DesktopErrors.INVALID, failure { link.stopTurn(c.pairingId, "t_1?x=1") }.code)
    }
}
