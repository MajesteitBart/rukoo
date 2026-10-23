package nl.bvdm.rukoo.core

import java.security.SecureRandom
import java.util.Base64
import java.util.UUID

/** Ids in the desktop's formats (hub.js:75-77), so conversations and items look the same on both. */
object Ids {
    private val random = SecureRandom()
    private const val ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

    /** n lowercase letters and digits. */
    fun rand(n: Int): String {
        val out = CharArray(n)
        for (i in 0 until n) out[i] = ALPHABET[random.nextInt(ALPHABET.length)]
        return String(out)
    }

    /** `c_<ms in base 36>_<6>`, like `newConversationId` on desktop. */
    fun conversationId(clock: Clock = Clock.System): String = "c_${clock.now().toString(36)}_${rand(6)}"

    fun itemId(): String = "i_${rand(10)}"

    fun turnId(): String = "t_${rand(10)}"

    fun uuid(): String = UUID.randomUUID().toString()

    /** 32 random bytes, base64url without padding (43 characters): bearer tokens Rukoo hands out. */
    fun token(): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
