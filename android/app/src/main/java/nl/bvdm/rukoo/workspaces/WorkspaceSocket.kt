package nl.bvdm.rukoo.workspaces

import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.RukooJson
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/**
 * The wake socket of one workspace (contract §3.11). It carries no messages: a `{"t":"wake"}` frame says the feed has
 * something new, and the service runs a sync.
 *
 * - **Connecting.** [ticket] (`POST /socket-ticket`), then an upgrade to [url] with `Authorization: Ticket <ticket>`
 *   and the subprotocol `rukoo.workspace.v1` offered. The ticket never goes in the URL or a subprotocol.
 * - **Frames.** A wake calls [Listener.wake]. Anything else, over [MAX_FRAME] bytes or binary, is ignored. Every
 *   [Timing.pingEvery] the socket sends `ping`; when no frame comes within [Timing.pongTimeout], it closes and
 *   connects again. On open, [Listener.opened] runs a catch-up.
 * - **Closes.** `4001` (the lease ended): [Listener.leaseEnded] runs a sync and the socket reconnects at once, at most
 *   once per [Timing.quickReconnectGap]. `4003` (removed): the socket parks and [Listener.removed] asks `GET /`.
 *   Anything else: [backoffDelay], 1, 2, 4, 8, 16, 32, then 60 s, each times a random factor from 0.5 to 1.0.
 * - **Ticket answers.** `429` waits `Retry-After`. `401`, `404`, `403` and `426` park the socket and tell
 *   [Listener.parked]: the session ended (the client already told the account service), the workspace is gone, or
 *   Rukoo needs an update. Trying again wouldn't help.
 * - **Upgrade refused.** A `401` to the upgrade means the ticket expired or was used: one new ticket at once, and the
 *   backoff after a second refusal in a row. A `404` parks it as a `4003` does, a `426` as the ticket's `426` does.
 *
 * [client] should come from the app's shared one; the socket derives its own without timeouts on reads, without
 * OkHttp's own pings and without redirects. Listener calls run on OkHttp's and [scope]'s threads, never under a lock.
 */
class WorkspaceSocket(
    client: OkHttpClient,
    /** `wss://<host>/v1/workspaces/{w}/socket`, or `ws://` for a dev host; see [socketUrl]. */
    val url: String,
    private val ticket: suspend () -> SocketTicket,
    private val listener: Listener,
    private val scope: CoroutineScope,
    private val timing: Timing = Timing(),
    private val now: () -> Long = System::currentTimeMillis,
    private val random: () -> Double = { ThreadLocalRandom.current().nextDouble() },
) {
    /** What the service does when the socket says something. Every method has a default that does nothing. */
    interface Listener {
        /** The socket opened: run a catch-up sync, since wakes sent while it was down are lost. Kick the outbox. */
        fun opened() {}

        /** A wake frame: run a sync. */
        fun wake() {}

        /** Close 4001: the lease ended instead of a wake, so run a sync; the socket reconnects by itself. */
        fun leaseEnded() {}

        /** Close 4003 or a 404 upgrade: removed from the workspace. Ask `GET /`, whose 404 runs the removal path. */
        fun removed() {}

        /** Parked by a ticket or upgrade answer that trying again won't change: signed out, gone, forbidden, upgrade. */
        fun parked(error: WorkspaceError) {}
    }

    /** The waits of §3.19, in milliseconds. Tests make them short. */
    data class Timing(
        val backoff: List<Long> = SOCKET_BACKOFF,
        val pingEvery: Long = 30_000,
        val pongTimeout: Long = 10_000,
        /** At most one reconnect at once after a 4001 in this time; then the backoff applies. */
        val quickReconnectGap: Long = 10_000,
        /** A ticket `429` without `Retry-After` waits this long. */
        val rateLimited: Long = 60_000,
    )

    private val http: OkHttpClient = client.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(0, TimeUnit.MILLISECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    private val lock = Any()
    private val _state = MutableStateFlow(SocketState.OFF)

    /** OFF while parked or not started, CONNECTING, OPEN, or DOWN while it waits to try again. */
    val state: StateFlow<SocketState> = _state.asStateFlow()

    private var wanted = false

    // Failed attempts in a row, for the backoff; an open socket resets it.
    private var attempt = 0

    // Each connect gets a number; what an older ticket or socket answers is ignored.
    private var token = 0
    private var socket: WebSocket? = null
    private var connectJob: Job? = null
    private var retryJob: Job? = null
    private var pingJob: Job? = null
    private var pongJob: Job? = null
    private var quickAt = Long.MIN_VALUE / 2

    // A 401 to the upgrade gets one new ticket at once; a second in a row meets the backoff.
    private var refusedOnce = false

    /** The wait before the last scheduled attempt, for tests and debugging; null when none was scheduled. */
    @Volatile
    var lastDelay: Long? = null
        private set

    /** The service wants this socket open. */
    fun start() {
        synchronized(lock) {
            if (wanted && _state.value != SocketState.OFF) return
            wanted = true
            connectLocked()
        }
    }

    /** Parked: closed, and no attempt until [start]. */
    fun stop() {
        synchronized(lock) { parkLocked() }
    }

    /**
     * Focus or resume: a socket waiting to try again tries now, from the first step of the backoff, and an open one
     * pings at once, which finds a connection that died while the phone slept.
     */
    fun nudge() {
        synchronized(lock) {
            if (!wanted) return
            when (_state.value) {
                SocketState.DOWN -> {
                    attempt = 0
                    connectLocked()
                }
                SocketState.OPEN -> pingLocked()
                else -> Unit
            }
        }
    }

    // ---- connecting ----

    private fun connectLocked() {
        if (!wanted) return
        val mine = ++token
        clearTimersLocked()
        closeSocketLocked(1000)
        _state.value = SocketState.CONNECTING
        connectJob = scope.launch { connect(mine) }
    }

    private suspend fun connect(mine: Int) {
        val t = try {
            ticket()
        } catch (e: CancellationException) {
            throw e
        } catch (e: WorkspaceError) {
            ticketFailed(mine, e)
            return
        } catch (e: Exception) {
            ticketFailed(mine, WorkspaceError("network", cause = e))
            return
        }
        synchronized(lock) {
            if (mine != token || !wanted) return
            val request = try {
                Request.Builder()
                    .url(url)
                    .header("Authorization", "Ticket ${t.ticket}")
                    .header("Sec-WebSocket-Protocol", SOCKET_PROTOCOL)
                    .build()
            } catch (e: IllegalArgumentException) {
                AppLog.w(TAG, "The socket address isn't one", e)
                parkLocked()
                return
            }
            socket = http.newWebSocket(request, Handler(mine))
        }
    }

    private fun ticketFailed(mine: Int, e: WorkspaceError) {
        val park = synchronized(lock) {
            if (mine != token || !wanted) return
            // A ticket failure sits between two upgrade 401s, so they aren't in a row.
            refusedOnce = false
            when (e.code) {
                "signed_out", "not_found", "forbidden", "upgrade_required" -> {
                    parkLocked()
                    true
                }
                "rate_limited" -> {
                    laterLocked(e.retryAfterS?.times(1000) ?: timing.rateLimited)
                    false
                }
                else -> {
                    backoffLocked()
                    false
                }
            }
        }
        if (park) safe { listener.parked(e) }
    }

    // ---- while open ----

    private inner class Handler(private val mine: Int) : WebSocketListener() {
        private var closed = false

        private fun current(ws: WebSocket): Boolean = mine == token && socket === ws

        override fun onOpen(webSocket: WebSocket, response: Response) {
            synchronized(lock) {
                if (!current(webSocket)) return
                attempt = 0
                refusedOnce = false
                lastDelay = null
                _state.value = SocketState.OPEN
                schedulePingLocked()
            }
            safe { listener.opened() }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            synchronized(lock) {
                if (!current(webSocket)) return
                // Any frame says the connection lives.
                alive()
            }
            if (text.length > MAX_FRAME || text.toByteArray(Charsets.UTF_8).size > MAX_FRAME || text == "pong") return
            val frame = runCatching { RukooJson.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return
            val t = (frame["t"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (t == "wake") safe { listener.wake() }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            synchronized(lock) {
                if (!current(webSocket)) return
                alive()
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            // Answer the close so the server's side finishes; then act on it once.
            runCatching { webSocket.close(1000, null) }
            closedWith(webSocket, code)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            closedWith(webSocket, code)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val status = response?.code
            val notify: (() -> Unit)? = synchronized(lock) {
                if (closed || !current(webSocket)) return
                closed = true
                socket = null
                clearTimersLocked()
                if (!wanted) {
                    _state.value = SocketState.OFF
                    return
                }
                when (status) {
                    401 -> {
                        if (!refusedOnce) {
                            refusedOnce = true
                            connectLocked()
                        } else {
                            backoffLocked(afterRefusal = true)
                        }
                        null
                    }
                    404 -> {
                        parkLocked()
                        ({ listener.removed() })
                    }
                    426 -> {
                        parkLocked()
                        ({ listener.parked(WorkspaceError("upgrade_required", 426)) })
                    }
                    else -> {
                        backoffLocked()
                        null
                    }
                }
            }
            notify?.let { safe(it) }
        }

        private fun closedWith(webSocket: WebSocket, code: Int) {
            val notify: List<() -> Unit> = synchronized(lock) {
                if (closed || !current(webSocket)) return
                closed = true
                socket = null
                clearTimersLocked()
                if (!wanted) {
                    _state.value = SocketState.OFF
                    return
                }
                when (code) {
                    CLOSE_LEASE -> {
                        // The lease ran out and the server sent this instead of a wake: something may be new.
                        val t = now()
                        if (t - quickAt >= timing.quickReconnectGap) {
                            quickAt = t
                            connectLocked()
                        } else {
                            backoffLocked()
                        }
                        listOf({ listener.leaseEnded() })
                    }
                    CLOSE_REMOVED -> {
                        parkLocked()
                        listOf({ listener.removed() })
                    }
                    else -> {
                        backoffLocked()
                        emptyList()
                    }
                }
            }
            for (n in notify) safe(n)
        }
    }

    // ---- pings ----

    private fun alive() {
        pongJob?.cancel()
        pongJob = null
    }

    private fun schedulePingLocked() {
        pingJob?.cancel()
        pingJob = scope.launch {
            delay(timing.pingEvery)
            synchronized(lock) { pingLocked() }
        }
    }

    /** A ping that no frame answers within the pong timeout closes the socket and connects again. */
    private fun pingLocked() {
        val s = socket
        if (_state.value != SocketState.OPEN || s == null) return
        s.send("ping")
        if (pongJob == null) {
            val mine = token
            pongJob = scope.launch {
                delay(timing.pongTimeout)
                synchronized(lock) {
                    if (mine != token || _state.value != SocketState.OPEN) return@synchronized
                    pongJob = null
                    deadLocked()
                }
            }
        }
        schedulePingLocked()
    }

    private fun deadLocked() {
        token++
        val s = socket
        socket = null
        runCatching { s?.cancel() }
        backoffLocked()
    }

    // ---- waiting ----

    /** The next backoff step. Any failure but a repeated upgrade `401` ends a run of 401s, so the next gets its quick retry. */
    private fun backoffLocked(afterRefusal: Boolean = false) {
        if (!afterRefusal) refusedOnce = false
        val delayMs = backoffDelay(attempt, random(), timing.backoff)
        attempt++
        laterLocked(delayMs)
    }

    private fun laterLocked(delayMs: Long) {
        clearTimersLocked()
        lastDelay = delayMs
        _state.value = SocketState.DOWN
        retryJob = scope.launch {
            delay(delayMs)
            synchronized(lock) {
                retryJob = null
                if (wanted && _state.value == SocketState.DOWN) connectLocked()
            }
        }
    }

    private fun parkLocked() {
        wanted = false
        token++
        connectJob?.cancel()
        connectJob = null
        clearTimersLocked()
        closeSocketLocked(1000)
        _state.value = SocketState.OFF
    }

    private fun clearTimersLocked() {
        retryJob?.cancel()
        pingJob?.cancel()
        pongJob?.cancel()
        retryJob = null
        pingJob = null
        pongJob = null
    }

    private fun closeSocketLocked(code: Int) {
        val s = socket ?: return
        socket = null
        runCatching { if (!s.close(code, null)) s.cancel() }
    }

    private inline fun safe(block: () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The service records its own failures; the socket goes on.
            AppLog.w(TAG, "A socket listener failed", e)
        }
    }

    companion object {
        private const val TAG = "WorkspaceSocket"

        /** Frames over this many bytes are ignored. */
        const val MAX_FRAME = 1024

        /** The lease ran out (§3.11). */
        const val CLOSE_LEASE = 4001

        /** Removed from the workspace, or it was deleted. */
        const val CLOSE_REMOVED = 4003

        /** §3.19 `SOCKET_BACKOFF`. */
        val SOCKET_BACKOFF: List<Long> = listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L)

        /**
         * The wait before attempt [attempt] (0 for the first retry): the table's step, its last step repeating, times
         * 0.5 plus half of [random] (0 to 1), so a server that comes back doesn't get every phone in the same second.
         */
        fun backoffDelay(attempt: Int, random: Double, table: List<Long> = SOCKET_BACKOFF): Long {
            val base = table[attempt.coerceIn(0, table.size - 1)]
            return Math.round(base * (0.5 + 0.5 * random.coerceIn(0.0, 1.0)))
        }

        /** The socket's address: the credential URL with `http` replaced by `ws`, plus `/v1/workspaces/{w}/socket`. */
        fun socketUrl(server: String, ws: String): String {
            require(WorkspaceIds.isWorkspace(ws)) { "not a workspace id" }
            val base = server.trimEnd('/')
            val scheme = when {
                base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
                base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
                else -> throw IllegalArgumentException("not an http address")
            }
            return "$scheme/v1/workspaces/$ws/socket"
        }
    }
}
