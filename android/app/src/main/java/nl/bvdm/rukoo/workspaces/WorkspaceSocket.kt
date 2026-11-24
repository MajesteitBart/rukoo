package nl.bvdm.rukoo.workspaces

import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
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
 *   backoff after a second refusal in a row. A `429` waits `Retry-After` as the ticket's does. A `404` parks it as a
 *   `4003` does, a `426` as the ticket's `426` does.
 * - **Waits by workspace.** The backoff's step and next attempt, a `Retry-After` and the last quick reconnect live in
 *   [pacing], which the service keeps per workspace, so a new socket for the same workspace waits them out too. An
 *   attempt that [close] cuts short counts as a failed one, so a network that comes and goes doesn't ask for a ticket
 *   each time.
 * - **One lifetime.** [stop] parks the socket until [start]. [close] ends it for good: it cancels the socket's own
 *   scope, and nothing called on it afterwards connects again.
 *
 * [client] should come from the app's shared one; the socket derives its own with [Timing.upgradeTimeout] for the
 * upgrade only, without OkHttp's own pings and without redirects. Listener calls run on OkHttp's and [scope]'s
 * threads, never under a lock.
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
    /** The workspace's waits, shared with the sockets the service makes for it before and after this one. */
    private val pacing: SocketPacing = SocketPacing(),
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
        /**
         * How long the upgrade may take, as the call and read timeouts. OkHttp lifts both once the upgrade completes
         * (the call timeout exits early, and a frame header is read without a timeout), so the open socket is
         * unaffected; an upgrade nobody answers fails into the backoff.
         */
        val upgradeTimeout: Long = 20_000,
    )

    private val http: OkHttpClient = client.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(timing.upgradeTimeout, TimeUnit.MILLISECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .callTimeout(timing.upgradeTimeout, TimeUnit.MILLISECONDS)
        .pingInterval(0, TimeUnit.MILLISECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    private val lock = Any()

    // Everything this socket launches runs here; close cancels it, so no timer or attempt outlives the socket.
    private val job = SupervisorJob(scope.coroutineContext[Job])
    private val own = CoroutineScope(scope.coroutineContext + job)

    // Set once by close and never cleared: a closed socket doesn't connect again.
    private var closed = false
    private val _state = MutableStateFlow(SocketState.OFF)

    /** OFF while parked or not started, CONNECTING, OPEN, or DOWN while it waits to try again. */
    val state: StateFlow<SocketState> = _state.asStateFlow()

    private var wanted = false

    // Each connect gets a number; what an older ticket or socket answers is ignored.
    private var token = 0
    private var socket: WebSocket? = null
    private var connectJob: Job? = null
    private var retryJob: Job? = null
    private var pingJob: Job? = null
    private var pongJob: Job? = null

    // A 401 to the upgrade gets one new ticket at once; a second in a row meets the backoff.
    private var refusedOnce = false

    // Whether [socket] finished its upgrade. One that didn't is cancelled on close: a close frame only queues.
    private var opened = false

    /** The wait before the last scheduled attempt, for tests and debugging; null when none was scheduled. */
    @Volatile
    var lastDelay: Long? = null
        private set

    /**
     * The service wants this socket open. It connects at once, or when the workspace's backoff or `Retry-After`
     * ([pacing]) ends. Nothing after [close].
     */
    fun start() {
        synchronized(lock) {
            if (closed || (wanted && _state.value != SocketState.OFF)) return
            wanted = true
            val wait = pacing.waitBeforeStart(now())
            if (wait > 0) laterLocked(wait) else connectLocked()
        }
    }

    /** Parked: closed, and no attempt until [start]. */
    fun stop() {
        synchronized(lock) { parkLocked() }
    }

    /**
     * Ends this socket for good: closed, its timers and attempt cancelled with its scope, and [start], [nudge] and
     * [check] do nothing from now on. An attempt under way counts as a failed one in [pacing].
     */
    fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            if (_state.value == SocketState.CONNECTING) pacing.failed(now(), random(), timing.backoff)
            parkLocked()
        }
        job.cancel()
    }

    /**
     * Focus or resume: a socket waiting to try again tries now, from the first step of the backoff, and an open one
     * pings at once, which finds a connection that died while the phone slept. A ticket `429` still waits its
     * `Retry-After` (§3.11).
     */
    fun nudge() {
        synchronized(lock) {
            if (!wanted || closed) return
            when (_state.value) {
                SocketState.DOWN -> {
                    if (pacing.limited(now())) return
                    pacing.reset()
                    connectLocked()
                }
                SocketState.OPEN -> pingLocked()
                else -> Unit
            }
        }
    }

    /**
     * The phone's default network moved to another: an open socket pings at once, so one left on the old network is
     * found and connects again through the backoff. A socket waiting to try again keeps its wait.
     */
    fun check() {
        synchronized(lock) {
            if (wanted && !closed && _state.value == SocketState.OPEN) pingLocked()
        }
    }

    // ---- connecting ----

    private fun connectLocked() {
        if (!wanted || closed) return
        val mine = ++token
        clearTimersLocked()
        closeSocketLocked(1000)
        _state.value = SocketState.CONNECTING
        connectJob = own.launch { connect(mine) }
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
            if (mine != token || !wanted || closed) return
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
            opened = false
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
                    limitedLocked(e.retryAfterS)
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
                opened = true
                pacing.reset()
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
                    429 -> {
                        refusedOnce = false
                        limitedLocked(WorkspaceError.retryAfterSeconds(response?.header("Retry-After")))
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
                        if (pacing.quickReconnect(now(), timing.quickReconnectGap)) {
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
        pingJob = own.launch {
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
            pongJob = own.launch {
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
        opened = false
        runCatching { s?.cancel() }
        backoffLocked()
    }

    // ---- waiting ----

    /** The next backoff step. Any failure but a repeated upgrade `401` ends a run of 401s, so the next gets its quick retry. */
    private fun backoffLocked(afterRefusal: Boolean = false) {
        if (!afterRefusal) refusedOnce = false
        laterLocked(pacing.failed(now(), random(), timing.backoff))
    }

    /** A `429`: no ticket or upgrade before `Retry-After` ([retryAfterS]), or [Timing.rateLimited] without one. */
    private fun limitedLocked(retryAfterS: Long?) {
        val wait = retryAfterS?.times(1000) ?: timing.rateLimited
        pacing.limit(now() + wait)
        laterLocked(wait)
    }

    private fun laterLocked(delayMs: Long) {
        clearTimersLocked()
        lastDelay = delayMs
        _state.value = SocketState.DOWN
        retryJob = own.launch {
            delay(delayMs)
            synchronized(lock) {
                retryJob = null
                if (wanted && !closed && _state.value == SocketState.DOWN) connectLocked()
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

    /** Closes an open socket with [code]; one still upgrading is cancelled, since its close frame would only queue. */
    private fun closeSocketLocked(code: Int) {
        val s = socket ?: return
        val wasOpen = opened
        socket = null
        opened = false
        runCatching { if (!wasOpen || !s.close(code, null)) s.cancel() }
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

/**
 * The waits one workspace's socket owes the server (§3.11, §3.19). The service keeps one per workspace for the
 * session, so they outlive the socket that met them: the socket closed when Phone tools' window closes and the one
 * made when it opens again share them. [WorkspaceSocket] calls these under its own lock; they lock this too, as a
 * closed socket can still be finishing a call while its successor starts.
 */
class SocketPacing {
    // Failed or cut-short attempts in a row, for the backoff; an open socket resets it.
    private var attempt = 0

    // When the backoff allows the next attempt. A nudge may go sooner.
    private var retryAt = Long.MIN_VALUE

    // A 429's Retry-After: no ticket or upgrade before this, whatever nudges.
    private var limitedUntil = Long.MIN_VALUE

    // The last reconnect at once after a 4001.
    private var quickAt = Long.MIN_VALUE / 2

    /** How long a socket that starts at [now] waits first: until the backoff's next attempt or `Retry-After`, or 0. */
    @Synchronized
    fun waitBeforeStart(now: Long): Long {
        val until = maxOf(retryAt, limitedUntil)
        return if (until <= now) 0 else until - now
    }

    /** Whether `Retry-After` still holds at [now]. */
    @Synchronized
    fun limited(now: Long): Boolean = now < limitedUntil

    /** An attempt failed or was cut short at [now]: the next backoff step. Returns its wait. */
    @Synchronized
    fun failed(now: Long, random: Double, table: List<Long>): Long {
        val wait = WorkspaceSocket.backoffDelay(attempt, random, table)
        attempt++
        retryAt = now + wait
        return wait
    }

    /** A `429` that holds until [until]. */
    @Synchronized
    fun limit(until: Long) {
        limitedUntil = maxOf(limitedUntil, until)
    }

    /** A socket opened, or a nudge tries at once: the backoff starts over. `Retry-After` stays. */
    @Synchronized
    fun reset() {
        attempt = 0
        retryAt = Long.MIN_VALUE
    }

    /** Whether a `4001` at [now] may reconnect at once: at most once per [gap]. */
    @Synchronized
    fun quickReconnect(now: Long, gap: Long): Boolean {
        if (now - quickAt < gap) return false
        quickAt = now
        return true
    }
}
