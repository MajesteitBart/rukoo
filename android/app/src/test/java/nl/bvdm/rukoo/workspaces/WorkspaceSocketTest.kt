package nl.bvdm.rukoo.workspaces

import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonPrimitive
import nl.bvdm.rukoo.account.BorrowedSession
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import okio.ByteString.Companion.encodeUtf8
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The wake socket (contract §3.11) against MockWebServer's WebSocket upgrade, with its ticket from the real server's
 * recorded `POST /socket-ticket` answer and refusals built from recorded answers.
 */
class WorkspaceSocketTest {
    private val v = WorkspaceVectors
    private val w = v.id("workspace")
    private val ticketText = (v.exchange("ticket").body!!.getValue("ticket") as JsonPrimitive).content

    private val server = RecordedWorkspaceServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val okhttp = OkHttpClient()
    private val refused = CopyOnWriteArrayList<BorrowedSession>()
    private val client = WorkspaceClient(
        OkHttpWorkspaceHttp(okhttp),
        { BorrowedSession(server.url, server.nextAuth ?: "mila", "tag", Any()) },
        { refused += it },
    )

    private val opened = AtomicInteger()
    private val wakes = AtomicInteger()
    private val leases = AtomicInteger()
    private val removals = AtomicInteger()
    private val parked = CopyOnWriteArrayList<WorkspaceError>()
    private val sockets = CopyOnWriteArrayList<WorkspaceSocket>()

    private val listener = object : WorkspaceSocket.Listener {
        override fun opened() {
            opened.incrementAndGet()
        }

        override fun wake() {
            wakes.incrementAndGet()
        }

        override fun leaseEnded() {
            leases.incrementAndGet()
        }

        override fun removed() {
            removals.incrementAndGet()
        }

        override fun parked(error: WorkspaceError) {
            parked += error
        }
    }

    /** The server's end of each upgraded socket: it records what the phone sends and answers `ping` unless told not to. */
    private class ServerSide(val pong: Boolean = true, val answerClose: Boolean = true) : WebSocketListener() {
        val sockets = LinkedBlockingQueue<WebSocket>()
        val received = CopyOnWriteArrayList<String>()
        val closes = CopyOnWriteArrayList<Int>()
        val failures = AtomicInteger()

        override fun onOpen(webSocket: WebSocket, response: Response) {
            sockets += webSocket
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            received += text
            if (text == "ping" && pong) webSocket.send("pong")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            closes += code
            if (answerClose) webSocket.close(code, null)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            failures.incrementAndGet()
        }

        fun next(): WebSocket = sockets.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("no socket opened")
    }

    private fun upgrade(side: ServerSide) = server.answerWith(
        MockResponse().setHeader("Sec-WebSocket-Protocol", SOCKET_PROTOCOL).withWebSocketUpgrade(side),
    )

    private fun refusal(name: String, retryAfter: String? = null): MockResponse {
        val e = v.exchange(name)
        val res = MockResponse().setResponseCode(e.status).setHeader("Content-Type", "application/json").setBody(e.responseBody.toString())
        if (retryAfter != null) res.setHeader("Retry-After", retryAfter)
        return res
    }

    private val quick = WorkspaceSocket.Timing(
        backoff = listOf(40L, 80L, 160L),
        pingEvery = 150,
        pongTimeout = 150,
        quickReconnectGap = 10_000,
    )

    private fun socket(timing: WorkspaceSocket.Timing = quick, random: Double = 0.0) = WorkspaceSocket(
        okhttp, WorkspaceSocket.socketUrl(server.url, w), { client.socketTicket(w) }, listener, scope,
        timing = timing, random = { random },
    ).also { sockets += it }

    private fun await(what: String, timeoutMs: Long = 5_000, cond: () -> Boolean) {
        val until = System.currentTimeMillis() + timeoutMs
        while (!cond()) {
            if (System.currentTimeMillis() > until) throw AssertionError("timed out waiting for $what")
            Thread.sleep(10)
        }
    }

    private fun upgrades(): List<RecordedRequest> = server.requests.filter { it.path.orEmpty().endsWith("/socket") }

    private fun tickets(): Int = server.requests.count { it.path.orEmpty().endsWith("/socket-ticket") }

    @After
    fun tearDown() {
        for (s in sockets) s.stop()
        scope.cancel()
        server.close()
    }

    @Test
    fun `the upgrade carries Authorization Ticket and offers rukoo_workspace_v1, with no ticket in the URL`() {
        val side = ServerSide()
        server.answer("ticket")
        upgrade(side)
        val s = socket()
        s.start()
        await("open") { s.state.value == SocketState.OPEN && opened.get() == 1 }
        server.verify()

        val (ticket, up) = server.requests
        assertEquals("POST", ticket.method)
        assertEquals("/v1/workspaces/$w/socket-ticket", ticket.path)
        assertEquals("GET", up.method)
        assertEquals("/v1/workspaces/$w/socket", up.path)
        assertEquals("Ticket $ticketText", up.getHeader("Authorization"))
        assertEquals("websocket", up.getHeader("Upgrade")?.lowercase())
        assertEquals(listOf(SOCKET_PROTOCOL), up.getHeader("Sec-WebSocket-Protocol")!!.split(',').map { it.trim() })
        assertFalse(up.path!!.contains(ticketText))
        assertFalse(up.path!!.contains('?'))
        assertEquals(1, side.sockets.size)
    }

    @Test
    fun `the socket address swaps http for ws and adds the workspace's path`() {
        assertEquals("wss://rukoo.io/v1/workspaces/$w/socket", WorkspaceSocket.socketUrl("https://rukoo.io", w))
        assertEquals("wss://example.test/team/v1/workspaces/$w/socket", WorkspaceSocket.socketUrl("https://example.test/team/", w))
        assertEquals("ws://10.0.2.2:8787/v1/workspaces/$w/socket", WorkspaceSocket.socketUrl("http://10.0.2.2:8787", w))
    }

    @Test
    fun `a wake frame starts a sync, and binary, large and other frames are ignored`() {
        val side = ServerSide()
        server.answer("ticket")
        upgrade(side)
        socket().start()
        val end = side.next()
        await("open") { opened.get() == 1 }

        end.send("""{"t":"wake"}""")
        end.send("""{"t":"wake"}""".encodeUtf8())
        end.send("""{"t":"wake","pad":"${"x".repeat(WorkspaceSocket.MAX_FRAME)}"}""")
        end.send("""{"t":"other"}""")
        end.send("""["wake"]""")
        end.send("wake")
        end.send("pong")
        end.send("""{"t":"wake"}""")
        await("two wakes") { wakes.get() == 2 }
        Thread.sleep(100)
        assertEquals(2, wakes.get())
    }

    @Test
    fun `it pings on a timer, and a ping without an answer closes and connects again`() {
        val silent = ServerSide(pong = false)
        val answering = ServerSide(pong = true)
        server.answer("ticket")
        upgrade(silent)
        server.answer("ticket")
        upgrade(answering)
        val s = socket()
        s.start()
        await("the first socket") { opened.get() == 1 }
        await("a ping") { silent.received.contains("ping") }
        // pingEvery + pongTimeout + the backoff's 20 ms, then a new ticket.
        await("a new socket after the missing pong") { opened.get() == 2 && s.state.value == SocketState.OPEN }
        assertEquals(2, tickets())

        // Answered pings keep the connection.
        Thread.sleep(800)
        assertTrue("pings went out: ${answering.received}", answering.received.count { it == "ping" } >= 3)
        assertEquals(2, opened.get())
        assertEquals(SocketState.OPEN, s.state.value)
        server.verify()
    }

    @Test
    fun `4001 runs a sync and reconnects at once, and a second within 10 s meets the backoff`() {
        val side = ServerSide()
        repeat(3) {
            server.answer("ticket")
            upgrade(side)
        }
        val s = socket()
        s.start()
        side.next().close(WorkspaceSocket.CLOSE_LEASE, "lease")
        await("a lease end and a quick reconnect") { leases.get() == 1 && opened.get() == 2 }
        assertNull("no wait before the quick reconnect", s.lastDelay)

        side.next().close(WorkspaceSocket.CLOSE_LEASE, "lease")
        await("the second lease end") { leases.get() == 2 }
        await("the backoff") { s.lastDelay == 20L }
        await("the third socket") { opened.get() == 3 }
        server.verify()
    }

    @Test
    fun `4003 parks the socket and asks for the removal path`() {
        val side = ServerSide()
        server.answer("ticket")
        upgrade(side)
        val s = socket()
        s.start()
        side.next().close(WorkspaceSocket.CLOSE_REMOVED, "removed")
        await("removed") { removals.get() == 1 }
        assertEquals(SocketState.OFF, s.state.value)
        Thread.sleep(300)
        assertEquals("nothing tries again", 2, server.requestCount)
    }

    @Test
    fun `a 401 to the upgrade gets one new ticket at once, and a second in a row meets the backoff`() {
        val side = ServerSide()
        val no = MockResponse().setResponseCode(401).setHeader("Content-Type", "application/json").setBody("""{"error":"unauthorized"}""")
        server.answer("ticket")
        server.answerWith(no)
        server.answer("ticket")
        server.answerWith(no)
        server.answer("ticket")
        upgrade(side)
        val s = socket()
        val delays = CopyOnWriteArrayList<Long>()
        s.start()
        val until = System.currentTimeMillis() + 5_000
        while (opened.get() < 1 && System.currentTimeMillis() < until) {
            s.lastDelay?.let { if (delays.lastOrNull() != it) delays += it }
            Thread.sleep(2)
        }
        await("open") { opened.get() == 1 && s.state.value == SocketState.OPEN }
        // No wait after the first refusal; the first backoff step after the second.
        assertEquals(listOf(20L), delays.toList())
        assertEquals(3, tickets())
        assertEquals(3, upgrades().size)
        assertTrue("an upgrade refusal doesn't sign out", refused.isEmpty())
        assertTrue(parked.isEmpty())
        server.verify()
    }

    @Test
    fun `an upgrade 401 after another failure gets its new ticket at once again`() {
        val side = ServerSide()
        val no = MockResponse().setResponseCode(401).setHeader("Content-Type", "application/json").setBody("""{"error":"unauthorized"}""")
        // 401, then a ticket 503 between, then another 401: the two refusals aren't in a row.
        server.answer("ticket")
        server.answerWith(no)
        server.answerWith(MockResponse().setResponseCode(503))
        server.answer("ticket")
        server.answerWith(no)
        server.answer("ticket")
        upgrade(side)
        val s = socket()
        val delays = CopyOnWriteArrayList<Long>()
        s.start()
        val until = System.currentTimeMillis() + 5_000
        while (opened.get() < 1 && System.currentTimeMillis() < until) {
            s.lastDelay?.let { if (delays.lastOrNull() != it) delays += it }
            Thread.sleep(2)
        }
        await("open") { opened.get() == 1 && s.state.value == SocketState.OPEN }
        // Only the 503 waited, the first backoff step; the later 401 got its new ticket without the second step.
        assertEquals(listOf(20L), delays.toList())
        assertEquals(4, tickets())
        assertEquals(3, upgrades().size)
        assertTrue(parked.isEmpty())
        server.verify()
    }

    @Test
    fun `a ticket 429 waits Retry-After, and a 401, 404 or 426 parks the socket`() {
        val side = ServerSide()
        server.answerWith(refusal("start dm too fast", retryAfter = "1"))
        server.answer("ticket")
        upgrade(side)
        val limited = socket()
        limited.start()
        await("the wait") { limited.lastDelay == 1_000L }
        assertEquals(SocketState.DOWN, limited.state.value)
        Thread.sleep(500)
        assertEquals("still waiting", 1, server.requestCount)
        await("open after Retry-After") { opened.get() == 1 }
        limited.stop()

        for ((answer, code) in listOf(
            refusal("signed out workspace route") to "signed_out",
            refusal("not a member") to "not_found",
            refusal("upgrade required") to "upgrade_required",
        )) {
            val before = server.requestCount
            server.answerWith(answer)
            val s = socket()
            s.start()
            await("parked with $code") { parked.any { it.code == code } }
            assertEquals(SocketState.OFF, s.state.value)
            Thread.sleep(200)
            assertEquals("$code: no second try", before + 1, server.requestCount)
        }
        assertEquals("workspace", parked.single { it.code == "not_found" }.scope)
        assertEquals("the ticket's 401 ended the session once", 1, refused.size)
        server.verify()
    }

    @Test
    fun `failures back off 1, 2, 4 … 60 s times 0_5 to 1_0, and an open socket starts over`() {
        // The real table: every step between half and all of its base, the last one repeating.
        val bases = listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L, 60_000L)
        for ((attempt, base) in bases.withIndex()) {
            assertEquals(base / 2, WorkspaceSocket.backoffDelay(attempt, 0.0))
            assertEquals(base, WorkspaceSocket.backoffDelay(attempt, 1.0))
            for (r in listOf(0.1, 0.37, 0.5, 0.92, 0.9999)) {
                val d = WorkspaceSocket.backoffDelay(attempt, r)
                assertTrue("attempt $attempt: $d", d in base / 2..base)
            }
        }

        // Each failure in a row takes the next step; an open socket resets the count.
        val side = ServerSide()
        repeat(3) { server.answerWith(MockResponse().setResponseCode(503)) }
        server.answer("ticket")
        upgrade(side)
        server.answer("ticket")
        upgrade(side)
        val s = socket(random = 1.0)
        val delays = CopyOnWriteArrayList<Long>()
        s.start()
        val until = System.currentTimeMillis() + 5_000
        while (opened.get() < 1 && System.currentTimeMillis() < until) {
            s.lastDelay?.let { if (delays.lastOrNull() != it) delays += it }
            Thread.sleep(2)
        }
        assertEquals(listOf(40L, 80L, 160L), delays.toList())
        side.next().close(1001, "going away")
        await("the first step again") { s.lastDelay == 40L }
        await("open again") { opened.get() == 2 }
        server.verify()
    }

    @Test
    fun `a nudge leaves a ticket 429's Retry-After alone`() {
        server.answerWith(refusal("start dm too fast", retryAfter = "60"))
        val s = socket()
        s.start()
        await("the wait") { s.lastDelay == 60_000L }
        s.nudge()
        Thread.sleep(300)
        assertEquals(SocketState.DOWN, s.state.value)
        assertEquals("no second ticket before Retry-After", 1, tickets())
    }

    @Test
    fun `a 429 to the upgrade waits its Retry-After, and a nudge doesn't cut it short`() {
        server.answer("ticket")
        server.answerWith(MockResponse().setResponseCode(429).setHeader("Retry-After", "1"))
        server.answer("ticket")
        upgrade(ServerSide())
        val s = socket()
        s.start()
        await("the wait") { s.lastDelay == 1_000L }
        assertEquals(SocketState.DOWN, s.state.value)
        s.nudge()
        Thread.sleep(500)
        assertEquals("no second ticket before Retry-After", 1, tickets())
        await("open after Retry-After") { opened.get() == 1 }
        server.verify()
    }

    @Test
    fun `close is final, so its waiting retry never fires and start, nudge and check do nothing`() {
        server.answerWith(MockResponse().setResponseCode(503))
        val s = socket(quick.copy(backoff = listOf(300L)))
        s.start()
        await("the backoff") { s.state.value == SocketState.DOWN }
        s.close()
        s.start()
        s.nudge()
        s.check()
        Thread.sleep(700)
        assertEquals(SocketState.OFF, s.state.value)
        assertEquals("no second ticket", 1, tickets())
    }

    @Test
    fun `a new socket on the same pacing waits out the backoff of the one closed before it`() {
        repeat(2) { server.answerWith(MockResponse().setResponseCode(503)) }
        val pacing = SocketPacing()
        fun paced() = WorkspaceSocket(
            okhttp, WorkspaceSocket.socketUrl(server.url, w), { client.socketTicket(w) }, listener, scope,
            timing = quick.copy(backoff = listOf(600L)), random = { 1.0 }, pacing = pacing,
        ).also { sockets += it }
        val first = paced()
        first.start()
        await("the backoff") { first.state.value == SocketState.DOWN }
        first.close()
        val second = paced()
        second.start()
        assertEquals("it waits instead of asking at once", SocketState.DOWN, second.state.value)
        Thread.sleep(200)
        assertEquals(1, tickets())
        await("the ticket once the wait is over") { tickets() == 2 }
    }

    // The review's interleaving: the retry timer's delay ends while another call holds the socket's lock, and a newer
    // Retry-After arrives under that lock. Cancelling the timer then can't stop it; it must look again.
    @Test
    fun `a retry timer that fired while the lock was held doesn't connect past a newer Retry-After`() {
        server.answerWith(MockResponse().setResponseCode(503))
        val pacing = SocketPacing()
        val hold = AtomicBoolean(false)
        val clock = {
            if (hold.compareAndSet(true, false)) {
                // Called under the socket's lock by the nudge below: wait until the timer is past its delay.
                Thread.sleep(600)
                pacing.limit(System.currentTimeMillis() + 60_000)
            }
            System.currentTimeMillis()
        }
        val s = WorkspaceSocket(
            okhttp, WorkspaceSocket.socketUrl(server.url, w), { client.socketTicket(w) }, listener, scope,
            timing = quick.copy(backoff = listOf(200L)), now = clock, random = { 1.0 }, pacing = pacing,
        ).also { sockets += it }
        s.start()
        await("the backoff") { s.state.value == SocketState.DOWN }
        hold.set(true)
        s.nudge()
        Thread.sleep(600)
        assertEquals("no ticket before the newer Retry-After", 1, tickets())
        assertEquals(SocketState.DOWN, s.state.value)
    }

    @Test
    fun `closing for good drops the connection at once, also when the peer never answers the close`() {
        val side = ServerSide(answerClose = false)
        server.answer("ticket")
        upgrade(side)
        val s = socket()
        s.start()
        side.next()
        await("open") { s.state.value == SocketState.OPEN }
        s.close()
        await("the connection ended", timeoutMs = 3_000) { side.failures.get() > 0 }
    }

    @Test
    fun `check pings an open socket at once`() {
        val side = ServerSide()
        server.answer("ticket")
        upgrade(side)
        val s = socket(quick.copy(pingEvery = 60_000))
        s.start()
        side.next()
        await("open") { s.state.value == SocketState.OPEN }
        s.check()
        await("a ping") { side.received.contains("ping") }
    }

    /** A listener on 127.0.0.1 that reads the upgrade request and never answers it. */
    private fun silent(block: (ServerSocket, () -> java.io.BufferedReader) -> Unit) {
        ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { endpoint ->
            endpoint.soTimeout = 5_000
            block(endpoint) {
                val peer = endpoint.accept()
                peers += peer
                val request = peer.getInputStream().bufferedReader()
                assertEquals("GET /socket HTTP/1.1", request.readLine())
                while (!request.readLine().isNullOrEmpty()) Unit
                request
            }
        }
    }

    private val peers = CopyOnWriteArrayList<Socket>()

    private fun silentSocket(endpoint: ServerSocket, timing: WorkspaceSocket.Timing = quick) = WorkspaceSocket(
        okhttp, "ws://127.0.0.1:${endpoint.localPort}/socket", { SocketTicket("ticket") }, listener, scope, timing = timing,
    ).also { sockets += it }

    /** True when the phone closed its end: the read sees the end of the stream or a reset. */
    private fun closedByPhone(request: java.io.BufferedReader, peer: Socket): Boolean {
        peer.soTimeout = 2_000
        return try {
            request.read() < 0
        } catch (_: SocketTimeoutException) {
            false
        } catch (_: java.io.IOException) {
            true
        }
    }

    @Test
    fun `stopping a socket whose upgrade hangs ends the connection and the call`() {
        silent { endpoint, accept ->
            val s = silentSocket(endpoint)
            s.start()
            val request = accept()
            assertEquals(SocketState.CONNECTING, s.state.value)
            s.stop()
            assertEquals(SocketState.OFF, s.state.value)
            assertTrue("the phone closed the connection", closedByPhone(request, peers.last()))
            await("no call left running") { okhttp.dispatcher.runningCallsCount() == 0 }
        }
        peers.forEach { it.close() }
    }

    @Test
    fun `an upgrade nobody answers times out into the backoff, and an open socket outlives that timeout`() {
        silent { endpoint, accept ->
            val s = silentSocket(endpoint, quick.copy(backoff = listOf(60_000L), upgradeTimeout = 500))
            s.start()
            val request = accept()
            await("the backoff after the timeout", timeoutMs = 3_000) { s.state.value == SocketState.DOWN }
            assertTrue("the phone closed the connection", closedByPhone(request, peers.last()))
            s.stop()
        }
        peers.forEach { it.close() }

        // The upgrade's timeout ends with the upgrade: an open socket that hears nothing for longer stays open.
        val side = ServerSide()
        server.answer("ticket")
        upgrade(side)
        val open = socket(quick.copy(pingEvery = 60_000, upgradeTimeout = 300))
        open.start()
        val remote = side.next()
        await("open") { open.state.value == SocketState.OPEN }
        Thread.sleep(1_200)
        assertEquals(SocketState.OPEN, open.state.value)
        remote.send("""{"t":"wake"}""")
        await("the wake") { wakes.get() == 1 }
        assertEquals(1, opened.get())
    }

    @Test
    fun `stop closes the socket and nothing connects again`() {
        val side = ServerSide()
        server.answer("ticket")
        upgrade(side)
        val s = socket()
        s.start()
        side.next()
        await("open") { opened.get() == 1 }
        s.stop()
        assertEquals(SocketState.OFF, s.state.value)
        await("the server saw the close") { side.closes.contains(1000) }
        Thread.sleep(300)
        assertEquals(2, server.requestCount)
        assertEquals(0, leases.get() + removals.get())
    }
}
