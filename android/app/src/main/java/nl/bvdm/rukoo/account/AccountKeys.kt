package nl.bvdm.rukoo.account

import java.security.SecureRandom
import java.text.Normalizer
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.core.RukooJson
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters

/** The account's password hashing settings (server/PROTOCOL.md, Keys): memory in KiB, passes and lanes. */
@Serializable
data class Kdf(val alg: String = "argon2id", val m: Int, val t: Int, val p: Int) {
    fun toJson(): JsonObject = buildJsonObject {
        put("alg", alg)
        put("m", m)
        put("t", t)
        put("p", p)
    }
}

/** The keys that open a session's records: [recordKey] seals them, [indexKey] names them. */
class RecordKeys(val recordKey: ByteArray, val indexKey: ByteArray)

/** One record as it is sealed (server/PROTOCOL.md, Records); [v] is JsonNull for a deletion. */
data class SealedRecord(val id: String, val data: String)

data class Rec(val c: String, val k: String, val v: JsonElement, val t: Long, val d: Boolean = false)

/**
 * The keys and encryption of a Rukoo account, as server/PROTOCOL.md describes them, ported from desktop's
 * src/main/account/crypto.js. Everything here runs on the phone; the server only ever gets authKey, recoveryAuth
 * and sealed bytes.
 */
object AccountKeys {
    val DEFAULT_KDF = Kdf("argon2id", 65536, 3, 1)

    // Below these a server could make a stolen verifier cheap to attack, so a device refuses them.
    private const val MIN_M = 19456
    private const val MIN_T = 2
    private const val MAX_M = 1048576
    private const val MAX_T = 10
    private const val MAX_P = 4
    private const val VERSION: Byte = 1
    private const val NONCE = 12
    private const val TAG = 16
    private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private const val DATA_KEY_AAD = "rukoo/v1/data-key"

    private val random = SecureRandom()

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also(random::nextBytes)

    fun b64u(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private val B64U = Regex("^[A-Za-z0-9_-]*$")

    /** Strict: anything but base64url characters is refused rather than skipped. */
    fun unb64u(text: String?, bytes: Int? = null): ByteArray {
        if (text == null || !B64U.matches(text)) throw IllegalArgumentException("invalid base64url")
        val out = try {
            Base64.getUrlDecoder().decode(text)
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("invalid base64url", e)
        }
        if (bytes != null && out.size != bytes) throw IllegalArgumentException("invalid length")
        return out
    }

    fun normalizeEmail(email: String?): String = email.orEmpty().trim().lowercase()

    /** The parameters as the server sent them, checked; throws on anything weaker or odder than Rukoo allows. */
    fun checkKdf(kdf: JsonElement?): Kdf {
        val k = kdf as? JsonObject ?: throw IllegalArgumentException("kdf")
        fun int(name: String): Int {
            val p = k[name] as? JsonPrimitive ?: throw IllegalArgumentException("kdf")
            val d = if (p.isString) null else p.doubleOrNull
            if (d == null || d % 1.0 != 0.0 || d > Int.MAX_VALUE || d < Int.MIN_VALUE) throw IllegalArgumentException("kdf")
            return d.toInt()
        }
        val alg = (k["alg"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (alg != "argon2id") throw IllegalArgumentException("kdf")
        val m = int("m")
        val t = int("t")
        val p = int("p")
        if (m < MIN_M || t < MIN_T || m > MAX_M || t > MAX_T || p < 1 || p > MAX_P) throw IllegalArgumentException("kdf")
        return Kdf("argon2id", m, t, p)
    }

    fun checkKdf(kdf: Kdf): Kdf = checkKdf(kdf.toJson())

    /** Argon2id (version 0x13) of the password, normalized to NFC, with the account's salt: 32 bytes. */
    fun masterKey(password: String, salt: ByteArray, kdf: Kdf): ByteArray {
        val k = checkKdf(kdf)
        val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withSalt(salt)
            .withParallelism(k.p)
            .withIterations(k.t)
            .withMemoryAsKB(k.m)
            .build()
        val generator = Argon2BytesGenerator()
        generator.init(params)
        val out = ByteArray(32)
        generator.generateBytes(Normalizer.normalize(password, Normalizer.Form.NFC).toByteArray(Charsets.UTF_8), out)
        return out
    }

    /** HKDF-SHA256 with an empty salt (the same as 32 zero bytes) and 32 bytes out. */
    fun hkdf(ikm: ByteArray, info: String): ByteArray {
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = extract.doFinal(ikm)
        val expand = Mac.getInstance("HmacSHA256")
        expand.init(SecretKeySpec(prk, "HmacSHA256"))
        expand.update(info.toByteArray(Charsets.UTF_8))
        expand.update(1)
        return expand.doFinal().copyOf(32)
    }

    class PasswordKeys(val authKey: ByteArray, val wrapKey: ByteArray)

    /** authKey proves the password to the server; wrapKey opens the data key and stays on the phone. */
    fun passwordKeys(password: String, salt: ByteArray, kdf: Kdf): PasswordKeys {
        val master = masterKey(password, salt, kdf)
        return PasswordKeys(hkdf(master, "rukoo/v1/auth"), hkdf(master, "rukoo/v1/wrap"))
    }

    /** AES-256-GCM: the version byte 0x01, the nonce, the ciphertext and the tag. */
    fun seal(key: ByteArray, plaintext: ByteArray, aad: String, nonce: ByteArray = randomBytes(NONCE)): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG * 8, nonce))
        cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
        return byteArrayOf(VERSION) + nonce + cipher.doFinal(plaintext)
    }

    /** The plaintext, or an exception for another version byte, a short input or a tag that doesn't verify. */
    fun open(key: ByteArray, sealed: ByteArray, aad: String): ByteArray {
        if (sealed.size < 1 + NONCE + TAG || sealed[0] != VERSION) throw IllegalArgumentException("sealed")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG * 8, sealed, 1, NONCE))
        cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
        return cipher.doFinal(sealed, 1 + NONCE, sealed.size - 1 - NONCE)
    }

    fun wrapDataKey(wrapKey: ByteArray, dataKey: ByteArray, nonce: ByteArray = randomBytes(NONCE)): ByteArray = seal(wrapKey, dataKey, DATA_KEY_AAD, nonce)

    fun unwrapDataKey(wrapKey: ByteArray, wrapped: ByteArray): ByteArray {
        val key = open(wrapKey, wrapped, DATA_KEY_AAD)
        if (key.size != 32) throw IllegalArgumentException("sealed")
        return key
    }

    /** The recovery key as people write it down: 32 Crockford base32 characters in groups of four. */
    fun formatRecoveryKey(bytes: ByteArray): String {
        var bits = 0
        var value = 0
        val out = StringBuilder()
        for (b in bytes) {
            value = (value shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                out.append(CROCKFORD[(value ushr (bits - 5)) and 31])
                bits -= 5
            }
            // Only the bits not yet written matter; this keeps the value from growing past an Int.
            value = value and ((1 shl bits) - 1)
        }
        if (bits > 0) out.append(CROCKFORD[(value shl (5 - bits)) and 31])
        return out.chunked(4).joinToString("-")
    }

    // JavaScript's \s, which takes in Unicode spaces too, and the dash.
    private val SEPARATORS = Regex("[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF-]")

    /** Forgiving about how it was copied: case, dashes, spaces, and O, I and L for 0 and 1. Null unless it is 20 bytes. */
    fun parseRecoveryKey(text: String?): ByteArray? {
        val clean = SEPARATORS.replace(text.orEmpty().uppercase(), "").replace('O', '0').replace('I', '1').replace('L', '1')
        if (clean.length != 32) return null
        var bits = 0
        var value = 0
        val out = ArrayList<Byte>(20)
        for (ch in clean) {
            val v = CROCKFORD.indexOf(ch)
            if (v < 0) return null
            value = ((value shl 5) or v) and 0xffff
            bits += 5
            if (bits >= 8) {
                out += ((value ushr (bits - 8)) and 0xff).toByte()
                bits -= 8
            }
        }
        return out.toByteArray()
    }

    class RecoveryKeys(val recoveryAuth: ByteArray, val recoveryWrap: ByteArray)

    fun recoveryKeys(recoveryKey: ByteArray) = RecoveryKeys(hkdf(recoveryKey, "rukoo/v1/recovery-auth"), hkdf(recoveryKey, "rukoo/v1/recovery-wrap"))

    fun recordKeys(dataKey: ByteArray) = RecordKeys(hkdf(dataKey, "rukoo/v1/records"), hkdf(dataKey, "rukoo/v1/index"))

    fun recordId(indexKey: ByteArray, c: String, k: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(indexKey, "HmacSHA256"))
        return b64u(mac.doFinal("$c\n$k".toByteArray(Charsets.UTF_8)))
    }

    private fun recordAad(id: String) = "rukoo/v1/record:$id"

    /** The record's JSON as desktop writes it: {c,k,v,t}, or {c,k,v:null,t,d:true} for a deletion. */
    fun recordJson(r: Rec): String = JsJson.stringify(
        buildJsonObject {
            put("c", r.c)
            put("k", r.k)
            put("v", if (r.d) JsonNull else r.v)
            put("t", r.t)
            if (r.d) put("d", true)
        },
    )

    fun sealRecord(keys: RecordKeys, r: Rec, nonce: ByteArray = randomBytes(NONCE)): SealedRecord {
        val id = recordId(keys.indexKey, r.c, r.k)
        val data = seal(keys.recordKey, recordJson(r).toByteArray(Charsets.UTF_8), recordAad(id), nonce)
        return SealedRecord(id, b64u(data))
    }

    /** The record under [id], or null when it doesn't open or claims to be another record than its id says. */
    fun openRecord(keys: RecordKeys, id: String, data: String?): Rec? = try {
        val rec = RukooJson.parseToJsonElement(String(open(keys.recordKey, unb64u(data), recordAad(id)), Charsets.UTF_8)).jsonObject
        val c = (rec["c"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val k = (rec["k"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (c == null || k == null || recordId(keys.indexKey, c, k) != id) {
            null
        } else {
            // Number(rec.t) || 0, as desktop reads it.
            val t = (rec["t"] as? JsonPrimitive)?.content?.trim()?.toDoubleOrNull()?.takeIf { !it.isNaN() }?.toLong() ?: 0L
            val d = (rec["d"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true
            Rec(c, k, rec["v"] ?: JsonNull, t, d)
        }
    } catch (e: Exception) {
        null
    }
}
