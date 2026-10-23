package nl.bvdm.rukoo.core

import java.io.ByteArrayOutputStream

/**
 * JavaScript's encodeURIComponent and decodeURIComponent. Message ids and the demo data must match
 * desktop byte for byte, and URLEncoder differs (spaces as `+`, `!'()*~` escaped).
 */
object UriComponent {
    private const val HEX = "0123456789ABCDEF"

    private fun unreserved(c: Char): Boolean =
        c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c in "-_.!~*'()"

    fun encode(value: String): String {
        val out = StringBuilder(value.length)
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val c = (byte.toInt() and 0xff).toChar()
            if (c.code < 0x80 && unreserved(c)) {
                out.append(c)
            } else {
                val b = byte.toInt() and 0xff
                out.append('%').append(HEX[b shr 4]).append(HEX[b and 0x0f])
            }
        }
        return out.toString()
    }

    /** Null where JavaScript would throw a URIError: a broken escape or bytes that aren't UTF-8. */
    fun decode(value: String): String? {
        if ('%' !in value) return value
        val out = StringBuilder(value.length)
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if (c != '%') {
                out.append(c)
                i++
                continue
            }
            val bytes = ByteArrayOutputStream()
            while (i < value.length && value[i] == '%') {
                if (i + 2 >= value.length) return null
                val hi = Character.digit(value[i + 1], 16)
                val lo = Character.digit(value[i + 2], 16)
                if (hi < 0 || lo < 0) return null
                bytes.write((hi shl 4) or lo)
                i += 3
            }
            out.append(utf8(bytes.toByteArray()) ?: return null)
        }
        return out.toString()
    }

    private fun utf8(bytes: ByteArray): String? {
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
        return runCatching { decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString() }.getOrNull()
    }
}
