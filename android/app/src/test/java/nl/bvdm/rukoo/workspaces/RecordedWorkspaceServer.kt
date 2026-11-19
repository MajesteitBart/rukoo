package nl.bvdm.rukoo.workspaces

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import nl.bvdm.rukoo.core.RukooJson
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy

/**
 * The real server's recorded answers (src/test/resources/workspace/vectors.json, written by
 * src/test/workspace-fixtures/make-fixtures.js). Each exchange is one request and the answer the server gave it.
 */
object WorkspaceVectors {
    class Exchange(
        val name: String,
        val method: String,
        /** The path with its query; a cursor in a `/changes` path is `{cursor}`. */
        val path: String,
        /** Whose session made the call, by name: the tests send it as the bearer token. Null for none. */
        val auth: String?,
        /** Headers the call sent beyond the usual ones, such as another protocol version. */
        val requestHeaders: Map<String, String>,
        val requestBody: JsonElement?,
        val status: Int,
        val responseHeaders: Map<String, String>,
        /** With `{server}` where the server's address was. */
        val responseBody: JsonElement?,
    ) {
        /** The answer's body as an object, or null. */
        val body: JsonObject? get() = responseBody as? JsonObject

        /** The `error` code of a refusal. */
        val error: String? get() = (body?.get("error") as? JsonPrimitive)?.contentOrNull

        override fun toString() = "$name ($method $path → $status)"
    }

    private val root: JsonObject by lazy {
        val text = WorkspaceVectors::class.java.getResource("/workspace/vectors.json")?.readText()
            ?: error("src/test/resources/workspace/vectors.json is missing: run make-fixtures.js")
        RukooJson.parseToJsonElement(text).jsonObject
    }

    /** IDs from the recording, by the names make-fixtures.js gave them (workspace, general, mila, …). */
    val ids: Map<String, String> by lazy { root.getValue("ids").jsonObject.mapValues { (it.value as JsonPrimitive).content } }

    val exchanges: List<Exchange> by lazy {
        root.getValue("exchanges").jsonArray.map { e ->
            val o = e.jsonObject
            val req = o.getValue("request").jsonObject
            val res = o.getValue("response").jsonObject
            Exchange(
                name = (o.getValue("name") as JsonPrimitive).content,
                method = (req.getValue("method") as JsonPrimitive).content,
                path = (req.getValue("path") as JsonPrimitive).content,
                auth = (req["auth"] as? JsonPrimitive)?.contentOrNull,
                requestHeaders = strings(req["headers"]),
                requestBody = req["body"]?.takeIf { it !is JsonNull },
                status = (res.getValue("status") as JsonPrimitive).int,
                responseHeaders = strings(res["headers"]),
                responseBody = res["body"]?.takeIf { it !is JsonNull },
            )
        }
    }

    private fun strings(e: JsonElement?): Map<String, String> =
        (e as? JsonObject)?.mapValues { (it.value as JsonPrimitive).content }.orEmpty()

    fun exchange(name: String): Exchange = exchanges.firstOrNull { it.name == name } ?: error("No recorded exchange \"$name\"")

    fun id(name: String): String = ids[name] ?: error("No recorded id \"$name\"")
}

/**
 * A MockWebServer that answers with the real server's recorded answers, one named exchange at a time, in the order
 * a test queues them with [answer] (contract 8.6). Each request has to be the recorded one: method, path (any cursor
 * for `{cursor}`), body as JSON, `Authorization: Bearer <person>` and `Rukoo-Workspace-Version: 1`. Anything else, or a
 * request nothing was queued for, goes into [problems], which [verify] reports. A replay can't answer an ID or
 * cursor the client made up, so stateful sequences across rooms are the live tests' job.
 */
class RecordedWorkspaceServer : AutoCloseable {
    private class Planned(val exchange: WorkspaceVectors.Exchange?, val response: MockResponse)

    private val server = MockWebServer()
    private val queue = ArrayDeque<Planned>()
    private val lock = Any()

    /** Every request that came in, in order. */
    val requests = CopyOnWriteArrayList<RecordedRequest>()

    /** What didn't match the recording. */
    val problems = CopyOnWriteArrayList<String>()

    val url: String

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val next = synchronized(lock) { queue.removeFirstOrNull() }
                if (next == null) {
                    problems += "nothing was queued for ${request.method} ${request.path}"
                    return MockResponse().setResponseCode(500).setBody("""{"error":"server"}""")
                }
                next.exchange?.let { check(it, request) }
                return next.response
            }
        }
        server.start()
        url = "http://127.0.0.1:${server.port}"
    }

    /** The person whose session the next queued exchange was recorded with, for a client's session provider. */
    val nextAuth: String? get() = synchronized(lock) { queue.firstOrNull()?.exchange?.auth }

    /**
     * Queues the recorded exchange [name]. With [lost], the server takes the request and drops the connection
     * without answering (`DISCONNECT_AFTER_REQUEST`), as when an answer is lost on the way back.
     */
    fun answer(name: String, lost: Boolean = false): WorkspaceVectors.Exchange {
        val e = WorkspaceVectors.exchange(name)
        val response = if (lost) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) else response(e)
        synchronized(lock) { queue.addLast(Planned(e, response)) }
        return e
    }

    /** Queues an answer the real server can't be made to give, such as a redirect or an oversized body. */
    fun answerWith(response: MockResponse) {
        synchronized(lock) { queue.addLast(Planned(null, response)) }
    }

    fun takeRequest(): RecordedRequest = server.takeRequest(5, TimeUnit.SECONDS) ?: error("no request came")

    val requestCount: Int get() = server.requestCount

    /** Fails when a request didn't match its recording or a queued answer was never asked for. */
    fun verify() {
        val left = synchronized(lock) { queue.map { it.exchange?.name ?: "a custom answer" } }
        val all = problems + left.map { "never asked for: $it" }
        if (all.isNotEmpty()) throw AssertionError(all.joinToString("\n"))
    }

    override fun close() = server.shutdown()

    private fun response(e: WorkspaceVectors.Exchange): MockResponse {
        val res = MockResponse().setResponseCode(e.status)
        for ((k, v) in e.responseHeaders) res.setHeader(k, v)
        e.responseBody?.let { res.setHeader("Content-Type", "application/json").setBody(it.toString().replace("{server}", url)) }
        return res
    }

    private fun check(e: WorkspaceVectors.Exchange, request: RecordedRequest) {
        val path = request.path.orEmpty()
        if (request.method != e.method) problems += "${e.name}: method ${request.method}, recorded ${e.method}"
        if (!pathPattern(e.path).matches(path)) problems += "${e.name}: path $path, recorded ${e.path}"
        val auth = request.getHeader("Authorization")
        if (e.auth != null && auth != "Bearer ${e.auth}") problems += "${e.name}: Authorization $auth, recorded the session of ${e.auth}"
        // The one exchange recorded with another version can't be asked for by a phone that speaks version 1.
        val version = request.getHeader(OkHttpWorkspaceHttp.VERSION_HEADER)
        if (e.requestHeaders.isEmpty() && version != WORKSPACE_VERSION.toString()) problems += "${e.name}: ${OkHttpWorkspaceHttp.VERSION_HEADER} $version"
        // A copy, so a test can still read the body from [requests].
        val text = request.body.clone().readUtf8()
        val sent = text.takeIf { it.isNotEmpty() }?.let { runCatching { RukooJson.parseToJsonElement(it) }.getOrNull() ?: JsonPrimitive(it) }
        if (sent != e.requestBody) problems += "${e.name}: body $sent, recorded ${e.requestBody}"
    }

    private companion object {
        fun pathPattern(recorded: String): Regex =
            Regex(recorded.split("{cursor}").joinToString("[A-Za-z0-9_-]+") { Regex.escape(it) })
    }
}
