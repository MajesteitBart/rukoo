package nl.bvdm.rukoo.mail.google

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import nl.bvdm.rukoo.core.UriComponent
import nl.bvdm.rukoo.mail.model.GoogleClient

/** Google's endpoints and Rukoo's scopes, verbatim from desktop's google.js:11-21. */
object GoogleOAuth {
    val CALENDAR_SCOPES = listOf(
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.events",
    )
    const val MAIL_SCOPE = "https://mail.google.com/"
    val SCOPES = listOf("openid", "email", "profile", MAIL_SCOPE) + CALENDAR_SCOPES
    const val AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
    const val TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
    const val SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000L
    const val TOKEN_TIMEOUT_MS = 30_000L

    /** Where the browser goes after the loopback page; MainActivity's intent filter brings Rukoo back. */
    const val RETURN_URL = "rukoo-oauth://done"

    private val random = SecureRandom()

    /** Standard base64 with `+`→`-`, `/`→`_` and no padding. */
    fun base64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun randomToken(bytes: Int): String = base64url(ByteArray(bytes).also(random::nextBytes))

    /** PKCE S256: the challenge is base64url(sha256(verifier)). */
    fun challenge(verifier: String): String =
        base64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    /** A fresh sign-in's secrets: verifier (48 random bytes), its challenge and the state (24 bytes). */
    data class Pkce(val verifier: String, val challenge: String, val state: String) {
        override fun toString() = "Pkce(...)"

        companion object {
            fun create(): Pkce {
                val verifier = randomToken(48)
                return Pkce(verifier, challenge(verifier), randomToken(24))
            }
        }
    }

    /** The consent page's URL with desktop's parameters, in the same order. */
    fun authUrl(client: GoogleClient, redirectUri: String, pkce: Pkce, loginHint: String? = null, endpoint: String = AUTH_ENDPOINT): String {
        val query = buildList {
            add("client_id" to client.clientId)
            add("redirect_uri" to redirectUri)
            add("response_type" to "code")
            add("scope" to SCOPES.joinToString(" "))
            add("access_type" to "offline")
            add("prompt" to "consent")
            // Signing in again for the calendar keeps the mail access the account already has.
            add("include_granted_scopes" to "true")
            add("code_challenge" to pkce.challenge)
            add("code_challenge_method" to "S256")
            add("state" to pkce.state)
            if (!loginHint.isNullOrEmpty()) add("login_hint" to loginHint)
        }
        // URLSearchParams on desktop writes spaces as '+'.
        return endpoint + "?" + query.joinToString("&") { (k, v) -> "$k=${UriComponent.encode(v).replace("%20", "+")}" }
    }

    /** The SASL XOAUTH2 initial response, base64("user=" + email + ^A + "auth=Bearer " + token + ^A^A). */
    fun xoauth2(email: String, accessToken: String): String =
        Base64.getEncoder().encodeToString("user=$email\u0001auth=Bearer $accessToken\u0001\u0001".toByteArray(Charsets.UTF_8))

    /** The payload of a JWT (an id_token), without checking its signature: it came straight from Google over TLS. */
    fun decodeJwtPayload(jwt: String?): JsonObject {
        val part = jwt?.split('.')?.getOrNull(1) ?: return JsonObject(emptyMap())
        return runCatching {
            val json = String(Base64.getUrlDecoder().decode(part.replace('+', '-').replace('/', '_').trimEnd('=')), Charsets.UTF_8)
            Json.parseToJsonElement(json).jsonObject
        }.getOrElse { JsonObject(emptyMap()) }
    }

    fun JsonObject.string(key: String): String? = this[key]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }

    /**
     * A client from a file the user picked or desktop sent: Google's download (`installed` or `web`) or
     * the flat `{client_id, client_secret}` form. Null when it isn't one.
     */
    fun parseClient(text: String): GoogleClient? = runCatching {
        val root = Json.parseToJsonElement(text).jsonObject
        val c = (root["installed"] ?: root["web"])?.jsonObject ?: root
        val id = c.string("client_id")
        val secret = c.string("client_secret")
        if (id.isNullOrBlank() || secret.isNullOrBlank()) null else GoogleClient(id, secret)
    }.getOrNull()
}
