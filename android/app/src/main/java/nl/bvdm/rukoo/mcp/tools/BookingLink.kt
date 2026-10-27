package nl.bvdm.rukoo.mcp.tools

import java.net.URI
import java.security.MessageDigest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.account.AccountKeys
import nl.bvdm.rukoo.account.AccountService

/**
 * The calendar tools on the phone. The phone has no calendar yet, so list_events, find_free_time and create_event
 * answer [NO_CALENDAR]. get_booking_link still works: the booking page's settings record in the Rukoo account
 * (booking/settings:<acct>, written by desktop's booking service) carries the page's full public URL and its meeting
 * types. Only the account server knows whether the page is on, and the phone doesn't ask it, so `on` is null here
 * where desktop says true or false. The answer has desktop's keys, in desktop's order.
 */
object BookingLink {
    const val NO_CALENDAR = "Rukoo on this phone has no calendar yet. Ask the user to use Rukoo on their computer."

    private val URL_CHARS = Regex("^[A-Za-z0-9\\-._~:/?#\\[\\]@!\$&()*+,;=%]{1,300}$")
    private val LOOPBACK = setOf("127.0.0.1", "localhost", "[::1]")
    private val SLUG = Regex("^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$")

    /**
     * The page's address as agents get it, by desktop's rule (tools.js bookingUrl): agents pass it on as it is, so
     * only URL characters, and https, or http on the computer itself for a test server. Anything else is no link.
     */
    fun safeUrl(value: String?): String? {
        if (value == null || !URL_CHARS.matches(value)) return null
        val uri = runCatching { URI(value) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        return value.takeIf { scheme == "https" || (scheme == "http" && host in LOOPBACK) }
    }

    /** `<acct>`: the first 16 characters of base64url(SHA-256) of the trimmed, lowercased Rukoo account email. */
    fun acct(email: String): String =
        AccountKeys.b64u(MessageDigest.getInstance("SHA-256").digest(AccountKeys.normalizeEmail(email).toByteArray(Charsets.UTF_8))).take(16)

    /** The signed-in account's booking settings record, or null without an account, a sign-in or the record. */
    fun settings(account: AccountService?): JsonObject? {
        val email = account?.status()?.email ?: return null
        return account.get("booking", "settings:${acct(email)}") as? JsonObject
    }

    /** get_booking_link's answer for a settings record, or for none. Hidden meeting types stay out. */
    fun answer(settings: JsonObject?): JsonObject {
        val url = safeUrl(settings?.str("url"))
            ?: return buildJsonObject {
                put("on", JsonNull)
                put("url", JsonNull)
                put("types", JsonArray(emptyList()))
                put("note", "Rukoo on this phone doesn't have the user's booking link. If they have a booking page, Rukoo on their computer has it.")
            }
        val base = url.trimEnd('/')
        return buildJsonObject {
            put("on", JsonNull)
            put("url", url)
            put(
                "types",
                buildJsonArray {
                    for (t in settings?.list("types").orEmpty()) {
                        val type = t as? JsonObject ?: continue
                        val slug = type.str("slug")?.takeIf { SLUG.matches(it) } ?: continue
                        if (type.bool("hidden") == true) continue
                        add(
                            buildJsonObject {
                                put("slug", slug)
                                put("title", type.str("title").orEmpty())
                                put("duration_minutes", type.long("duration"))
                                put("url", "$base/$slug")
                            },
                        )
                    }
                },
            )
            put("note", "Rukoo on this phone can't tell whether the booking page is turned on. If the user isn't sure, they can check in Rukoo on their computer, under Settings > Booking page.")
        }
    }
}
