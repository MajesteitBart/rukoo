package nl.bvdm.rukoo.mcp

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.InetAddress
import java.net.Socket
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.agents.ToolIdentity
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The request pipeline over real sockets: desktop's checks in desktop's order and status codes (spec 2 §1.3). */
class McpHttpServerTest {
    private val key = "hermes-key"
    private val token = McpTokens.clark(key)
    private var secrets = AuthSecrets(toolsOn = true, clarkKey = key)
    private var accepts = true
    private var listFails = false
    private val callers = java.util.concurrent.CopyOnWriteArrayList<McpCaller>()
    private lateinit var server: McpHttpServer
    private val port get() = server.localPort

    private val backend = object : McpBackend {
        override fun listTools(): JsonArray = if (listFails) error("boom") else JsonArray(emptyList())
        override suspend fun callTool(identity: ToolIdentity, name: String, args: JsonObject, meta: JsonObject) = buildJsonObject { put("agent", identity.agent) }
        override fun skillInstructions(room: Int) = ""
        override fun identity(caller: McpCaller, meta: JsonObject?) = ToolIdentity("clark")
        override fun owns(identity: ToolIdentity, conversationId: String) = false
        override fun idleSeconds(): Long? = 0
    }

    private val policy = object : EndpointPolicy {
        override fun accepts(local: InetAddress) = accepts
        override fun hosts(local: InetAddress, port: Int) = listOf("127.0.0.1:$port", "localhost:$port")
        override fun endpoint(local: InetAddress, localPort: Int, host: String) = "${local.hostAddress}:$localPort"
    }

    @Before
    fun start() {
        server = McpHttpServer(0, policy, McpAuth { secrets }, McpHandler(backend, "1.2.3", { "test-phone" }), requestTimeoutMs = 5_000, onCaller = { callers += it })
        server.start()
    }

    @After
    fun stop() = server.stop()

    private class Reply(val status: Int, val headers: Map<String, String>, val body: String) {
        val json: JsonObject get() = Json.parseToJsonElement(body).jsonObject
    }

    private fun request(
        body: String? = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}",
        method: String = "POST",
        path: String = "/mcp",
        host: String? = "127.0.0.1:$port",
        headers: Map<String, String> = mapOf("Authorization" to "Bearer $token"),
        socket: Socket? = null,
    ): Reply {
        val s = socket ?: Socket("127.0.0.1", port).apply { soTimeout = 5_000 }
        val bytes = body?.toByteArray(Charsets.UTF_8)
        val head = buildString {
            append("$method $path HTTP/1.1\r\n")
            if (host != null) append("Host: $host\r\n")
            headers.forEach { (k, v) -> append("$k: $v\r\n") }
            if (bytes != null) append("Content-Type: application/json\r\nContent-Length: ${bytes.size}\r\n")
            append("\r\n")
        }
        s.getOutputStream().write(head.toByteArray(Charsets.ISO_8859_1))
        if (bytes != null) s.getOutputStream().write(bytes)
        s.getOutputStream().flush()
        val reply = read(s.getInputStream(), head = method == "HEAD")
        if (socket == null) s.close()
        return reply
    }

    private fun read(input: InputStream, head: Boolean = false): Reply {
        val buffer = ByteArrayOutputStream()
        while (!buffer.toString(Charsets.ISO_8859_1.name()).endsWith("\r\n\r\n")) {
            val b = input.read()
            if (b == -1) error("connection closed")
            buffer.write(b)
        }
        val lines = buffer.toString(Charsets.ISO_8859_1.name()).trimEnd().split("\r\n")
        val status = lines[0].split(' ')[1].toInt()
        val headers = lines.drop(1).associate { it.substringBefore(':').lowercase() to it.substringAfter(':').trim() }
        val length = if (head) 0 else headers["content-length"]?.toInt() ?: 0
        val body = ByteArray(length)
        var read = 0
        while (read < length) read += input.read(body, read, length - read).also { if (it == -1) error("short body") }
        return Reply(status, headers, String(body, Charsets.UTF_8))
    }

    @Test
    fun answersAPing() {
        val r = request()
        assertEquals(200, r.status)
        assertEquals("application/json", r.headers["content-type"])
        assertEquals("no-store", r.headers["cache-control"])
        assertEquals("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}", r.body)
    }

    @Test
    fun refusesInDesktopsOrder() {
        // 1. Origin, whatever else is wrong.
        assertEquals(403, request(headers = mapOf("Origin" to "https://evil.example", "Authorization" to "Bearer $token")).status)
        assertEquals(403, request(method = "GET", path = "/x", host = "evil:1", headers = mapOf("Origin" to "x"), body = null).status)
        // 2. Host: a name that isn't this server's, one without the port, or none.
        assertEquals("{\"error\":\"forbidden\"}", request(host = "evil.example:$port").body)
        assertEquals(403, request(host = "127.0.0.1").status)
        assertEquals(403, request(host = null).status)
        assertEquals(403, request(host = "evil:1", path = "/x").status)
        assertEquals(200, request(host = "LOCALHOST:$port").status)
        // 3. Path, before the method.
        val notFound = request(path = "/other", method = "GET", body = null)
        assertEquals(404, notFound.status)
        assertEquals("{\"error\":\"not found\"}", notFound.body)
        assertEquals(200, request(path = "/mcp?session=1").status)
        // 4. Method, before the token.
        val get = request(method = "GET", body = null, headers = emptyMap())
        assertEquals(405, get.status)
        assertEquals("POST", get.headers["allow"])
        assertEquals("{\"error\":\"method not allowed\"}", get.body)
        // 5. Token.
        val noToken = request(headers = emptyMap())
        assertEquals(401, noToken.status)
        assertEquals("{\"error\":\"unauthorized\"}", noToken.body)
        assertNull(noToken.headers["x-rukoo-proof"])
        assertNull(noToken.headers["x-rukoo-bridge-protocol"])
        assertEquals(401, request(headers = mapOf("Authorization" to "Bearer wrong")).status)
        assertEquals(401, request(headers = mapOf("Authorization" to token)).status)
        assertEquals(200, request(headers = mapOf("Authorization" to "bearer   $token  ")).status)
    }

    @Test
    fun provesToTheBridge() {
        val challenge = "c1Ue5Xq0bWm2yNnR8PaVtG3o_kLs7d9Z"
        val r = request(headers = mapOf("X-Rukoo-Challenge" to challenge), body = "{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"ping\"}")
        assertEquals(401, r.status)
        assertEquals("{\"error\":\"unauthorized\"}", r.body)
        assertEquals(McpTokens.proof(token, "127.0.0.1:$port", challenge), r.headers["x-rukoo-proof"])
        // With the protocol the proof follows, as desktop sends it, so the bridge can tell another version from another key.
        assertEquals("2", r.headers["x-rukoo-bridge-protocol"])
        // Also with a wrong token present.
        assertEquals(r.headers["x-rukoo-proof"], request(headers = mapOf("X-Rukoo-Challenge" to challenge, "Authorization" to "Bearer nope")).headers["x-rukoo-proof"])
        // A challenge out of form gets no proof, and no protocol.
        val short = request(headers = mapOf("X-Rukoo-Challenge" to "short"))
        assertNull(short.headers["x-rukoo-proof"])
        assertNull(short.headers["x-rukoo-bridge-protocol"])
        // No Hermes key, or phone tools off: the literal none, so the bridge knows this Rukoo has another key.
        secrets = AuthSecrets(toolsOn = true)
        val keyless = request(headers = mapOf("X-Rukoo-Challenge" to challenge))
        assertEquals("none", keyless.headers["x-rukoo-proof"])
        assertEquals("2", keyless.headers["x-rukoo-bridge-protocol"])
        secrets = AuthSecrets(toolsOn = false, clarkKey = key)
        assertEquals("none", request(headers = mapOf("X-Rukoo-Challenge" to challenge)).headers["x-rukoo-proof"])
    }

    /** One bridge serves the phone and desktop, so all three name the same bridge protocol. */
    @Test
    fun bridgeProtocolMatchesDesktopAndTheBridge() {
        val repo = listOf(File("../.."), File("..")).first { File(it, "src/main/agents/mcp.js").exists() }
        val desktop = Regex("""const BRIDGE_PROTOCOL = (\d+);""").find(File(repo, "src/main/agents/mcp.js").readText())
        val bridge = Regex("""(?m)^BRIDGE_PROTOCOL = (\d+)$""").find(File(repo, "integrations/hermes/rukoo_bridge.py").readText())
        assertEquals(McpHttpServer.BRIDGE_PROTOCOL.toString(), desktop?.groupValues?.get(1))
        assertEquals(McpHttpServer.BRIDGE_PROTOCOL.toString(), bridge?.groupValues?.get(1))
    }

    @Test
    fun answersRefusalsOnlyAfterTheBodyAndKeepsTheConnection() {
        Socket("127.0.0.1", port).use { s ->
            s.soTimeout = 5_000
            val body = "{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"ping\"}".toByteArray()
            s.getOutputStream().write("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nContent-Length: ${body.size}\r\n\r\n".toByteArray())
            s.getOutputStream().flush()
            // Nothing comes back until the body is there.
            s.soTimeout = 400
            val early = runCatching { s.getInputStream().read() }
            assertTrue(early.isFailure)
            s.soTimeout = 5_000
            s.getOutputStream().write(body)
            s.getOutputStream().flush()
            assertEquals(401, read(s.getInputStream()).status)
            // The drained connection serves the next request.
            assertEquals(200, request(socket = s).status)
        }
    }

    @Test
    fun handlesSizesAndShapes() {
        // Notification: 202 with no body.
        val note = request(body = "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}")
        assertEquals(202, note.status)
        assertEquals("0", note.headers["content-length"])
        // "id": null is a request.
        assertEquals("{\"jsonrpc\":\"2.0\",\"id\":null,\"result\":{}}", request(body = "{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"ping\"}").body)
        val parse = request(body = "{not json")
        assertEquals(400, parse.status)
        assertEquals("{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":\"Parse error\"}}", parse.body)
        val batch = request(body = "[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}]")
        assertEquals(400, batch.status)
        assertEquals("{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32600,\"message\":\"Batch requests are not supported\"}}", batch.body)
        // Over 2 MiB: read, dropped, 413 and the connection closes.
        val big = "{\"x\":\"" + "a".repeat(McpHttpServer.MAX_BODY) + "\"}"
        val tooBig = request(body = big)
        assertEquals(413, tooBig.status)
        assertEquals("close", tooBig.headers["connection"]?.lowercase())
        assertEquals("{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32600,\"message\":\"Request body too large\"}}", tooBig.body)
        // Just under the cap is fine (a 100,000-character draft fits easily).
        assertEquals(200, request(body = "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\",\"pad\":\"" + "b".repeat(1_900_000) + "\"}").status)
        // dispatch throwing: 500 with the request's id.
        listFails = true
        val failed = request(body = "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/list\"}")
        assertEquals(500, failed.status)
        assertEquals("{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":{\"code\":-32603,\"message\":\"Internal error\"}}", failed.body)
    }

    @Test
    fun answersAnAbsurdBodyAtOnce() {
        Socket("127.0.0.1", port).use { s ->
            s.soTimeout = 5_000
            s.getOutputStream().write(
                "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nAuthorization: Bearer $token\r\nContent-Length: ${65L * 1024 * 1024}\r\n\r\n".toByteArray(),
            )
            s.getOutputStream().flush()
            val r = read(s.getInputStream())
            assertEquals(413, r.status)
            assertEquals("close", r.headers["connection"]?.lowercase())
        }
    }

    @Test
    fun readsChunkedBodies() {
        Socket("127.0.0.1", port).use { s ->
            s.soTimeout = 5_000
            val body = "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}"
            val chunks = "10\r\n${body.substring(0, 16)}\r\n${Integer.toHexString(body.length - 16)}\r\n${body.substring(16)}\r\n0\r\n\r\n"
            s.getOutputStream().write(
                "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nAuthorization: Bearer $token\r\nTransfer-Encoding: chunked\r\n\r\n$chunks".toByteArray(),
            )
            s.getOutputStream().flush()
            val r = read(s.getInputStream())
            assertEquals(200, r.status)
            assertEquals("{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{}}", r.body)
        }
    }

    @Test
    fun answersHeadWithoutABody() {
        val r = request(method = "HEAD", body = null)
        assertEquals(405, r.status)
        assertEquals("POST", r.headers["allow"])
    }

    @Test
    fun dropsConnectionsOnOtherAddresses() {
        accepts = false
        Socket("127.0.0.1", port).use { s ->
            s.soTimeout = 5_000
            s.getOutputStream().write("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nContent-Length: 0\r\n\r\n".toByteArray())
            assertEquals(-1, runCatching { s.getInputStream().read() }.getOrDefault(-1))
        }
    }

    @Test
    fun servesToolCallsFromTheHandler() {
        val r = request(body = "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"method\":\"tools/call\",\"params\":{\"name\":\"get_context\"}}")
        assertEquals(200, r.status)
        assertEquals("clark", r.json["result"]!!.jsonObject["agent"]!!.jsonPrimitive.content)
    }

    @Test
    fun tellsWhoGotIn() {
        // The bridge's probe and a wrong token got nowhere; only a request that got in counts.
        request(headers = mapOf("X-Rukoo-Challenge" to "c1Ue5Xq0bWm2yNnR8PaVtG3o_kLs7d9Z"))
        request(headers = mapOf("Authorization" to "Bearer wrong"))
        assertEquals(emptyList<McpCaller>(), callers.toList())
        request()
        assertEquals(listOf<McpCaller>(McpCaller.Clark), callers.toList())
    }
}
