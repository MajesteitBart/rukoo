package nl.bvdm.rukoo.account

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import nl.bvdm.rukoo.core.RukooJson
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

/**
 * A Rukoo account server in memory, a port of desktop's test/fixtures/account-server.js. It follows
 * server/PROTOCOL.md closely enough for the phone's side; the real server in server/ has its own tests.
 */
class FakeAccountServer(
    private val signups: String = "open",
    private val invites: List<String> = emptyList(),
    private val limit: Int = 1000,
    private val jurisdiction: String? = "eu",
    private val kdf: JsonObject = AccountKeys.DEFAULT_KDF.toJson(),
) : AutoCloseable {
    class Stored(var seq: Long, var data: String?)

    class Acc(
        val email: String,
        val createdAt: Long,
        var kdf: JsonElement,
        var salt: String,
        var auth: String,
        var wrappedKey: String,
        var recovery: String,
        var recoveryWrappedKey: String,
        val records: LinkedHashMap<String, Stored> = LinkedHashMap(),
        var seq: Long = 0,
    )

    class Sess(val email: String, val id: String, val name: String, val platform: String, val createdAt: Long)

    data class Call(val route: String, val body: String)

    val accounts = LinkedHashMap<String, Acc>()
    val sessions = LinkedHashMap<String, Sess>()
    val calls = CopyOnWriteArrayList<Call>()
    private val lock = Any()
    private val random = SecureRandom()
    private val server = MockWebServer()

    val url: String

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = synchronized(lock) { handle(request) }
        }
        server.start()
        url = "http://127.0.0.1:${server.port}"
    }

    override fun close() = server.shutdown()

    private fun sha(b64: String): String = b64u(MessageDigest.getInstance("SHA-256").digest(Base64.getUrlDecoder().decode(b64)))

    private fun b64u(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private fun token(): String = ByteArray(32).also(random::nextBytes).let(::b64u)

    private fun info() = buildJsonObject {
        put("protocol", 1)
        put("version", "1.0.0-test")
        putJsonObject("operator") {
            put("name", "Test operator")
            put("url", "https://example.test")
            put("contact", "ops@example.test")
            put("privacy", "https://example.test/privacy")
        }
        putJsonObject("hosting") {
            put("provider", "Cloudflare")
            put("company", "Cloudflare, Inc.")
            put("country", "US")
            put("jurisdiction", jurisdiction)
        }
        put("signups", signups)
        putJsonObject("limits") {
            put("records", 250000)
            put("bytes", 104857600)
            put("recordBytes", 16384)
            put("batch", 500)
        }
    }

    private fun accountView(acc: Acc, current: String?) = buildJsonObject {
        put("email", acc.email)
        put("createdAt", acc.createdAt)
        put("kdf", acc.kdf)
        putJsonObject("usage") {
            put("records", acc.records.values.count { it.data != null })
            put("bytes", acc.records.values.sumOf { r -> r.data?.let { Base64.getUrlDecoder().decode(it).size } ?: 0 })
        }
        putJsonArray("devices") {
            for ((tok, s) in sessions) {
                if (s.email != acc.email) continue
                addJsonObject {
                    put("id", s.id)
                    put("name", s.name)
                    put("platform", s.platform)
                    put("createdAt", s.createdAt)
                    put("lastSeenAt", s.createdAt)
                    put("current", tok == current)
                }
            }
        }
    }

    private fun newSession(acc: Acc, device: JsonObject?): String {
        val tok = token()
        val id = ByteArray(8).also(random::nextBytes).joinToString("") { "%02x".format(it) }
        sessions[tok] = Sess(acc.email, id, device.str("name"), device.str("platform"), System.currentTimeMillis())
        return tok
    }

    private fun endSessions(email: String, keep: String?) {
        sessions.entries.removeIf { it.value.email == email && it.key != keep }
    }

    private fun JsonObject?.str(key: String): String = (this?.get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()

    private fun json(status: Int, body: JsonElement? = null): MockResponse {
        val res = MockResponse().setResponseCode(status)
        return if (body == null) res else res.setHeader("content-type", "application/json").setBody(body.toString())
    }

    private fun error(status: Int, code: String) = json(status, buildJsonObject { put("error", code) })

    private fun handle(request: RecordedRequest): MockResponse {
        val url = request.requestUrl!!
        val path = url.encodedPath
        val method = request.method!!
        val text = request.body.readUtf8()
        val body = runCatching { RukooJson.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())
        val route = if (path.startsWith("/v1/devices/") && method == "DELETE") "DELETE /v1/devices" else "$method $path"
        calls += Call(route, text)
        val tok = request.getHeader("Authorization").orEmpty().removePrefix("Bearer ")
        val session = sessions[tok]
        val acc = session?.let { accounts[it.email] }
        if (route == "DELETE /v1/devices") {
            if (acc == null) return error(401, "unauthorized")
            val id = path.removePrefix("/v1/devices/")
            val found = sessions.entries.firstOrNull { it.value.email == acc.email && it.value.id == id } ?: return error(404, "not_found")
            sessions.remove(found.key)
            return json(204)
        }
        val open = setOf("GET /v1/info", "POST /v1/prelogin", "POST /v1/signup", "POST /v1/login", "POST /v1/recover/start", "POST /v1/recover/finish")
        if (route !in open && acc == null) return if (route in ROUTES) error(401, "unauthorized") else error(404, "not_found")
        return when (route) {
            "GET /v1/info" -> json(200, info())
            "POST /v1/prelogin" -> {
                val email = body.str("email")
                val a = accounts[email]
                val fake = b64u(MessageDigest.getInstance("SHA-256").digest("salt\n$email".toByteArray()).copyOf(16))
                json(200, buildJsonObject {
                    put("kdf", a?.kdf ?: kdf)
                    put("salt", a?.salt ?: fake)
                })
            }
            "POST /v1/signup" -> when {
                signups == "closed" -> error(403, "signups_closed")
                signups == "invite" && body.str("invite") !in invites -> error(403, "invite_required")
                accounts.containsKey(body.str("email")) -> error(409, "exists")
                else -> {
                    val a = Acc(
                        email = body.str("email"),
                        createdAt = System.currentTimeMillis(),
                        kdf = body["kdf"] ?: JsonNull,
                        salt = body.str("salt"),
                        auth = sha(body.str("authKey")),
                        wrappedKey = body.str("wrappedKey"),
                        recovery = sha(body.str("recoveryAuth")),
                        recoveryWrappedKey = body.str("recoveryWrappedKey"),
                    )
                    accounts[a.email] = a
                    val t = newSession(a, body["device"] as? JsonObject)
                    json(201, buildJsonObject {
                        put("token", t)
                        put("account", accountView(a, t))
                    })
                }
            }
            "POST /v1/login" -> {
                val a = accounts[body.str("email")]
                if (a == null || a.auth != sha(body.str("authKey"))) return error(401, "unauthorized")
                val t = newSession(a, body["device"] as? JsonObject)
                json(200, buildJsonObject {
                    put("token", t)
                    put("wrappedKey", a.wrappedKey)
                    put("account", accountView(a, t))
                })
            }
            "POST /v1/recover/start" -> {
                val a = accounts[body.str("email")]
                if (a == null || a.recovery != sha(body.str("recoveryAuth"))) return error(401, "unauthorized")
                json(200, buildJsonObject {
                    put("recoveryWrappedKey", a.recoveryWrappedKey)
                    put("kdf", a.kdf)
                })
            }
            "POST /v1/recover/finish" -> {
                val a = accounts[body.str("email")]
                if (a == null || a.recovery != sha(body.str("recoveryAuth"))) return error(401, "unauthorized")
                a.kdf = body["kdf"] ?: JsonNull
                a.salt = body.str("salt")
                a.auth = sha(body.str("authKey"))
                a.wrappedKey = body.str("wrappedKey")
                endSessions(a.email, null)
                val t = newSession(a, body["device"] as? JsonObject)
                json(200, buildJsonObject {
                    put("token", t)
                    put("account", accountView(a, t))
                })
            }
            "POST /v1/logout" -> {
                sessions.remove(tok)
                json(204)
            }
            "GET /v1/account" -> json(200, accountView(acc!!, tok))
            "POST /v1/password" -> {
                if (acc!!.auth != sha(body.str("authKey"))) return error(403, "wrong_password")
                acc.kdf = body["kdf"] ?: JsonNull
                acc.salt = body.str("salt")
                acc.auth = sha(body.str("newAuthKey"))
                acc.wrappedKey = body.str("wrappedKey")
                endSessions(acc.email, tok)
                json(204)
            }
            "POST /v1/recovery" -> {
                if (acc!!.auth != sha(body.str("authKey"))) return error(403, "wrong_password")
                acc.recovery = sha(body.str("recoveryAuth"))
                acc.recoveryWrappedKey = body.str("recoveryWrappedKey")
                json(204)
            }
            "DELETE /v1/account" -> {
                if (acc!!.auth != sha(body.str("authKey"))) return error(403, "wrong_password")
                accounts.remove(acc.email)
                endSessions(acc.email, null)
                json(204)
            }
            "GET /v1/records" -> {
                val since = url.queryParameter("since")?.toLongOrNull() ?: 0
                val max = minOf(url.queryParameter("limit")?.toIntOrNull() ?: limit, limit)
                val all = acc!!.records.entries.filter { it.value.seq > since }.sortedBy { it.value.seq }
                json(200, buildJsonObject {
                    putJsonArray("records") {
                        for ((id, r) in all.take(max)) {
                            addJsonObject {
                                put("id", id)
                                put("seq", r.seq)
                                put("data", r.data)
                            }
                        }
                    }
                    put("seq", acc.seq)
                    put("more", all.size > max)
                })
            }
            "POST /v1/records" -> {
                val a = acc!!
                // Like the real server: one record over 16 KiB fails the whole push.
                val tooLarge = (body["records"] as? JsonArray).orEmpty().any { r ->
                    ((r as JsonObject)["data"] as? JsonPrimitive)?.contentOrNull?.let { Base64.getUrlDecoder().decode(it).size > 16384 } == true
                }
                if (tooLarge) return error(413, "too_large")
                val results = (body["records"] as? JsonArray).orEmpty().map { it as JsonObject }.map { r ->
                    val id = r.str("id")
                    val had = a.records[id]
                    val ifAbsent = (r["ifAbsent"] as? JsonPrimitive)?.booleanOrNull == true
                    if (ifAbsent && had?.data != null) {
                        Triple(id, had.seq, false)
                    } else {
                        a.seq += 1
                        a.records[id] = Stored(a.seq, (r["data"] as? JsonPrimitive)?.contentOrNull)
                        Triple(id, a.seq, true)
                    }
                }
                json(200, buildJsonObject {
                    putJsonArray("results") {
                        for ((id, seq, stored) in results) {
                            addJsonObject {
                                put("id", id)
                                put("seq", seq)
                                put("stored", stored)
                            }
                        }
                    }
                    put("seq", a.seq)
                })
            }
            else -> error(404, "not_found")
        }
    }

    private companion object {
        val ROUTES = setOf("POST /v1/logout", "GET /v1/account", "POST /v1/password", "POST /v1/recovery", "DELETE /v1/account", "GET /v1/records", "POST /v1/records")
    }
}
