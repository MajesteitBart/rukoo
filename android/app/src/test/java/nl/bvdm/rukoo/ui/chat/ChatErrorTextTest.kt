package nl.bvdm.rukoo.ui.chat

import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.mail.UiStrings
import nl.bvdm.rukoo.workspaces.WorkspaceError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * The words for a team chat failure (contract §3.15, §7.4 `ChatUi.errorText`): every code the UI tells apart maps to
 * its own string, with the placeholders filled from the context, and anything else falls back to "Something went
 * wrong".
 */
class ChatErrorTextTest {
    /** Each text names its resource and what filled it, so the test sees which string was picked. */
    private object Strings : UiStrings {
        override fun get(id: Int, vararg args: Any) = "s$id" + if (args.isEmpty()) "" else args.joinToString(",", "(", ")")
        override fun plural(id: Int, count: Int, vararg args: Any) = "p$id:$count" + args.joinToString(",", "(", ")")
    }

    private val ctx = ErrorContext(host = "rukoo.example", workspace = "Acme", member = "Mila", linkHost = "chat.elsewhere.example")

    private fun s(id: Int, vararg args: Any) = Strings.get(id, *args)

    private fun text(e: Throwable) = ChatErrors.text(e, Strings, ctx)

    private fun text(code: String) = text(WorkspaceError(code))

    private val failed = s(R.string.chat_errors_failed)

    @Test
    fun `every code of section 3_15 maps to its own string`() {
        // The plain mapping; codes with a scope, limit or field get their own tests below.
        val expected = mapOf(
            "network" to s(R.string.chat_errors_network, "rukoo.example"),
            "signed_out" to s(R.string.chat_errors_signed_out),
            "upgrade_required" to s(R.string.chat_errors_upgrade, "rukoo.example"),
            "rate_limited" to Strings.plural(R.plurals.chat_errors_rate_limited, 1, 1),
            "not_found" to s(R.string.chat_errors_not_found),
            "forbidden" to s(R.string.chat_errors_forbidden),
            "cosign_required" to s(R.string.chat_channel_add_guest_needs_admin),
            "workspace_limit" to s(R.string.chat_errors_workspace_limit, "rukoo.example"),
            "workspaces_full" to s(R.string.chat_errors_workspaces_full, "rukoo.example"),
            "workspace_account_scope" to s(R.string.chat_errors_account_scope),
            "dm_unavailable" to s(R.string.chat_errors_dm_unavailable),
            "blocked" to s(R.string.chat_errors_blocked, "Mila"),
            "name_taken" to s(R.string.chat_errors_name_taken),
            "last_owner" to s(R.string.chat_errors_last_owner),
            "last_manager" to s(R.string.chat_errors_last_manager),
            "members_remain" to s(R.string.chat_errors_members_remain),
            "archived" to s(R.string.chat_errors_archived),
            "invite_gone" to s(R.string.chat_errors_invite_gone),
            "quota" to s(R.string.chat_errors_quota, "Acme"),
            "invalid" to s(R.string.chat_errors_invalid),
            "bad_link" to s(R.string.chat_join_bad_link),
            "other_server" to s(R.string.chat_join_other_host, "chat.elsewhere.example", "rukoo.example"),
            "not_saved" to s(R.string.chat_errors_not_saved),
            "paused" to s(R.string.chat_errors_paused, "Acme"),
            "server" to failed,
        )
        // The table covers every code the UI shows, and nothing else.
        assertEquals(WorkspaceError.UI_CODES, expected.keys)
        for ((code, want) in expected) assertEquals(code, want, text(code))
        // Only `server` falls back; every other code says what happened.
        for (code in WorkspaceError.UI_CODES - "server") assertNotEquals(code, failed, text(code))
    }

    @Test
    fun `a 404 says what is gone by its scope`() {
        assertEquals(s(R.string.chat_errors_gone_workspace), text(WorkspaceError("not_found", status = 404, scope = "workspace")))
        assertEquals(s(R.string.chat_errors_gone_conversation), text(WorkspaceError("not_found", status = 404, scope = "conversation")))
        assertEquals(s(R.string.chat_errors_not_found), text(WorkspaceError("not_found", status = 404)))
    }

    @Test
    fun `a full workspace says which limit it hit`() {
        assertEquals(s(R.string.chat_errors_quota_members, "Acme"), text(WorkspaceError("quota", limit = "members")))
        assertEquals(s(R.string.chat_errors_quota_conversations, "Acme"), text(WorkspaceError("quota", limit = "conversations")))
        assertEquals(s(R.string.chat_errors_quota_invites, "Acme"), text(WorkspaceError("quota", limit = "invites")))
        assertEquals(s(R.string.chat_errors_quota_bytes, "Acme"), text(WorkspaceError("quota", limit = "bytes")))
        assertEquals(s(R.string.chat_errors_quota, "Acme"), text(WorkspaceError("quota", limit = "something new")))
    }

    @Test
    fun `an invalid name gets the name rule and anything else the general text`() {
        assertEquals(s(R.string.chat_errors_invalid_name), text(WorkspaceError("invalid", field = "name")))
        assertEquals(s(R.string.chat_errors_invalid_name), text(WorkspaceError("invalid", field = "displayName")))
        assertEquals(s(R.string.chat_errors_invalid), text(WorkspaceError("invalid", field = "members")))
    }

    @Test
    fun `too many requests says when, and the daily DM limit says so`() {
        assertEquals(Strings.plural(R.plurals.chat_errors_rate_limited, 12, 12), text(WorkspaceError("rate_limited", retryAfterS = 12)))
        assertEquals(s(R.string.chat_errors_daily_dms), text(WorkspaceError("rate_limited", retryAfterS = 3600, limit = "dailyDms")))
    }

    @Test
    fun `the engine's own outcomes, unknown codes and other failures read as something went wrong`() {
        for (code in WorkspaceError.ENGINE_CODES) assertEquals(code, failed, text(code))
        assertEquals(failed, text("a_code_from_a_newer_server"))
        assertEquals(failed, text(IllegalStateException("boom")))
    }

    @Test
    fun `a failed send says why under its row`() {
        fun reason(r: String?) = ChatErrors.reasonText(r, Strings, ctx)
        assertEquals(s(R.string.chat_errors_operation_conflict), reason("conflict"))
        assertEquals(s(R.string.chat_errors_archived), reason("archived"))
        assertEquals(s(R.string.chat_errors_quota, "Acme"), reason("quota"))
        assertEquals(s(R.string.chat_errors_mentions), reason("mentions"))
        assertEquals(s(R.string.chat_errors_invalid), reason("invalid"))
        assertEquals(s(R.string.chat_errors_gone_conversation), reason("no_access"))
        assertEquals(failed, reason(null))
    }
}
