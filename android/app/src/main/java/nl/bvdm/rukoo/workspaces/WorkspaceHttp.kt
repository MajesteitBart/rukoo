package nl.bvdm.rukoo.workspaces

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import nl.bvdm.rukoo.core.RukooJson
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink

/** A workspace route's answer: its status, 2xx only, and its JSON body, or null when it had none (a 204). */
class WorkspaceAnswer(val status: Int, val body: JsonElement?)

/**
 * One call to a workspace route on [server] with the session's [token] (android.md "HTTP"). A 2xx answer comes back;
 * anything else throws [WorkspaceError]: the server's refusal decoded by [WorkspaceError.fromAnswer], `network` when
 * no answer came, and `server` for an answer the phone can't read. [path] starts with `/v1/`.
 */
fun interface WorkspaceHttp {
    suspend fun request(server: String, method: String, path: String, body: JsonElement?, token: String): WorkspaceAnswer
}

/**
 * The workspace routes over OkHttp, on a client derived from the app's shared one (AppContainer.http), so its
 * connections are pooled: the feed runs on every wake, and a TLS handshake per call would cost time and battery.
 *
 * - Redirects aren't followed: a bearer token never goes to another address, or from https to http.
 * - Connect 15 s, read and write 30 s, the whole call 45 s.
 * - At most [MAX_BYTES] of body, counted after OkHttp undid any gzip, so a small compressed answer can't unpack into
 *   more. That fits the largest valid events page: 100 messages of 16,384 bytes each, which JSON writes as up to six
 *   bytes per byte for control characters (9.8 MB), plus their mentions and fields.
 * - The body is read on OkHttp's thread inside the call, so cancelling the caller cancels the call while the body
 *   is still coming, and the connection and thread go at once instead of at the read timeout.
 * - Every request says `Authorization: Bearer <token>`, `Accept: application/json` and `Rukoo-Workspace-Version: 1`.
 */
class OkHttpWorkspaceHttp(base: OkHttpClient) : WorkspaceHttp {
    internal val client: OkHttpClient = base.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .callTimeout(45, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    override suspend fun request(server: String, method: String, path: String, body: JsonElement?, token: String): WorkspaceAnswer =
        withContext(Dispatchers.IO) { send(server, method, path, body, token) }

    private suspend fun send(server: String, method: String, path: String, body: JsonElement?, token: String): WorkspaceAnswer {
        val url = (server + path).toHttpUrlOrNull() ?: throw WorkspaceError("server", message = "not an address")
        // Every write goes out once. OkHttp resends a request whose pooled connection dropped after it was sent,
        // without telling the caller, unless its body is one-shot. A create sent twice makes a second invite or
        // workspace, or a 409 for the channel the first one made; the caller decides what to retry. A DELETE gets an
        // empty body for the same reason. GETs keep OkHttp's retries.
        val payload = if (method == "GET") null else OneShotBody(body?.let { RukooJson.encodeToString(JsonElement.serializer(), it).encodeToByteArray() })
        val request = Request.Builder().url(url)
            .header("Accept", "application/json")
            .header("Authorization", "Bearer $token")
            .header(VERSION_HEADER, WORKSPACE_VERSION.toString())
            .method(method, payload)
            .build()
        val res = try {
            client.newCall(request).await()
        } catch (e: IOException) {
            throw WorkspaceError("network", message = e.message, cause = e)
        }
        val text = res.text
        val json = text?.takeIf { it.isNotEmpty() }?.let { runCatching { RukooJson.parseToJsonElement(it) }.getOrNull() }
        if (res.code in 200..299) {
            if (text != null && text.isNotEmpty() && json == null) throw WorkspaceError("server", res.code, message = "the answer isn't JSON")
            return WorkspaceAnswer(res.code, json)
        }
        throw WorkspaceError.fromAnswer(res.code, json as? JsonObject, res.retryAfter)
    }

    /** An answer read whole: its status, its body as text (null when it had none) and its `Retry-After`. */
    private class Read(val code: Int, val text: String?, val retryAfter: String?)

    /** The body as text, or null when there is none; `server` when it is over [MAX_BYTES]. */
    private fun read(res: Response): String? {
        val source = res.body?.source() ?: return null
        source.request(MAX_BYTES + 1)
        if (source.buffer.size > MAX_BYTES) throw WorkspaceError("server", res.code, message = "the answer is too large")
        return source.buffer.readUtf8()
    }

    /**
     * The call, with its body read on OkHttp's thread before the caller resumes. Cancelling the caller cancels the
     * call at any point, the body's read included, which then fails at once and closes the connection.
     */
    private suspend fun Call.await(): Read = suspendCancellableCoroutine { cont ->
        enqueue(
            object : Callback {
                override fun onResponse(call: Call, response: Response) {
                    val read = try {
                        response.use { Read(it.code, read(it), it.header("Retry-After")) }
                    } catch (e: IOException) {
                        if (!cont.isCancelled) cont.resumeWithException(WorkspaceError("network", response.code, message = e.message, cause = e))
                        return
                    } catch (e: WorkspaceError) {
                        if (!cont.isCancelled) cont.resumeWithException(e)
                        return
                    }
                    if (!cont.isCancelled) cont.resume(read)
                }

                override fun onFailure(call: Call, e: IOException) {
                    if (!cont.isCancelled) cont.resumeWithException(e)
                }
            },
        )
        cont.invokeOnCancellation { runCatching { cancel() } }
    }

    /** A request body OkHttp sends at most once; JSON when there is one, empty otherwise. */
    private class OneShotBody(private val bytes: ByteArray?) : RequestBody() {
        override fun contentType(): MediaType? = if (bytes != null) JSON else null

        override fun contentLength(): Long = bytes?.size?.toLong() ?: 0L

        override fun writeTo(sink: BufferedSink) {
            bytes?.let { sink.write(it) }
        }

        override fun isOneShot(): Boolean = true
    }

    companion object {
        /** The largest body read, after decompression: room for the largest valid events page (see the class). */
        const val MAX_BYTES = 16L * 1024 * 1024
        const val VERSION_HEADER = "Rukoo-Workspace-Version"
        private val JSON = "application/json".toMediaType()
    }
}
