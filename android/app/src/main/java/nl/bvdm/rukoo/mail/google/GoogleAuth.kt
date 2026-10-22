package nl.bvdm.rukoo.mail.google

import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.UriComponent
import nl.bvdm.rukoo.mail.MailException
import nl.bvdm.rukoo.mail.MailStrings
import nl.bvdm.rukoo.mail.google.GoogleOAuth.string
import nl.bvdm.rukoo.mail.mime.MailText
import nl.bvdm.rukoo.mail.model.GoogleClient
import nl.bvdm.rukoo.mail.model.GoogleTokens
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request

/** A fresh access token from a refresh, and what the grant still covers when Google says so. */
data class TokenGrant(val accessToken: String, val expiresAt: Long, val scopes: List<String>?) {
    override fun toString() = "TokenGrant(expiresAt=$expiresAt, scopes=$scopes)"
}

/**
 * OAuth 2.0 for installed apps with a loopback redirect and PKCE, ported from desktop's google.js
 * (spec 4 §4). The same Desktop-type client works on the phone: a ServerSocket on 127.0.0.1 receives
 * the redirect, and its page sends the browser on to `rukoo-oauth://done` so Rukoo comes back to the
 * front. Google refuses sign-in inside WebViews; a Custom Tab is a real browser. The engine's
 * signInWithGoogle is the way in; this class only talks to Google.
 */
class GoogleAuth(
    private val clients: GoogleClientStore,
    http: OkHttpClient,
    private val strings: MailStrings,
    private val clock: Clock = Clock.System,
    private val tokenEndpoint: String = GoogleOAuth.TOKEN_ENDPOINT,
    private val authEndpoint: String = GoogleOAuth.AUTH_ENDPOINT,
) {
    private val http = http.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        // A token request that hangs would hold up every sync of the account behind it.
        .callTimeout(GoogleOAuth.TOKEN_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .build()

    @Volatile
    private var pending: CompletableDeferred<String>? = null

    private fun oauthError(message: String, code: String) = MailException(message, code)

    fun setClient(client: GoogleClient) = clients.set(client)

    fun client(): GoogleClient? = clients.client.value

    /** Ends a sign-in that is still waiting for the browser; the next one takes over. */
    private fun cancelWaiting() {
        pending?.completeExceptionally(oauthError(strings.get(R.string.engine_errors_google_cancelled), "cancelled"))
    }

    /**
     * Opens Google's consent page through [openUrl] (a Custom Tab) and waits, up to five minutes, for the
     * browser to come back to the loopback address. Throws a [MailException] with a text for the user on
     * failure; cancelling the caller ends the wait and closes the loopback socket.
     */
    suspend fun signIn(openUrl: (String) -> Unit, loginHint: String? = null): GoogleTokens {
        val client = client() ?: throw oauthError(strings.get(R.string.engine_errors_google_not_configured), "no_client")
        cancelWaiting()
        val pkce = GoogleOAuth.Pkce.create()
        val server = withContext(Dispatchers.IO) { ServerSocket(0, 8, InetAddress.getByName("127.0.0.1")) }
        val redirectUri = "http://127.0.0.1:${server.localPort}/"
        val waiting = CompletableDeferred<String>()
        pending = waiting
        try {
            val open = Connections()
            val code = coroutineScope {
                val acceptor = launch(Dispatchers.IO) { serve(server, pkce.state, waiting, open) }
                try {
                    openUrl(GoogleOAuth.authUrl(client, redirectUri, pkce, loginHint, authEndpoint))
                    withTimeout(GoogleOAuth.SIGN_IN_TIMEOUT_MS) { waiting.await() }
                } catch (e: TimeoutCancellationException) {
                    throw oauthError(strings.get(R.string.engine_errors_google_timeout), "timeout")
                } finally {
                    runCatching { server.close() }
                    // Closing a connection the browser left idle ends its blocked read at once.
                    open.closeAll()
                    acceptor.cancel()
                }
            }
            return exchange(client, code, redirectUri, pkce.verifier)
        } finally {
            if (pending === waiting) pending = null
            runCatching { server.close() }
        }
    }

    /** Swaps the code for tokens and checks what Google granted (google.js:148-170). */
    internal suspend fun exchange(client: GoogleClient, code: String, redirectUri: String, verifier: String): GoogleTokens {
        val tokens = tokenRequest(
            mapOf(
                "grant_type" to "authorization_code",
                "code" to code,
                "redirect_uri" to redirectUri,
                "code_verifier" to verifier,
                "client_id" to client.clientId,
                "client_secret" to client.clientSecret,
            ),
        )
        val granted = tokens.string("scope").orEmpty().split(' ').filter { it.isNotEmpty() }
        if (GoogleOAuth.MAIL_SCOPE !in granted) throw oauthError(strings.get(R.string.engine_errors_google_scope), "scope")
        val refreshToken = tokens.string("refresh_token") ?: throw oauthError(strings.get(R.string.engine_errors_google_no_refresh_token), "no_refresh")
        val profile = GoogleOAuth.decodeJwtPayload(tokens.string("id_token"))
        val email = profile.string("email") ?: throw oauthError(strings.get(R.string.engine_errors_google_no_email), "no_email")
        return GoogleTokens(
            email = email,
            name = profile.string("name").orEmpty(),
            refreshToken = refreshToken,
            accessToken = tokens.string("access_token"),
            expiresAt = clock.now() + (tokens.string("expires_in")?.toLongOrNull() ?: 3600) * 1000,
            scopes = granted,
        )
    }

    /** A new access token for [refreshToken] (google.js:178-191). */
    suspend fun refresh(refreshToken: String): TokenGrant {
        val client = client() ?: throw oauthError(strings.get(R.string.engine_errors_google_not_configured), "no_client")
        val tokens = tokenRequest(
            mapOf(
                "grant_type" to "refresh_token",
                "refresh_token" to refreshToken,
                "client_id" to client.clientId,
                "client_secret" to client.clientSecret,
            ),
        )
        val access = tokens.string("access_token") ?: throw oauthError(strings.get(R.string.engine_errors_google_connection), "network")
        // Google reports what the refresh token still covers; access taken away in the Google account shows up here.
        val scopes = tokens.string("scope")?.split(' ')?.filter { it.isNotEmpty() }
        return TokenGrant(access, clock.now() + (tokens.string("expires_in")?.toLongOrNull() ?: 3600) * 1000, scopes)
    }

    private suspend fun tokenRequest(form: Map<String, String>): JsonObject = withContext(Dispatchers.IO) {
        val body = FormBody.Builder().apply { form.forEach { (k, v) -> add(k, v) } }.build()
        val request = Request.Builder().url(tokenEndpoint).post(body).build()
        val (ok, status, text) = try {
            http.newCall(request).execute().use { Triple(it.isSuccessful, it.code, it.body?.string().orEmpty()) }
        } catch (e: IOException) {
            throw oauthError(strings.get(R.string.engine_errors_google_connection), "network")
        }
        val json = runCatching { Json.parseToJsonElement(text).jsonObject }.getOrNull()
        if (ok) return@withContext json ?: throw oauthError(strings.get(R.string.engine_errors_google_connection), "network")
        val error = json?.string("error")
        if (error == "invalid_grant") throw oauthError(strings.get(R.string.engine_errors_google_expired), "invalid_grant")
        throw oauthError(strings.get(R.string.engine_errors_google_request, error ?: status.toString()), error ?: "token_error")
    }

    /**
     * Answers the browser on the loopback address until [waiting] settles or the socket closes. Each
     * connection gets its own coroutine: Chrome may open one ahead of time and send nothing on it, which
     * must not hold up the real redirect.
     */
    private fun CoroutineScope.serve(server: ServerSocket, state: String, waiting: CompletableDeferred<String>, open: Connections) {
        while (!server.isClosed && !waiting.isCompleted) {
            val socket = try {
                server.accept()
            } catch (e: IOException) {
                return
            }
            // Accepted while the sign-in ended: closed at once. Otherwise closeAll() reaches it, also when its
            // handler is cancelled before it starts.
            if (!open.add(socket)) continue
            launch(Dispatchers.IO) {
                try {
                    socket.use { runCatching { answer(it, state, waiting) } }
                } finally {
                    open.remove(socket)
                }
            }
        }
    }

    /** The browser connections of one sign-in. Adding and closing all are atomic, so none is missed. */
    internal class Connections {
        private val open = mutableSetOf<Socket>()
        private var closed = false

        /** False (and the socket closed) once [closeAll] ran. */
        @Synchronized
        fun add(socket: Socket): Boolean {
            if (closed) {
                runCatching { socket.close() }
                return false
            }
            open += socket
            return true
        }

        @Synchronized
        fun remove(socket: Socket) {
            open -= socket
        }

        @Synchronized
        fun closeAll() {
            closed = true
            open.forEach { runCatching { it.close() } }
            open.clear()
        }
    }

    /**
     * The request head, at most 16 KiB within 10 s in all, so a connection that trickles bytes can't keep
     * its handler busy. Headers are ignored; the request has no body.
     */
    private fun readHead(socket: Socket): String? {
        val input = java.io.BufferedInputStream(socket.getInputStream())
        val head = java.io.ByteArrayOutputStream()
        val deadline = System.currentTimeMillis() + 10_000
        // At the start of a line, a line end is the blank line that ends the head ("\r\n\r\n" or "\n\n").
        var lineStart = true
        while (head.size() < 16 * 1024) {
            val left = deadline - System.currentTimeMillis()
            if (left <= 0) return null
            socket.soTimeout = left.toInt()
            val b = input.read()
            if (b < 0) break
            head.write(b)
            if (b == '\n'.code) {
                if (lineStart && head.size() > 2) break
                lineStart = true
            } else if (b != '\r'.code) {
                lineStart = false
            }
        }
        return head.toString(Charsets.ISO_8859_1.name()).takeIf { it.isNotEmpty() }
    }

    private fun answer(socket: Socket, state: String, waiting: CompletableDeferred<String>) {
        val requestLine = readHead(socket)?.lineSequence()?.firstOrNull()?.trimEnd('\r') ?: return
        val target = requestLine.split(' ').getOrNull(1).orEmpty()
        val path = target.substringBefore('?')
        if (path != "/") {
            respond(socket, 404, "")
            return
        }
        val params = target.substringAfter('?', "").split('&').filter { it.isNotEmpty() }.associate { pair ->
            val k = pair.substringBefore('=')
            val v = pair.substringAfter('=', "")
            (UriComponent.decode(k.replace('+', ' ')) ?: k) to (UriComponent.decode(v.replace('+', ' ')) ?: v)
        }
        if (params["state"] != state) {
            respond(socket, 200, page(R.string.engine_google_page_failed, R.string.engine_google_page_invalid_request, returnToApp = false))
            return
        }
        val error = params["error"]
        if (error != null) {
            respond(socket, 200, page(R.string.engine_google_page_cancelled, R.string.engine_google_page_close_tab, returnToApp = true))
            val message = if (error == "access_denied") strings.get(R.string.engine_errors_google_denied) else "Google: $error"
            waiting.completeExceptionally(oauthError(message, error))
            return
        }
        respond(socket, 200, page(R.string.engine_google_page_success, R.string.engine_google_page_return, returnToApp = true))
        params["code"]?.let { waiting.complete(it) }
    }

    private fun respond(socket: Socket, status: Int, html: String) {
        val body = html.toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 $status ${if (status == 200) "OK" else "Not Found"}\r\n" +
            "Content-Type: text/html; charset=utf-8\r\nContent-Length: ${body.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        socket.getOutputStream().apply {
            write(head.toByteArray(Charsets.ISO_8859_1))
            write(body)
            flush()
        }
    }

    /**
     * Desktop's PAGE (google.js:40-42). After sign-in it also sends the browser on to Rukoo, with a link
     * as a fallback for browsers that only follow an app link after a tap.
     */
    private fun page(title: Int, text: Int, returnToApp: Boolean): String {
        val t = MailText.escapeHtml(strings.get(title))
        val p = MailText.escapeHtml(strings.get(text))
        val back = GoogleOAuth.RETURN_URL
        val redirect = if (returnToApp) "<meta http-equiv=\"refresh\" content=\"0;url=$back\">" else ""
        val link = if (returnToApp) {
            "<p><a href=\"$back\" style=\"display:inline-block;margin-top:8px;padding:10px 18px;border-radius:999px;" +
                "background:#eee;color:#111;text-decoration:none;font-weight:600\">${MailText.escapeHtml(strings.get(R.string.engine_google_page_open))}</a></p>" +
                "<script>location.replace(\"$back\")</script>"
        } else {
            ""
        }
        return "<!doctype html><html lang=\"${Locale.getDefault().language}\"><meta charset=\"utf-8\">" +
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">$redirect<title>$t</title>\n" +
            "<body style=\"font:16px system-ui,'Segoe UI',sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0\">\n" +
            "<div style=\"text-align:center;max-width:420px;padding:0 24px\"><h1 style=\"font-weight:600;font-size:24px\">$t</h1>" +
            "<p style=\"color:#aaa\">$p</p>$link</div></body></html>"
    }
}
