package nl.bvdm.rukoo.desktop

import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import nl.bvdm.rukoo.agents.AgentSettingsStore
import nl.bvdm.rukoo.agents.PairedComputer
import nl.bvdm.rukoo.agents.model.HostLine
import nl.bvdm.rukoo.agents.model.HostStream
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.OwnSkills
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.Ids
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.core.Tailnet
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionPool
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody

/**
 * The phone's client for desktop Rukoo's `/phone/v1` routes (spec 3 §7, as phonehost.js implements them,
 * wave0-api.md F). Pairings live in [store], with their tokens encrypted there. Every failure is a
 * [DesktopException]; the bearer token never appears in one.
 */
class HttpDesktopLink(
    private val store: AgentSettingsStore,
    http: OkHttpClient,
    private val device: () -> DeviceInfo,
    private val clock: Clock = Clock.System,
) : DesktopLink {
    // Desktop Rukoo (Node's http server) closes a connection after 5 s without a request. Idle connections go
    // before that, so a request never starts on one the computer already closed.
    private val client: OkHttpClient = http.newBuilder()
        .connectTimeout(CONNECT_TIMEOUT_S, TimeUnit.SECONDS)
        .readTimeout(READ_TIMEOUT_S, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .followRedirects(false)
        .connectionPool(ConnectionPool(MAX_IDLE_CONNECTIONS, KEEP_ALIVE_S, TimeUnit.SECONDS))
        .build()

    // The computer pings every 15 s while a turn runs, so a read that waits longer than this means the link is gone.
    private val streams: OkHttpClient = client.newBuilder()
        .readTimeout(STREAM_READ_TIMEOUT_S, TimeUnit.SECONDS)
        // A turn must not be sent twice: the computer would start it twice. So it isn't retried, and it always opens
        // a connection of its own: a pooled one can have been closed by the computer a moment ago, and then the turn
        // would fail before it was sent.
        .retryOnConnectionFailure(false)
        .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
        .build()

    override val computers: Flow<List<PairedComputer>> = store.settings.map { it.computers }.distinctUntilChanged()

    // ---------- pairing ----------

    override suspend fun pair(address: String, code: String): PairedComputer {
        val target = DesktopAddress.parse(address) ?: throw DesktopException(DesktopErrors.INVALID_ADDRESS)
        val normalized = PairingCode.normalize(code) ?: throw DesktopException(DesktopErrors.INVALID_CODE)
        val body = encode(PairRequest.serializer(), PairRequest(PairingCode.format(normalized), device()))
        val answer = exchange(target.baseUrl + "/phone/v1/pair", body, PairResponse.serializer())
        if (!PAIRING_ID.matches(answer.pairingId) || answer.token.isBlank() || answer.token.length > 512) {
            throw DesktopException(DesktopErrors.PROTOCOL, "the pairing answer had no usable id or token")
        }
        val reported = answer.desktop
        val now = clock.now()
        // An IP address the user typed just worked, so it stays. A name (MagicDNS) is swapped for the Tailscale IP
        // the computer reports, which keeps working when the phone's MagicDNS doesn't. Anything else the computer
        // reports (its side of a relay, a LAN address) may not be reachable from the phone, so the typed one stays.
        val reportedIp = reported.address.trim().takeIf { isIpLiteral(it) && isTailscaleIp(it) }
        val useReported = !isIpLiteral(target.host) && reportedIp != null
        val computer = PairedComputer(
            pairingId = answer.pairingId,
            name = reported.name.trim().ifBlank { target.host }.take(80),
            address = if (useReported) reportedIp!! else target.host,
            port = if (useReported) reported.port.takeIf { it in 1..65535 } ?: target.port else target.port,
            token = answer.token,
            mcpToken = Ids.token(),
            exportUntil = answer.exportUntil,
            version = reported.version.take(40),
            pairedAt = now,
            lastSeenAt = now,
        )
        var replaced = emptyList<PairedComputer>()
        store.update { s ->
            // Pairing the same computer again replaces the old pairing, so the agent picker lists it once.
            replaced = s.computers.filter { it.isSameComputer(computer) }
            s.copy(computers = s.computers.filterNot { it.isSameComputer(computer) } + computer)
        }
        for (old in replaced) withTimeoutOrNull(FORGET_TIMEOUT_MS) { runCatching { unpairRemote(old) } }
        return computer
    }

    override suspend fun hello(pairingId: String): HelloResponse {
        val c = computer(pairingId)
        val hello = request(c, "GET", "/phone/v1/hello", null, HelloResponse.serializer())
        seen(pairingId) {
            it.copy(
                name = hello.desktop.name.trim().ifBlank { it.name }.take(80),
                version = hello.desktop.version.ifBlank { it.version }.take(40),
                exportUntil = hello.exportUntil,
            )
        }
        return hello
    }

    override suspend fun export(pairingId: String): ExportBundle {
        val c = computer(pairingId)
        val bundle = try {
            request(c, "GET", "/phone/v1/export", null, ExportBundle.serializer(), maxBytes = EXPORT_MAX_BYTES)
        } catch (e: DesktopException) {
            if (e.code == DesktopErrors.EXPORT_CLOSED) seen(pairingId) { it.copy(exportUntil = null) }
            throw e
        }
        // The window closes when the computer sent the bundle.
        seen(pairingId) { it.copy(exportUntil = null) }
        return bundle
    }

    override suspend fun forget(pairingId: String) {
        val c = store.current().computer(pairingId)
        // Best effort: an unreachable computer must not keep the phone from forgetting it. It lists the phone
        // until the user removes it there.
        if (c != null) withTimeoutOrNull(FORGET_TIMEOUT_MS) { runCatching { unpairRemote(c) } }
        store.update { s -> s.copy(computers = s.computers.filterNot { it.pairingId == pairingId }) }
    }

    private suspend fun unpairRemote(c: PairedComputer) {
        call(c, "DELETE", "/phone/v1/pairing", "", touch = false)
    }

    // ---------- the agents' lists ----------

    override suspend fun models(pairingId: String, agent: String, refresh: Boolean): ModelOptions =
        request(computer(pairingId), "GET", listPath(agent, "models", refresh), null, ModelOptions.serializer())

    override suspend fun skills(pairingId: String, agent: String, refresh: Boolean): OwnSkills =
        request(computer(pairingId), "GET", listPath(agent, "skills", refresh), null, OwnSkills.serializer())

    private fun listPath(agent: String, what: String, refresh: Boolean): String {
        if (agent !in AGENTS) throw DesktopException(DesktopErrors.INVALID, "agent must be claude or codex")
        return "/phone/v1/agents/$agent/$what" + if (refresh) "?refresh=1" else ""
    }

    // ---------- turns ----------

    override fun startTurn(pairingId: String, request: HostTurnRequest): Flow<HostLine> = stream(pairingId) { c ->
        if (request.agent !in AGENTS) throw DesktopException(DesktopErrors.INVALID, "agent must be claude or codex")
        build(c, "POST", "/phone/v1/turns", encode(HostTurnRequest.serializer(), request))
    }

    override fun reattach(pairingId: String, turnId: String, afterSeq: Long): Flow<HostLine> = stream(pairingId) { c ->
        build(c, "GET", "/phone/v1/turns/${id(turnId)}/events?after=${afterSeq.coerceAtLeast(0)}", null)
    }

    override suspend fun answerApproval(pairingId: String, turnId: String, approvalId: String, choice: String) {
        val path = "/phone/v1/turns/${id(turnId)}/approvals/${id(approvalId)}"
        call(computer(pairingId), "POST", path, encode(ChoiceBody.serializer(), ChoiceBody(choice)))
    }

    override suspend fun stopTurn(pairingId: String, turnId: String) {
        try {
            call(computer(pairingId), "POST", "/phone/v1/turns/${id(turnId)}/stop", "")
        } catch (e: DesktopException) {
            // The turn ended and the computer dropped it: nothing is left to stop.
            if (e.code != DesktopErrors.NOT_FOUND) throw e
        }
    }

    override suspend fun startOver(pairingId: String, turnId: String, requestId: String, input: String) {
        val path = "/phone/v1/turns/${id(turnId)}/start-over/${id(requestId)}"
        call(computer(pairingId), "POST", path, encode(StartOverBody.serializer(), StartOverBody(input)))
    }

    override suspend fun forgetConversation(pairingId: String, agent: String, conversationId: String) {
        val body = encode(ForgetBody.serializer(), ForgetBody(agent, conversationId))
        call(computer(pairingId), "POST", "/phone/v1/conversations/forget", body)
    }

    // ---------- plumbing ----------

    private fun computer(pairingId: String): PairedComputer =
        store.current().computer(pairingId) ?: throw DesktopException(DesktopErrors.UNKNOWN_COMPUTER)

    /** A path segment for an id the computer handed out; anything else could leave the route. */
    private fun id(value: String): String {
        if (!SEGMENT.matches(value)) throw DesktopException(DesktopErrors.INVALID, "not an id the computer hands out")
        return value
    }

    private fun build(c: PairedComputer, method: String, path: String, body: String?): Request =
        Request.Builder()
            .url(DesktopAddress(c.address, c.port).baseUrl + path)
            .header("Authorization", "Bearer ${c.token}")
            .header("Accept", "application/json, application/x-ndjson")
            .method(method, body?.let(::jsonBody))
            .build()

    /** A bearer route and its decoded answer. */
    private suspend fun <T> request(
        c: PairedComputer,
        method: String,
        path: String,
        body: String?,
        serializer: KSerializer<T>,
        maxBytes: Long = MAX_BYTES,
    ): T = decode(serializer, call(c, method, path, body, maxBytes))

    /** A bearer route whose answer only matters for its status. */
    private suspend fun call(
        c: PairedComputer,
        method: String,
        path: String,
        body: String?,
        maxBytes: Long = MAX_BYTES,
        touch: Boolean = true,
    ): String {
        val text = send(build(c, method, path, body), maxBytes)
        if (touch) seen(c.pairingId)
        return text
    }

    /** The pairing route: no token yet. */
    private suspend fun <T> exchange(url: String, body: String, serializer: KSerializer<T>): T {
        val request = Request.Builder().url(url).header("Accept", "application/json").post(jsonBody(body)).build()
        return decode(serializer, send(request, MAX_BYTES))
    }

    /** Runs [request] and returns the answer's text, or throws the route's error. */
    private suspend fun send(request: Request, maxBytes: Long): String {
        val response = try {
            client.newCall(request).await()
        } catch (e: IOException) {
            throw offline(e)
        }
        return withContext(Dispatchers.IO) {
            response.use {
                if (!it.isSuccessful) throw errorOf(it)
                try {
                    it.body?.let { b -> readCapped(b, maxBytes) }.orEmpty()
                } catch (e: IOException) {
                    throw offline(e)
                }
            }
        }
    }

    /**
     * An NDJSON stream: one [HostLine] per line, until the computer ends it. Cancelling the collector cancels
     * the call, which unblocks the read. A stream that ends without `done` just completes, so the caller can
     * reattach within the computer's 30 s grace.
     */
    private fun stream(pairingId: String, request: (PairedComputer) -> Request): Flow<HostLine> = callbackFlow {
        val call = streams.newCall(request(computer(pairingId)))
        launch(Dispatchers.IO) {
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) throw errorOf(response)
                    val source = response.body?.source() ?: throw DesktopException(DesktopErrors.PROTOCOL, "empty stream")
                    var first = true
                    while (true) {
                        val line = source.readUtf8Line() ?: break
                        if (line.length > MAX_LINE) throw DesktopException(DesktopErrors.PROTOCOL, "a stream line is too long")
                        if (first) {
                            first = false
                            seen(pairingId)
                        }
                        HostStream.parse(line)?.let { send(it) }
                    }
                }
                channel.close()
            } catch (e: DesktopException) {
                channel.close(e)
            } catch (e: IOException) {
                // A cancelled call fails its read too; then nobody is listening any more.
                channel.close(if (call.isCanceled()) null else offline(e))
            }
        }
        awaitClose { call.cancel() }
    }

    private suspend fun seen(pairingId: String, change: (PairedComputer) -> PairedComputer = { it }) {
        val now = clock.now()
        val before = store.current().computer(pairingId) ?: return
        val last = before.lastSeenAt
        val stale = last == null || now - last >= SEEN_SAVE_MS
        // A computer that answers every few seconds shouldn't rewrite agents.json each time.
        if (change(before) == before && !stale) return
        store.update { s ->
            s.copy(computers = s.computers.map { if (it.pairingId == pairingId) change(it).copy(lastSeenAt = now) else it })
        }
    }

    private fun <T> encode(serializer: KSerializer<T>, value: T): String = RukooJson.encodeToString(serializer, value)

    private fun <T> decode(serializer: KSerializer<T>, text: String): T = try {
        RukooJson.decodeFromString(serializer, text)
    } catch (e: SerializationException) {
        throw DesktopException(DesktopErrors.PROTOCOL, "the answer wasn't the expected JSON")
    } catch (e: IllegalArgumentException) {
        throw DesktopException(DesktopErrors.PROTOCOL, "the answer wasn't the expected JSON")
    }

    companion object {
        /** The routes' `agent`: desktop's ids for Claude Code and Codex. */
        val AGENTS = setOf("claude", "codex")

        private const val CONNECT_TIMEOUT_S = 10L
        private const val READ_TIMEOUT_S = 30L
        private const val MAX_IDLE_CONNECTIONS = 2
        private const val KEEP_ALIVE_S = 4L

        /** Above the computer's 15 s heartbeat (spec 3 §7.6 step 7). */
        const val STREAM_READ_TIMEOUT_S = 45L
        private const val FORGET_TIMEOUT_MS = 5_000L
        private const val SEEN_SAVE_MS = 60_000L
        private const val MAX_BYTES = 4L * 1024 * 1024

        // Accounts with their signatures, which can carry pictures.
        private const val EXPORT_MAX_BYTES = 32L * 1024 * 1024
        private const val ERROR_MAX_BYTES = 64L * 1024
        private const val MAX_LINE = 1_000_000
        private val PAIRING_ID = Regex("^ph_[a-z0-9]{10}$")

        // phonehost.js ID: the turn, approval and start-over ids it hands out.
        private val SEGMENT = Regex("^[A-Za-z0-9_-]{1,40}$")
        private val IPV4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")
        private val JSON = "application/json; charset=utf-8".toMediaType()

        private fun jsonBody(text: String): RequestBody = text.toRequestBody(JSON)

        internal fun isIpLiteral(s: String): Boolean =
            IPV4.matchEntire(s)?.groupValues?.drop(1)?.all { (it.toIntOrNull() ?: 256) <= 255 } == true ||
                (':' in s && s.all { it.isLetterOrDigit() || it == ':' || it == '.' })

        /** An IP literal in Tailscale's ranges. Only literals get here, so parsing it never looks anything up. */
        internal fun isTailscaleIp(s: String): Boolean =
            runCatching { Tailnet.isTailscaleAddress(InetAddress.getByName(s)) }.getOrDefault(false)

        /** The route's `{error, detail}` as an exception; `not found` (with a space) means phones aren't let in there. */
        internal fun errorOf(response: Response): DesktopException {
            val text = runCatching { response.body?.let { readCapped(it, ERROR_MAX_BYTES) } }.getOrNull().orEmpty()
            val body = runCatching { RukooJson.decodeFromString(HostErrorBody.serializer(), text) }.getOrNull()
            val status = response.code
            val code = when {
                body == null || body.error.isBlank() -> when (status) {
                    401 -> DesktopErrors.UNAUTHORIZED
                    403 -> DesktopErrors.EXPORT_CLOSED
                    404 -> DesktopErrors.NOT_ENABLED
                    413 -> DesktopErrors.TOO_LARGE
                    422 -> DesktopErrors.INVALID
                    429 -> DesktopErrors.RATE_LIMITED
                    else -> DesktopErrors.UNKNOWN
                }
                body.error == "not found" -> DesktopErrors.NOT_ENABLED
                else -> body.error.take(40)
            }
            val retry = response.header("Retry-After")?.trim()?.toIntOrNull()?.takeIf { it >= 0 }
            return DesktopException(code, body?.detail.orEmpty().take(300), status, retry)
        }

        private fun readCapped(body: ResponseBody, max: Long): String {
            val source = body.source()
            if (source.request(max + 1)) throw DesktopException(DesktopErrors.TOO_LARGE, "the answer is larger than $max bytes")
            return source.buffer.readUtf8()
        }

        // The message names the failure, never the request, which carries the token.
        private fun offline(e: IOException) = DesktopException(DesktopErrors.OFFLINE, e.javaClass.simpleName)

        // The listener's address, not the name: two computers can share a host name, and replacing the wrong
        // pairing would unpair a computer the user still uses.
        private fun PairedComputer.isSameComputer(other: PairedComputer): Boolean =
            address.equals(other.address, ignoreCase = true) && port == other.port

        private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { runCatching { cancel() } }
            enqueue(
                object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (cont.isActive) cont.resumeWithException(e)
                    }

                    override fun onResponse(call: Call, response: Response) {
                        cont.resume(response) { _, r, _ -> r.close() }
                    }
                },
            )
        }
    }
}
