package nl.bvdm.rukoo.account

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import nl.bvdm.rukoo.core.RukooJson
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Codes by email in the phone's account (AccountService.requestCode and the emailCode of sign-up, sign-in and
 * recovery): the cases of desktop's test/account-codes.test.js, so both apps send and read the same.
 */
class AccountCodesTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val scopes = mutableListOf<CoroutineScope>()
    private val servers = mutableListOf<FakeAccountServer>()
    private val devices = mutableListOf<AccountService>()
    private val okhttp = OkHttpClient()

    @After
    fun tearDown() {
        devices.forEach { it.close() }
        scopes.forEach { it.cancel() }
        servers.forEach { it.close() }
    }

    private fun server(signups: String = "open", invites: List<String> = emptyList(), codes: Boolean = true) =
        FakeAccountServer(signups, invites, codes = codes).also { servers += it }

    private fun device(srv: FakeAccountServer, name: String = "phone"): AccountService {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        return AccountService(tmp.newFolder(), PlainSecrets, srv.url, name, OkHttpAccountHttp(okhttp), scope, devHosts = true, platform = "android")
            .also { devices += it }
    }

    private suspend fun rejects(code: String, block: suspend () -> Unit): AccountError {
        try {
            block()
        } catch (e: AccountError) {
            assertEquals(code, e.code)
            return e
        }
        fail("expected $code")
        throw IllegalStateException()
    }

    private fun bodies(srv: FakeAccountServer, route: String): List<JsonObject> =
        srv.calls.filter { it.route == route }.map { RukooJson.parseToJsonElement(it.body).jsonObject }

    private fun JsonObject.str(key: String) = (this[key] as? JsonPrimitive)?.content

    @Test
    fun `a server without codes signs up as before and says it sends none`() = runBlocking<Unit> {
        val srv = server(signups = "invite", invites = listOf("welcome"), codes = false)
        val phone = device(srv)
        val info = phone.serverInfo()
        assertFalse(info.codesFor("signup"))
        assertFalse(info.codesFor("unlock"))
        rejects("mail_unavailable") { phone.requestCode("nocodes@example.com", "signup") }
        phone.signUp("nocodes@example.com", PASSWORD, "welcome")
        assertTrue(phone.signedIn)
        assertNull(bodies(srv, "POST /v1/signup").single()["emailCode"])
    }

    @Test
    fun `a server that sends only unlock codes takes sign-ups by invite code as before`() = runBlocking<Unit> {
        val srv = server(signups = "invite", invites = listOf("welcome"))
        val phone = device(srv)
        val info = phone.serverInfo()
        assertFalse(info.codesFor("signup"))
        assertTrue(info.codesFor("unlock"))
        rejects("invite_required") { phone.signUp("invited@example.com", PASSWORD) }
        phone.signUp("invited@example.com", PASSWORD, "welcome")
        assertTrue(phone.signedIn)
    }

    @Test
    fun `a sign-up on a server that checks addresses gets a code first and goes through with it`() = runBlocking<Unit> {
        val srv = server(signups = "verified")
        val phone = device(srv)
        val info = phone.serverInfo()
        assertEquals("invite", info.signups)
        assertTrue(info.codesFor("signup"))

        rejects("code_required") { phone.signUp(" New@Example.com ", PASSWORD) }
        assertTrue(bodies(srv, "POST /v1/signup").isEmpty())

        val sent = phone.requestCode(" New@Example.com ", "signup", "nl")
        assertEquals(AccountService.CodeSent("new@example.com", 600), sent)
        val asked = bodies(srv, "POST /v1/email-code").single()
        assertEquals("new@example.com", asked.str("email"))
        assertEquals("signup", asked.str("purpose"))
        assertEquals("nl", asked.str("lang"))
        val code = srv.codeFor("new@example.com")!!

        val wrong = if (code == "000000") "111111" else "000000"
        val err = rejects("code_wrong") { phone.signUp("new@example.com", PASSWORD, emailCode = wrong) }
        assertEquals(4, err.attemptsLeft)
        assertFalse(phone.signedIn)

        phone.signUp("new@example.com", PASSWORD, emailCode = " ${code.take(3)}-${code.drop(3)} ")
        assertTrue(phone.signedIn)
        val body = bodies(srv, "POST /v1/signup").last()
        val emailCode = body["emailCode"]!!.jsonObject
        assertEquals(code, emailCode.str("code"))
        assertTrue(Regex("[A-Za-z0-9_-]{43}").matches(emailCode.str("challenge")!!))
        assertNull(body["invite"])
    }

    @Test
    fun `the long code works on a phone that never asked, and six digits there do not`() = runBlocking<Unit> {
        val srv = server(signups = "verified")
        val asker = device(srv, "asker")
        val phone = device(srv, "other")
        asker.requestCode("long@example.com", "signup")
        val token = srv.tokenFor("long@example.com")!!
        rejects("code_expired") { phone.signUp("long@example.com", PASSWORD, emailCode = srv.codeFor("long@example.com")!!) }
        rejects("code_format") { phone.signUp("long@example.com", PASSWORD, emailCode = "not a code") }
        assertTrue(bodies(srv, "POST /v1/signup").isEmpty())
        phone.signUp("long@example.com", PASSWORD, emailCode = token.take(20) + "\n" + token.drop(20))
        assertTrue(phone.signedIn)
        assertEquals(token, bodies(srv, "POST /v1/signup").last()["emailCode"]!!.jsonObject.str("token"))
    }

    @Test
    fun `five wrong codes end the six digits and the long code still works`() = runBlocking<Unit> {
        val srv = server(signups = "verified")
        val phone = device(srv)
        phone.requestCode("typo@example.com", "signup")
        val code = srv.codeFor("typo@example.com")!!
        val wrong = if (code == "123456") "654321" else "123456"
        for (left in listOf(4, 3, 2, 1, 0)) {
            assertEquals(left, rejects("code_wrong") { phone.signUp("typo@example.com", PASSWORD, emailCode = wrong) }.attemptsLeft)
        }
        val tries = bodies(srv, "POST /v1/signup").size
        rejects("code_expired") { phone.signUp("typo@example.com", PASSWORD, emailCode = code) }
        assertEquals(tries, bodies(srv, "POST /v1/signup").size)
        phone.signUp("typo@example.com", PASSWORD, emailCode = srv.tokenFor("typo@example.com")!!)
        assertTrue(phone.signedIn)
    }

    @Test
    fun `a second code within the minute waits for the server's Retry-After`() = runBlocking<Unit> {
        val srv = server(signups = "verified")
        val phone = device(srv)
        phone.requestCode("again@example.com", "signup")
        val err = rejects("rate_limited") { phone.requestCode("again@example.com", "signup") }
        assertNotNull(err.retryAfter)
        assertTrue(err.retryAfter!! in 1..60)
        srv.allowCode("again@example.com", "signup")
        phone.requestCode("again@example.com", "signup")
        rejects("code_expired") { phone.signUp("other@example.com", PASSWORD, emailCode = srv.codeFor("again@example.com")!!) }
        phone.signUp("again@example.com", PASSWORD, emailCode = srv.codeFor("again@example.com")!!)
        assertTrue(phone.signedIn)
    }

    @Test
    fun `Retry-After reads seconds and dates, up to a day`() {
        assertEquals(42L, AccountError.retryAfter("42"))
        assertEquals(1L, AccountError.retryAfter("0"))
        assertEquals(86_400L, AccountError.retryAfter("999999"))
        val now = 1_800_000_000_000L
        val date = java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME.format(java.time.Instant.ofEpochMilli(now + 7_200_000).atZone(java.time.ZoneOffset.UTC))
        assertEquals(7200L, AccountError.retryAfter(date, now))
        assertNull(AccountError.retryAfter("soon"))
        assertNull(AccountError.retryAfter(null))
    }

    @Test
    fun `an invite code needs no emailed code, and a wrong one asks the server for a code instead`() = runBlocking<Unit> {
        val srv = server(signups = "verified", invites = listOf("welcome"))
        val phone = device(srv)
        phone.signUp("invited@example.com", PASSWORD, "welcome")
        assertTrue(phone.signedIn)
        assertNull(bodies(srv, "POST /v1/signup").last()["emailCode"])
        assertTrue(srv.mail.isEmpty())
        val other = device(srv, "other")
        rejects("code_required") { other.signUp("wrong@example.com", PASSWORD, "nope") }
        assertEquals("nope", bodies(srv, "POST /v1/signup").last().str("invite"))
    }

    @Test
    fun `a locked account signs in with an unlock code, and a wrong password costs the code a try`() = runBlocking<Unit> {
        val srv = server(signups = "open")
        val first = device(srv, "first")
        first.signUp("locked@example.com", PASSWORD)
        first.signOut()
        srv.lock("locked@example.com")
        val phone = device(srv)
        val locked = rejects("locked") { phone.signIn("locked@example.com", PASSWORD) }
        assertEquals(900L, locked.retryAfter)
        phone.requestCode("locked@example.com", "unlock")
        val code = srv.codeFor("locked@example.com")!!
        rejects("unauthorized") { phone.signIn("locked@example.com", "not the password at all", code) }
        phone.signIn("locked@example.com", PASSWORD, code)
        assertTrue(phone.signedIn)
        assertEquals(code, bodies(srv, "POST /v1/login").last()["emailCode"]!!.jsonObject.str("code"))
        rejects("locked") { device(srv, "third").signIn("locked@example.com", PASSWORD) }
    }

    @Test
    fun `a locked account recovers with an unlock code sent with both steps`() = runBlocking<Unit> {
        val srv = server(signups = "open")
        val first = device(srv, "first")
        val key = first.signUp("recover@example.com", PASSWORD).recoveryKey
        srv.lock("recover@example.com")
        val phone = device(srv)
        rejects("locked") { phone.recover("recover@example.com", key, "a brand new password") }
        phone.requestCode("recover@example.com", "unlock")
        val token = srv.tokenFor("recover@example.com")!!
        phone.recover("recover@example.com", key, "a brand new password", token)
        assertTrue(phone.signedIn)
        assertEquals(token, bodies(srv, "POST /v1/recover/start").last()["emailCode"]!!.jsonObject.str("token"))
        assertEquals(token, bodies(srv, "POST /v1/recover/finish").last()["emailCode"]!!.jsonObject.str("token"))
    }

    private companion object {
        const val PASSWORD = "a long enough password"
    }
}
