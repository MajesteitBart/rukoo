package nl.bvdm.rukoo.account

import java.io.Closeable
import java.io.FilterOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.ExtendedSSLSession
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import kotlin.concurrent.thread
import okhttp3.tls.HandshakeCertificates

/**
 * An HTTPS server on the device, for answers MockWebServer can't give, such as chunk extensions. [answer] writes the
 * whole response to each request. Without [keepAlive] the connection ends after one answer; with it, the connection
 * waits for the next request, so the answers must say how long they are and not ask to close.
 */
internal class TlsServer(certs: HandshakeCertificates, private val keepAlive: Boolean = false, private val answer: (OutputStream) -> Unit) : Closeable {
    private val server = certs.sslContext().serverSocketFactory.createServerSocket(0)
    val url = "https://localhost:${server.localPort}"
    val written = AtomicLong()
    val cutOff = AtomicBoolean()
    val connections = AtomicInteger()
    val requests = AtomicInteger()
    val serverNames = CopyOnWriteArrayList<String>()
    private val served = LinkedBlockingQueue<Unit>()

    init {
        thread(isDaemon = true, name = "tls-server") {
            while (true) {
                val socket = try {
                    server.accept() as SSLSocket
                } catch (e: IOException) {
                    break
                }
                connections.incrementAndGet()
                thread(isDaemon = true, name = "tls-connection") { serve(socket) }
            }
        }
    }

    /** Waits for the next connection to be done with. */
    fun awaitServed(): Boolean = served.poll(60, TimeUnit.SECONDS) != null

    private fun serve(socket: SSLSocket) {
        try {
            socket.use {
                it.startHandshake()
                (it.session as? ExtendedSSLSession)?.requestedServerNames?.forEach { name -> if (name is SNIHostName) serverNames += name.asciiName }
                val input = it.inputStream.buffered()
                val counted = object : FilterOutputStream(it.outputStream.buffered(64 * 1024)) {
                    override fun write(b: ByteArray, off: Int, len: Int) {
                        out.write(b, off, len)
                        written.addAndGet(len.toLong())
                    }

                    override fun write(b: Int) {
                        out.write(b)
                        written.incrementAndGet()
                    }
                }
                while (readRequest(input)) {
                    requests.incrementAndGet()
                    try {
                        answer(counted)
                        counted.flush()
                    } catch (e: IOException) {
                        cutOff.set(true)
                        break
                    }
                    if (!keepAlive) break
                }
            }
        } catch (e: IOException) {
            // The handshake or the request failed; the test sees that on its side.
        } finally {
            served.put(Unit)
        }
    }

    /** Reads a request's headers and its body when it has a Content-Length; false when the client went away first. */
    private fun readRequest(input: InputStream): Boolean {
        val line = StringBuilder()
        var length = 0L
        while (true) {
            val b = input.read()
            if (b < 0) return false
            if (b != '\n'.code) {
                line.append(b.toChar())
                continue
            }
            val text = line.toString().trimEnd('\r')
            line.setLength(0)
            if (text.isEmpty()) break
            if (text.substringBefore(':').trim().equals("Content-Length", ignoreCase = true)) length = text.substringAfter(':').trim().toLongOrNull() ?: 0
        }
        while (length > 0) {
            if (input.read() < 0) return false
            length--
        }
        return true
    }

    override fun close() {
        server.close()
    }

    companion object {
        /**
         * A 200 answer of [body] as one chunk, behind a chunk extension of [extension] bytes, written in pieces so a
         * long one never sits in memory. With [close] the answer asks for the connection to end.
         */
        fun chunked(out: OutputStream, body: ByteArray, extension: Long, headers: String = "", close: Boolean = true) {
            out.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n${if (close) "Connection: close\r\n" else ""}$headers\r\n".toByteArray())
            out.write(body.size.toString(16).toByteArray())
            if (extension > 0) {
                out.write(';'.code)
                val piece = ByteArray(64 * 1024) { 'x'.code.toByte() }
                var left = extension - 1
                while (left > 0) {
                    val n = minOf(left, piece.size.toLong()).toInt()
                    out.write(piece, 0, n)
                    left -= n
                }
            }
            out.write("\r\n".toByteArray())
            out.write(body)
            out.write("\r\n0\r\n\r\n".toByteArray())
        }
    }
}
