package nl.bvdm.rukoo.core.net

import kotlinx.coroutines.runBlocking
import nl.bvdm.rukoo.account.RawHttpServer
import nl.bvdm.rukoo.categories.Category
import nl.bvdm.rukoo.categories.Jev
import nl.bvdm.rukoo.categories.JevError
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.mail.FakeCipher
import nl.bvdm.rukoo.mail.MailException
import nl.bvdm.rukoo.mail.TestStrings
import nl.bvdm.rukoo.mail.google.GoogleAuth
import nl.bvdm.rukoo.mail.google.GoogleClientStore
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.GoogleClient
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.net.SafeHttp
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The app's other OkHttp clients count every byte of an answer, headers and chunk framing too, as the account client
 * does (#252): a server can't put megabytes of chunk extension, which OkHttp reads in any length, in front of a small
 * body. 8 MiB of extension is well over each client's limit, so what the client leaves unread doesn't fit in the
 * sockets' buffers and the server sees it hang up.
 */
class MeteredClientsTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val extension = 8L * 1024 * 1024

    // ---- SafeHttp (one-click unsubscribe) ----

    private val safe = SafeHttp(OkHttpClient(), scheme = "http", dns = Dns.SYSTEM, checkLiterals = false)

    @Test
    fun `a remote answer with a long chunk extension is dropped where the connection passes the limit`() = runBlocking {
        RawHttpServer { _, out -> RawHttpServer.chunked(out, "ok".toByteArray(), extension) }.use { srv ->
            assertNull(safe.request("${srv.url}/u"))
            assertTrue(srv.awaitServed())
            assertEquals("the server couldn't send its whole answer", 1, srv.cutOff.get())
            assertTrue("it wrote less than the answer (${srv.written.get()})", srv.written.get() < extension)
        }
        // A short one is read.
        RawHttpServer { _, out -> RawHttpServer.chunked(out, "ok".toByteArray(), 10_000) }.use { srv ->
            assertEquals("ok", safe.request("${srv.url}/u")!!.body!!.toString(Charsets.UTF_8))
        }
    }

    @Test
    fun `a remote answer comes uncompressed or not at all`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("plain"))
            server.enqueue(MockResponse().setHeader("Content-Encoding", "gzip").setBody("not really gzip"))
            server.start()
            assertEquals("plain", safe.request(server.url("/a").toString())!!.body!!.toString(Charsets.UTF_8))
            assertEquals("identity", server.takeRequest().getHeader("Accept-Encoding"))
            assertNull(safe.request(server.url("/b").toString()))
        }
    }

    // ---- GoogleAuth (token requests) ----

    private fun google(url: String): GoogleAuth {
        val store = GoogleClientStore(java.io.File(tmp.newFolder(), "client.json"), FakeCipher)
        store.set(GoogleClient("cid", "secret"))
        return GoogleAuth(store, OkHttpClient(), TestStrings, Clock { 1_000 }, tokenEndpoint = "$url/token")
    }

    private suspend fun refreshFails(auth: GoogleAuth) {
        try {
            auth.refresh("rt")
            fail("expected a connection error")
        } catch (e: MailException) {
            assertEquals("network", e.code)
        }
    }

    @Test
    fun `a token answer with a long chunk extension fails as a connection error`() = runBlocking {
        RawHttpServer { _, out -> RawHttpServer.chunked(out, """{"access_token":"at"}""".toByteArray(), extension) }.use { srv ->
            refreshFails(google(srv.url))
            assertTrue(srv.awaitServed())
            assertEquals(1, srv.cutOff.get())
            assertTrue(srv.written.get() < extension)
        }
        RawHttpServer { _, out -> RawHttpServer.chunked(out, """{"access_token":"at","expires_in":60}""".toByteArray(), 10_000) }.use { srv ->
            assertEquals("at", google(srv.url).refresh("rt").accessToken)
        }
    }

    @Test
    fun `a token answer is read up to its limit and uncompressed`() = runBlocking {
        MockWebServer().use { server ->
            val big = """{"access_token":"at","pad":"${"x".repeat(GoogleAuth.MAX_ANSWER.toInt())}"}"""
            server.enqueue(MockResponse().setBody(big))
            server.enqueue(MockResponse().setHeader("Content-Encoding", "gzip").setBody("""{"access_token":"at"}"""))
            server.enqueue(MockResponse().setBody("""{"access_token":"at","expires_in":60}"""))
            server.start()
            val auth = google(server.url("").toString().trimEnd('/'))
            refreshFails(auth)
            refreshFails(auth)
            assertEquals("at", auth.refresh("rt").accessToken)
            assertEquals("identity", server.takeRequest().getHeader("Accept-Encoding"))
        }
    }

    // ---- Jev (TypeSafe) ----

    private val categories = listOf(
        Category("updates", "updates", "Updates", "Notifications", customName = false, customDescription = false, color = "blue", order = 0),
        Category("people", "people", "People", "Mail from people", customName = false, customDescription = false, color = "green", order = 1),
    )
    private val message = MessageSummary(id = "acc1:INBOX:1", accountId = "acc1", folder = "INBOX", uid = 1, from = Address("App", "app@example.com"), subject = "Your code")

    private fun answer(pad: Int = 0) =
        """{"model":"jev-1.13.0","answers":{"category":{"choice":"updates","confidence":0.9}}${if (pad > 0) ",\"pad\":\"${"x".repeat(pad)}\"" else ""}}"""

    private suspend fun Jev.ask() = classify("KEY", message, categories, toMe = true)

    @Test
    fun `a Jev answer with a long chunk extension is refused where the connection passes the limit`() = runBlocking {
        RawHttpServer { _, out -> RawHttpServer.chunked(out, answer().toByteArray(), extension) }.use { srv ->
            try {
                Jev(OkHttpClient(), "${srv.url}/v1/systemone").ask()
                fail("expected a refusal")
            } catch (e: JevError) {
                assertEquals("server", e.code)
            }
            assertTrue(srv.awaitServed())
            assertEquals(1, srv.cutOff.get())
            assertTrue(srv.written.get() < extension)
        }
        RawHttpServer { _, out -> RawHttpServer.chunked(out, answer().toByteArray(), 10_000) }.use { srv ->
            assertEquals("updates", Jev(OkHttpClient(), "${srv.url}/v1/systemone").ask().category)
        }
    }

    @Test
    fun `each Jev answer counts from zero on a connection kept for the next email`() = runBlocking {
        MockWebServer().use { server ->
            // Each answer is under the limit; the two together are over it.
            val pad = 900 * 1024
            repeat(3) { server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(answer(pad))) }
            server.enqueue(MockResponse().setHeader("Content-Encoding", "gzip").setBody(answer()))
            server.start()
            val jev = Jev(OkHttpClient(), server.url("/v1/systemone").toString())
            repeat(3) { assertEquals("updates", jev.ask().category) }
            for (i in 0 until 3) {
                val request = server.takeRequest()
                assertEquals("the connection is kept", i, request.sequenceNumber)
                assertEquals("identity", request.getHeader("Accept-Encoding"))
            }
            try {
                jev.ask()
                fail("a compressed answer is refused")
            } catch (e: JevError) {
                assertEquals("server", e.code)
            }
        }
    }

    @Test
    fun `a kept connection counts each call from zero and fails the one that passes the limit`() = runBlocking {
        // Four answers of 40 KiB on one connection, 160 KiB together, under a limit of 64 KiB a call.
        val meter = ConnectionMeter(64 * 1024)
        val client = meter.client(OkHttpClient()).build()
        MockWebServer().use { server ->
            repeat(4) { server.enqueue(MockResponse().setBody("x".repeat(40 * 1024))) }
            server.start()
            repeat(4) {
                client.newCall(okhttp3.Request.Builder().url(server.url("/$it")).build()).execute().use { res ->
                    assertEquals(40 * 1024, res.body!!.string().length)
                }
            }
            assertEquals(4, server.requestCount)
        }
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("x".repeat(80 * 1024)))
            server.start()
            val failed = runCatching { client.newCall(okhttp3.Request.Builder().url(server.url("/big")).build()).execute().use { it.body!!.string() } }
            assertNotNull("an answer over the limit fails", failed.exceptionOrNull() as? TooMuchRead)
        }
    }
}
