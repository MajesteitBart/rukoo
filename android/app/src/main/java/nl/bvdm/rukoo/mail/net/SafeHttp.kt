package nl.bvdm.rukoo.mail.net

import java.io.IOException
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Dns
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaTypeOrNull

/** Desktop's isPublicAddress (net.js:12-63): no private, loopback, link-local, CGNAT, multicast or reserved ranges. */
object PublicAddress {
    private fun v4(ip: String): IntArray? {
        val parts = ip.split('.')
        if (parts.size != 4) return null
        return IntArray(4) { i ->
            val p = parts[i]
            if (p.isEmpty() || p.length > 3 || !p.all { it.isDigit() } || (p.length > 1 && p[0] == '0')) return null
            p.toInt().takeIf { it <= 255 } ?: return null
        }
    }

    private fun v4Private(a: Int, b: Int): Boolean =
        a == 0 || a == 10 || a == 127 || (a == 100 && b in 64..127) || (a == 169 && b == 254) || (a == 172 && b in 16..31) ||
            (a == 192 && b == 168) || (a == 192 && b == 0) || (a == 198 && (b == 18 || b == 19)) || a >= 224

    /** The eight 16-bit groups of an IPv6 address, whichever way it is written ("::", an IPv4 tail). */
    internal fun v6Groups(ip: String): IntArray? {
        var text = ip.lowercase().substringBefore('%')
        if (':' !in text) return null
        val tail = Regex("(\\d+\\.\\d+\\.\\d+\\.\\d+)$").find(text)
        if (tail != null) {
            val q = v4(tail.value) ?: return null
            text = text.dropLast(tail.value.length) + "${((q[0] shl 8) or q[1]).toString(16)}:${((q[2] shl 8) or q[3]).toString(16)}"
        }
        val halves = text.split("::")
        if (halves.size > 2) return null
        val left = if (halves[0].isEmpty()) emptyList() else halves[0].split(':')
        val right = if (halves.size == 2 && halves[1].isNotEmpty()) halves[1].split(':') else emptyList()
        val fill = if (halves.size == 2) List(8 - left.size - right.size) { "0" } else emptyList()
        if (halves.size == 2 && left.size + right.size > 7) return null
        val all = left + fill + right
        if (all.size != 8) return null
        return IntArray(8) { i ->
            val g = all[i]
            if (g.isEmpty() || g.length > 4) return null
            g.toIntOrNull(16) ?: return null
        }
    }

    fun isIp(host: String): Boolean = v4(host) != null || v6Groups(host.removePrefix("[").removeSuffix("]")) != null

    fun isPublic(ip: String): Boolean {
        v4(ip)?.let { return !v4Private(it[0], it[1]) }
        val g = v6Groups(ip.removePrefix("[").removeSuffix("]")) ?: return false
        fun zero(n: Int) = (0 until n).all { g[it] == 0 }
        // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d).
        if (zero(5) && g[5] == 0xffff) return !v4Private(g[6] shr 8, g[6] and 255)
        if (zero(6)) return g[6] != 0 && !v4Private(g[6] shr 8, g[6] and 255)
        if (g[0] == 0x64 && g[1] == 0xff9b) return false
        val first = g[0]
        return !(
            (first and 0xfe00) == 0xfc00 || // unique local
                (first and 0xffc0) == 0xfe80 || // link local
                (first and 0xffc0) == 0xfec0 || // site local
                (first and 0xff00) == 0xff00 // multicast
            )
    }
}

/**
 * A DNS lookup that refuses names resolving to anything but public addresses. OkHttp connects only to
 * what this returns, so the check is on the address actually used, like net.js publicLookup.
 */
class PublicDns(private val delegate: Dns = Dns.SYSTEM) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val addresses = delegate.lookup(hostname)
        if (addresses.isEmpty() || !addresses.all { PublicAddress.isPublic(it.hostAddress ?: "") }) {
            throw UnknownHostException("not a public address")
        }
        return addresses
    }
}

/**
 * Requests the app makes on its own behalf to URLs that come from mail (one-click unsubscribe). Ported
 * from desktop's net.js: https only, public addresses only, a few checked redirects at most, one
 * deadline for the whole request and a size limit on the answer.
 */
class SafeHttp(
    base: OkHttpClient,
    private val scheme: String = "https",
    dns: Dns = PublicDns(),
    /** Tests run against a local server; production always checks literal addresses. */
    private val checkLiterals: Boolean = true,
) {
    class Result(val status: Int, val headers: Headers, val body: ByteArray?)

    private val client = base.newBuilder().dns(dns).followRedirects(false).followSslRedirects(false).build()

    /** The answer, or null when the request failed, was refused or ran over a limit. */
    suspend fun request(
        url: String,
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        contentType: String? = null,
        maxBytes: Long = 256 * 1024,
        timeoutMs: Long = 3000,
        redirects: Int = 3,
    ): Result? = withContext(Dispatchers.IO) {
        val deadline = System.currentTimeMillis() + timeoutMs
        var target = url.toHttpUrlOrNull() ?: return@withContext null
        var left = redirects
        while (true) {
            if (!allowed(target)) return@withContext null
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) return@withContext null
            val request = Request.Builder().url(target).apply {
                headers.forEach { (k, v) -> header(k, v) }
                method(method, body?.toRequestBody(contentType?.toMediaTypeOrNull()))
            }.build()
            val call = client.newBuilder().callTimeout(remaining, TimeUnit.MILLISECONDS).build().newCall(request)
            try {
                call.execute().use { res ->
                    val location = res.header("Location")
                    if (res.code in 300..399 && location != null) {
                        if (left <= 0 || method != "GET") return@withContext Result(res.code, res.headers, null)
                        target = target.resolve(location) ?: return@withContext null
                        left--
                        return@use
                    }
                    val declared = res.header("Content-Length")?.toLongOrNull()
                    if (declared != null && declared > maxBytes) return@withContext null
                    val source = res.body?.source() ?: return@withContext Result(res.code, res.headers, ByteArray(0))
                    // Reads at most one byte past the limit to tell "too large" from "exactly the limit".
                    source.request(maxBytes + 1)
                    if (source.buffer.size > maxBytes) return@withContext null
                    return@withContext Result(res.code, res.headers, source.buffer.readByteArray())
                }
            } catch (e: IOException) {
                return@withContext null
            }
        }
        @Suppress("UNREACHABLE_CODE")
        null
    }

    private fun allowed(url: HttpUrl): Boolean {
        if (url.scheme != scheme) return false
        // Sockets skip the lookup for an address written as a literal, so check that one here.
        if (checkLiterals && PublicAddress.isIp(url.host) && !PublicAddress.isPublic(url.host)) return false
        return true
    }

    /** RFC 8058 one-click unsubscribe: a POST that counts only if the endpoint itself answers 2xx. */
    suspend fun oneClickUnsubscribe(url: String): Boolean {
        val res = request(
            url,
            method = "POST",
            body = "List-Unsubscribe=One-Click".toByteArray(),
            contentType = "application/x-www-form-urlencoded",
            maxBytes = 64 * 1024,
            timeoutMs = 10_000,
            redirects = 0,
        )
        return res != null && res.status in 200..299
    }
}
