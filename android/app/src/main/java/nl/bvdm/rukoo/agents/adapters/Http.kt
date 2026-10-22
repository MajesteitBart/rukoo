package nl.bvdm.rukoo.agents.adapters

// The HTTP plumbing of the agents the phone reaches itself, Hermes and an OpenClaw gateway: a port of desktop's
// src/main/agents/http.js. Both servers sit on a Tailscale address, so plain OkHttp, no public-only filter.
// Requests only ever go to the configured server and never follow redirects.

import java.io.IOException
import java.io.InterruptedIOException
import java.security.MessageDigest
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.AgentException
import nl.bvdm.rukoo.agents.TurnHandle
import nl.bvdm.rukoo.agents.TurnResult
import nl.bvdm.rukoo.agents.model.AdapterEvent
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.core.RukooJson
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer

/** How long connecting to a server, or a short request to it, may take (http.js CONNECT_TIMEOUT). */
internal const val CONNECT_TIMEOUT = 8_000L

private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

/** Desktop's adapter clip (proc.js): longer than [max] ends in an ellipsis within the limit. */
internal fun clip(text: String?, max: Int): String {
    val s = text ?: ""
    return if (s.length > max) s.take(max - 1) + "…" else s
}

internal fun sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

/** What a failed request says about itself: the exception's message, or its kind. */
internal fun describe(e: Throwable): String = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName

/** A server URL with an optional path prefix (Hermes serves profiles under /p/<name>/). */
internal class ServerBase private constructor(private val root: HttpUrl, val prefix: String, val host: String) {
    /** The URL of [path] (which may carry a `?query`) under the prefix, on the same origin. */
    fun endpoint(path: String): HttpUrl {
        val q = path.indexOf('?')
        val p = if (q < 0) path else path.substring(0, q)
        return root.newBuilder().encodedPath(prefix + p).encodedQuery(if (q < 0) null else path.substring(q + 1)).build()
    }

    companion object {
        /**
         * Desktop's serverBase, plus dudan's normalization: an address without a scheme gets http://, and a
         * trailing /v1 goes, since the paths below add it. Throws `not-configured` for a URL that isn't one.
         */
        fun parse(raw: String, texts: AdapterTexts): ServerBase {
            var url = raw.trim()
            if (url.isNotEmpty() && !url.contains("://")) url = "http://$url"
            val scheme = url.substringBefore("://", "").lowercase()
            if (url.isNotEmpty() && scheme != "http" && scheme != "https") {
                throw AgentException(ErrorCodes.NOT_CONFIGURED, texts.get(R.string.adapters_url_scheme))
            }
            val parsed = url.toHttpUrlOrNull()
            if (parsed == null || parsed.username.isNotEmpty() || parsed.password.isNotEmpty()) {
                throw AgentException(ErrorCodes.NOT_CONFIGURED, texts.get(R.string.adapters_url_invalid))
            }
            var prefix = parsed.encodedPath.trimEnd('/')
            if (prefix.endsWith("/v1")) prefix = prefix.removeSuffix("/v1").trimEnd('/')
            val host = if (parsed.port == HttpUrl.defaultPort(parsed.scheme)) parsed.host else "${parsed.host}:${parsed.port}"
            val root = parsed.newBuilder().encodedPath("/").query(null).fragment(null).build()
            return ServerBase(root, prefix, host)
        }
    }
}

/** A server's answer: the status and the body, parsed as JSON when it is JSON, else as a JSON string of the text. */
internal data class HttpAnswer(
    val status: Int,
    val data: JsonElement?,
    /** The key or token of the request, so error texts drop it before they are clipped. */
    val secret: String? = null,
) {
    val ok: Boolean get() = status in 200..299

    val obj: JsonObject? get() = data as? JsonObject

    companion object {
        fun of(status: Int, text: String, secret: String? = null): HttpAnswer = HttpAnswer(status, parseBody(text), secret)

        /** JSON.parse or the text itself, as desktop reads a body. A bare word such as `starting` is text, not JSON. */
        fun parseBody(text: String): JsonElement? {
            if (text.isEmpty()) return null
            val parsed = runCatching { RukooJson.parseToJsonElement(text) }.getOrNull() ?: return JsonPrimitive(text)
            if (parsed is JsonPrimitive && !parsed.isString && parsed !is kotlinx.serialization.json.JsonNull) {
                val t = text.trim()
                if (t != "true" && t != "false" && t.toDoubleOrNull() == null) return JsonPrimitive(text)
            }
            return parsed
        }
    }
}

/**
 * The error text in a server's answer (http.js errorText), at most 200 characters. [secret] goes before the text is
 * clipped: a cut could otherwise leave most of it standing.
 */
internal fun errorText(data: JsonElement?, secret: String? = null): String {
    if (data == null) return ""
    if (data is JsonPrimitive) return if (data.isString) clipSafe(data.content.trim(), secret, 200) else ""
    val o = data as? JsonObject ?: return ""
    val e = o["error"]
    val fromError = (e as? JsonObject)?.str("message")?.takeIf { it.isNotEmpty() } ?: (e as? JsonPrimitive)?.takeIf { it.isString }?.content
    return clipSafe(fromError?.takeIf { it.isNotEmpty() } ?: o.str("message")?.takeIf { it.isNotEmpty() } ?: o.str("detail").orEmpty(), secret, 200)
}

/** [clip] of server text without [secret]: redacted first, so the cut can't leave part of it standing. */
internal fun clipSafe(text: String?, secret: String?, max: Int): String = clip(redact(text ?: "", secret), max)

/** http.js httpError: 401/403 unauthorized, 429 rate-limited, the rest protocol, with `HTTP <status>: <text>`. */
internal fun httpError(answer: HttpAnswer): AgentException {
    val text = errorText(answer.data, answer.secret)
    val detail = "HTTP ${answer.status}${if (text.isNotEmpty()) ": $text" else ""}"
    val code = when (answer.status) {
        401, 403 -> ErrorCodes.UNAUTHORIZED
        429 -> ErrorCodes.RATE_LIMITED
        else -> ErrorCodes.PROTOCOL
    }
    return AgentException(code, detail)
}

/** A connection that failed: no route, refused, reset, or our own deadline (http.js networkError). */
internal fun networkError(e: IOException, host: String, timeoutMs: Long, texts: AdapterTexts): AgentException =
    if (e is InterruptedIOException) {
        AgentException(ErrorCodes.OFFLINE, texts.get(R.string.adapters_no_answer, host, (timeoutMs / 1000).toInt()))
    } else {
        AgentException(ErrorCodes.OFFLINE, clip(describe(e), 200))
    }

/** An OkHttp client for these servers: no redirects, and timeouts per call. */
internal fun OkHttpClient.forAgents(): OkHttpClient = newBuilder().followRedirects(false).followSslRedirects(false).build()

internal fun jsonBody(body: JsonElement) = body.toString().toRequestBody(JSON_MEDIA)

/**
 * Runs [call] and reads its whole body, within [timeoutMs] for everything. The body is read on OkHttp's
 * thread before the answer comes back, so cancelling the coroutine cancels the call at any point.
 */
internal suspend fun Call.readAll(timeoutMs: Long): Pair<Int, String> {
    timeout().timeout(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
    return suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { runCatching { cancel() } }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                val result = try {
                    response.use { it.code to (it.body?.string() ?: "") }
                } catch (e: IOException) {
                    if (cont.isActive) cont.resumeWithException(e)
                    return
                }
                if (cont.isActive) cont.resume(result)
            }
        })
    }
}

/** Thrown when the headers of a stream didn't come within its connect deadline. */
internal class HeadersTimeout : InterruptedIOException("timeout")

/**
 * Runs [call] until the response headers arrive; only that part has a deadline ([deadlineMs], 0 for none),
 * the body can then stream as long as it takes. The caller owns (and closes) the response.
 */
internal suspend fun Call.awaitHeaders(deadlineMs: Long): Response = coroutineScope {
    var timedOut = false
    val timer = if (deadlineMs > 0) {
        launch {
            delay(deadlineMs)
            timedOut = true
            cancel()
        }
    } else {
        null
    }
    try {
        suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { runCatching { cancel() } }
            enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (cont.isActive) cont.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    // A caller cancelled while the answer arrived: nobody else would close it.
                    cont.resume(response) { _, value, _ -> value.close() }
                }
            })
        }
    } catch (e: IOException) {
        if (timedOut) throw HeadersTimeout()
        throw e
    } finally {
        timer?.cancel()
    }
}

/**
 * At most [limit] bytes of a failed response's body, for at most [ms] (http.js readCapped): an error text is
 * short, and a server that answers 5xx and then trickles its body must not hold the turn.
 */
internal suspend fun readCapped(call: Call, response: Response, ms: Long, limit: Long = 8192): String = coroutineScope {
    val out = Buffer()
    val timer = launch {
        delay(ms)
        call.cancel()
    }
    // The reader owns the response and closes it: closed from here while it reads, the read would fail with an
    // IllegalStateException, which would then replace the cancellation as the reason this scope ended.
    // Atomic: a Stop before the reader runs must still reach its finally, which closes the response.
    val reader = async(Dispatchers.IO, start = CoroutineStart.ATOMIC) {
        try {
            val source = response.body?.source()
            while (source != null && out.size < limit) {
                if (source.read(out, limit - out.size) == -1L) break
            }
        } catch (_: Exception) {
            // A body that broke off, or a read the deadline or Stop cancelled: what came is enough for an error text.
        } finally {
            runCatching { response.close() }
        }
    }
    try {
        reader.await()
    } catch (e: CancellationException) {
        // A blocking read doesn't notice cancellation; cancelling the call ends it, so Stop isn't held up.
        call.cancel()
        throw e
    } finally {
        timer.cancel()
    }
    out.readUtf8(minOf(out.size, limit))
}

/**
 * Text without the connection's [secret]: a server whose error or event echoes the key or token must not carry it
 * into a notice, a status or a log. Applied to what an adapter hands out, after parsing, never to the protocol data
 * it parses: the secret may well appear in a field name or an id there.
 */
internal fun redact(text: String, secret: String?): String =
    if (secret.isNullOrEmpty() || !text.contains(secret)) text else text.replace(secret, "[redacted]")

internal fun AgentException.redacted(secret: String?): AgentException {
    val clean = redact(detail, secret)
    return if (clean == detail) this else AgentException(code, clean)
}

internal fun TurnResult.redacted(secret: String?): TurnResult = error?.let { copy(error = it.copy(detail = redact(it.detail, secret))) } ?: this

internal fun AgentStatus.redacted(secret: String?): AgentStatus = copy(detail = redact(detail, secret))

/** The texts of an event the user sees. The answer's own text deltas pass as the agent wrote them. */
internal fun AdapterEvent.redacted(secret: String?): AdapterEvent = when (this) {
    is AdapterEvent.Error -> copy(detail = redact(detail, secret))
    is AdapterEvent.Notice -> copy(text = redact(text, secret))
    is AdapterEvent.Commentary -> copy(text = redact(text, secret))
    is AdapterEvent.ToolStart -> copy(detail = redact(detail, secret))
    is AdapterEvent.ToolEnd -> copy(detail = detail?.let { redact(it, secret) })
    else -> this
}

/** The turn as the adapter's own code sees it, with every emitted event redacted. */
internal fun TurnHandle.redacting(secret: String?): TurnHandle {
    if (secret.isNullOrEmpty()) return this
    val inner = this
    return object : TurnHandle by inner {
        override fun emit(event: AdapterEvent) = inner.emit(event.redacted(secret))
    }
}

/** A short JSON request to a configured server; a request body when [body] isn't null. */
internal suspend fun OkHttpClient.jsonRequest(
    method: String,
    base: ServerBase,
    path: String,
    texts: AdapterTexts,
    bearer: String? = null,
    body: JsonElement? = null,
    headers: Map<String, String> = emptyMap(),
    timeoutMs: Long = CONNECT_TIMEOUT,
): HttpAnswer {
    val request = Request.Builder().url(base.endpoint(path)).header("Accept", "application/json").apply {
        if (bearer != null) header("Authorization", "Bearer $bearer")
        headers.forEach { (k, v) -> header(k, v) }
        method(method, body?.let { jsonBody(it) } ?: if (method == "POST") jsonBody(JsonObject(emptyMap())) else null)
    }.build()
    val (status, text) = try {
        newCall(request).readAll(timeoutMs)
    } catch (e: CancellationException) {
        throw e
    } catch (e: IOException) {
        throw networkError(e, base.host, timeoutMs, texts)
    }
    return HttpAnswer.of(status, text, bearer)
}

// Tolerant JSON reading: servers send loosely typed payloads, so read by hand (as dudan's HermesModels does).

/** A string member, or null when it is missing or not a string. */
internal fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** A number member (JS `typeof x === 'number'`), or null. */
internal fun JsonObject.num(key: String): Double? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull

internal fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }

internal fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

/** JavaScript truthiness of a member: present, not null, false, 0 or "". */
internal fun JsonElement?.truthy(): Boolean = when (this) {
    null -> false
    is JsonPrimitive -> when {
        isString -> content.isNotEmpty()
        contentOrNull == null -> false
        booleanOrNull != null -> booleanOrNull == true
        doubleOrNull != null -> doubleOrNull != 0.0
        else -> true
    }
    else -> true
}
