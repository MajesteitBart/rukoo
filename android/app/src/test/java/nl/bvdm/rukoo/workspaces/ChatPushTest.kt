package nl.bvdm.rukoo.workspaces

import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import nl.bvdm.rukoo.account.AccountError
import nl.bvdm.rukoo.account.AccountHttp
import nl.bvdm.rukoo.account.AccountStatus
import nl.bvdm.rukoo.account.BorrowedSession
import nl.bvdm.rukoo.account.ServerInfo
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.settings.AppSettings
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Push wakes on the phone (ChatPush): what the plan does for each state of the account, the server, the switch and the
 * distributors; how a failed registration tries again; and the flow from registering with a distributor to the
 * server's copy of the endpoint and back, and from a wake to the catch-up.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatPushTest {
    private val dir: File = Files.createTempDirectory("chat-push").toFile()
    private val harnesses = CopyOnWriteArrayList<Harness>()

    @After
    fun cleanUp() {
        for (h in harnesses) h.work.cancel()
        dir.deleteRecursively()
    }

    private val endpoint = PushEndpoint("https://ntfy.sh/upAbCdEf?up=1", "BKey", "authSecret")

    private fun inputs(
        wanted: Boolean = true,
        vapid: String? = VAPID,
        session: String? = "s1",
        installed: List<String> = listOf(NTFY),
        attempted: Boolean = true,
        confirmed: Boolean = true,
        force: Boolean = false,
        server: String = "1.0.0",
    ) = PushPlan.Inputs(wanted, vapid, session, installed, OWN, server, attempted, confirmed, force)

    private fun registered(failure: String? = null, failures: Int = 0, attemptAt: Long = NOW) =
        PushRecord(distributor = NTFY, vapid = VAPID, endpoint = endpoint, failure = failure, failures = failures, attemptAt = attemptAt)

    // ---- the plan ----

    @Test
    fun `registers with the distributor, then gives the server its endpoint once`() {
        val fresh = PushRecord()
        assertEquals(listOf(PushPlan.Step.Register(NTFY, VAPID)), PushPlan.steps(inputs(), fresh, NOW))
        assertEquals(ChatDelivery.Connecting(NTFY), PushPlan.delivery(inputs(), fresh, NOW))

        val answered = registered()
        assertEquals(listOf(PushPlan.Step.Send("s1", endpoint)), PushPlan.steps(inputs(), answered, NOW))
        assertEquals(ChatDelivery.Connecting(NTFY), PushPlan.delivery(inputs(), answered, NOW))

        val sent = answered.copy(sentFor = PushPlan.key("s1", endpoint), sentAt = NOW)
        assertEquals(emptyList<PushPlan.Step>(), PushPlan.steps(inputs(), sent, NOW + 1000))
        assertEquals(ChatDelivery.Instant(NTFY), PushPlan.delivery(inputs(), sent, NOW))
        // Once a day the server gets it again, in case its copy went.
        assertEquals(listOf(PushPlan.Step.Send("s1", endpoint)), PushPlan.steps(inputs(), sent, NOW + PushPlan.RESEND))
    }

    @Test
    fun `registers again once per process, as UnifiedPush asks, and a new session sends the endpoint again`() {
        val sent = registered().copy(sentFor = PushPlan.key("s1", endpoint), sentAt = NOW)
        assertEquals(listOf(PushPlan.Step.Register(NTFY, VAPID)), PushPlan.steps(inputs(attempted = false, confirmed = false), sent, NOW))
        assertEquals(listOf(PushPlan.Step.Send("s2", endpoint)), PushPlan.steps(inputs(session = "s2"), sent, NOW))
        assertEquals(ChatDelivery.Connecting(NTFY), PushPlan.delivery(inputs(session = "s2"), sent, NOW))
    }

    @Test
    fun `new keys at the same address are a new registration, which the server gets`() {
        val sent = registered().copy(sentFor = PushPlan.key("s1", endpoint), sentAt = NOW)
        val rekeyed = sent.copy(endpoint = endpoint.copy(p256dh = "BOtherKey"))
        assertNotEquals(endpoint.fingerprint, rekeyed.endpoint!!.fingerprint)
        assertEquals(listOf(PushPlan.Step.Send("s1", rekeyed.endpoint!!)), PushPlan.steps(inputs(), rekeyed, NOW))
        assertEquals(ChatDelivery.Connecting(NTFY), PushPlan.delivery(inputs(), rekeyed, NOW))
    }

    @Test
    fun `without a distributor, or a server that sends no wakes, it says so and the 15-minute check stays`() {
        assertEquals(emptyList<PushPlan.Step>(), PushPlan.steps(inputs(installed = emptyList()), PushRecord(), NOW))
        assertEquals(ChatDelivery.NoDistributor, PushPlan.delivery(inputs(installed = emptyList()), PushRecord(), NOW))
        assertEquals(ChatDelivery.ServerWithout, PushPlan.delivery(inputs(vapid = null), PushRecord(), NOW))
        assertEquals(ChatDelivery.Off, PushPlan.delivery(inputs(wanted = false), PushRecord(), NOW))
    }

    @Test
    fun `turning notifications off unregisters and takes the server's copy back`() {
        val sent = registered().copy(sentFor = PushPlan.key("s1", endpoint), sentAt = NOW)
        assertEquals(listOf(PushPlan.Step.Unregister, PushPlan.Step.Withdraw), PushPlan.steps(inputs(wanted = false), sent, NOW))
        // A server that stopped offering wakes, and an uninstalled distributor, unregister as well.
        assertEquals(listOf(PushPlan.Step.Unregister, PushPlan.Step.Withdraw), PushPlan.steps(inputs(vapid = null), sent, NOW))
        assertEquals(listOf(PushPlan.Step.Unregister, PushPlan.Step.Withdraw), PushPlan.steps(inputs(installed = emptyList()), sent, NOW))
        // Signed out, there is no session to take it back with: only the distributor is left.
        assertEquals(listOf(PushPlan.Step.Unregister), PushPlan.steps(inputs(wanted = false, session = null), sent, NOW))
        // A withdrawal that didn't get through is still due at the next run.
        assertEquals(listOf(PushPlan.Step.Withdraw), PushPlan.steps(inputs(wanted = false), PushRecord(sentFor = PushPlan.key("s1", endpoint)), NOW))
    }

    @Test
    fun `a new VAPID key or another distributor means a new registration`() {
        val sent = registered().copy(sentFor = PushPlan.key("s1", endpoint), sentAt = NOW)
        val other = "B" + "x".repeat(86)
        assertEquals(listOf(PushPlan.Step.Register(NTFY, other)), PushPlan.steps(inputs(vapid = other), sent, NOW))
        val both = inputs(installed = listOf(NTFY, NEXTPUSH))
        assertEquals(emptyList<PushPlan.Step>(), PushPlan.steps(both, sent, NOW))
        assertEquals(listOf(PushPlan.Step.Register(NEXTPUSH, VAPID)), PushPlan.steps(both, sent.copy(preferred = NEXTPUSH), NOW))
    }

    @Test
    fun `an app the person installed comes before the distributor embedded in Rukoo`() {
        assertEquals(NTFY, PushPlan.pick(inputs(installed = listOf(OWN, NTFY)), PushRecord()))
        assertEquals(OWN, PushPlan.pick(inputs(installed = listOf(OWN)), PushRecord()))
        // Installing ntfy moves Rukoo off the embedded one, unless the person picked that in Settings.
        assertEquals(NTFY, PushPlan.pick(inputs(installed = listOf(OWN, NTFY)), PushRecord(distributor = OWN)))
        assertEquals(OWN, PushPlan.pick(inputs(installed = listOf(OWN, NTFY)), PushRecord(distributor = OWN, preferred = OWN)))
        // Between apps the person installed, it stays with the one it registered with.
        assertEquals(NEXTPUSH, PushPlan.pick(inputs(installed = listOf(OWN, NTFY, NEXTPUSH)), PushRecord(distributor = NEXTPUSH)))
        assertEquals(NTFY, PushPlan.pick(inputs(installed = listOf(NTFY)), PushRecord(distributor = OWN)))
    }

    @Test
    fun `a refusal holds for that registration and server for a day, and anything new tries again`() {
        val key = PushPlan.key("s1", endpoint)
        val refused = registered().copy(refused = PushRefusal(key, PushPlan.NOT_ALLOWED, NTFY, "1.0.0", NOW))
        assertEquals(emptyList<PushPlan.Step>(), PushPlan.steps(inputs(), refused, NOW + 1000))
        assertEquals(ChatDelivery.Failed(NTFY, PushPlan.NOT_ALLOWED), PushPlan.delivery(inputs(), refused, NOW))
        val send = listOf(PushPlan.Step.Send("s1", endpoint))
        assertEquals("a day later", send, PushPlan.steps(inputs(), refused, NOW + PushPlan.RETRY_REFUSED))
        assertEquals("a new server version", send, PushPlan.steps(inputs(server = "1.1.0"), refused, NOW + 1000))
        val rekeyed = endpoint.copy(auth = "newSecret")
        assertEquals("new keys", listOf(PushPlan.Step.Send("s1", rekeyed)), PushPlan.steps(inputs(), refused.copy(endpoint = rekeyed), NOW + 1000))
        assertEquals("a new session", listOf(PushPlan.Step.Send("s2", endpoint)), PushPlan.steps(inputs(session = "s2"), refused, NOW + 1000))
    }

    @Test
    fun `a registration that failed waits out its backoff, or less on returning to the app or the network coming back`() {
        val failed = registered(failure = "NETWORK", failures = 1)
        val waiting = inputs(confirmed = false)
        assertFalse(PushPlan.registerDue(waiting, failed, NOW + 10_000))
        assertTrue(PushPlan.registerDue(waiting, failed, NOW + PushPlan.backoff(1)))
        // Forced, after a short gap.
        assertFalse(PushPlan.registerDue(waiting.copy(force = true), failed, NOW + 10_000))
        assertTrue(PushPlan.registerDue(waiting.copy(force = true), failed, NOW + PushPlan.FORCE_GAP))
        assertEquals(listOf(PushPlan.Step.Register(NTFY, VAPID)), PushPlan.steps(waiting.copy(force = true), failed.copy(endpoint = null), NOW + PushPlan.FORCE_GAP))
        // ACTION_REQUIRED waits the same way: the person returning from the distributor is the moment to try.
        assertTrue(PushPlan.registerDue(waiting.copy(force = true), registered(failure = "ACTION_REQUIRED", failures = 3), NOW + PushPlan.FORCE_GAP))
        // A registration without an answer is sent again after a minute; one that was answered isn't.
        assertTrue(PushPlan.registerDue(waiting, registered(), NOW + PushPlan.ANSWER_TIME))
        assertFalse(PushPlan.registerDue(inputs(confirmed = true), failed, NOW + PushPlan.BACKOFF_MAX))
        // The backoff doubles to an hour at most.
        assertEquals(listOf(60_000L, 120_000L, 240_000L, 480_000L), (1..4).map { PushPlan.backoff(it) })
        assertEquals(PushPlan.BACKOFF_MAX, PushPlan.backoff(40))
    }

    @Test
    fun `the VAPID key comes from the server's info only with the push-wake capability`() {
        assertEquals(VAPID, PushPlan.vapid(status(info(push = true))))
        assertNull(PushPlan.vapid(status(info(push = false))))
        assertNull(PushPlan.vapid(status(info(push = true, vapid = "short"))))
        assertNull(PushPlan.vapid(status(null)))
    }

    @Test
    fun `a wake names its workspaces, and an older server's wake names none`() {
        val a = "w_" + "A".repeat(22)
        val b = "w_" + "B".repeat(22)
        assertEquals(setOf(a, b), PushPlan.wakeWorkspaces("""{"t":"wake","w":["$a","$b","$a"]}""".toByteArray()))
        assertEquals(emptySet<String>(), PushPlan.wakeWorkspaces("""{"t":"wake"}""".toByteArray()))
        assertEquals(setOf(a), PushPlan.wakeWorkspaces("""{"t":"wake","w":["$a","not an id",7,"c_${"C".repeat(22)}"]}""".toByteArray()))
        assertEquals(emptySet<String>(), PushPlan.wakeWorkspaces("not json".toByteArray()))
        val many = (0 until 15).joinToString(",") { "\"w_${it.toString().padStart(22, 'x')}\"" }
        assertEquals(10, PushPlan.wakeWorkspaces("""{"t":"wake","w":[$many]}""".toByteArray()).size)
    }

    // ---- the flow ----

    private class FakeDistributors(var list: List<String>) : PushDistributors {
        override val own = OWN
        val registered = CopyOnWriteArrayList<Pair<String, String>>()
        var unregistered = 0
        override fun installed() = list
        override fun register(distributor: String, vapid: String) {
            registered += distributor to vapid
        }
        override fun unregister() {
            unregistered += 1
        }
    }

    private class FakeHttp : AccountHttp {
        data class Call(val server: String, val method: String, val path: String, val body: JsonElement?, val token: String?)
        val calls = CopyOnWriteArrayList<Call>()
        var fail: AccountError? = null
        override suspend fun request(server: String, method: String, path: String, body: JsonElement?, token: String?, meter: java.util.concurrent.atomic.AtomicLong?): JsonElement? {
            calls += Call(server, method, path, body, token)
            fail?.let { throw it }
            return null
        }
        fun puts() = calls.filter { it.method == "PUT" }
        fun deletes() = calls.filter { it.method == "DELETE" }
    }

    private class FakeAccount(info: ServerInfo?) : ChatAccount {
        val statusFlow = MutableStateFlow(AccountStatus(server = SERVER, info = info))
        var session: BorrowedSession? = null
        val refused = CopyOnWriteArrayList<BorrowedSession>()
        override val status: StateFlow<AccountStatus> get() = statusFlow
        override val sessionEnded: SharedFlow<Unit> = MutableSharedFlow()
        override fun borrowSession() = session
        override fun sessionRefused(session: BorrowedSession) {
            refused += session
        }
        override suspend fun refreshInfo() {}
        fun signIn(tag: String) {
            session = BorrowedSession(SERVER, "token-$tag", tag, Any())
            statusFlow.value = statusFlow.value.copy(signedIn = true)
        }
    }

    // On the test's scheduler but not a child of the test, so advanceUntilIdle runs what ChatPush launches (which it
    // doesn't for backgroundScope) and the collector that never ends doesn't hold the test open. [now] is the clock.
    private class Harness(scope: TestScope, dir: File, installed: List<String> = listOf(NTFY)) {
        val work = CoroutineScope(SupervisorJob() + StandardTestDispatcher(scope.testScheduler))
        var now = NOW
        val account = FakeAccount(info(push = true))
        val settings = MutableStateFlow(AppSettings())
        val distributors = FakeDistributors(installed)
        val http = FakeHttp()
        var catchUps = 0
        val push = ChatPush(account, settings, distributors, http, File(dir, ChatPush.FILE_NAME), work, { catchUps += 1 }, Clock { now })
    }

    private fun TestScope.harness(installed: List<String> = listOf(NTFY)) = Harness(this, dir, installed).also { harnesses += it }

    @Test
    fun `signed in, it registers, sends the endpoint to the server with the session, and a wake runs the catch-up`() = runTest {
        val h = harness()
        h.account.signIn("s1")
        h.push.start()
        advanceUntilIdle()
        assertEquals(listOf(NTFY to VAPID), h.distributors.registered.toList())
        assertEquals(ChatDelivery.Connecting(NTFY), h.push.state.value.delivery)

        h.push.newEndpoint(endpoint)
        advanceUntilIdle()
        val put = h.http.calls.single()
        assertEquals(FakeHttp.Call(SERVER, "PUT", "/v1/push-endpoint", put.body, "token-s1"), put)
        val body = put.body as JsonObject
        assertEquals(JsonPrimitive(endpoint.url), body["endpoint"])
        assertEquals(JsonPrimitive(endpoint.p256dh), body["p256dh"])
        assertEquals(JsonPrimitive(endpoint.auth), body["auth"])
        assertEquals(PushState(ChatDelivery.Instant(NTFY), listOf(NTFY)), h.push.state.value)

        h.push.message()
        advanceUntilIdle()
        assertEquals(1, h.catchUps)
        // Another check changes nothing.
        h.push.check()
        advanceUntilIdle()
        assertEquals(1, h.http.calls.size)
        assertEquals(1, h.distributors.registered.size)
    }

    @Test
    fun `a new process registers again and keeps what the server has`() = runTest {
        val h = harness()
        h.account.signIn("s1")
        h.push.start()
        advanceUntilIdle()
        h.push.newEndpoint(endpoint)
        advanceUntilIdle()

        val again = harness()
        again.account.signIn("s1")
        again.push.start()
        advanceUntilIdle()
        assertEquals(listOf(NTFY to VAPID), again.distributors.registered.toList())
        assertEquals(emptyList<FakeHttp.Call>(), again.http.calls.toList())
        assertEquals(ChatDelivery.Instant(NTFY), again.push.state.value.delivery)
    }

    @Test
    fun `new keys at the same address go to the server`() = runTest {
        val h = harness()
        h.account.signIn("s1")
        h.push.start()
        advanceUntilIdle()
        h.push.newEndpoint(endpoint)
        advanceUntilIdle()
        h.push.newEndpoint(endpoint.copy(p256dh = "BNewKey", auth = "newAuth"))
        advanceUntilIdle()
        assertEquals(2, h.http.puts().size)
        assertEquals(JsonPrimitive("BNewKey"), (h.http.puts().last().body as JsonObject)["p256dh"])
    }

    @Test
    fun `without a distributor nothing registers, and installing one is found at the next check`() = runTest {
        val h = harness(installed = emptyList())
        h.account.signIn("s1")
        h.push.start()
        advanceUntilIdle()
        assertEquals(ChatDelivery.NoDistributor, h.push.state.value.delivery)
        assertTrue(h.distributors.registered.isEmpty())

        h.distributors.list = listOf(NTFY)
        h.push.check()
        advanceUntilIdle()
        assertEquals(listOf(NTFY to VAPID), h.distributors.registered.toList())
    }

    @Test
    fun `turning team chat notifications off unregisters and deletes the server's copy, trying until it gets through`() = runTest {
        val h = harness()
        h.account.signIn("s1")
        h.push.start()
        advanceUntilIdle()
        h.push.newEndpoint(endpoint)
        advanceUntilIdle()

        h.http.fail = AccountError("network", 0)
        h.settings.value = h.settings.value.copy(notifyChat = false)
        advanceUntilIdle()
        assertEquals(1, h.distributors.unregistered)
        assertEquals(1, h.http.deletes().size)
        // The withdrawal is still pending: the next check sends it again.
        h.http.fail = null
        h.push.check()
        advanceUntilIdle()
        assertEquals(2, h.http.deletes().size)
        assertEquals(FakeHttp.Call(SERVER, "DELETE", "/v1/push-endpoint", null, "token-s1"), h.http.calls.last())
        h.push.check()
        advanceUntilIdle()
        assertEquals("confirmed, so no more", 2, h.http.deletes().size)
        assertEquals(ChatDelivery.Off, h.push.state.value.delivery)

        // On again: a fresh registration.
        h.settings.value = h.settings.value.copy(notifyChat = true)
        advanceUntilIdle()
        assertEquals(2, h.distributors.registered.size)
    }

    @Test
    fun `a server that stops offering wakes gets the endpoint taken back`() = runTest {
        val h = harness()
        h.account.signIn("s1")
        h.push.start()
        advanceUntilIdle()
        h.push.newEndpoint(endpoint)
        advanceUntilIdle()
        h.account.statusFlow.value = h.account.statusFlow.value.copy(info = info(push = false))
        advanceUntilIdle()
        assertEquals(1, h.http.deletes().size)
        assertEquals(ChatDelivery.ServerWithout, h.push.state.value.delivery)
    }

    @Test
    fun `the server's answers, 400 holds for a day, 401 ends the session, others try again at the next check`() = runTest {
        val h = harness()
        h.account.signIn("s1")
        h.push.start()
        advanceUntilIdle()

        h.http.fail = AccountError("unavailable", 503)
        h.push.newEndpoint(endpoint)
        advanceUntilIdle()
        assertEquals(ChatDelivery.Connecting(NTFY), h.push.state.value.delivery)
        h.http.fail = null
        h.push.check()
        advanceUntilIdle()
        assertEquals(ChatDelivery.Instant(NTFY), h.push.state.value.delivery)

        val other = endpoint.copy(url = "https://ntfy.example.org/up/1")
        h.http.fail = AccountError("invalid", 400)
        h.push.newEndpoint(other)
        advanceUntilIdle()
        assertEquals(ChatDelivery.Failed(NTFY, PushPlan.REFUSED), h.push.state.value.delivery)
        val tries = h.http.calls.size
        h.push.check()
        advanceUntilIdle()
        assertEquals("a refused endpoint isn't sent again the same day", tries, h.http.calls.size)
        h.now += PushPlan.RETRY_REFUSED
        h.push.check()
        advanceUntilIdle()
        assertEquals("a day later it is", tries + 1, h.http.calls.size)

        h.http.fail = AccountError("unauthorized", 401)
        h.push.newEndpoint(endpoint.copy(url = "https://ntfy.sh/upNew?up=1"))
        advanceUntilIdle()
        assertEquals(1, h.account.refused.size)
    }

    @Test
    fun `a push service the server doesn't post to says so, and another distributor isn't held back by it`() = runTest {
        val h = harness(installed = listOf(NTFY, OWN))
        h.account.signIn("s1")
        h.push.start()
        advanceUntilIdle()
        h.http.fail = AccountError(ChatPush.NOT_ALLOWED_CODE, 400)
        h.push.newEndpoint(endpoint.copy(url = "https://ntfy.example.org/upX"))
        advanceUntilIdle()
        assertEquals(ChatDelivery.Failed(NTFY, PushPlan.NOT_ALLOWED), h.push.state.value.delivery)

        h.http.fail = null
        h.push.choose(OWN)
        advanceUntilIdle()
        assertEquals(OWN to VAPID, h.distributors.registered.last())
        val fcm = PushEndpoint("https://fcm.googleapis.com/fcm/send/abc", "BFcmKey", "fcmAuth")
        h.push.newEndpoint(fcm)
        advanceUntilIdle()
        assertEquals(JsonPrimitive(fcm.url), (h.http.puts().last().body as JsonObject)["endpoint"])
        assertEquals(ChatDelivery.Instant(OWN), h.push.state.value.delivery)
    }

    @Test
    fun `a failed registration tries again after its backoff, or when Rukoo returns, never at once`() = runTest {
        val h = harness()
        h.account.signIn("s1")
        h.push.start()
        advanceUntilIdle()
        h.push.registrationFailed("NETWORK")
        advanceUntilIdle()
        assertEquals(ChatDelivery.Failed(NTFY, "NETWORK"), h.push.state.value.delivery)
        assertEquals(1, h.distributors.registered.size)

        h.push.check()
        h.push.check(force = true)
        advanceUntilIdle()
        assertEquals("not again within seconds", 1, h.distributors.registered.size)

        h.now += PushPlan.FORCE_GAP
        h.push.check(force = true)
        advanceUntilIdle()
        assertEquals("returning to the app tries again", 2, h.distributors.registered.size)

        h.push.registrationFailed("ACTION_REQUIRED")
        advanceUntilIdle()
        h.now += PushPlan.FORCE_GAP
        h.push.check()
        advanceUntilIdle()
        assertEquals("an ordinary check waits out the backoff", 2, h.distributors.registered.size)
        h.now += PushPlan.backoff(2)
        h.push.check()
        advanceUntilIdle()
        assertEquals(3, h.distributors.registered.size)

        h.push.newEndpoint(endpoint)
        advanceUntilIdle()
        assertEquals(ChatDelivery.Instant(NTFY), h.push.state.value.delivery)
    }

    @Test
    fun `what the distributor says shows in Settings, and the end of a registration registers again`() = runTest {
        val h = harness()
        h.account.signIn("s1")
        h.push.start()
        advanceUntilIdle()
        h.push.newEndpoint(endpoint)
        advanceUntilIdle()
        assertEquals(ChatDelivery.Instant(NTFY), h.push.state.value.delivery)
        h.push.unavailable()
        advanceUntilIdle()
        assertEquals(ChatDelivery.Failed(NTFY, PushPlan.UNAVAILABLE), h.push.state.value.delivery)

        h.push.unregistered()
        advanceUntilIdle()
        assertEquals("DELETE", h.http.calls.last().method)
        assertEquals(2, h.distributors.registered.size)
        assertEquals(ChatDelivery.Connecting(NTFY), h.push.state.value.delivery)
    }

    @Test
    fun `wakes keep their workspaces for the catch-up, and one during a catch-up makes it run once more`() = runTest {
        val h = harness()
        val a = "w_" + "A".repeat(22)
        val b = "w_" + "B".repeat(22)
        h.push.message(setOf(a))
        h.push.message(setOf(b))
        advanceUntilIdle()
        assertEquals(2, h.catchUps)

        val runs = mutableListOf<Set<String>>()
        h.push.catchUpRounds { first ->
            runs += first
            // A wake comes in while the first round runs.
            if (runs.size == 1) {
                h.push.message(setOf(a))
                advanceUntilIdle()
            }
        }
        assertEquals(listOf(setOf(a, b), setOf(a)), runs)

        // Without wakes in between, one round.
        runs.clear()
        h.push.catchUpRounds { runs += it }
        assertEquals(listOf(emptySet<String>()), runs)

        // Wakes that keep coming stop after three rounds.
        runs.clear()
        h.push.catchUpRounds { first ->
            runs += first
            h.push.message()
            advanceUntilIdle()
        }
        assertEquals(3, runs.size)
    }

    @Test
    fun `choosing another distributor in Settings registers with it`() = runTest {
        val h = harness(installed = listOf(NTFY, NEXTPUSH))
        h.account.signIn("s1")
        h.push.start()
        advanceUntilIdle()
        h.push.newEndpoint(endpoint)
        advanceUntilIdle()
        assertEquals(listOf(NTFY, NEXTPUSH), h.push.state.value.distributors)
        h.push.choose(NEXTPUSH)
        advanceUntilIdle()
        assertEquals(NEXTPUSH to VAPID, h.distributors.registered.last())
        assertEquals(ChatDelivery.Connecting(NEXTPUSH), h.push.state.value.delivery)
    }

    companion object {
        const val SERVER = "https://rukoo.example"
        const val NOW = 1_800_000_000_000L
        const val OWN = "nl.bvdm.rukoo"
        const val NTFY = "io.heckel.ntfy"
        const val NEXTPUSH = "org.unifiedpush.distributor.nextpush"
        val VAPID = "B" + "A".repeat(86)

        fun info(push: Boolean, vapid: String = VAPID) = ServerInfo(
            protocol = 1,
            version = "1.0.0",
            features = listOf(WORKSPACES_FEATURE),
            workspace = WorkspaceServerInfo(
                versions = listOf(1, 2),
                capabilities = listOfNotNull("reactions", "push-wake".takeIf { push }),
                push = WorkspacePushInfo(vapid),
            ),
        )

        fun status(info: ServerInfo?) = AccountStatus(server = SERVER, signedIn = true, info = info)
    }
}
