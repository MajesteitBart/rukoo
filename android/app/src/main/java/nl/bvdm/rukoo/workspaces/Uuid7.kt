package nl.bvdm.rukoo.workspaces

import java.security.SecureRandom

/**
 * Operation IDs: UUIDv7 with the layout of contract §3.8, the same on both apps. From 10 random bytes `r`: bytes 0 to
 * 5 are the milliseconds big-endian, byte 6 is `0x70 | (r[0] & 0x0f)`, byte 7 is `r[1]`, byte 8 is
 * `0x80 | (r[2] & 0x3f)`, bytes 9 to 15 are `r[3..9]`; lowercase hex in 8-4-4-4-12 groups.
 *
 * There is no counter: the server checks an ID's time against its clock, and two sends in one millisecond differ in
 * 74 random bits. The caller passes the server-corrected time (`now + clockOffset`).
 */
object Uuid7 {
    const val MAX_MS = (1L shl 48) - 1
    private val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    private val random = SecureRandom()

    /** A new ID for the time [ms], with fresh random bytes. */
    fun next(ms: Long): String = format(ms, ByteArray(10).also(random::nextBytes))

    /** The ID for [ms] and the 10 bytes [r]. */
    fun format(ms: Long, r: ByteArray): String {
        require(ms in 0..MAX_MS) { "milliseconds outside 48 bits" }
        require(r.size == 10) { "10 random bytes" }
        val b = ByteArray(16)
        for (i in 0 until 6) b[i] = (ms ushr (8 * (5 - i))).toByte()
        b[6] = (0x70 or (r[0].toInt() and 0x0f)).toByte()
        b[7] = r[1]
        b[8] = (0x80 or (r[2].toInt() and 0x3f)).toByte()
        for (i in 9 until 16) b[i] = r[i - 6]
        val hex = buildString(32) { for (x in b) append(HEX[(x.toInt() ushr 4) and 0xf]).append(HEX[x.toInt() and 0xf]) }
        return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
    }

    fun isValid(id: String?): Boolean = id != null && UUID.matches(id)

    /** The milliseconds in an ID's first 48 bits, or null when it isn't a UUIDv7. */
    fun timeOf(id: String): Long? = if (isValid(id)) id.replace("-", "").substring(0, 12).toLong(16) else null

    private const val HEX = "0123456789abcdef"
}
