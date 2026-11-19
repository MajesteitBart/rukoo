package nl.bvdm.rukoo.ui.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import java.util.Locale
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.RkToastState
import nl.bvdm.rukoo.ui.icons.IconSpec
import nl.bvdm.rukoo.ui.icons.IconSpecBuilder
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.mail.DialogAnswer
import nl.bvdm.rukoo.ui.mail.DialogChoice
import nl.bvdm.rukoo.ui.mail.DialogRequest
import nl.bvdm.rukoo.ui.mail.ResourceStrings
import nl.bvdm.rukoo.ui.mail.UiStrings
import nl.bvdm.rukoo.workspaces.ChatState
import nl.bvdm.rukoo.workspaces.WorkspaceError
import nl.bvdm.rukoo.workspaces.Workspaces

/** What Chat's actions need from navigation. AppViewModel implements it. */
interface ChatUiHost {
    /** Opens a room in the selected workspace, at a seq when one is given. */
    fun openRoom(id: String, at: Long? = null)

    /** Shows another workspace, or none. */
    fun selectWorkspace(id: String?)
}

/**
 * What an error's text names: the account server's [host], the [workspace] it happened in, the person a block names
 * ([member], a display name) and the server of an invitation link for another server ([linkHost]).
 */
data class ErrorContext(val host: String = "", val workspace: String = "", val member: String? = null, val linkHost: String? = null)

/** The texts of contract §3.15 for a [WorkspaceError], and of a failed send's reason (§3.8). Pure, for the tests. */
object ChatErrors {
    // The inputs a `400 invalid` names that are names, which get the name rule's text (§3.16).
    private val NAME_FIELDS = setOf("name", "displayName")

    fun text(e: Throwable, s: UiStrings, ctx: ErrorContext): String {
        if (e !is WorkspaceError) return s.get(R.string.chat_errors_failed)
        return when (e.code) {
            "network" -> s.get(R.string.chat_errors_network, ctx.host)
            "signed_out" -> s.get(R.string.chat_errors_signed_out)
            "upgrade_required" -> s.get(R.string.chat_errors_upgrade, ctx.host)
            "rate_limited" ->
                if (e.limit == "dailyDms") s.get(R.string.chat_errors_daily_dms)
                else (e.retryAfterS ?: 1L).toInt().let { s.plural(R.plurals.chat_errors_rate_limited, it, it) }
            "not_found" -> when (e.scope) {
                "workspace" -> s.get(R.string.chat_errors_gone_workspace)
                "conversation" -> s.get(R.string.chat_errors_gone_conversation)
                else -> s.get(R.string.chat_errors_not_found)
            }
            "forbidden" -> s.get(R.string.chat_errors_forbidden)
            "cosign_required" -> s.get(R.string.chat_channel_add_guest_needs_admin)
            "workspace_limit" -> s.get(R.string.chat_errors_workspace_limit, ctx.host)
            "workspaces_full" -> s.get(R.string.chat_errors_workspaces_full, ctx.host)
            "workspace_account_scope" -> s.get(R.string.chat_errors_account_scope)
            "dm_unavailable" -> s.get(R.string.chat_errors_dm_unavailable)
            "blocked" -> s.get(R.string.chat_errors_blocked, ctx.member.orEmpty())
            "name_taken" -> s.get(R.string.chat_errors_name_taken)
            "last_owner" -> s.get(R.string.chat_errors_last_owner)
            "last_manager" -> s.get(R.string.chat_errors_last_manager)
            "members_remain" -> s.get(R.string.chat_errors_members_remain)
            "archived" -> s.get(R.string.chat_errors_archived)
            "invite_gone" -> s.get(R.string.chat_errors_invite_gone)
            "quota" -> when (e.limit) {
                "members" -> s.get(R.string.chat_errors_quota_members, ctx.workspace)
                "conversations" -> s.get(R.string.chat_errors_quota_conversations, ctx.workspace)
                "invites" -> s.get(R.string.chat_errors_quota_invites, ctx.workspace)
                "bytes" -> s.get(R.string.chat_errors_quota_bytes, ctx.workspace)
                else -> s.get(R.string.chat_errors_quota, ctx.workspace)
            }
            "invalid" -> if (e.field in NAME_FIELDS) s.get(R.string.chat_errors_invalid_name) else s.get(R.string.chat_errors_invalid)
            "bad_link" -> s.get(R.string.chat_join_bad_link)
            "other_server" -> s.get(R.string.chat_join_other_host, ctx.linkHost.orEmpty(), ctx.host)
            "not_saved" -> s.get(R.string.chat_errors_not_saved)
            "paused" -> s.get(R.string.chat_errors_paused, ctx.workspace)
            // `server`, and the engine's own outcomes, which never reach the UI as call errors (§3.15).
            else -> s.get(R.string.chat_errors_failed)
        }
    }

    /** Why a send failed, for "Not sent: {reason}" under a pending row. */
    fun reasonText(reason: String?, s: UiStrings, ctx: ErrorContext): String = when (reason) {
        "conflict" -> s.get(R.string.chat_errors_operation_conflict)
        "archived" -> s.get(R.string.chat_errors_archived)
        "quota" -> s.get(R.string.chat_errors_quota, ctx.workspace)
        "mentions" -> s.get(R.string.chat_errors_mentions)
        "invalid" -> s.get(R.string.chat_errors_invalid)
        "no_access" -> s.get(R.string.chat_errors_gone_conversation)
        else -> s.get(R.string.chat_errors_failed)
    }
}

/**
 * Chat's work outside composition, like MailUi for mail: dialogs and confirm prompts, busy flags, error toasts and the
 * error texts of §3.15. It lives in the view model, so an action started in a sheet finishes after the sheet closed.
 * [workspaces] is null until the app has team chat (AppServices.workspaces).
 */
class ChatUi(
    val workspaces: Workspaces?,
    private val scope: CoroutineScope,
    private val host: ChatUiHost,
    val toasts: RkToastState = RkToastState(),
    private val state: () -> ChatState = { ChatState() },
) {
    /** Set by the root from the current resources, so texts follow the language. */
    var strings: UiStrings = object : UiStrings {
        override fun get(id: Int, vararg args: Any) = ""
        override fun plural(id: Int, count: Int, vararg args: Any) = ""
    }

    var dialog: DialogRequest? by mutableStateOf(null)
        private set

    private var covers by mutableIntStateOf(0)

    /**
     * Whether a dialog or sheet covers the panes: the timeline reports nothing as read meanwhile (§3.9). Sheets drawn
     * outside the navigation state count themselves with [Covering].
     */
    val covered: Boolean get() = covers > 0 || dialog != null

    /** Counts the composable calling it as covering the panes while it is on screen. */
    @Composable
    fun Covering() {
        DisposableEffect(this) {
            covers++
            onDispose { covers-- }
        }
    }

    /** Keys of the actions running now, for buttons that show progress. */
    var busy: Set<String> by mutableStateOf(emptySet())
        private set

    fun isBusy(key: String): Boolean = key in busy

    private val leaving = HashSet<String>()

    /**
     * The person is leaving or deleting the room or workspace [id] themself, so its going isn't news: no "You're no
     * longer in" toast when it disappears.
     */
    fun expectGone(id: String) {
        leaving += id
    }

    /** Whether [id] went because the person asked; true once. */
    fun wasExpected(id: String): Boolean = leaving.remove(id)

    /** The error context of [ws] (the selected workspace by default) on the configured server. */
    fun context(ws: String? = null, member: String? = null, linkHost: String? = null): ErrorContext {
        val s = state()
        val id = ws ?: s.selected
        return ErrorContext(host = s.host, workspace = s.workspaces.firstOrNull { it.id == id }?.name.orEmpty(), member = member, linkHost = linkHost)
    }

    fun errorText(e: Throwable, ctx: ErrorContext = context()): String = ChatErrors.text(e, strings, ctx)

    fun reasonText(reason: String?, ctx: ErrorContext = context()): String = ChatErrors.reasonText(reason, strings, ctx)

    fun showError(e: Throwable, ctx: ErrorContext = context()) = toasts.showError(errorText(e, ctx))

    /** Shows [request] and waits for the answer; an earlier open question is cancelled. */
    suspend fun ask(request: DialogRequest): DialogAnswer {
        dialog?.answer(DialogChoice.CANCEL)
        dialog = request
        return try {
            request.answer.await()
        } finally {
            if (dialog === request) dialog = null
        }
    }

    suspend fun confirm(title: String, message: String?, label: String, danger: Boolean = false): Boolean =
        ask(DialogRequest(title, message, label, strings.get(R.string.common_actions_cancel), danger)).choice == DialogChoice.CONFIRM

    /**
     * Runs [block] on the workspaces in the view model's scope, with [key] busy meanwhile (a second run with the same
     * key is ignored). A failure shows its §3.15 text in [ctx] as an error toast. Null when there is no team chat or
     * the key is busy.
     */
    fun launch(key: String? = null, ctx: ErrorContext? = null, block: suspend Workspaces.() -> Unit): Job? {
        val w = workspaces ?: return null
        if (key != null && key in busy) return null
        if (key != null) busy = busy + key
        return scope.launch {
            try {
                w.block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                showError(e, ctx ?: context())
            } finally {
                if (key != null) busy = busy - key
            }
        }
    }

    /** Pull to refresh and the status line's sync button: runs the feed of [ws], or of every workspace. */
    fun refresh(ws: String? = null) = launch("refresh:${ws.orEmpty()}") { refresh(ws) }

    /** Start over on a stopped workspace (§3.6). */
    fun reload(ws: String) = launch("reload:$ws", context(ws)) { reload(ws) }

    fun select(ws: String?) = host.selectWorkspace(ws)

    /** Members' names in the interface language, for code outside composition. */
    fun names(): ChatNames = chatNames(strings)
}

/** Members' names as [s] words them: Former member, Deleted member, " and N others" and the language's list. */
fun chatNames(s: UiStrings): ChatNames = ChatNames(
    former = s.get(R.string.chat_log_former_member),
    deleted = s.get(R.string.chat_log_deleted_member),
    others = { n -> s.plural(R.plurals.reader_recipients_others, n, n) },
    list = listFormat(s.locale),
)

/** Joins names as the language lists them ("Sanne, Mila and Olga"), with commas where ICU isn't there (unit tests). */
internal fun listFormat(locale: Locale): (List<String>) -> String = { names ->
    runCatching { android.icu.text.ListFormatter.getInstance(locale).format(names) }.getOrNull() ?: names.joinToString(", ")
}

/** [chatNames] for the current resources. */
@Composable
fun rememberChatNames(): ChatNames {
    val resources = LocalContext.current.resources
    val locale = LocalConfiguration.current.locales[0]
    return remember(resources, locale) { chatNames(ResourceStrings(resources)) }
}

/** The few line icons Chat needs that the app's set doesn't have, drawn like RukooIcons (24 grid, 1.6 strokes). */
internal object ChatIcons {
    private fun icon(name: String, block: IconSpecBuilder.() -> Unit): ImageVector =
        IconSpec(RukooIcons.STROKE, IconSpecBuilder().apply(block).parts).build(name)

    /** desktop icons.js `lock`: a private channel. */
    val Lock: ImageVector by lazy {
        icon("lock") {
            rect(5f, 10.5f, 14f, 10f, 2.5f)
            path("M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5")
            path("M12 14.5v2.5")
        }
    }

    /** A channel visible to the workspace. */
    val Hash: ImageVector by lazy { icon("hash") { path("M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16") } }

    /** A speech bubble, for Chat's empty states. */
    val Bubble: ImageVector by lazy {
        icon("bubble") { path("M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17h-1A.5.5 0 0 1 4 16.5z") }
    }
}
