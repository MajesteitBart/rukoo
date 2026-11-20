package nl.bvdm.rukoo.workspaces

import java.util.Collections
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.account.BorrowedSession
import nl.bvdm.rukoo.core.RukooJson
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The outbox (contract §3.8, §3.14) on real SQLite, against the real server's recorded answers where the server can
 * be made to give them (contract 8.6), and against answers built from those recordings where an operation ID or grant
 * differs from the recording.
 */
class OutboxTest {
    private val v = WorkspaceVectors
    private val w = v.id("workspace")
    private val general = v.id("general")
    private val old = v.id("old")
    private val olga = v.id("olga")
    private val mila = v.id("mila")

    /** What the recording sent: Olga's grant in #general, the workspace's generation and her message to Mila. */
    private val grant = str("post", "grant")
    private val generation = str("post", "generation")
    private val text = str("post", "text")
    private val mentions = listOf(Mention(mila, 4, 9))

    private val server = RecordedWorkspaceServer()
    private val db = TestDb()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile
    private var clock = TestDb.NOW

    private val ids = ArrayDeque<String>()
    private val idTimes = CopyOnWriteArrayList<Long>()
    private val restored = CopyOnWriteArrayList<String>()
    private val removed = CopyOnWriteArrayList<String>()
    private val upgrades = CopyOnWriteArrayList<String>()

    private val ok = OkHttpWorkspaceHttp(OkHttpClient())

    /** Makes the restore hook throw, as a restore transaction that failed would. */
    @Volatile
    private var failRestore = false

    /** Whatever the test puts here runs before each request goes out, with the request's method and path. */
    @Volatile
    private var beforeRequest: (String, String) -> Unit = { _, _ -> }
    private val http = WorkspaceHttp { s, method, path, body, token ->
        beforeRequest(method, path)
        ok.request(s, method, path, body, token)
    }

    private fun client(http: WorkspaceHttp = this.http) =
        WorkspaceClient(http, { BorrowedSession(server.url, server.nextAuth ?: "olga", "tag", Any()) }, {})

    private lateinit var store: WorkspaceStore

    private fun outbox(store: WorkspaceStore = this.store, client: WorkspaceClient = client(), roomsInFlight: Int = 2) = Outbox(
        store, client, scope,
        hooks = object : Outbox.Hooks {
            override suspend fun restored(ws: String, details: WorkspaceDetails) {
                if (failRestore) throw IllegalStateException("the restore path failed")
                restored += details.workspace.generation
                // What the service's restore path does with the outbox (§3.6 "Restore").
                store.tx {
                    val before = getWs(ws)!!.generation
                    updateWs(ws, mapOf("generation" to details.workspace.generation))
                    markLookup(ws, before)
                }
            }

            override fun removed(ws: String) {
                removed += ws
            }

            override fun upgrade(ws: String) {
                upgrades += ws
            }
        },
        timing = Outbox.Timing(roomsInFlight = roomsInFlight),
        now = { clock },
        newId = { ms ->
            idTimes += ms
            synchronized(ids) { ids.removeFirstOrNull() } ?: Uuid7.next(ms)
        },
    )

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
        db.close()
    }

    private fun str(name: String, key: String) = (v.exchange(name).requestBody!!.jsonObject.getValue(key) as JsonPrimitive).content

    private fun op(name: String) = str(name, "operationId")

    /** A recorded answer for a request the recording can't match, such as another operation ID. */
    private fun reply(name: String): MockResponse {
        val e = v.exchange(name)
        val res = MockResponse().setResponseCode(e.status)
        for ((k, value) in e.responseHeaders) res.setHeader(k, value)
        e.responseBody?.let { res.setHeader("Content-Type", "application/json").setBody(it.toString()) }
        return res
    }

    private fun created(op: String, seq: Long, message: String = "e_" + "N".repeat(21) + seq % 10) = MockResponse()
        .setResponseCode(201)
        .setHeader("Content-Type", "application/json")
        .setBody("""{"operationId":"$op","messageId":"$message","seq":$seq}""")

    private fun room(id: String, grant: String, head: Long = 7) = Change(
        conversation = id, kind = "channel", name = "room", visibility = "workspace", grant = grant, role = "member",
        members = 3, head = head, floor = 1, read = head, unread = 0, mentions = 0,
    )

    /** Olga's workspace with #general cached up to seq 7, and a clock measured a minute ago unless [clockKnown] is false. */
    private suspend fun seed(gen: String = generation, roomGrant: String = grant, clockKnown: Boolean = true) {
        store = db.store { clock }
        store.tx {
            insertWs(WsRow(id = w, name = "Acme", role = "owner", me = olga, myName = "Olga Owner", generation = gen))
            upsertRoom(w, room(general, roomGrant))
            setRoomFields(w, general, mapOf("lo" to 1L, "hi" to 7L))
            upsertRoom(w, room(old, str("post archived channel", "grant")))
            if (clockKnown) {
                setMeta(Outbox.CLOCK_OFFSET, "0")
                setMeta(Outbox.CLOCK_AT, (clock - 60_000).toString())
            }
        }
    }

    private suspend fun rows(): List<OutboxRow> = store.read { outboxForWs(w) }

    private suspend fun row(local: String): OutboxRow = store.read { getOutbox(local) } ?: throw AssertionError("no row $local")

    private fun posts(): List<RecordedRequest> = server.requests.filter { it.method == "POST" && it.path.orEmpty().endsWith("/messages") }

    private fun bodyOf(r: RecordedRequest): JsonObject = RukooJson.parseToJsonElement(r.body.clone().readUtf8()).jsonObject

    private fun field(r: RecordedRequest, key: String) = (bodyOf(r).getValue(key) as JsonPrimitive).content

    /** The outbox as another connection reads it from the file: only what was committed. */
    private fun onDisk(): List<Triple<String, String?, String>> {
        val conn = db.driver.open(db.file.path)
        try {
            return conn.prepare("SELECT local, operationId, state FROM outbox ORDER BY createdAt").use { st ->
                buildList { while (st.step()) add(Triple(st.getText(0), if (st.isNull(1)) null else st.getText(1), st.getText(2))) }
            }
        } finally {
            conn.close()
        }
    }

    @Test
    fun `the row and its operation ID are on disk before the POST goes out, and the 201 caches the message`() = runBlocking {
        seed(clockKnown = false)
        val box = outbox()
        val sent = CopyOnWriteArrayList<Outbox.Sent>()
        scope.launch { box.sent.collect { sent += it } }
        delay(100)
        val seen = CopyOnWriteArrayList<List<Triple<String, String?, String>>>()
        beforeRequest = { method, path -> if (method == "POST" && path.endsWith("/messages")) seen += onDisk() }
        ids += op("post")
        server.answer("workspace")
        server.answer("post")

        val local = box.enqueue(w, general, null, text, mentions)
        // Written before anything was sent: queued, without an ID yet.
        assertEquals(listOf(Triple(local, null, "queued")), onDisk())
        box.synced(w)
        assertTrue(box.flush(10_000))

        assertEquals("the POST went out once", 1, posts().size)
        assertEquals(listOf(listOf(Triple(local, op("post"), "sending"))), seen)
        // The ID's time is the server's: workspace.time − (t0 + t1) / 2 with t0 = t1.
        val time = v.exchange("workspace").body!!["workspace"]!!.jsonObject["time"].toString().toLong()
        assertEquals(listOf(time), idTimes)
        server.verify()

        assertTrue(rows().isEmpty())
        val roomRow = store.read { getRoom(w, general) }!!
        assertEquals(8L, roomRow.hi)
        assertEquals(8L, roomRow.read)
        assertEquals(8L, roomRow.readLocal)
        assertEquals(8L, roomRow.readSent)
        val event = store.read { eventAt(w, general, 8) }!!
        assertEquals(v.id("message"), event.id)
        assertEquals(text, event.text)
        assertEquals(mentions, event.mentions)
        assertEquals(olga, event.actor)
        delay(50)
        assertEquals(listOf(Outbox.Sent(w, general, local, v.id("message"), 8)), sent.toList())
    }

    @Test
    fun `an answer lost on the way back is sent again with the same ID and bytes, and the replay posts it once`() = runBlocking {
        seed()
        val box = outbox()
        ids += op("post")
        server.answer("post", lost = true)
        server.answer("post retry")
        box.synced(w)
        val local = box.enqueue(w, general, null, text, mentions)
        assertFalse(box.flush(10_000))

        val waiting = row(local)
        assertEquals("queued", waiting.state)
        assertEquals(1, waiting.attempts)
        assertEquals(clock + 2_000, waiting.nextAt)
        assertEquals(op("post"), waiting.operationId)
        assertEquals(1, posts().size)

        clock += 2_000
        assertTrue(box.flush(10_000))
        server.verify()
        val (first, second) = posts()
        assertEquals(first.body.clone().readUtf8(), second.body.clone().readUtf8())
        assertEquals("one ID for both attempts", 1, idTimes.size)
        assertTrue(rows().isEmpty())
        assertEquals(1L, store.read { sql.long("SELECT COUNT(*) FROM event WHERE ws = ? AND id = ?", w, v.id("message")) })
    }

    @Test
    fun `stale_grant holds the row and its room, and Send keeps the operation ID with the current grant`() = runBlocking {
        val oldGrant = str("post stale grant", "grant")
        seed(roomGrant = oldGrant)
        val box = outbox()
        ids += op("post stale grant")
        ids += op("post")
        server.answer("post stale grant")
        box.synced(w)
        val local = box.enqueue(w, general, null, text, mentions)
        assertTrue(box.flush(10_000))
        assertEquals("held" to "stale_grant", row(local).let { it.state to it.reason })
        assertEquals(op("post stale grant"), row(local).operationId)

        // A later message waits behind the held one and doesn't go out.
        val later = box.enqueue(w, general, null, "Later", emptyList())
        box.flush(10_000)
        assertEquals(1, posts().size)
        assertEquals(
            listOf(PendingState.HELD, PendingState.WAITING),
            Outbox.pending(rows()).map { it.state },
        )

        // The person was let back in: the room has a new grant. Send keeps the ID and takes that grant.
        store.tx { setRoomFields(w, general, mapOf("grantId" to grant)) }
        server.answerWith(created(op("post stale grant"), 8, v.id("message")))
        server.answerWith(created(op("post"), 9))
        box.resend(local, ResendMode.SEND)
        assertTrue(box.flush(10_000))
        server.verify()

        val (_, resent, next) = posts()
        assertEquals(op("post stale grant"), field(resent, "operationId"))
        assertEquals(grant, field(resent, "grant"))
        assertEquals(text, field(resent, "text"))
        assertEquals("Later", field(next, "text"))
        assertTrue(rows().isEmpty())
        assertNull(store.read { getOutbox(later) })
    }

    @Test
    fun `discarding a held row sends the rows behind it without another nudge`() = runBlocking {
        val oldGrant = str("post stale grant", "grant")
        seed(roomGrant = oldGrant)
        val box = outbox()
        ids += op("post stale grant")
        server.answer("post stale grant")
        box.synced(w)
        val held = box.enqueue(w, general, null, text, mentions)
        assertTrue(box.flush(10_000))
        val later = box.enqueue(w, general, null, "Later", emptyList())
        box.flush(10_000)
        assertEquals(1, posts().size)
        assertEquals(listOf(PendingState.HELD, PendingState.WAITING), Outbox.pending(rows()).map { it.state })

        val fresh = "01a1f5ec-a6e1-7000-8000-000000000004"
        ids += fresh
        server.answerWith(created(fresh, 8))
        box.discard(held)
        // No flush, kick, wake or new send: the discard itself runs the queue for the row behind.
        val until = System.currentTimeMillis() + 5_000
        while (store.read { getOutbox(later) } != null && System.currentTimeMillis() < until) delay(10)
        assertNull(store.read { getOutbox(later) })
        server.verify()
        assertEquals(2, posts().size)
        assertEquals("Later", field(posts().last(), "text"))
        assertEquals(fresh, field(posts().last(), "operationId"))
        assertTrue(rows().isEmpty())
    }

    @Test
    fun `a 4xx the table doesn't list fails the row instead of retrying it, and a 403 of any code means no access`() = runBlocking {
        seed()
        val box = outbox()
        box.synced(w)
        fun answer(status: Int, body: String?) = MockResponse().setResponseCode(status).apply {
            if (body != null) setHeader("Content-Type", "application/json").setBody(body)
        }
        for ((refusal, reason) in listOf(
            answer(403, """{"error":"cosign_required","message":"An owner has to agree."}""") to "no_access",
            answer(403, """{"error":"workspace_account_scope"}""") to "no_access",
            answer(409, """{"error":"blocked"}""") to "invalid",
            answer(409, """{"error":"something_new"}""") to "invalid",
            answer(400, """{"error":"something_new"}""") to "invalid",
            answer(413, """{"error":"something_new"}""") to "invalid",
        )) {
            server.answerWith(refusal)
            val local = box.enqueue(w, general, null, text, mentions)
            assertTrue("a failed row waits for the person", box.flush(10_000))
            val r = row(local)
            assertEquals("failed" to reason, r.state to r.reason)
            assertEquals(0, r.attempts)
            box.discard(local)
        }
        assertEquals(6, posts().size)

        // A proxy's 408 is a timeout: it waits out the backoff with the same ID, as a 5xx does.
        server.answerWith(answer(408, null))
        val timedOut = box.enqueue(w, general, null, text, mentions)
        assertFalse(box.flush(10_000))
        assertEquals("queued", row(timedOut).state)
        assertEquals(1, row(timedOut).attempts)
        assertEquals(clock + 2_000, row(timedOut).nextAt)
        box.discard(timedOut)

        // A lookup refused for good: a 403 means no access, another 4xx leaves the person to decide.
        server.answerWith(reply("post expired"))
        server.answerWith(answer(403, """{"error":"cosign_required"}"""))
        val noAccess = box.enqueue(w, general, null, text, mentions)
        assertTrue(box.flush(10_000))
        assertEquals("failed" to "no_access", row(noAccess).let { it.state to it.reason })
        box.discard(noAccess)

        server.answerWith(reply("post expired"))
        server.answerWith(answer(400, """{"error":"something_new"}"""))
        val unsure = box.enqueue(w, general, null, text, mentions)
        assertTrue(box.flush(10_000))
        assertEquals("held" to "unknown", row(unsure).let { it.state to it.reason })
        server.verify()
    }

    @Test
    fun `a send that stops on a failing hook goes back to the queue instead of staying sending`() = runBlocking {
        val oldGeneration = str("post stale generation", "generation")
        seed(gen = oldGeneration)
        val box = outbox()
        ids += op("post stale generation")
        server.answer("post stale generation")
        server.answer("workspace")
        failRestore = true
        box.synced(w)
        val local = box.enqueue(w, general, null, text, mentions)
        assertFalse(box.flush(10_000))
        server.verify()

        val r = row(local)
        assertEquals("queued", r.state)
        assertEquals(op("post stale generation"), r.operationId)
        assertEquals(1, r.attempts)
        assertEquals(clock + 2_000, r.nextAt)
        assertEquals(listOf(PendingState.QUEUED), Outbox.pending(rows()).map { it.state })

        // The room isn't blocked: after the backoff the same ID goes out again, and this time the restore runs.
        failRestore = false
        clock += 2_000
        server.answer("post stale generation")
        server.answer("workspace")
        server.answerWith(reply("operation unknown"))
        assertTrue(box.flush(10_000))
        server.verify()
        assertEquals(1, idTimes.size)
        assertEquals(listOf(generation), restored.toList())
        assertEquals("held" to "unknown", row(local).let { it.state to it.reason })
    }

    @Test
    fun `submission_expired is looked up, and an operation the server has is sent`() = runBlocking {
        seed()
        val box = outbox()
        ids += op("post")
        server.answerWith(reply("post expired"))
        server.answer("operation")
        box.synced(w)
        val local = box.enqueue(w, general, null, text, mentions)
        assertTrue(box.flush(10_000))
        server.verify()

        assertEquals(1, idTimes.size)
        assertNull(store.read { getOutbox(local) })
        assertEquals(text, store.read { eventAt(w, general, 8) }!!.text)
        assertEquals(op("post"), field(posts().single(), "operationId"))
    }

    @Test
    fun `submission_expired the server doesn't know is held as unknown, and only Send makes a new ID`() = runBlocking {
        seed()
        val box = outbox()
        val unknown = v.exchange("operation unknown").path.substringAfterLast('/')
        val fresh = "01a1f5ec-a6e1-7000-8000-000000000001"
        ids += unknown
        ids += fresh
        server.answerWith(reply("post expired"))
        server.answer("operation unknown")
        box.synced(w)
        val local = box.enqueue(w, general, null, text, mentions)
        assertTrue(box.flush(10_000))
        assertEquals("held" to "unknown", row(local).let { it.state to it.reason })
        assertEquals(unknown, row(local).operationId)

        // Nothing goes out by itself, however often the queue runs.
        clock += 3_600_000
        box.kick(retryNow = true)
        box.flush(10_000)
        assertEquals(2, server.requests.size)

        server.answerWith(created(fresh, 8))
        box.resend(local, ResendMode.SEND)
        assertTrue(box.flush(10_000))
        server.verify()
        assertEquals(fresh, field(posts().last(), "operationId"))
        assertEquals(generation, field(posts().last(), "generation"))
    }

    @Test
    fun `stale_generation measures the workspace, runs the restore hook and looks the message up`() = runBlocking {
        val oldGeneration = str("post stale generation", "generation")
        seed(gen = oldGeneration)
        val box = outbox()
        ids += op("post stale generation")
        server.answer("post stale generation")
        server.answer("workspace")
        server.answerWith(reply("operation unknown"))
        box.synced(w)
        val local = box.enqueue(w, general, null, text, mentions)
        assertTrue(box.flush(10_000))
        server.verify()

        assertEquals(listOf(generation), restored.toList())
        assertEquals(generation, store.read { getWs(w) }!!.generation)
        assertEquals("held" to "unknown", row(local).let { it.state to it.reason })
        val lookup = server.requests.last()
        assertEquals("GET", lookup.method)
        assertTrue(lookup.path!!.endsWith("/operations/${op("post stale generation")}"))
    }

    @Test
    fun `an ID ahead of the server's clock is made again once from a measured clock`() = runBlocking {
        seed()
        val box = outbox()
        ids += op("post ahead of time")
        ids += op("post")
        server.answer("post ahead of time")
        server.answer("workspace")
        server.answer("post")
        box.synced(w)
        box.enqueue(w, general, null, text, mentions)
        assertTrue(box.flush(10_000))
        server.verify()
        assertTrue(rows().isEmpty())
        assertEquals(2, idTimes.size)
    }

    @Test
    fun `archived, quota and mentions refusals fail the row with what the person can do`() = runBlocking {
        seed()
        val box = outbox()
        box.synced(w)

        ids += op("post archived channel")
        server.answer("post archived channel")
        val archived = box.enqueue(w, old, null, str("post archived channel", "text"), emptyList())
        box.flush(10_000)
        assertEquals("failed" to "archived", row(archived).let { it.state to it.reason })
        assertMode(box, archived, ResendMode.RETRY)
        assertMode(box, archived, ResendMode.SEND)
        box.discard(archived)
        assertNull(store.read { getOutbox(archived) })

        // quota: Retry sends the same ID again.
        ids += op("post")
        server.answerWith(
            MockResponse().setResponseCode(413).setHeader("Content-Type", "application/json")
                .setBody("""{"error":"quota","message":"This workspace has no room for more messages.","scope":"workspace","limit":"bytes"}"""),
        )
        val quota = box.enqueue(w, general, null, text, mentions)
        box.flush(10_000)
        assertEquals("failed" to "quota", row(quota).let { it.state to it.reason })
        assertMode(box, quota, ResendMode.WITHOUT_MENTIONS)
        server.answerWith(created(op("post"), 8))
        box.resend(quota, ResendMode.RETRY)
        assertTrue(box.flush(10_000))
        assertEquals(op("post"), field(posts().last(), "operationId"))
        assertEquals(field(posts()[posts().size - 2], "text"), field(posts().last(), "text"))

        // mentions: Send without mentions clears them and takes a new ID.
        val again = "01a1f5ec-a6e1-7000-8000-000000000002"
        val third = "01a1f5ec-a6e1-7000-8000-000000000003"
        ids += again
        ids += third
        server.answerWith(reply("post bad mentions"))
        val named = box.enqueue(w, general, null, text, mentions)
        box.flush(10_000)
        assertEquals("failed" to "mentions", row(named).let { it.state to it.reason })
        assertMode(box, named, ResendMode.RETRY)
        server.answerWith(created(third, 9))
        box.resend(named, ResendMode.WITHOUT_MENTIONS)
        assertTrue(box.flush(10_000))
        server.verify()
        val last = bodyOf(posts().last())
        assertEquals(third, (last.getValue("operationId") as JsonPrimitive).content)
        assertEquals(0, last.getValue("mentions").jsonArray.size)
        assertTrue(rows().isEmpty())
    }

    private suspend fun assertMode(box: Outbox, local: String, mode: ResendMode) {
        try {
            box.resend(local, mode)
            fail("$mode shouldn't answer ${row(local).reason}")
        } catch (e: WorkspaceError) {
            assertEquals("invalid", e.code)
            assertEquals("mode", e.field)
        }
    }

    @Test
    fun `a 429 waits its Retry-After with the same ID, and a wake doesn't send it early`() = runBlocking {
        seed()
        val box = outbox()
        ids += op("post")
        server.answerWith(
            MockResponse().setResponseCode(429).setHeader("Retry-After", "7").setHeader("Content-Type", "application/json")
                .setBody(v.exchange("start dm too fast").responseBody.toString()),
        )
        box.synced(w)
        val local = box.enqueue(w, general, null, text, mentions)
        assertFalse(box.flush(10_000))
        val waiting = row(local)
        assertEquals("queued", waiting.state)
        assertEquals(clock + 7_000, waiting.nextAt)
        assertEquals(0, waiting.attempts)

        box.kick(retryNow = true)
        box.flush(10_000)
        assertEquals(1, posts().size)
        assertEquals(clock + 7_000, row(local).nextAt)

        clock += 7_000
        server.answer("post")
        assertTrue(box.flush(10_000))
        server.verify()
        assertEquals(field(posts()[0], "operationId"), field(posts()[1], "operationId"))
    }

    @Test
    fun `network failures and 5xx back off 2, 5, 15, 30, 60 s and then every 60 s, with the same ID`() = runBlocking {
        seed()
        val calls = AtomicInteger()
        val failing = WorkspaceHttp { _, _, _, _, _ ->
            if (calls.incrementAndGet() % 2 == 0) throw WorkspaceError.fromAnswer(503, null) else throw WorkspaceError("network")
        }
        val box = outbox(client = client(failing))
        box.synced(w)
        val local = box.enqueue(w, general, null, text, mentions)
        val waits = ArrayList<Long>()
        repeat(7) {
            box.flush(10_000)
            val r = row(local)
            assertEquals("queued", r.state)
            waits += r.nextAt - clock
            clock = r.nextAt
        }
        assertEquals(listOf(2_000L, 5_000L, 15_000L, 30_000L, 60_000L, 60_000L, 60_000L), waits)
        assertEquals(7, row(local).attempts)
        assertEquals(1, idTimes.size)

        // A wake retries at once.
        box.kick(w, retryNow = true)
        val until = System.currentTimeMillis() + 5_000
        while (calls.get() < 8 && System.currentTimeMillis() < until) delay(10)
        assertEquals(8, calls.get())
    }

    @Test
    fun `one message per room is in flight, two rooms at once, each room in order`() = runBlocking {
        seed()
        val rooms = listOf("c_" + "R".repeat(22), "c_" + "S".repeat(22), "c_" + "T".repeat(22))
        store.tx { for (r in rooms) upsertRoom(w, room(r, "g_" + r.takeLast(22), head = 0)) }
        val active = Collections.synchronizedMap(HashMap<String, Int>())
        val total = AtomicInteger()
        var maxTotal = 0
        var maxRoom = 0
        val order = Collections.synchronizedList(ArrayList<Pair<String, String>>())
        val seqs = AtomicInteger()
        val slow = WorkspaceHttp { _, _, path, body, _ ->
            val room = path.substringAfter("/conversations/").substringBefore('/')
            val now = total.incrementAndGet()
            val inRoom = synchronized(active) { (active[room] ?: 0).plus(1).also { active[room] = it } }
            synchronized(this) {
                maxTotal = maxOf(maxTotal, now)
                maxRoom = maxOf(maxRoom, inRoom)
            }
            order += room to (body!!.jsonObject.getValue("text") as JsonPrimitive).content
            delay(150)
            synchronized(active) { active[room] = active[room]!! - 1 }
            total.decrementAndGet()
            WorkspaceAnswer(201, buildJsonObject {
                put("messageId", "e_" + "M".repeat(20) + seqs.incrementAndGet().toString().padStart(2, '0'))
                put("seq", 1)
            })
        }
        val box = outbox(client = client(slow))
        for (r in rooms) for (i in 1..2) box.enqueue(w, r, null, "$r $i", emptyList())
        box.synced(w)
        assertTrue(box.flush(20_000))

        assertEquals(6, order.size)
        assertEquals(2, maxTotal)
        assertEquals(1, maxRoom)
        for (r in rooms) assertEquals(listOf("$r 1", "$r 2"), order.filter { it.first == r }.map { it.second })
    }

    @Test
    fun `rows survive a reopen, and a row left sending goes out with its ID`() = runBlocking {
        seed()
        val first = outbox()
        val local = first.enqueue(w, general, null, text, mentions)
        val later = first.enqueue(w, general, null, "Nog eentje", emptyList())
        // The process ended between saving the ID and the answer.
        store.tx { updateOutbox(local, mapOf("operationId" to op("post"), "state" to "sending")) }
        first.close()
        store.close()

        store = db.store { clock }
        val second = outbox()
        assertEquals(listOf(local, later), rows().map { it.local })
        second.start()
        assertEquals(listOf("queued", "queued"), rows().map { it.state })
        assertEquals(op("post"), row(local).operationId)
        assertEquals(2, second.unsent())

        server.answer("post")
        server.answerWith(created("01a1f5ec-a6e1-7000-8000-000000000009", 9))
        ids += "01a1f5ec-a6e1-7000-8000-000000000009"
        second.synced(w)
        assertTrue(second.flush(10_000))
        server.verify()
        assertEquals(1, idTimes.size)
        assertTrue(rows().isEmpty())
        assertEquals("Nog eentje", field(posts().last(), "text"))
    }

    @Test
    fun `a write that fails leaves no row and says not_saved`() = runBlocking {
        seed()
        val box = outbox()
        box.synced(w)
        store.read { sql.exec("PRAGMA query_only = 1") }
        try {
            box.enqueue(w, general, null, text, mentions)
            fail("expected not_saved")
        } catch (e: WorkspaceError) {
            assertEquals("not_saved", e.code)
        }
        store.read { sql.exec("PRAGMA query_only = 0") }
        assertTrue(rows().isEmpty())
        assertTrue(onDisk().isEmpty())
        box.flush(5_000)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `sends refused before anything is written`() = runBlocking {
        seed()
        val box = outbox()
        suspend fun refused(code: String, field: String? = null, call: suspend () -> Unit) {
            try {
                call()
                fail("expected $code")
            } catch (e: WorkspaceError) {
                assertEquals(code, e.code)
                if (field != null) assertEquals(field, e.field)
            }
        }
        refused("invalid", "text") { box.enqueue(w, general, null, "  \n", emptyList()) }
        refused("invalid", "text") { box.enqueue(w, general, null, "é".repeat(TEXT_BYTES / 2 + 1), emptyList()) }
        refused("invalid", "mentions") { box.enqueue(w, general, null, text, listOf(Mention(mila, 21, 22))) }
        refused("invalid", "root") { box.enqueue(w, general, "../x", text, emptyList()) }
        refused("not_found") { box.enqueue(w, "c_" + "Z".repeat(22), null, text, emptyList()) }
        store.tx { setRoomFields(w, old, mapOf("archived" to true)) }
        refused("archived") { box.enqueue(w, old, null, text, emptyList()) }
        store.tx { updateWs(w, mapOf("state" to "quarantined")) }
        refused("paused") { box.enqueue(w, general, null, text, emptyList()) }
        assertTrue(rows().isEmpty())
    }

    @Test
    fun `a 426 parks the workspace and keeps the row, a 404 for the room fails it, one for the workspace runs removal`() = runBlocking {
        seed()
        val box = outbox()
        box.synced(w)
        ids += op("post")
        server.answerWith(reply("upgrade required"))
        val local = box.enqueue(w, general, null, text, mentions)
        box.flush(10_000)
        assertEquals("queued", row(local).state)
        assertEquals("upgrade", store.read { getWs(w) }!!.state)
        assertEquals(listOf(w), upgrades.toList())
        box.flush(5_000)
        assertEquals("nothing sends while the workspace waits for an update", 1, server.requestCount)

        store.tx { updateWs(w, mapOf("state" to "ok")) }
        server.answerWith(reply("unknown conversation"))
        box.kick()
        box.flush(10_000)
        assertEquals("failed" to "no_access", row(local).let { it.state to it.reason })
        box.discard(local)

        val next = box.enqueue(w, general, null, text, emptyList())
        server.answerWith(reply("not a member"))
        box.flush(10_000)
        assertEquals(listOf(w), removed.toList())
        assertEquals("queued", row(next).state)
        server.verify()
    }

    @Test
    fun `redact marks the cached message removed after the 200, and a refusal changes nothing`() = runBlocking {
        seed()
        val message = v.id("message")
        store.tx {
            appendEvents(w, general, listOf(WireEvent(8, message, WireEvent.MESSAGE_POSTED, olga, 1, text = text, mentions = mentions)))
        }
        val box = outbox()

        server.answer("redact as someone else")
        try {
            box.redact(w, general, message)
            fail("expected forbidden")
        } catch (e: WorkspaceError) {
            assertEquals("forbidden", e.code)
        }
        assertEquals(text, store.read { eventById(w, message) }!!.text)

        server.answer("redact")
        box.redact(w, general, message)
        server.verify()
        val gone = store.read { eventById(w, message) }!!
        assertTrue(gone.redacted)
        assertNull(gone.text)
        assertTrue(store.read { hasTombstone(w, message) })
    }

    private suspend fun waitFor(what: String, ms: Long = 5_000, check: suspend () -> Boolean) {
        val until = System.currentTimeMillis() + ms
        while (!check()) {
            if (System.currentTimeMillis() > until) throw AssertionError("timed out waiting for $what")
            delay(10)
        }
    }

    /** What the service's restore path does with the outbox (§3.6 "Restore"): a new generation, the old one's rows marked. */
    private suspend fun restoreNow() = store.tx {
        val before = getWs(w)!!.generation
        updateWs(w, mapOf("generation" to "the restored generation"))
        markLookup(w, before)
    }

    @Test
    fun `a 201 that comes after a restore marked the row changes nothing, and the lookup decides`() = runBlocking {
        seed()
        val posted = CompletableDeferred<String>()
        val answer = CompletableDeferred<Unit>()
        val lookups = AtomicInteger()
        val late = WorkspaceHttp { _, method, path, body, _ ->
            when {
                method == "POST" && path.endsWith("/messages") -> {
                    val op = (body!!.jsonObject.getValue("operationId") as JsonPrimitive).content
                    posted.complete(op)
                    answer.await()
                    WorkspaceAnswer(201, RukooJson.parseToJsonElement("""{"operationId":"$op","messageId":"e_${"Z".repeat(22)}","seq":8}"""))
                }
                path.contains("/operations/") -> {
                    lookups.incrementAndGet()
                    throw WorkspaceError("network")
                }
                else -> error("unexpected $method $path")
            }
        }
        val box = outbox(client = client(late))
        val sent = CopyOnWriteArrayList<Outbox.Sent>()
        scope.launch { box.sent.collect { sent += it } }
        val local = box.enqueue(w, general, null, text, mentions)
        box.synced(w)
        val op = withTimeout(5_000) { posted.await() }
        restoreNow()
        // The old generation's 201 arrives now.
        answer.complete(Unit)
        waitFor("the lookup") { lookups.get() == 1 && row(local).attempts == 1 }
        delay(200)

        val r = row(local)
        assertEquals(Outbox.QUEUED to Outbox.LOOKUP, r.state to r.reason)
        assertEquals(op, r.operationId)
        assertEquals("one lookup, after the network failure it waits its backoff", 1, lookups.get())
        assertNull(store.read { eventAt(w, general, 8) })
        val room = store.read { getRoom(w, general) }!!
        assertEquals(listOf(7L, 7L, 7L, 7L), listOf(room.head, room.hi, room.read, room.readLocal))
        assertTrue(sent.isEmpty())
        box.close()
    }

    @Test
    fun `a network failure after a restore keeps the lookup mark, and the next attempt is the lookup`() = runBlocking {
        seed()
        val started = CompletableDeferred<Unit>()
        val fail = CompletableDeferred<Unit>()
        val requests = CopyOnWriteArrayList<String>()
        val failing = WorkspaceHttp { _, method, path, _, _ ->
            requests += "$method ${path.substringAfter("/conversations/$general")}"
            if (requests.size == 1) {
                started.complete(Unit)
                fail.await()
            }
            throw WorkspaceError("network")
        }
        val box = outbox(client = client(failing))
        val local = box.enqueue(w, general, null, text, mentions)
        box.synced(w)
        withTimeout(5_000) { started.await() }
        val op = row(local).operationId
        restoreNow()
        fail.complete(Unit)
        waitFor("the second request") { requests.size >= 2 && row(local).attempts == 1 }

        assertTrue(requests[0], requests[0].startsWith("POST /messages"))
        assertTrue("the lookup, not the old generation's POST: $requests", requests[1].startsWith("GET /operations/$op"))
        val r = row(local)
        assertEquals(Outbox.QUEUED to Outbox.LOOKUP, r.state to r.reason)
        assertEquals(op, r.operationId)
        box.close()
    }

    @Test
    fun `an attempt that throws before it changed the row backs off instead of running again at once`() = runBlocking {
        seed()
        val tries = AtomicInteger()
        val box = Outbox(store, client(), scope, now = { clock }, newId = {
            tries.incrementAndGet()
            // As Uuid7.next does for a time outside 48 bits.
            throw IllegalArgumentException("milliseconds outside 48 bits")
        })
        val local = box.enqueue(w, general, null, text, mentions)
        box.synced(w)
        delay(1_000)
        box.close()
        assertTrue("tries=${tries.get()}", tries.get() in 1..3)
        val r = row(local)
        assertEquals(Outbox.QUEUED, r.state)
        assertEquals(1, r.attempts)
        assertEquals(clock + 2_000, r.nextAt)
    }

    @Test
    fun `in the background outside the worker's window nothing is sent, a backoff's timer included`() = runBlocking {
        seed()
        val calls = AtomicInteger()
        val failing = WorkspaceHttp { _, _, _, _, _ ->
            calls.incrementAndGet()
            throw WorkspaceError("network")
        }
        val automatic = java.util.concurrent.atomic.AtomicBoolean(false)
        val box = Outbox(
            store, client(failing), scope, timing = Outbox.Timing(sendBackoff = listOf(200L)), now = { clock },
            automatic = { automatic.get() },
        )
        try {
            box.synced(w)
            val local = box.enqueue(w, general, null, text, mentions)
            box.kick(retryNow = true)
            delay(300)
            assertEquals("nothing goes out in the background", 0, calls.get())
            // The foreground (or the worker's window): the send goes out, fails and waits its backoff.
            automatic.set(true)
            box.kick()
            val until = System.currentTimeMillis() + 5_000
            while (calls.get() < 1 && System.currentTimeMillis() < until) delay(10)
            delay(50)
            assertEquals(1, calls.get())
            assertEquals(clock + 200, row(local).nextAt)
            // The app goes to the background before the backoff ends: its timer sends nothing.
            automatic.set(false)
            clock += 200
            delay(600)
            assertEquals("the retry timer waited for the foreground", 1, calls.get())
            automatic.set(true)
            box.kick(retryNow = true)
            val again = System.currentTimeMillis() + 5_000
            while (calls.get() < 2 && System.currentTimeMillis() < again) delay(10)
            assertEquals(2, calls.get())
        } finally {
            box.close()
        }
    }

    @Test
    fun `an attempt on a cache that takes no writes waits a backoff step before the next`() = runBlocking {
        seed()
        val tries = AtomicInteger()
        val box = Outbox(store, client(), scope, now = { clock }, newId = { ms ->
            tries.incrementAndGet()
            Uuid7.next(ms)
        })
        box.enqueue(w, general, null, text, mentions)
        // A full disk: the claim and the backoff's own write both fail.
        store.read { sql.exec("PRAGMA query_only = 1") }
        try {
            box.synced(w)
            delay(1_000)
            assertEquals("one attempt in the first second, tries=${tries.get()}", 1, tries.get())
        } finally {
            box.close()
            store.read { sql.exec("PRAGMA query_only = 0") }
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `a workspace parked while the clock is measured sends nothing`() = runBlocking {
        seed(clockKnown = false)
        val asked = CompletableDeferred<Unit>()
        val details = CompletableDeferred<Unit>()
        val posted = CompletableDeferred<Unit>()
        val parked = WorkspaceHttp { _, method, _, _, _ ->
            if (method == "GET") {
                asked.complete(Unit)
                details.await()
                WorkspaceAnswer(200, v.exchange("workspace").body)
            } else {
                posted.complete(Unit)
                throw WorkspaceError("network")
            }
        }
        val box = outbox(client = client(parked))
        val local = box.enqueue(w, general, null, text, mentions)
        box.synced(w)
        withTimeout(5_000) { asked.await() }
        // A 409 history_regressed on the feed meanwhile.
        store.tx { updateWs(w, mapOf("state" to "quarantined")) }
        details.complete(Unit)
        assertNull("no POST for a quarantined workspace", withTimeoutOrNull(1_000) { posted.await() })
        val r = row(local)
        assertEquals(Outbox.QUEUED, r.state)
        assertNull(r.operationId)
        box.close()
    }

    @Test
    fun `a 429's Retry-After outlasts a restart, and a resume doesn't send early`() = runBlocking {
        seed()
        val calls = AtomicInteger()
        val limited = WorkspaceHttp { _, _, _, _, _ ->
            calls.incrementAndGet()
            throw WorkspaceError("rate_limited", 429, retryAfterS = 120)
        }
        val first = outbox(client = client(limited))
        val local = first.enqueue(w, general, null, text, mentions)
        first.synced(w)
        waitFor("the wait") { row(local).nextAt == clock + 120_000 }
        first.close()

        // The process was killed and started again: a new outbox on the same cache, then a resume.
        val second = outbox(client = client(limited))
        second.start()
        second.synced(w)
        second.kick(w, retryNow = true)
        delay(500)
        assertEquals(1, calls.get())
        assertEquals(clock + 120_000, row(local).nextAt)

        // Once the wait is over it goes, and the hold goes with the row.
        clock += 120_000
        second.kick(w, retryNow = true)
        waitFor("the second POST") { calls.get() == 2 }
        second.close()
    }

    @Test
    fun `a 2xx that names no event keeps the row with its ID for the next attempt`() = runBlocking {
        seed()
        val answers = ArrayDeque(
            listOf(
                WorkspaceAnswer(201, RukooJson.parseToJsonElement("""{"messageId":"not-an-event-id","seq":8}""")),
                WorkspaceAnswer(201, RukooJson.parseToJsonElement("""{"messageId":"e_${"Z".repeat(22)}","seq":0}""")),
                WorkspaceAnswer(200, RukooJson.parseToJsonElement("""{"messageId":"e_${"Z".repeat(22)}","seq":-1,"visible":true}""")),
            ),
        )
        val paths = CopyOnWriteArrayList<String>()
        val odd = WorkspaceHttp { _, method, path, _, _ ->
            paths += "$method ${path.substringAfter("/conversations/$general")}"
            synchronized(answers) { answers.removeFirst() }
        }
        val box = outbox(client = client(odd))
        val local = box.enqueue(w, general, null, text, mentions)
        box.synced(w)
        waitFor("the first answer") { row(local).attempts == 1 }
        val op = row(local).operationId
        assertNotNull(op)
        assertEquals(Outbox.QUEUED, row(local).state)

        clock += 2_000
        box.kick(w)
        waitFor("the second answer") { row(local).attempts == 2 }
        assertEquals(op, row(local).operationId)

        // A lookup's answer is checked the same way.
        store.tx { updateOutbox(local, mapOf("reason" to Outbox.LOOKUP, "nextAt" to 0L)) }
        box.kick(w)
        waitFor("the lookup's answer") { row(local).attempts == 3 }
        assertEquals(Outbox.QUEUED to Outbox.LOOKUP, row(local).let { it.state to it.reason })
        assertTrue(paths.last(), paths.last().startsWith("GET /operations/$op"))
        assertNull(store.read { eventAt(w, general, 8) })
        assertEquals(7L, store.read { getRoom(w, general) }!!.read)
        box.close()
    }

    @Test
    fun `a message with half a surrogate pair is refused, as desktop does`() = runBlocking {
        seed()
        val box = outbox()
        try {
            box.enqueue(w, general, null, "a\uD83Db", emptyList())
            fail("expected invalid")
        } catch (e: WorkspaceError) {
            assertEquals("invalid", e.code)
            assertEquals("text", e.field)
        }
        assertTrue(rows().isEmpty())
        // A whole pair is fine.
        box.enqueue(w, general, null, "a😀b", emptyList())
        assertEquals(1, rows().size)
    }

    @Test
    fun `pending rows show waiting behind a held or failed row of their room`() {
        fun r(local: String, room: String, state: String, at: Long) =
            OutboxRow(local, w, room, olga, grant, generation, local, emptyList(), null, state = state, createdAt = at)
        val list = Outbox.pending(
            listOf(
                r("d", "c_b", "queued", 4), r("a", "c_a", "failed", 1), r("b", "c_a", "queued", 2), r("c", "c_b", "sending", 3),
            ),
        )
        assertEquals(listOf("a", "b", "c", "d"), list.map { it.local })
        assertEquals(
            listOf(PendingState.FAILED, PendingState.WAITING, PendingState.SENDING, PendingState.QUEUED),
            list.map { it.state },
        )
        assertNotNull(list.first().createdAt)
    }
}
