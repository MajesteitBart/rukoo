package nl.bvdm.rukoo.core.net

import java.io.OutputStream
import kotlinx.coroutines.runBlocking
import nl.bvdm.rukoo.account.TlsServer
import nl.bvdm.rukoo.categories.Category
import nl.bvdm.rukoo.categories.Jev
import nl.bvdm.rukoo.categories.JevError
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.net.SafeHttp
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Jev and the remote fetches over the phone's own TLS (Conscrypt), as AccountClientDeviceTest does for the account
 * client: the counts only work when the TLS socket reads the connection through the counting socket underneath, and
 * Jev's count also has to follow the connection a call takes from the pool (#252). Both ends run on the device.
 */
class MeteredClientsDeviceTest {
    private val held = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val serverCerts = HandshakeCertificates.Builder().heldCertificate(held).build()
    private val clientCerts = HandshakeCertificates.Builder().addTrustedCertificate(held.certificate).build()
    private val base = OkHttpClient.Builder().sslSocketFactory(clientCerts.sslSocketFactory(), clientCerts.trustManager).build()
    private val servers = mutableListOf<TlsServer>()
    private val extension = 64L * 1024 * 1024

    @After
    fun tearDown() {
        servers.forEach { it.close() }
    }

    private fun server(keepAlive: Boolean = false, answer: (OutputStream) -> Unit) = TlsServer(serverCerts, keepAlive, answer).also { servers += it }

    private val categories = listOf(
        Category("updates", "updates", "Updates", "Notifications", customName = false, customDescription = false, color = "blue", order = 0),
        Category("people", "people", "People", "Mail from people", customName = false, customDescription = false, color = "green", order = 1),
    )
    private val message = MessageSummary(id = "acc1:INBOX:1", accountId = "acc1", folder = "INBOX", uid = 1, from = Address("App", "app@example.com"), subject = "Your code")

    private fun answer(pad: Int = 0) =
        """{"model":"jev-1.13.0","answers":{"category":{"choice":"updates","confidence":0.9}}${if (pad > 0) ",\"pad\":\"${"x".repeat(pad)}\"" else ""}}"""

    @Test
    fun aJevAnswerWithALongChunkExtensionOverTlsIsRefusedAtTheLimit() = runBlocking {
        val srv = server { out -> TlsServer.chunked(out, answer().toByteArray(), extension) }
        try {
            Jev(base, "${srv.url}/v1/systemone").classify("KEY", message, categories, toMe = true)
            fail("expected a refusal")
        } catch (e: JevError) {
            assertEquals("server", e.code)
        }
        assertTrue(srv.awaitServed())
        assertTrue("the server couldn't send its whole answer", srv.cutOff.get())
        assertTrue("it wrote less than the answer (${srv.written.get()})", srv.written.get() < extension)
    }

    @Test
    fun eachJevAnswerOverOneKeptTlsConnectionCountsFromZero() = runBlocking {
        // Each answer is under Jev's limit (1.5 MiB with framing); the three together are far over it.
        val body = answer(900 * 1024).toByteArray()
        val srv = server(keepAlive = true) { out -> TlsServer.chunked(out, body, 1000, close = false) }
        val jev = Jev(base, "${srv.url}/v1/systemone")
        repeat(3) { assertEquals("updates", jev.classify("KEY", message, categories, toMe = true).category) }
        assertEquals("the calls shared one connection", 1, srv.connections.get())
        assertEquals(3, srv.requests.get())
    }

    @Test
    fun aRemoteAnswerWithALongChunkExtensionOverTlsIsDropped() = runBlocking {
        val safe = SafeHttp(base, scheme = "https", dns = Dns.SYSTEM, checkLiterals = false)
        val srv = server { out -> TlsServer.chunked(out, "ok".toByteArray(), extension) }
        assertNull(safe.request("${srv.url}/u", timeoutMs = 30_000))
        assertTrue(srv.awaitServed())
        assertTrue("the server couldn't send its whole answer", srv.cutOff.get())
        assertTrue(srv.written.get() < extension)
        val fine = server { out -> TlsServer.chunked(out, "ok".toByteArray(), 10_000) }
        assertEquals("ok", safe.request("${fine.url}/u", timeoutMs = 30_000)!!.body!!.toString(Charsets.UTF_8))
    }
}
