package nl.bvdm.rukoo.account

import java.io.OutputStream
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The account client over the phone's own TLS (Conscrypt), which a JVM test doesn't have: the counting socket only
 * works when the TLS socket reads the connection through it. Both ends run on the device, over localhost.
 */
class AccountClientDeviceTest {
    private val held = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val serverCerts = HandshakeCertificates.Builder().heldCertificate(held).build()
    private val clientCerts = HandshakeCertificates.Builder().addTrustedCertificate(held.certificate).build()
    private val http = OkHttpAccountHttp(OkHttpClient.Builder().sslSocketFactory(clientCerts.sslSocketFactory(), clientCerts.trustManager).build())
    private val servers = mutableListOf<TlsServer>()

    @After
    fun tearDown() {
        servers.forEach { it.close() }
    }

    @Test
    fun headersAndChunkFramingCountOverTls() = runBlocking {
        val pad = "x".repeat(200 * 1024)
        val srv = server { out -> TlsServer.chunked(out, """{"ok":true}""".toByteArray(), 100_000, "X-Pad: $pad\r\n") }
        val meter = AtomicLong()
        val res = http.request(srv.url, "GET", "/v1/info", null, null, meter) as JsonObject
        assertEquals(JsonPrimitive(true), res["ok"])
        assertTrue(srv.awaitServed())
        val written = srv.written.get()
        // Read encrypted, the answer takes a little more than the server wrote: the handshake and a few bytes per record.
        assertTrue("the meter has at least what the server wrote ($written): ${meter.get()}", meter.get() >= written)
        assertTrue("and not much more: ${meter.get()}", meter.get() < written + 64 * 1024)
        assertEquals("the phone named the server it wanted", listOf("localhost"), srv.serverNames.toList())
    }

    @Test
    fun aLongChunkExtensionOverTlsEndsTheAnswerAtTheLimit() = runBlocking {
        val extension = 64L * 1024 * 1024
        val srv = server { out -> TlsServer.chunked(out, "{}".toByteArray(), extension) }
        val meter = AtomicLong()
        try {
            http.request(srv.url, "GET", "/v1/records?since=0", null, "token", meter)
            fail("expected too_large")
        } catch (e: AccountError) {
            assertEquals("too_large", e.code)
        }
        assertTrue(srv.awaitServed())
        assertTrue("the server couldn't send its whole answer", srv.cutOff.get())
        assertTrue("the server wrote less than the answer (${srv.written.get()})", srv.written.get() < extension)
        val limit = OkHttpAccountHttp.RAW_LIMIT
        assertTrue("the meter has what was read, up to the limit (${meter.get()})", meter.get() > limit && meter.get() < limit + 1024 * 1024)
    }

    private fun server(answer: (OutputStream) -> Unit) = TlsServer(serverCerts, answer = answer).also { servers += it }
}
