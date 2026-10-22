package nl.bvdm.rukoo.mcp

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import nl.bvdm.rukoo.core.RukooJson

/**
 * Which connections and Host names count as this phone. The server listens on every interface and asks per
 * connection, so a Tailscale reconnect or a new address needs no rebind.
 */
interface EndpointPolicy {
    /** Whether a connection that arrived on [local] may be served at all: this phone's Tailscale address. */
    fun accepts(local: InetAddress): Boolean

    /** The Host header values that name this server for a connection on [local] (lower case, `name:port`). */
    fun hosts(local: InetAddress, port: Int): Collection<String>

    /** The address a proof covers: where the connection arrived. [host] is the request's Host header. */
    fun endpoint(local: InetAddress, localPort: Int, host: String): String
}

/**
 * Rukoo's MCP endpoint on the phone: stateless Streamable HTTP with plain JSON responses, `POST /mcp` only, like
 * desktop's mcp.js. The socket handling is a port of dudan's device/McpHttpServer.kt (same author); the checks
 * are desktop's, in desktop's order (spec 2 §1.3): Origin, Host, path, method, token, size, JSON, batch.
 *
 * Every refusal goes out after the request body is read: answering mid-body closes the socket while the rest
 * still arrives, and the reset can reach the client before the answer does (the bridge's probes send their body
 * after the headers).
 */
class McpHttpServer(
    private val port: Int,
    private val policy: EndpointPolicy,
    private val auth: McpAuth,
    private val handler: McpHandler,
    private val log: (String, Throwable?) -> Unit = { _, _ -> },
    private val requestTimeoutMs: Int = REQUEST_TIMEOUT_MS,
) {
    private val slots = Semaphore(MAX_CONNECTIONS)
    private val workers: ExecutorService = Executors.newCachedThreadPool { r -> Thread(r, "rukoo-mcp").apply { isDaemon = true } }
    private val clients: MutableSet<Socket> = ConcurrentHashMap.newKeySet()

    @Volatile private var socket: ServerSocket? = null

    /** The port it listens on, which differs from the requested one when that was 0. */
    val localPort: Int get() = socket?.localPort ?: -1

    /** Binds every interface; throws [IOException] (a `BindException` when the port is taken). */
    fun start() {
        val server = ServerSocket()
        server.reuseAddress = true
        try {
            server.bind(InetSocketAddress(port))
        } catch (e: IOException) {
            runCatching { server.close() }
            throw e
        }
        socket = server
        thread(name = "rukoo-mcp-accept", isDaemon = true) { acceptLoop(server) }
    }

    /** Stops listening and closes open connections; blocked reads don't notice an interrupt. */
    fun stop() {
        runCatching { socket?.close() }
        clients.forEach { runCatching { it.close() } }
        workers.shutdownNow()
    }

    private fun acceptLoop(server: ServerSocket) {
        while (!server.isClosed) {
            val client = try {
                server.accept()
            } catch (_: IOException) {
                break
            }
            val allowed = runCatching { policy.accepts(client.localAddress) }.getOrDefault(false)
            if (!allowed || !slots.tryAcquire()) {
                runCatching { client.close() }
                continue
            }
            try {
                workers.execute {
                    // An uncaught exception on this thread would take the whole app down.
                    try {
                        serve(client)
                    } catch (e: Exception) {
                        log("connection failed", e)
                    } catch (_: StackOverflowError) {
                    } finally {
                        slots.release()
                    }
                }
            } catch (_: Exception) {
                slots.release()
                runCatching { client.close() }
            }
        }
    }

    private fun serve(client: Socket) = client.use {
        clients += client
        try {
            val input = BufferedInputStream(client.getInputStream())
            val output = BufferedOutputStream(client.getOutputStream())
            while (true) {
                val head = try {
                    readHead(client, input) ?: return
                } catch (_: BadRequest) {
                    runCatching { write(output, Response(400, close = true), head = false) }
                    return
                } catch (_: IOException) {
                    return // idle, too slow, or the client went away
                }
                val keep = try {
                    handle(client, head, input, output)
                } catch (_: BadRequest) {
                    runCatching { write(output, Response(400, close = true), head = false) }
                    false
                } catch (_: IOException) {
                    false
                }
                if (!keep) return
            }
        } finally {
            clients -= client
        }
    }

    /** Answers one request; false when the connection must close afterwards. */
    private fun handle(client: Socket, req: Head, input: InputStream, output: OutputStream): Boolean {
        val isHead = req.method == "HEAD"
        val refusal = refusal(client, req)
        val caller = if (refusal == null) auth.identify(bearer(req.headers["authorization"])) else null
        val refused = refusal ?: if (caller == null) unauthorized(client, req) else null
        // A body nobody would send on purpose: no point reading it.
        if (req.declared > MAX_ABSURD) {
            write(output, (refused ?: tooLarge()).copy(close = true), isHead)
            return false
        }
        if (refused != null) {
            readBody(input, req, keep = 0)
            write(output, refused, isHead)
            return !req.close
        }
        // Too big: read the rest and drop it, then answer and close.
        val body = readBody(input, req, keep = MAX_BODY) ?: run {
            write(output, tooLarge(), isHead)
            return false
        }
        val msg: JsonElement = try {
            RukooJson.parseToJsonElement(body.toString(Charsets.UTF_8))
        } catch (_: Exception) {
            write(output, json(400, McpHandler.rpcError(null, -32700, "Parse error")), isHead)
            return !req.close
        }
        // Batches are not part of the 2025-06-18+ transport.
        if (msg is JsonArray) {
            write(output, json(400, McpHandler.rpcError(null, -32600, "Batch requests are not supported")), isHead)
            return !req.close
        }
        val response = try {
            val out = runBlocking { handler.dispatch(caller!!, msg) }
            if (out == null) json(202, null) else json(200, out)
        } catch (e: Exception) {
            log("mcp dispatch failed", e)
            json(500, McpHandler.rpcError((msg as? JsonObject)?.get("id"), -32603, "Internal error"))
        }
        write(output, response, isHead)
        return !req.close
    }

    // Checks 1-4 of desktop's handle(): Origin, Host, path, method.
    private fun refusal(client: Socket, req: Head): Response? {
        // Browsers send Origin on cross-site requests; agents don't. Refusing it keeps web pages out.
        if (req.headers.containsKey("origin")) return json(403, ERROR_FORBIDDEN)
        // DNS-rebinding guard: a page can point a name at this address, but it cannot fake the Host header.
        val host = req.headers["host"].orEmpty().lowercase()
        val allowed = runCatching { policy.hosts(client.localAddress, localPort) }.getOrDefault(emptyList())
        if (host.isEmpty() || allowed.none { it.lowercase() == host }) return json(403, ERROR_FORBIDDEN)
        if (req.path.substringBefore('?') != "/mcp") return json(404, ERROR_NOT_FOUND)
        if (req.method != "POST") return json(405, ERROR_METHOD, mapOf("Allow" to "POST"))
        return null
    }

    // Clark's bridge asks before it sends its token: Rukoo proves it has the same key, or says it has none.
    private fun unauthorized(client: Socket, req: Head): Response {
        val challenge = req.headers["x-rukoo-challenge"].orEmpty()
        if (!CHALLENGE.matches(challenge)) return json(401, ERROR_UNAUTHORIZED)
        // The address from the socket, not from a header: the one the bridge connected to if nothing relayed it.
        val endpoint = runCatching { policy.endpoint(client.localAddress, client.localPort, req.headers["host"].orEmpty()) }.getOrDefault("")
        val proof = runCatching { auth.proof(challenge, endpoint) }.getOrDefault("").ifEmpty { "none" }
        return json(401, ERROR_UNAUTHORIZED, mapOf("X-Rukoo-Proof" to proof))
    }

    private fun tooLarge() = json(413, McpHandler.rpcError(null, -32600, "Request body too large")).copy(close = true)

    private data class Head(
        val method: String,
        val path: String,
        val version: String,
        val headers: Map<String, String>,
        val chunked: Boolean,
        val declared: Long,
        val deadline: Long,
    ) {
        val close: Boolean
            get() {
                val c = headers["connection"].orEmpty().lowercase()
                return c.contains("close") || (version == "HTTP/1.0" && !c.contains("keep-alive"))
            }
    }

    private data class Response(
        val status: Int,
        val body: ByteArray? = null,
        val headers: Map<String, String> = emptyMap(),
        val close: Boolean = false,
    )

    private class BadRequest : IOException()

    private fun json(status: Int, body: JsonElement?, extra: Map<String, String> = emptyMap()): Response =
        Response(status, body?.let { RukooJson.encodeToString(JsonElement.serializer(), it).toByteArray(Charsets.UTF_8) } ?: ByteArray(0), extra)

    /** Null on a clean end of stream between requests. */
    private fun readHead(client: Socket, input: InputStream): Head? {
        client.soTimeout = IDLE_TIMEOUT_MS
        val first = input.read()
        if (first == -1) return null
        // From its first byte on, a request must arrive whole in time, so a slow sender can't hold a slot.
        client.soTimeout = requestTimeoutMs
        val deadline = System.nanoTime() + requestTimeoutMs * 1_000_000L
        val text = readUntilBlankLine(input, first, deadline)
        val lines = text.split("\r\n")
        val parts = lines.first().split(' ')
        if (parts.size != 3 || !parts[2].startsWith("HTTP/1.")) throw BadRequest()
        val headers = LinkedHashMap<String, String>()
        for (line in lines.drop(1)) {
            if (line.isEmpty()) continue
            val colon = line.indexOf(':').takeIf { it > 0 } ?: throw BadRequest()
            val name = line.substring(0, colon).trim().lowercase()
            val value = line.substring(colon + 1).trim()
            // Repeated headers join with a comma, as HTTP allows; a second Content-Length must agree.
            headers[name] = headers[name]?.let { if (name == "content-length") (if (it != value) throw BadRequest() else it) else "$it, $value" } ?: value
        }
        val te = headers["transfer-encoding"]?.lowercase()
        val chunked = te != null && te.split(',').map { it.trim() }.lastOrNull() == "chunked"
        if (te != null && !chunked) throw BadRequest()
        val declared = if (chunked) 0L else headers["content-length"]?.let { it.toLongOrNull()?.takeIf { n -> n >= 0 } ?: throw BadRequest() } ?: 0L
        return Head(parts[0].uppercase(), parts[1], parts[2], headers, chunked, declared, deadline)
    }

    private fun readUntilBlankLine(input: InputStream, first: Int, deadline: Long): String {
        val buffer = ByteArrayOutputStream()
        var matched = 0
        var b = first
        while (true) {
            if (b == -1) throw EOFException()
            buffer.write(b)
            if (buffer.size() > MAX_HEAD_BYTES) throw BadRequest()
            matched = when {
                b == HEAD_END[matched].toInt() -> matched + 1
                b == '\r'.code -> 1
                else -> 0
            }
            if (matched == HEAD_END.size) return buffer.toString(Charsets.ISO_8859_1.name()).removeSuffix("\r\n\r\n")
            checkDeadline(deadline)
            b = input.read()
        }
    }

    /**
     * Reads the whole body, keeping at most [keep] bytes. Null when it was longer than that (the rest was read
     * and dropped); with keep 0 it only drains.
     */
    private fun readBody(input: InputStream, req: Head, keep: Int): ByteArray? {
        val out = ByteArrayOutputStream()
        var total = 0L
        var tooBig = false
        val chunk = ByteArray(16 * 1024)
        fun take(n: Long) {
            var left = n
            while (left > 0) {
                checkDeadline(req.deadline)
                val r = input.read(chunk, 0, minOf(chunk.size.toLong(), left).toInt())
                if (r == -1) throw EOFException()
                left -= r
                total += r
                if (total > MAX_ABSURD) throw BadRequest()
                if (!tooBig && total > keep) tooBig = true
                if (!tooBig) out.write(chunk, 0, r)
            }
        }
        if (!req.chunked) {
            take(req.declared)
        } else {
            while (true) {
                val sizeLine = readLine(input, req.deadline)
                val size = sizeLine.substringBefore(';').trim().toLongOrNull(16)?.takeIf { it >= 0 } ?: throw BadRequest()
                if (size == 0L) {
                    // Trailers, up to the blank line.
                    while (readLine(input, req.deadline).isNotEmpty()) Unit
                    break
                }
                take(size)
                if (readLine(input, req.deadline).isNotEmpty()) throw BadRequest()
            }
        }
        if (keep == 0) return ByteArray(0)
        return if (tooBig) null else out.toByteArray()
    }

    private fun readLine(input: InputStream, deadline: Long): String {
        val buffer = ByteArrayOutputStream()
        while (true) {
            checkDeadline(deadline)
            val b = input.read()
            if (b == -1) throw EOFException()
            if (b == '\n'.code) return buffer.toString(Charsets.ISO_8859_1.name()).removeSuffix("\r")
            buffer.write(b)
            if (buffer.size() > MAX_HEAD_BYTES) throw BadRequest()
        }
    }

    private fun checkDeadline(deadline: Long) {
        if (System.nanoTime() > deadline) throw SocketTimeoutException("Request took too long")
    }

    private fun write(output: OutputStream, response: Response, head: Boolean) {
        val body = response.body ?: ByteArray(0)
        val text = buildString {
            append("HTTP/1.1 ${response.status} ${REASONS[response.status] ?: "Status"}\r\n")
            append("Content-Type: application/json\r\n")
            if (!head) {
                append("Cache-Control: no-store\r\n")
                append("Content-Length: ${body.size}\r\n")
            }
            response.headers.forEach { (name, value) -> append("$name: $value\r\n") }
            if (response.close) append("Connection: close\r\n")
            append("\r\n")
        }
        output.write(text.toByteArray(Charsets.ISO_8859_1))
        if (!head) output.write(body)
        output.flush()
    }

    companion object {
        const val MAX_BODY = 2 * 1024 * 1024
        const val MAX_ABSURD = 64L * 1024 * 1024
        private const val MAX_CONNECTIONS = 16
        private const val IDLE_TIMEOUT_MS = 30_000
        // Head and body together; a 2 MiB write_draft over mobile data needs more than dudan's 10 s.
        private const val REQUEST_TIMEOUT_MS = 60_000
        private const val MAX_HEAD_BYTES = 16 * 1024
        private val HEAD_END = "\r\n\r\n".toByteArray(Charsets.ISO_8859_1)
        val CHALLENGE = Regex("^[A-Za-z0-9_-]{16,128}$")
        private val BEARER = Regex("^Bearer\\s+(\\S+)\\s*$", RegexOption.IGNORE_CASE)

        private val ERROR_FORBIDDEN = JsonObject(mapOf("error" to JsonPrimitive("forbidden")))
        private val ERROR_NOT_FOUND = JsonObject(mapOf("error" to JsonPrimitive("not found")))
        private val ERROR_METHOD = JsonObject(mapOf("error" to JsonPrimitive("method not allowed")))
        private val ERROR_UNAUTHORIZED = JsonObject(mapOf("error" to JsonPrimitive("unauthorized")))

        private val REASONS = mapOf(
            200 to "OK", 202 to "Accepted", 400 to "Bad Request", 401 to "Unauthorized", 403 to "Forbidden",
            404 to "Not Found", 405 to "Method Not Allowed", 413 to "Payload Too Large", 500 to "Internal Server Error",
        )

        /** desktop bearer() (mcp.js:39-42): one token after a case-insensitive scheme, or "". */
        fun bearer(header: String?): String = header?.let { BEARER.find(it)?.groupValues?.get(1) }.orEmpty()
    }
}
