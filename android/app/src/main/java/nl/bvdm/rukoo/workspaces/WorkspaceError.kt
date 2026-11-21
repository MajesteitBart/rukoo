package nl.bvdm.rukoo.workspaces

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * A team chat failure, as the UI tells failures apart (contract §3.15). [code] is one of [CODES]; anything else
 * becomes `server` through [known], as AccountError.known does for the account.
 *
 * - [status]: the HTTP status, or 0 for a failure on the phone.
 * - [scope]: `workspace`, `conversation` or `account` for a 404 or 401 that names what is gone or refused.
 * - [field]: the input a `400 invalid` refused, such as `name`, `mentions` or `operationId`.
 * - [retryAfterS]: seconds from `Retry-After`, clamped to 1..3600.
 * - [minVersion]: what a `426 upgrade_required` asks for.
 * - [channels]: the channels a `409 last_manager` needs a successor for, at most 100 `c_` IDs.
 * - [member]: the person a `409 blocked` names.
 * - [limit]: which limit a `413 quota` or a `429 rate_limited` hit: `members`, `conversations`, `invites`, `bytes`,
 *   or `dailyDms`.
 */
class WorkspaceError(
    code: String,
    val status: Int = 0,
    val scope: String? = null,
    val field: String? = null,
    val retryAfterS: Long? = null,
    val minVersion: Int? = null,
    val channels: List<String> = emptyList(),
    val member: String? = null,
    val limit: String? = null,
    message: String? = null,
    cause: Throwable? = null,
) : Exception(message ?: code, cause) {
    val code: String = known(code)

    /** True for the codes §3.15 says never reach the UI as a call error; the engines turn them into outcomes. */
    val internal: Boolean get() = code in ENGINE_CODES

    override fun toString(): String = buildString {
        append("WorkspaceError(").append(code)
        if (status != 0) append(", ").append(status)
        scope?.let { append(", scope=").append(it) }
        field?.let { append(", field=").append(it) }
        limit?.let { append(", limit=").append(it) }
        append(')')
    }

    companion object {
        /** The codes the UI shows (§3.15), each with its own text. */
        val UI_CODES: Set<String> = setOf(
            "network", "signed_out", "upgrade_required", "rate_limited", "not_found", "forbidden", "cosign_required",
            "workspace_limit", "workspaces_full", "workspace_account_scope", "dm_unavailable", "blocked", "name_taken",
            "last_owner", "last_manager", "members_remain", "archived", "invite_gone", "quota", "invalid", "bad_link",
            "other_server", "not_saved", "paused", "server",
            // Billing (server/WORKSPACES.md "Billing").
            "billing_active", "billing_none", "billing_unavailable",
        )

        /** Answers the feed and the outbox handle themselves; none is ever shown as a call error (§3.15). */
        val ENGINE_CODES: Set<String> = setOf(
            "operation_conflict", "submission_expired", "stale_grant", "stale_generation", "history_regressed", "reset_required",
        )

        val CODES: Set<String> = UI_CODES + ENGINE_CODES

        fun known(code: String?): String = if (code != null && code in CODES) code else "server"

        private val CONVERSATION_ID = Regex("^c_[A-Za-z0-9_-]{22}$")
        private val MEMBER_ID = Regex("^u_[A-Za-z0-9_-]{22}$")
        private val SCOPES = setOf("workspace", "conversation", "account")
        private const val MAX_CHANNELS = 100
        private const val MAX_TEXT = 200

        /** The code a 4xx stands for when its body names none we know. */
        private val BY_STATUS = mapOf(429 to "rate_limited", 404 to "not_found", 403 to "forbidden")

        /**
         * The error a server answer stands for: [status] and its JSON [body] (`{ error, message, field, scope, … }`),
         * with [retryAfter] the raw `Retry-After` header. A 401 is `signed_out` whatever the body says, a 426
         * `upgrade_required`, and a 5xx or an unknown code `server`. Every field is type-checked and capped, so a
         * hostile answer can't put a long string into the UI.
         */
        fun fromAnswer(status: Int, body: JsonObject?, retryAfter: String? = null): WorkspaceError {
            fun text(name: String): String? = (body?.get(name) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.take(MAX_TEXT)
            val sent = text("error")
            val code = when {
                status == 401 -> "signed_out"
                status == 426 -> "upgrade_required"
                status >= 500 -> "server"
                // A body without a code we know, such as a proxy's own HTML 429 page, still says what its status says.
                else -> known(sent).let { if (it == "server") BY_STATUS[status] ?: it else it }
            }
            val channels = (body?.get("channels") as? JsonArray).orEmpty()
                .mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
                .filter { CONVERSATION_ID.matches(it) }
                .take(MAX_CHANNELS)
            return WorkspaceError(
                code = code,
                status = status,
                scope = text("scope")?.takeIf { it in SCOPES },
                field = text("field")?.takeIf { it.length <= 40 },
                retryAfterS = retryAfterSeconds(retryAfter),
                minVersion = (body?.get("minVersion") as? JsonPrimitive)?.intOrNull,
                channels = channels,
                member = text("member")?.takeIf { MEMBER_ID.matches(it) },
                limit = text("limit")?.takeIf { it.length <= 40 },
                message = text("message"),
            )
        }

        /** Whole seconds from a `Retry-After` header, clamped to 1..3600, or null when it isn't a number. */
        fun retryAfterSeconds(header: String?): Long? = header?.trim()?.toLongOrNull()?.coerceIn(1, 3600)
    }
}
