package nl.bvdm.rukoo.account

import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.core.RukooJson
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The keys and sealing of server/PROTOCOL.md against the repository's shared vectors, as desktop tests them. */
class AccountKeysTest {
    /** test/fixtures/account-vectors.json at the repository's root, read where it is, not from a copy. */
    private val vectors: JsonObject by lazy {
        val file = listOf("../../test/fixtures/account-vectors.json", "../test/fixtures/account-vectors.json").map(::File).first { it.exists() }
        RukooJson.parseToJsonElement(file.readText()).jsonObject
    }

    private fun v(name: String) = vectors.getValue(name).jsonPrimitive.content

    private fun b64(bytes: ByteArray) = AccountKeys.b64u(bytes)

    @Test
    fun `the keys match the shared vectors`() {
        val salt = AccountKeys.unb64u(v("salt"), 16)
        val kdfJson = vectors.getValue("kdf").jsonObject
        val kdf = Kdf(kdfJson.getValue("alg").jsonPrimitive.content, kdfJson.getValue("m").jsonPrimitive.int, kdfJson.getValue("t").jsonPrimitive.int, kdfJson.getValue("p").jsonPrimitive.int)
        assertEquals(v("normalizedEmail"), AccountKeys.normalizeEmail(v("email")))
        assertEquals(v("masterKey"), b64(AccountKeys.masterKey(v("password"), salt, kdf)))
        val keys = AccountKeys.passwordKeys(v("password"), salt, kdf, v("server"))
        assertEquals(v("authKey"), b64(keys.authKey))
        assertEquals(v("wrapKey"), b64(keys.wrapKey))
        assertEquals(v("authVerifier"), b64(MessageDigest.getInstance("SHA-256").digest(keys.authKey)))
        val dataKey = AccountKeys.unwrapDataKey(keys.wrapKey, AccountKeys.unb64u(v("wrappedKey")))
        assertEquals(v("dataKey"), b64(dataKey))
        assertEquals(v("wrappedKey"), b64(AccountKeys.wrapDataKey(keys.wrapKey, dataKey, AccountKeys.unb64u(v("wrapNonce")))))
        val recovery = AccountKeys.unb64u(v("recoveryKeyBytes"))
        assertEquals(v("recoveryKey"), AccountKeys.formatRecoveryKey(recovery))
        assertArrayEquals(recovery, AccountKeys.parseRecoveryKey(v("recoveryKey")))
        val rk = AccountKeys.recoveryKeys(recovery, v("server"))
        assertEquals(v("recoveryAuth"), b64(rk.recoveryAuth))
        assertEquals(v("recoveryWrap"), b64(rk.recoveryWrap))
        val records = AccountKeys.recordKeys(dataKey)
        assertEquals(v("recordKey"), b64(records.recordKey))
        assertEquals(v("indexKey"), b64(records.indexKey))
        val record = vectors.getValue("record").jsonObject
        val c = record.getValue("c").jsonPrimitive.content
        val k = record.getValue("k").jsonPrimitive.content
        assertEquals(v("recordId"), AccountKeys.recordId(records.indexKey, c, k))
        val expected = Rec(c, k, record.getValue("v"), record.getValue("t").jsonPrimitive.long)
        assertEquals(expected, AccountKeys.openRecord(records, v("recordId"), v("recordData")))
        assertEquals(SealedRecord(v("recordId"), v("recordData")), AccountKeys.sealRecord(records, expected, AccountKeys.unb64u(v("recordNonce"))))
    }

    @Test
    fun `the proofs are bound to the server's address, and the data key isn't`() {
        val salt = AccountKeys.randomBytes(16)
        val a = AccountKeys.passwordKeys("a long enough password", salt, AccountKeys.DEFAULT_KDF, "https://one.example")
        val b = AccountKeys.passwordKeys("a long enough password", salt, AccountKeys.DEFAULT_KDF, "https://two.example")
        assertFalse(a.authKey.contentEquals(b.authKey))
        assertArrayEquals("the data key opens the same everywhere", a.wrapKey, b.wrapKey)
        val key = AccountKeys.randomBytes(20)
        assertFalse(AccountKeys.recoveryKeys(key, "https://one.example").recoveryAuth.contentEquals(AccountKeys.recoveryKeys(key, "https://two.example").recoveryAuth))
        assertArrayEquals(AccountKeys.recoveryKeys(key, "https://one.example").recoveryWrap, AccountKeys.recoveryKeys(key, "https://two.example").recoveryWrap)
        try {
            AccountKeys.recoveryKeys(key, "")
            fail("no server, no proof")
        } catch (e: IllegalArgumentException) {
            // refused
        }
    }

    @Test
    fun `a sealed record refuses another id, other bytes and another key`() {
        val keys = AccountKeys.recordKeys(AccountKeys.randomBytes(32))
        val sealed = AccountKeys.sealRecord(keys, Rec("sender", "a@b.c", buildJsonObject { put("category", "x") }, 1))
        assertEquals("a@b.c", AccountKeys.openRecord(keys, sealed.id, sealed.data)?.k)
        val other = AccountKeys.sealRecord(keys, Rec("sender", "d@e.f", kotlinx.serialization.json.JsonNull, 1))
        assertNull("the server swapped two records", AccountKeys.openRecord(keys, other.id, sealed.data))
        val bytes = AccountKeys.unb64u(sealed.data)
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
        assertNull("a changed tag", AccountKeys.openRecord(keys, sealed.id, b64(bytes)))
        assertNull("another account", AccountKeys.openRecord(AccountKeys.recordKeys(AccountKeys.randomBytes(32)), sealed.id, sealed.data))
        assertNull(AccountKeys.openRecord(keys, sealed.id, "not base64url!"))
        // Another version byte is refused before anything is decrypted.
        val versioned = AccountKeys.unb64u(sealed.data)
        versioned[0] = 2
        assertNull(AccountKeys.openRecord(keys, sealed.id, b64(versioned)))
        // A record that names another collection than its id says is dropped too.
        val swapped = AccountKeys.sealRecord(keys, Rec("override", "a@b.c", kotlinx.serialization.json.JsonNull, 1))
        assertNull(AccountKeys.openRecord(keys, sealed.id, swapped.data))
    }

    @Test
    fun `a deletion is sealed with d true and no value`() {
        val keys = AccountKeys.recordKeys(AccountKeys.randomBytes(32))
        val sealed = AccountKeys.sealRecord(keys, Rec("sender", "a@b.c", buildJsonObject { put("category", "x") }, 5, d = true))
        val back = AccountKeys.openRecord(keys, sealed.id, sealed.data)!!
        assertTrue(back.d)
        assertEquals(kotlinx.serialization.json.JsonNull, back.v)
        assertEquals("{\"c\":\"sender\",\"k\":\"a@b.c\",\"v\":null,\"t\":5,\"d\":true}", AccountKeys.recordJson(Rec("sender", "a@b.c", kotlinx.serialization.json.JsonNull, 5, d = true)))
    }

    @Test
    fun `recovery keys read back however they were copied`() {
        val bytes = AccountKeys.randomBytes(20)
        val text = AccountKeys.formatRecoveryKey(bytes)
        assertTrue(text, Regex("^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$").matches(text))
        assertArrayEquals(bytes, AccountKeys.parseRecoveryKey(text))
        assertArrayEquals(bytes, AccountKeys.parseRecoveryKey(" ${text.lowercase().replace('-', ' ')} "))
        assertArrayEquals(AccountKeys.parseRecoveryKey("0011-1000-0000-0000-0000-0000-0000-0000"), AccountKeys.parseRecoveryKey("0O1I-L000-0000-0000-0000-0000-0000-0000"))
        assertNull(AccountKeys.parseRecoveryKey("too short"))
        assertNull(AccountKeys.parseRecoveryKey("${text}U"))
        // U isn't a Crockford character, even at the right length.
        assertNull(AccountKeys.parseRecoveryKey("U" + text.replace("-", "").drop(1)))
        // A non-breaking space between the groups reads like a space, as JavaScript's \s takes it.
        assertArrayEquals(bytes, AccountKeys.parseRecoveryKey(text.replace('-', ' ')))
    }

    @Test
    fun `weak or odd key derivation settings are refused`() {
        fun kdf(alg: String, m: Int, t: Int, p: Int, extra: Boolean = false) = buildJsonObject {
            put("alg", alg)
            put("m", m)
            put("t", t)
            put("p", p)
            if (extra) put("extra", true)
        }
        for (weak in listOf(kdf("argon2id", 1024, 3, 1), kdf("argon2id", 65536, 1, 1), kdf("scrypt", 65536, 3, 1), kdf("argon2id", 65536, 3, 9))) {
            try {
                AccountKeys.checkKdf(weak)
                fail("accepted $weak")
            } catch (e: IllegalArgumentException) {
                // refused
            }
        }
        assertEquals(AccountKeys.DEFAULT_KDF, AccountKeys.checkKdf(kdf("argon2id", 65536, 3, 1, extra = true)))
        // A number written with a fraction is still a whole number to JavaScript; a string isn't one.
        assertEquals(AccountKeys.DEFAULT_KDF, AccountKeys.checkKdf(RukooJson.parseToJsonElement("""{"alg":"argon2id","m":65536.0,"t":3,"p":1}""")))
        try {
            AccountKeys.checkKdf(RukooJson.parseToJsonElement("""{"alg":"argon2id","m":"65536","t":3,"p":1}"""))
            fail("a string is no number")
        } catch (e: IllegalArgumentException) {
            // refused
        }
    }

    @Test
    fun `a phone runs at most 256 MiB, half of its memory and 1 GiB of passes`() {
        val gib = 1024L * 1024 * 1024
        assertTrue(AccountKeys.affordable(AccountKeys.DEFAULT_KDF, heap = 4 * gib))
        // Allowed by the protocol, too much for a phone.
        assertFalse(AccountKeys.affordable(Kdf("argon2id", 1048576, 10, 4), heap = 4 * gib))
        assertFalse(AccountKeys.affordable(Kdf("argon2id", 524288, 2, 1), heap = 4 * gib))
        assertTrue(AccountKeys.affordable(Kdf("argon2id", 262144, 4, 1), heap = 4 * gib))
        assertFalse("m × t over 1 GiB", AccountKeys.affordable(Kdf("argon2id", 262144, 5, 1), heap = 4 * gib))
        assertTrue(AccountKeys.affordable(Kdf("argon2id", 65536, 10, 4), heap = 4 * gib))
        // Half of a 256 MiB heap is 128 MiB.
        assertTrue(AccountKeys.affordable(Kdf("argon2id", 131072, 3, 1), heap = gib / 4))
        assertFalse(AccountKeys.affordable(Kdf("argon2id", 131073, 3, 1), heap = gib / 4))
        // Rukoo's own settings, even on a small heap.
        assertTrue(AccountKeys.affordable(AccountKeys.DEFAULT_KDF, heap = gib / 16))
    }

    @Test
    fun `only https servers, or http on this machine and the emulator's host in debug builds`() {
        val s = AccountServers
        assertEquals("https://sync.example.com", s.serverUrl("https://sync.example.com/", false))
        assertEquals("https://example.com/rukoo", s.serverUrl("https://example.com/rukoo/", false))
        assertEquals("https://example.com:8443", s.serverUrl(" https://Example.com:8443 ", false))
        assertEquals("http://127.0.0.1:8787", s.serverUrl("http://127.0.0.1:8787", true))
        assertEquals("http://10.0.2.2:8790", s.serverUrl("http://10.0.2.2:8790", true))
        assertEquals("http://localhost:8790", s.serverUrl("http://localhost:8790/", true))
        assertNull("a release build talks https only", s.serverUrl("http://127.0.0.1:8787", false))
        assertNull(s.serverUrl("http://10.0.2.2:8790", false))
        assertNull(s.serverUrl("http://sync.example.com", true))
        assertNull(s.serverUrl("https://user:pw@example.com", false))
        assertNull(s.serverUrl("https://example.com/?a=1", false))
        assertNull(s.serverUrl("https://example.com/#x", false))
        assertNull(s.serverUrl("ftp://example.com", false))
        assertNull(s.serverUrl("nonsense", false))
        assertNull(s.serverUrl("", false))
    }

    @Test
    fun `JSON is written as JavaScript writes it`() {
        assertEquals("1793000000000", JsJson.number("1793000000000"))
        assertEquals("1", JsJson.number("1.0"))
        assertEquals("0.5", JsJson.number("0.5"))
        assertEquals("1e+21", JsJson.number("1e21"))
        assertEquals("1e-7", JsJson.number("0.0000001"))
        assertEquals("0.000001", JsJson.number("1e-6"))
        assertEquals("-2.5", JsJson.number("-2.5"))
        assertEquals("123456789012345680000", JsJson.number("123456789012345678901"))
        val obj = RukooJson.parseToJsonElement("""{"b":1,"10":2,"a":"é\u0001\n\"","2":[true,null,1.50]}""")
        assertEquals("""{"2":[true,null,1.5],"10":2,"b":1,"a":"é\u0001\n\""}""", JsJson.stringify(obj))
    }

    @Test
    fun `a newer change wins, and a tie goes to the larger JSON of d and v`() {
        val a = buildJsonObject { put("category", "money") }
        val b = buildJsonObject { put("category", "updates") }
        assertTrue(AccountService.newer(2, false, a, 1, false, b))
        assertFalse(AccountService.newer(1, false, b, 2, false, a))
        // On a tie: "updates" > "money", and a deletion ([1,null]) beats any value ([0,…]).
        assertTrue(AccountService.newer(5, false, b, 5, false, a))
        assertFalse(AccountService.newer(5, false, a, 5, false, b))
        assertTrue(AccountService.newer(5, true, kotlinx.serialization.json.JsonNull, 5, false, b))
        assertNotNull(AccountKeys.DEFAULT_KDF)
    }
}
