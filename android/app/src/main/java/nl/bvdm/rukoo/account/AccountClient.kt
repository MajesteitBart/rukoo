package nl.bvdm.rukoo.account

import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import nl.bvdm.rukoo.core.RukooJson
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * A failed account call. [code] is the server's `error` code (server/PROTOCOL.md, HTTP API) or one of the phone's
 * own ([AccountError.CODES]); the UI turns it into words. [status] is the HTTP status, 0 when there was none.
 */
class AccountError(val code: String, val status: Int = 0, message: String? = null) : Exception(message ?: code) {
    companion object {
        /** The codes Rukoo has words for (account.errors.* on desktop); any other reads as `server`. */
        val CODES = setOf(
            "invalid", "unauthorized", "locked", "rate_limited", "exists", "signups_closed", "invite_required", "quota", "too_large",
            "not_configured", "network", "server", "invalid_email", "weak_password", "recovery_key", "weak_kdf", "no_server", "protocol",
            "signed_in", "signed_out", "wrong_password",
            // Only the phone has a limit on how heavy a password hash may be.
            "heavy_kdf",
        )

        fun known(code: String?): String = if (code != null && code in CODES) code else "server"
    }
}

/**
 * One call to an account server: the JSON it answered (null for an empty body), or an [AccountError]. Each byte of the
 * answer's body is added to [meter], so a caller can bound a run of calls by what they downloaded rather than by the
 * parts it reads.
 */
fun interface AccountHttp {
    suspend fun request(server: String, method: String, path: String, body: JsonElement?, token: String?, meter: AtomicLong?): JsonElement?
}

/**
 * Where the account server may be. https only; plain http only for a server on this machine or the emulator's
 * host (10.0.2.2) when [devHosts] is on, which debug builds and tests turn on.
 */
object AccountServers {
    private val LOCAL = setOf("localhost", "127.0.0.1", "[::1]", "::1", "10.0.2.2")

    /** The server's base URL without a trailing slash, or null when it isn't one Rukoo may talk to. */
    fun serverUrl(text: String?, devHosts: Boolean): String? {
        val raw = text.orEmpty().trim()
        val url = raw.toHttpUrlOrNull() ?: return null
        // OkHttp reads only http and https; anything else (ftp:, a bare word) never parses.
        val scheme = raw.substringBefore("://", "").lowercase()
        if (scheme != url.scheme) return null
        val host = url.host.lowercase()
        if (url.scheme != "https" && !(url.scheme == "http" && devHosts && host in LOCAL)) return null
        if (url.username.isNotEmpty() || url.password.isNotEmpty() || url.encodedQuery != null || url.encodedFragment != null) return null
        // A query or fragment written but empty still counts as one, as desktop's URL parsing sees it.
        if (raw.contains('?') || raw.contains('#')) return null
        val defaultPort = if (url.scheme == "https") 443 else 80
        val origin = "${url.scheme}://${if (host.contains(':')) "[$host]" else host}${if (url.port != defaultPort) ":${url.port}" else ""}"
        return origin + url.encodedPath.trimEnd('/')
    }
}

/**
 * The account server over OkHttp: 20-second connect, read and write timeouts and a 40-second call timeout, no
 * redirects, no compression, at most 32 MiB of response body. HTTP framing isn't counted or capped (see #123).
 */
class OkHttpAccountHttp(base: OkHttpClient) : AccountHttp {
    private val client = base.newBuilder()
        .connectTimeout(TIMEOUT_S, TimeUnit.SECONDS)
        .readTimeout(TIMEOUT_S, TimeUnit.SECONDS)
        .writeTimeout(TIMEOUT_S, TimeUnit.SECONDS)
        .callTimeout(2 * TIMEOUT_S, TimeUnit.SECONDS)
        // A redirect could take the session to another address, or from https to http.
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    // The answer is read off the main thread: OkHttp hands over the headers, and the body still has to come.
    override suspend fun request(server: String, method: String, path: String, body: JsonElement?, token: String?, meter: AtomicLong?): JsonElement? =
        withContext(Dispatchers.IO) { send(server, method, path, body, token, meter) }

    private suspend fun send(server: String, method: String, path: String, body: JsonElement?, token: String?, meter: AtomicLong?): JsonElement? {
        val url = (server + path).toHttpUrlOrNull() ?: throw AccountError("no_server")
        // OkHttp wants a body on every POST; logout has nothing to say, so it sends an empty one.
        val payload = body?.let { RukooJson.encodeToString(JsonElement.serializer(), it).toRequestBody(JSON) }
            ?: if (method == "POST") ByteArray(0).toRequestBody(JSON) else null
        val request = Request.Builder().url(url).header("Accept", "application/json")
            // Answers come as they were sent, so the meter counts the body that was downloaded. Without this header OkHttp
            // asks for gzip and unpacks it first, and a few bytes of JSON can come with megabytes of padding in a gzip
            // header.
            .header("Accept-Encoding", "identity")
            .apply { if (token != null) header("Authorization", "Bearer $token") }
            .method(method, payload)
            .build()
        val response = try {
            client.newCall(request).await()
        } catch (e: IOException) {
            throw AccountError("network", 0, e.message)
        }
        response.use { res ->
            // An answer compressed anyway can't be read, so it isn't downloaded either.
            val encodings = res.headers("Content-Encoding").flatMap { it.split(',') }.map { it.trim() }
            if (encodings.any { it.isNotEmpty() && !it.equals("identity", ignoreCase = true) }) throw AccountError("server", res.code)
            val text = try {
                val source = res.body?.source()
                if (source == null) {
                    ""
                } else {
                    source.request(MAX_BYTES + 1)
                    // The body only: OkHttp doesn't report the bytes of HTTP framing around it, such as chunk extensions,
                    // which desktop counts. Those are bounded by the call timeout, not by bytes.
                    meter?.addAndGet(source.buffer.size)
                    if (source.buffer.size > MAX_BYTES) throw AccountError("too_large", res.code)
                    source.buffer.readUtf8()
                }
            } catch (e: IOException) {
                throw AccountError("network", 0, e.message)
            }
            val json = text.takeIf { it.isNotEmpty() }?.let { runCatching { RukooJson.parseToJsonElement(it) }.getOrNull() }
            if (res.code in 200..299) return json
            val error = json as? JsonObject
            val code = (error?.get("error") as? JsonPrimitive)?.takeIf { it.isString }?.content
            val message = (error?.get("message") as? JsonPrimitive)?.takeIf { it.isString }?.content
            throw AccountError(code ?: "server", res.code, message)
        }
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
        enqueue(
            object : Callback {
                // A response that comes after the caller went away is closed, so its connection isn't held.
                override fun onResponse(call: Call, response: Response) = cont.resume(response) { _, value, _ -> value.close() }

                override fun onFailure(call: Call, e: IOException) {
                    if (!cont.isCancelled) cont.resumeWithException(e)
                }
            },
        )
        cont.invokeOnCancellation { runCatching { cancel() } }
    }

    private companion object {
        const val TIMEOUT_S = 20L
        const val MAX_BYTES = 32L * 1024 * 1024
        val JSON = "application/json".toMediaType()
    }
}
