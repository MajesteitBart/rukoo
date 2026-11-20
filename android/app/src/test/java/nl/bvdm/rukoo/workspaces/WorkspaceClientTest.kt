package nl.bvdm.rukoo.workspaces

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.long
import nl.bvdm.rukoo.account.BorrowedSession
import nl.bvdm.rukoo.core.RukooJson
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import okio.GzipSink
import okio.buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The workspace client against the real server's recorded answers (contract 8.6): every route's method, path and
 * body, the headers, no redirect followed, the 16 MiB cap, how refusals decode, and what a 401 does.
 */
class WorkspaceClientTest {
    private val server = RecordedWorkspaceServer()
    private val okhttp = OkHttpClient()
    private val http = OkHttpWorkspaceHttp(okhttp)
    private val refused = CopyOnWriteArrayList<BorrowedSession>()
    private val ref = Any()

    /** The session of whoever the next queued exchange was recorded for: their name is the token. */
    private val client = WorkspaceClient(http, { BorrowedSession(server.url, server.nextAuth ?: "olga", "tag", ref) }, { refused += it })

    @After
    fun tearDown() {
        server.close()
    }

    private val v = WorkspaceVectors
    private val w = v.id("workspace")

    private suspend fun <T> recorded(name: String, call: suspend WorkspaceClient.() -> T): T {
        server.answer(name)
        return client.call()
    }

    private suspend fun refusal(name: String, call: suspend WorkspaceClient.() -> Any?): WorkspaceError {
        server.answer(name)
        try {
            client.call()
        } catch (e: WorkspaceError) {
            return e
        }
        fail("$name: expected a WorkspaceError")
        throw AssertionError()
    }

    private fun body(name: String) = v.exchange(name).requestBody!!.jsonObject

    private fun str(name: String, key: String) = (body(name).getValue(key) as JsonPrimitive).content

    @Test
    fun `every route sends its method, path and body`() = runBlocking {
        val project = v.id("project")
        val random = v.id("random")
        val me = recorded("account") { identity() }
        assertEquals("olga@example.com", me.email)
        assertEquals("full", me.accountClass)
        assertEquals(emptyList<WorkspaceRef>(), recorded("list empty") { list() })
        assertEquals(listOf(WorkspaceRef(w, "Acme", "owner")), recorded("list") { list() })
        assertEquals(w, recorded("create workspace") { create("Acme", "Olga Owner") }.workspace?.id)
        val details = recorded("workspace") { get(w) }
        assertEquals("owner", details.me.role)
        assertTrue(details.workspace.generation.isNotEmpty())

        val made = recorded("create invite") { createInvite(w, "member", emptyList(), 86400) }
        assertEquals(v.id("secret"), made.secret)
        assertEquals(listOf(v.id("invite")), recorded("invites") { invites(w) }.map { it.id })
        val preview = recorded("preview invite") { previewInvite(w, v.id("secret")) }
        assertEquals("Olga Owner", preview.issuer.name)
        assertEquals("Acme", preview.workspace.name)
        val joined = recorded("join") { join(w, v.id("secret"), "Mila Member") }
        assertTrue("a first join is new", joined.created)
        assertEquals(v.id("mila"), joined.value.me.id)
        assertFalse("joining again answers the membership there is", recorded("join again") { join(w, v.id("secret"), "Mila Member") }.created)
        recorded("withdraw invite") { withdrawInvite(w, v.id("goneInvite")) }

        assertTrue(recorded("members") { members(w) }.members.any { it.id == v.id("gus") && it.role == "guest" })
        assertEquals("Mila M.", recorded("rename me") { renameMe(w, "Mila M.") }.name)
        assertEquals("admin", recorded("set role") { setRole(w, v.id("bart"), "admin") }.role)
        recorded("remove member") { removeMember(w, v.id("tom")) }
        recorded("leave workspace") { leave(w) }

        assertEquals(listOf("general"), recorded("channels") { channels(w) }.map { it.name })
        assertEquals("manager", recorded("create channel") { createChannel(w, "project", "private") }.role)
        assertEquals("Project X", recorded("rename channel") { renameChannel(w, project, "Project X") }.name)
        assertTrue(recorded("archive channel") { archiveChannel(w, v.id("old")) }.archived)
        assertTrue(recorded("join channel") { joinChannel(w, random) }.joined)
        assertEquals(RoomMember(v.id("pia"), "member"), recorded("admit") { admit(w, project, v.id("pia")) })
        assertEquals(2, recorded("channel members") { channelMembers(w, project) }.size)
        assertEquals(RoomMember(v.id("pia"), "manager"), recorded("channel role") { setChannelRole(w, project, v.id("pia"), "manager") })
        recorded("leave channel") { leaveChannel(w, random) }
        recorded("remove from channel") { removeFromChannel(w, random, v.id("tom")) }
        recorded("leave channel with successor") { leaveChannel(w, v.id("design"), successor = v.id("bart")) }

        val first = recorded("feed first pass") { changes(w) }
        assertTrue(first.directory.members && first.directory.channels && first.directory.blocks)
        val page = recorded("feed small page") { changes(w, limit = 2) }
        assertTrue(page.more)
        recorded("feed next page") { changes(w, after = page.next, limit = 2) }
        val after = recorded("member feed after") { changes(w, after = "AnyCursor_1") }
        assertEquals(listOf(v.id("message")), after.changes.single().removed)

        val send = RukooJson.decodeFromJsonElement(SendBody.serializer(), body("post"))
        val ack = recorded("post") { post(w, v.id("general"), send) }
        assertEquals(v.id("message"), ack.messageId)
        val op = recorded("operation") { operation(w, v.id("general"), v.id("operation")) }
        assertEquals(ack.seq, op?.seq)
        val unknownOp = v.exchange("operation unknown").path.substringAfterLast('/')
        assertNull("an operation the server has no message from is null", recorded("operation unknown") { operation(w, v.id("general"), unknownOp) })
        val events = recorded("events") { events(w, v.id("general"), after = 0, limit = 100) }
        assertEquals("channel.created", events.events.first().kind)
        assertEquals(v.id("message"), events.events.first { it.id == v.id("reply") }.root)
        val before = Regex("before=(\\d+)").find(v.exchange("events before").path)!!.groupValues[1].toLong()
        assertEquals(v.id("reply"), recorded("events before") { events(w, v.id("general"), before = before, limit = 1) }.events.single().id)
        val seq = (body("read")["seq"] as JsonPrimitive).long
        assertEquals(seq, recorded("read") { read(w, v.id("general"), seq) }.read)
        assertTrue(recorded("redact") { redact(w, v.id("general"), v.id("message")) }.redacted)
        val ticket = recorded("ticket") { socketTicket(w) }
        assertEquals(SOCKET_PROTOCOL, ticket.protocol)
        assertTrue(ticket.ticket.isNotEmpty())

        val dm = recorded("start dm") { startDm(w, listOf(v.id("mila"))) }
        assertTrue(dm.created)
        assertEquals("dm", dm.value.kind)
        assertNull(dm.value.name)
        assertEquals(listOf(v.id("olga"), v.id("mila")), dm.value.participants)
        assertEquals(v.id("olga"), dm.value.startedBy)
        val again = recorded("start dm again") { startDm(w, listOf(v.id("olga"))) }
        assertFalse(again.created)
        assertEquals(dm.value.conversation, again.value.conversation)
        assertEquals(3, recorded("start group dm") { startDm(w, listOf(v.id("mila"), v.id("pia"))) }.value.members)
        recorded("leave dm") { leaveDm(w, v.id("group")) }
        val block = recorded("block") { block(w, v.id("bart")) }
        assertTrue(block.created)
        assertEquals(v.id("bart"), block.value.member)
        val repeated = recorded("block again") { block(w, v.id("bart")) }
        assertFalse(repeated.created)
        assertEquals(block.value.at, repeated.value.at)
        assertEquals(listOf(v.id("bart")), recorded("blocks") { blocks(w) }.map { it.member })
        recorded("unblock") { unblock(w, v.id("bart")) }

        recorded("delete workspace") { deleteWorkspace(v.id("solo")) }
        server.verify()
        assertTrue("nobody was signed out", refused.isEmpty())
    }

    @Test
    fun `every request carries the bearer token, the protocol version and asks for JSON`() = runBlocking {
        recorded("members") { members(w) }
        recorded("start dm") { startDm(w, listOf(v.id("mila"))) }
        server.verify()
        assertEquals("Bearer mila", server.requests[0].getHeader("Authorization"))
        assertEquals("Bearer olga", server.requests[1].getHeader("Authorization"))
        for (request in server.requests) {
            assertEquals("1", request.getHeader("Rukoo-Workspace-Version"))
            assertEquals("application/json", request.getHeader("Accept"))
        }
        // Neither the token nor anything else goes in the address.
        assertTrue(server.requests.none { it.path!!.contains("mila") || it.path!!.contains("olga") })
        assertTrue(server.requests[1].getHeader("Content-Type")!!.startsWith("application/json"))
    }

    @Test
    fun `refusals decode with their scope, field, channels, member, limit and Retry-After`() = runBlocking {
        val lastManager = refusal("leave workspace last manager") { leave(w) }
        assertEquals("last_manager", lastManager.code)
        assertEquals(409, lastManager.status)
        assertEquals(listOf(v.id("project")), lastManager.channels)

        val blocked = refusal("start dm blocked") { startDm(w, listOf(v.id("bart"))) }
        assertEquals("blocked", blocked.code)
        assertEquals(v.id("bart"), blocked.member)

        val full = refusal("join full workspace") { join(w, str("join full workspace", "invite"), "Zoë") }
        assertEquals("quota", full.code)
        assertEquals("members", full.limit)
        assertEquals("workspace", full.scope)

        val tiny = v.id("tiny")
        assertEquals("conversations", refusal("create channel over quota") { createChannel(tiny, "one more", "workspace") }.limit)
        val inTiny = (body("start dm over quota").getValue("members").jsonArray.single() as JsonPrimitive).content
        val dmQuota = refusal("start dm over quota") { startDm(tiny, listOf(inTiny)) }
        assertEquals("quota", dmQuota.code)
        assertEquals("conversations", dmQuota.limit)

        val fast = refusal("start dm too fast") { startDm(w, listOf(v.id("mila"))) }
        assertEquals("rate_limited", fast.code)
        assertEquals(429, fast.status)
        assertEquals(v.exchange("start dm too fast").responseHeaders.getValue("retry-after").toLong(), fast.retryAfterS)
        assertEquals("workspace", fast.scope)

        val badName = refusal("create channel bad name") { createChannel(w, "two\nlines", "workspace") }
        assertEquals("invalid", badName.code)
        assertEquals("name", badName.field)
        assertEquals("members", refusal("start dm with guest") { startDm(w, listOf(v.id("gus"))) }.let { assertEquals("dm_unavailable", it.code); it.field })

        val gone = refusal("not a member") { get("w_AAAAAAAAAAAAAAAAAAAAAA") }
        assertEquals("not_found", gone.code)
        assertEquals("workspace", gone.scope)
        val noRoom = refusal("unknown conversation") { events(w, "c_AAAAAAAAAAAAAAAAAAAAAA", after = 0, limit = 50) }
        assertEquals("not_found", noRoom.code)
        assertEquals("conversation", noRoom.scope)
        val noPerson = refusal("block unknown") { block(w, "u_AAAAAAAAAAAAAAAAAAAAAA") }
        assertEquals("not_found", noPerson.code)
        assertNull(noPerson.scope)

        val upgrade = refusal("upgrade required") { get(w) }
        assertEquals("upgrade_required", upgrade.code)
        assertEquals(1, upgrade.minVersion)
        assertEquals("invite_gone", refusal("preview withdrawn invite") { previewInvite(w, str("preview withdrawn invite", "invite")) }.code)
        assertEquals("cosign_required", refusal("admit guest as manager") { admit(w, v.id("project"), v.id("gus")) }.code)
        assertEquals("members_remain", refusal("delete workspace members remain") { deleteWorkspace(tiny) }.code)
        val archived = refusal("post archived channel") { post(w, v.id("old"), RukooJson.decodeFromJsonElement(SendBody.serializer(), body("post archived channel"))) }
        assertEquals("archived", archived.code)
        assertEquals("conversation", archived.scope)
        server.verify()
        assertTrue(refused.isEmpty())
    }

    @Test
    fun `the feed and the outbox get their own answers as errors the UI never shows`() = runBlocking {
        fun sent(name: String) = RukooJson.decodeFromJsonElement(SendBody.serializer(), body(name))
        val general = v.id("general")
        for ((name, code) in listOf(
            "post changed retry" to "operation_conflict",
            "post stale grant" to "stale_grant",
            "post stale generation" to "stale_generation",
            "post expired" to "submission_expired",
        )) {
            val e = refusal(name) { post(w, general, sent(name)) }
            assertEquals(name, code, e.code)
            assertTrue(name, e.internal)
        }
        val reset = refusal("bad cursor") { changes(w, after = "AAAA") }
        assertEquals("reset_required", reset.code)
        assertEquals(410, reset.status)
        assertTrue(reset.internal)
        assertEquals("operationId", refusal("post ahead of time") { post(w, general, sent("post ahead of time")) }.field)
        assertEquals("mentions", refusal("post bad mentions") { post(w, general, sent("post bad mentions")) }.field)
        server.verify()
    }

    @Test
    fun `a 401 for the account signs out once, with the session it was for`() = runBlocking {
        val e = refusal("signed out list") { list() }
        assertEquals("signed_out", e.code)
        assertEquals(401, e.status)
        assertEquals("account", e.scope)
        assertEquals(1, refused.size)
        assertSame(ref, refused.single().ref)
        assertEquals("rex", refused.single().token)

        refusal("signed out workspace route") { changes(w) }
        assertEquals("each refused call reports its own 401 once", 2, refused.size)

        // A 401 about a socket ticket names the workspace, and signs nobody out.
        server.answerWith(MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized","scope":"workspace"}"""))
        try {
            client.socketTicket(w)
            fail("expected signed_out")
        } catch (e: WorkspaceError) {
            assertEquals("signed_out", e.code)
        }
        assertEquals(2, refused.size)
        server.verify()
    }

    @Test
    fun `a 401 whose body is cut off is a network failure and signs nobody out`() = runBlocking {
        val body = """{"error":"unauthorized","scope":"account","message":"${"x".repeat(4096)}"}"""
        for (status in listOf(401, 403)) {
            server.answerWith(
                MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)
                    .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY),
            )
            try {
                client.list()
                fail("expected network")
            } catch (e: WorkspaceError) {
                assertEquals("$status", "network", e.code)
                assertEquals("$status: no whole answer came, so no status", 0, e.status)
            }
        }
        assertTrue("nobody was signed out", refused.isEmpty())
    }

    @Test
    fun `without a session nothing is sent`() = runBlocking {
        val signedOut = WorkspaceClient(http, { null }, { refused += it })
        try {
            signedOut.list()
            fail("expected signed_out")
        } catch (e: WorkspaceError) {
            assertEquals("signed_out", e.code)
            assertEquals(0, e.status)
        }
        assertEquals(0, server.requestCount)
        assertTrue(refused.isEmpty())
    }

    @Test
    fun `a lost answer is a network failure, and the retry with the same body gets the first answer`() = runBlocking {
        val send = RukooJson.decodeFromJsonElement(SendBody.serializer(), body("post"))
        server.answer("post", lost = true)
        try {
            client.post(w, v.id("general"), send)
            fail("expected network")
        } catch (e: WorkspaceError) {
            assertEquals("network", e.code)
        }
        server.answer("post retry")
        val ack = client.post(w, v.id("general"), send)
        assertEquals(v.id("message"), ack.messageId)
        val (first, second) = server.requests
        assertEquals(first.body.readUtf8(), second.body.readUtf8())
        server.verify()
    }

    /**
     * OkHttp resends a request on its own when a pooled connection drops after the request went out. For a create
     * that would make a second channel or invite, or a 409 for the one the first request made, so the client sends
     * every write once and leaves the retry to the caller. Each write here goes out on the connection a GET used.
     */
    @Test
    fun `a lost answer on a pooled connection is not sent again`() = runBlocking {
        val writes = listOf<Pair<String, suspend WorkspaceClient.() -> Unit>>(
            "create channel" to { createChannel(w, "project", "private") },
            "leave channel" to { leaveChannel(w, v.id("random")) },
            "join channel" to { joinChannel(w, v.id("random")) },
        )
        for ((name, write) in writes) {
            recorded("members") { members(w) }
            val before = server.requests.size
            server.answer(name, lost = true)
            try {
                client.write()
                fail("$name: expected network")
            } catch (e: WorkspaceError) {
                assertEquals(name, "network", e.code)
            }
            val sent = server.requests.drop(before)
            assertEquals("$name is sent once", 1, sent.size)
            assertTrue("$name reused the GET's connection", sent.single().sequenceNumber > 0)
        }
        // A read is safe to repeat, so OkHttp still sends it again on a fresh connection.
        recorded("members") { members(w) }
        val before = server.requests.size
        server.answer("channels", lost = true)
        server.answer("channels")
        assertEquals(listOf("general"), client.channels(w).map { it.name })
        assertEquals(2, server.requests.size - before)
        server.verify()
    }

    @Test
    fun `a redirect is not followed, so the token stays with the server`() = runBlocking {
        MockWebServer().use { elsewhere ->
            elsewhere.enqueue(MockResponse().setBody("""{"workspaces":[]}"""))
            server.answerWith(MockResponse().setResponseCode(302).setHeader("Location", elsewhere.url("/v1/workspaces")))
            try {
                client.list()
                fail("expected an error")
            } catch (e: WorkspaceError) {
                assertEquals("server", e.code)
                assertEquals(302, e.status)
            }
            assertEquals(0, elsewhere.requestCount)
        }
        assertFalse(http.client.followRedirects)
        assertFalse(http.client.followSslRedirects)
    }

    @Test
    fun `answers are capped at 16 MiB after decompression`() = runBlocking {
        val max = OkHttpWorkspaceHttp.MAX_BYTES.toInt()
        fun padded(size: Int): String {
            val head = """{"workspaces":[],"pad":""""
            return head + "x".repeat(size - head.length - 2) + "\"}"
        }
        server.answerWith(MockResponse().setBody(padded(max)))
        assertEquals(emptyList<WorkspaceRef>(), client.list())

        server.answerWith(MockResponse().setBody(padded(max + 1)))
        try {
            client.list()
            fail("expected a refusal of the size")
        } catch (e: WorkspaceError) {
            assertEquals("server", e.code)
        }

        // A few kilobytes of gzip that unpack into more than the cap.
        val zipped = Buffer()
        GzipSink(zipped).buffer().use { it.writeUtf8(padded(max + 1024)) }
        assertTrue(zipped.size < 100_000)
        server.answerWith(MockResponse().setHeader("Content-Encoding", "gzip").setBody(zipped))
        try {
            client.list()
            fail("expected a refusal of the unpacked size")
        } catch (e: WorkspaceError) {
            assertEquals("server", e.code)
        }
        server.verify()
    }

    @Test
    fun `the largest valid events page is read whole`() = runBlocking {
        // The server takes any well-formed text of 1 to 16,384 bytes, control characters included, and JSON writes
        // each of those as six bytes: 50 such messages are 4.9 MB, 100 are 9.8 MB.
        val text = "".repeat(TEXT_BYTES)
        val olga = v.id("olga")
        fun page(n: Int) = RukooJson.encodeToString(
            EventPage.serializer(),
            EventPage((1..n).map { WireEvent(it.toLong(), "e_" + it.toString().padStart(22, '0'), WireEvent.MESSAGE_POSTED, olga, 1, text = text) }, n.toLong(), 1),
        )
        for (n in listOf(50, 100)) {
            val body = page(n)
            assertTrue(body.length > n * TEXT_BYTES * 6)
            server.answerWith(MockResponse().setHeader("Content-Type", "application/json").setBody(body))
            val got = client.events(w, v.id("general"), before = n + 1L, limit = n)
            assertEquals(n, got.events.size)
            assertEquals(text, got.events.last().text)
        }
    }

    @Test
    fun `cancelling a call stops it while its body is still coming`() = runBlocking {
        val headers = CompletableDeferred<Unit>()
        val base = OkHttpClient.Builder().eventListener(object : EventListener() {
            override fun responseHeadersEnd(call: Call, response: Response) {
                headers.complete(Unit)
            }
        }).build()
        val slow = OkHttpWorkspaceHttp(base)
        server.answerWith(MockResponse().setHeader("Content-Type", "application/json").setBody("[]").setBodyDelay(5, TimeUnit.SECONDS))
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val job = scope.launch { runCatching { slow.request(server.url, "GET", "/v1/workspaces", null, "olga") } }
            withTimeout(5_000) { headers.await() }
            delay(200)
            val t0 = System.nanoTime()
            job.cancel()
            job.join()
            val ms = (System.nanoTime() - t0) / 1_000_000
            assertTrue("joined ${ms} ms after the cancel", ms < 1_000)
            withTimeout(2_000) { while (base.dispatcher.runningCallsCount() > 0) delay(10) }
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `an answer of the wrong shape is a server failure`() = runBlocking {
        server.answerWith(MockResponse().setBody("""{"workspaces":"none"}"""))
        try {
            client.list()
            fail("expected server")
        } catch (e: WorkspaceError) {
            assertEquals("server", e.code)
        }
        server.answerWith(MockResponse().setBody("<html>"))
        try {
            client.list()
            fail("expected server")
        } catch (e: WorkspaceError) {
            assertEquals("server", e.code)
        }
        server.answerWith(MockResponse().setResponseCode(503).setBody("<html>busy</html>"))
        try {
            client.list()
            fail("expected server")
        } catch (e: WorkspaceError) {
            assertEquals("server", e.code)
            assertEquals(503, e.status)
        }
    }

    @Test
    fun `an ID that isn't one never reaches a path`() = runBlocking {
        for (bad in listOf("..", "w_x/../../v1/account", "", "w_a?b=c", "w_ä")) {
            try {
                client.get(bad)
                fail("expected not_found for $bad")
            } catch (e: WorkspaceError) {
                assertEquals("not_found", e.code)
            }
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `connections are pooled and the timeouts are 15, 30 and 45 seconds`() = runBlocking {
        recorded("members") { members(w) }
        recorded("channels") { channels(w) }
        server.verify()
        assertEquals("the second call reuses the first one's connection", 1, server.requests[1].sequenceNumber)
        assertEquals(15_000, http.client.connectTimeoutMillis)
        assertEquals(30_000, http.client.readTimeoutMillis)
        assertEquals(30_000, http.client.writeTimeoutMillis)
        assertEquals(45_000, http.client.callTimeoutMillis)
        assertNotNull(http.client.connectionPool)
    }
}
