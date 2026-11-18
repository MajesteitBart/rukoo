package nl.bvdm.rukoo.core.net

import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import javax.net.SocketFactory
import okhttp3.Call
import okhttp3.Connection
import okhttp3.ConnectionPool
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response

/**
 * Plain sockets that count every byte read from them, so an answer's headers and HTTP framing count as well as its
 * body. Under TLS, the platform's TLS socket reads the encrypted stream through [Socket.getInputStream] of the socket
 * it wraps, so the count is the encrypted bytes, handshake included. [read] adds up every socket this factory made;
 * a read that takes it past [limit] fails with [TooMuchRead], and so does every read after it.
 */
internal class MeteredSocketFactory(val limit: Long) : SocketFactory() {
    val read = AtomicLong()

    /** Whether the sockets read past [limit]. */
    val over: Boolean get() = read.get() > limit

    // OkHttp asks for an unconnected socket and connects it itself; the other ways are here for completeness.
    override fun createSocket(): Socket = MeteredSocket()

    override fun createSocket(host: String?, port: Int): Socket = connected(MeteredSocket(), InetSocketAddress(InetAddress.getByName(host), port), null)

    override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket =
        connected(MeteredSocket(), InetSocketAddress(InetAddress.getByName(host), port), InetSocketAddress(localHost, localPort))

    override fun createSocket(host: InetAddress?, port: Int): Socket = connected(MeteredSocket(), InetSocketAddress(host, port), null)

    override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket =
        connected(MeteredSocket(), InetSocketAddress(address, port), InetSocketAddress(localAddress, localPort))

    private fun count(n: Long) {
        if (read.addAndGet(n) > limit) throw TooMuchRead(limit)
    }

    private fun refuseWhenOver() {
        if (over) throw TooMuchRead(limit)
    }

    private inner class MeteredSocket : Socket() {
        override fun getInputStream(): InputStream = Counted(super.getInputStream(), ::refuseWhenOver, ::count)
    }
}

/**
 * Counts what each call reads off its connection, on a client that keeps its connections for the next call: the count
 * starts again when a call takes the connection (EventListener.connectionAcquired), and a read that takes it past
 * [limit] fails with [TooMuchRead]. Headers and framing such as chunk extensions count, as with [MeteredSocketFactory],
 * without a TLS handshake for every call. [client] makes the client: HTTP/1.1, so a connection carries one call at a
 * time, and a pool of its own.
 *
 * OkHttp makes a connection's socket with the client's socket factory and reports connectStart on the same thread
 * before connecting it, which ties the socket to the connection the call then takes. A call that finds no socket of
 * its own, such as one through a SOCKS proxy (which skips the socket factory), isn't counted.
 */
internal class ConnectionMeter(val limit: Long) {
    // The socket this thread made last, until connectStart takes it.
    private val made = ThreadLocal<CountingSocket?>()

    // Each connection's socket. Weak, so a connection the pool let go of goes with its entry.
    private val sockets: MutableMap<Connection, CountingSocket> = Collections.synchronizedMap(WeakHashMap())

    fun client(base: OkHttpClient): OkHttpClient.Builder = base.newBuilder()
        .socketFactory(Factory())
        .eventListenerFactory { Listener() }
        .protocols(listOf(Protocol.HTTP_1_1))
        .connectionPool(ConnectionPool())

    private inner class Factory : SocketFactory() {
        override fun createSocket(): Socket = CountingSocket(limit).also { made.set(it) }

        override fun createSocket(host: String?, port: Int): Socket = connected(CountingSocket(limit), InetSocketAddress(InetAddress.getByName(host), port), null)

        override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket =
            connected(CountingSocket(limit), InetSocketAddress(InetAddress.getByName(host), port), InetSocketAddress(localHost, localPort))

        override fun createSocket(host: InetAddress?, port: Int): Socket = connected(CountingSocket(limit), InetSocketAddress(host, port), null)

        override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket =
            connected(CountingSocket(limit), InetSocketAddress(address, port), InetSocketAddress(localAddress, localPort))
    }

    /** One per call. */
    private inner class Listener : EventListener() {
        private var fresh: CountingSocket? = null

        override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
            fresh = made.get()
            made.remove()
        }

        override fun connectionAcquired(call: Call, connection: Connection) {
            // A connection this call made, unless it lost a race to a pooled one and was closed.
            val own = fresh?.takeUnless { it.isClosed }
            fresh = null
            val socket = if (own != null) own.also { sockets[connection] = it } else sockets[connection]
            socket?.restart()
        }
    }
}

/** A socket whose reads count from [restart] on, failing with [TooMuchRead] once past [limit]. */
private class CountingSocket(private val limit: Long) : Socket() {
    private val read = AtomicLong()

    fun restart() = read.set(0)

    override fun getInputStream(): InputStream = Counted(
        super.getInputStream(),
        refuse = { if (read.get() > limit) throw TooMuchRead(limit) },
        count = { n -> if (read.addAndGet(n) > limit) throw TooMuchRead(limit) },
    )
}

private class Counted(input: InputStream, private val refuse: () -> Unit, private val count: (Long) -> Unit) : FilterInputStream(input) {
    override fun read(): Int {
        refuse()
        return super.read().also { if (it >= 0) count(1) }
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        refuse()
        return super.read(b, off, len).also { if (it > 0) count(it.toLong()) }
    }

    override fun skip(n: Long): Long {
        refuse()
        return super.skip(n).also { if (it > 0) count(it) }
    }
}

private fun connected(socket: Socket, remote: InetSocketAddress, local: InetSocketAddress?): Socket = socket.apply {
    try {
        if (local != null) bind(local)
        connect(remote)
    } catch (e: IOException) {
        close()
        throw e
    }
}

/**
 * [base] for one call whose bytes [sockets] counts: a connection of its own that ends with the answer, so every byte
 * read on it belongs to that call, on HTTP/1.1, which carries one call per connection.
 */
internal fun ownConnection(base: OkHttpClient, sockets: MeteredSocketFactory): OkHttpClient = base.newBuilder()
    .socketFactory(sockets)
    .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
    .protocols(listOf(Protocol.HTTP_1_1))
    .build()

/**
 * Whether the answer came compressed although the request asked for `Accept-Encoding: identity`. A compressed answer
 * can't be read as it is, and OkHttp unpacks only what it asked for itself, so it isn't downloaded either.
 */
internal fun Response.compressed(): Boolean =
    headers("Content-Encoding").flatMap { it.split(',') }.map { it.trim() }.any { it.isNotEmpty() && !it.equals("identity", ignoreCase = true) }

/**
 * Room for what comes with an answer besides its body: headers (OkHttp takes up to 256 KiB of them) and, under TLS, the
 * handshake and the encryption's few bytes per record.
 */
internal const val FRAMING_ALLOWANCE = 512L * 1024

/** An answer that took more bytes than one call may read. */
internal class TooMuchRead(limit: Long) : IOException("more than $limit bytes read")
