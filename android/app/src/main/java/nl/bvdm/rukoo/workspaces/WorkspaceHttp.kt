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
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

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
 *   more. That fits a full events page: 100 messages of 16 KiB.
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
        // OkHttp wants a body on every POST; routes without one (join a channel, redact, leave a DM) send none.
        val payload = body?.let { RukooJson.encodeToString(JsonElement.serializer(), it).toRequestBody(JSON) }
            ?: if (method == "POST") ByteArray(0).toRequestBody(JSON) else null
        val request = Request.Builder().url(url)
            .header("Accept", "application/json")
            .header("Authorization", "Bearer $token")
            .header(VERSION_HEADER, WORKSPACE_VERSION.toString())
            .method(method, payload)
            .build()
        val response = try {
            client.newCall(request).await()
        } catch (e: IOException) {
            throw WorkspaceError("network", message = e.message, cause = e)
        }
        response.use { res ->
            val text = try {
                read(res)
            } catch (e: IOException) {
                throw WorkspaceError("network", res.code, message = e.message, cause = e)
            }
            val json = text?.takeIf { it.isNotEmpty() }?.let { runCatching { RukooJson.parseToJsonElement(it) }.getOrNull() }
            if (res.code in 200..299) {
                if (text != null && text.isNotEmpty() && json == null) throw WorkspaceError("server", res.code, message = "the answer isn't JSON")
                return WorkspaceAnswer(res.code, json)
            }
            throw WorkspaceError.fromAnswer(res.code, json as? JsonObject, res.header("Retry-After"))
        }
    }

    /** The body as text, or null when there is none; `server` when it is over [MAX_BYTES]. */
    private fun read(res: Response): String? {
        val source = res.body?.source() ?: return null
        source.request(MAX_BYTES + 1)
        if (source.buffer.size > MAX_BYTES) throw WorkspaceError("server", res.code, message = "the answer is too large")
        return source.buffer.readUtf8()
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
        enqueue(
            object : Callback {
                // An answer that comes after the caller went away is closed, so its connection goes back to the pool.
                override fun onResponse(call: Call, response: Response) = cont.resume(response) { _, value, _ -> value.close() }

                override fun onFailure(call: Call, e: IOException) {
                    if (!cont.isCancelled) cont.resumeWithException(e)
                }
            },
        )
        cont.invokeOnCancellation { runCatching { cancel() } }
    }

    companion object {
        /** The largest body read, after decompression. */
        const val MAX_BYTES = 4L * 1024 * 1024
        const val VERSION_HEADER = "Rukoo-Workspace-Version"
        private val JSON = "application/json".toMediaType()
    }
}
