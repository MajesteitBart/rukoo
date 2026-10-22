package nl.bvdm.rukoo.ui.agent

import android.content.res.Resources
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.model.AgentKind
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.ApprovalChoice
import nl.bvdm.rukoo.agents.model.ApprovalField
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.DraftMode
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.agents.model.TaskStatus
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.agents.model.ToolKind
import nl.bvdm.rukoo.core.Unsafe

/**
 * Text the chat shows: a string resource with its arguments, a plural, or text as it came from an agent or the
 * hub. Deciding which is pure, so it is unit-tested; [resolve] turns it into words.
 */
sealed interface Txt {
    data class Res(@param:StringRes val id: Int, val args: List<Any> = emptyList()) : Txt

    data class Plural(@param:PluralsRes val id: Int, val count: Int, val args: List<Any> = emptyList()) : Txt

    data class Raw(val text: String) : Txt
}

fun Txt.resolve(resources: Resources): String = when (this) {
    is Txt.Res -> if (args.isEmpty()) resources.getString(id) else resources.getString(id, *args.toTypedArray())
    is Txt.Plural -> resources.getQuantityString(id, count, *args.toTypedArray())
    is Txt.Raw -> text
}

/** The words of [this] in the interface language; recomposes when the language changes. */
@Composable
@ReadOnlyComposable
fun Txt.text(): String {
    LocalConfiguration.current
    return resolve(LocalContext.current.resources)
}

/** An approval card as the user reads it: titles, field labels and standard choices in the interface language. */
data class ShownApproval(
    val title: Txt,
    val detail: String,
    val fields: List<ShownField>,
    val choices: List<ShownChoice>,
)

data class ShownField(val label: Txt, val value: String, val key: String?, val truncated: Int)

data class ShownChoice(val id: String, val label: Txt, val kind: nl.bvdm.rukoo.agents.model.ChoiceKind)

/** Desktop panel.js's translations of what main and the adapters write in English (localizeApproval, localizeNotice, ...). */
object AgentText {
    /** Product names: not translated. */
    fun product(kind: AgentKind): String = when (kind) {
        AgentKind.HERMES -> "Hermes Agent"
        AgentKind.OPENCLAW -> "OpenClaw"
        AgentKind.CLAUDE -> "Claude Code"
        AgentKind.CODEX -> "Codex"
        AgentKind.FAKE -> "Fake agent"
    }

    /** Until these are fixed in Settings the agent can't take a message. */
    fun blocked(state: AgentState): Boolean =
        state == AgentState.UNCONFIGURED || state == AgentState.DISABLED || state == AgentState.MISSING || state == AgentState.UNAUTHORIZED

    fun status(state: AgentState): Txt = Txt.Res(
        when (state) {
            AgentState.CHECKING -> R.string.agentui_status_starting
            AgentState.READY -> R.string.agentui_status_ready
            AgentState.OFFLINE -> R.string.agentui_status_offline
            AgentState.UNCONFIGURED -> R.string.agentui_status_unconfigured
            AgentState.DISABLED -> R.string.agentui_status_disabled
            AgentState.MISSING -> R.string.agentui_status_missing
            AgentState.UNAUTHORIZED -> R.string.agentui_status_unauthorized
            AgentState.UNKNOWN -> R.string.agentui_status_unknown
        },
    )

    /** Why the input is off ("Clark isn't set up yet."); null when the agent can take a message. */
    fun setup(state: AgentState, name: String): Txt? = when (state) {
        AgentState.UNCONFIGURED -> Txt.Res(R.string.agentui_setup_unconfigured, listOf(name))
        AgentState.DISABLED -> Txt.Res(R.string.agentui_setup_disabled, listOf(name))
        AgentState.MISSING -> Txt.Res(R.string.agentui_setup_missing, listOf(name))
        AgentState.UNAUTHORIZED -> Txt.Res(R.string.agentui_setup_unauthorized, listOf(name))
        else -> null
    }

    private val ERRORS = mapOf(
        ErrorCodes.OFFLINE to R.string.agentui_errors_offline,
        ErrorCodes.UNAUTHORIZED to R.string.agentui_errors_unauthorized,
        ErrorCodes.NOT_CONFIGURED to R.string.agentui_errors_not_configured,
        ErrorCodes.NOT_INSTALLED to R.string.agentui_errors_not_installed,
        ErrorCodes.DISABLED to R.string.agentui_errors_disabled,
        ErrorCodes.SPAWN_FAILED to R.string.agentui_errors_spawn_failed,
        ErrorCodes.BUSY to R.string.agentui_errors_busy,
        ErrorCodes.WINDOW to R.string.agentui_errors_window,
        ErrorCodes.TIMEOUT to R.string.agentui_errors_timeout,
        ErrorCodes.PROTOCOL to R.string.agentui_errors_protocol,
        ErrorCodes.RATE_LIMITED to R.string.agentui_errors_rate_limited,
        ErrorCodes.STOPPED to R.string.agentui_errors_stopped,
        ErrorCodes.UNKNOWN to R.string.agentui_errors_unknown,
    )

    fun isErrorCode(code: String?): Boolean = code != null && code in ERRORS

    /** A sentence for an error code ("Can't reach Clark."); codes Rukoo doesn't know read as "Something went wrong." */
    fun error(code: String?, name: String): Txt {
        val id = ERRORS[code] ?: R.string.agentui_errors_unknown
        return if (id == R.string.agentui_errors_unknown || id == R.string.agentui_errors_stopped) Txt.Res(id) else Txt.Res(id, listOf(name))
    }

    private val MAIL_RESULTS = mapOf(
        "archive" to R.plurals.agentui_mail_archive,
        "trash" to R.plurals.agentui_mail_trash,
        "move" to R.plurals.agentui_mail_move,
        "mark_read" to R.plurals.agentui_mail_mark_read,
        "mark_unread" to R.plurals.agentui_mail_mark_unread,
        "star" to R.plurals.agentui_mail_star,
        "unstar" to R.plurals.agentui_mail_unstar,
        "undo" to R.plurals.agentui_mail_undo,
    )

    /** Notices from the hub are English; errors and mail results carry a code or counts that can be said in the interface language. */
    fun notice(item: Item.Notice, name: String): Txt {
        val title = Unsafe.untag(item.params?.title)
        when (item.code) {
            "approval-too-long" -> return Txt.Res(R.string.agentui_notices_approval_too_long, listOf(title))
            "kept-approval" -> return Txt.Res(R.string.agentui_notices_kept_approval, listOf(title, name))
            "new-session" -> return Txt.Res(R.string.agentui_notices_new_session, listOf(name))
            "new-thread" -> return Txt.Res(R.string.agentui_notices_new_thread, listOf(name))
        }
        if (item.code != null && (isErrorCode(item.code) || item.tone == Tone.ERROR)) return error(item.code, name)
        val m = item.mail
        if (m != null && m.failed == 0) {
            val mailed = m.mailed ?: 0
            val opened = m.opened ?: 0
            // Only unsubscribe emails were opened: the user still has to send them.
            if (m.action == "unsubscribe_email" && mailed > 0 && mailed == m.count) {
                return if (mailed == 1 && !m.to.isNullOrBlank()) Txt.Res(R.string.agentui_mail_unsubscribe_email_one, listOf(m.to))
                else Txt.Res(R.string.agentui_mail_unsubscribe_email_many, listOf(mailed))
            }
            // Only unsubscribe pages were opened: the user finishes in the browser.
            if (m.action == "unsubscribe_page" && opened > 0 && opened == m.count) {
                return if (opened == 1 && !m.sender.isNullOrBlank()) Txt.Res(R.string.agentui_mail_unsubscribe_page_one, listOf(m.sender))
                else Txt.Res(R.string.agentui_mail_unsubscribe_page_many, listOf(opened))
            }
            val plural = MAIL_RESULTS[m.action]
            if (plural != null && m.count > 0 && (m.action != "move" || !m.folder.isNullOrBlank())) {
                return Txt.Plural(plural, m.count, listOf(m.count, m.folder.orEmpty()))
            }
        }
        return Txt.Raw(item.text)
    }

    // Runtime approvals name the kind of tool, so the card says in the interface language what the agent wants.
    private val TITLES = mapOf(
        ToolKind.COMMAND to R.string.agentui_approval_command,
        ToolKind.READ_FILE to R.string.agentui_approval_read_file,
        ToolKind.CHANGE_FILES to R.string.agentui_approval_change_files,
        ToolKind.WEB to R.string.agentui_approval_web,
        ToolKind.PERMISSIONS to R.string.agentui_approval_permissions,
    )

    private val FIELDS = mapOf(
        "command" to R.string.agentui_approval_field_command,
        "folder" to R.string.agentui_approval_field_folder,
        "file" to R.string.agentui_approval_field_file,
        "path" to R.string.agentui_approval_field_path,
        "url" to R.string.agentui_approval_field_url,
        "query" to R.string.agentui_approval_field_query,
        "pattern" to R.string.agentui_approval_field_pattern,
        "content" to R.string.agentui_approval_field_content,
        "before" to R.string.agentui_approval_field_before,
        "after" to R.string.agentui_approval_field_after,
        "diff" to R.string.agentui_approval_field_diff,
        "reason" to R.string.agentui_approval_field_reason,
    )

    private val CHOICES = mapOf(
        "allow" to R.string.agentui_choices_allow,
        "deny" to R.string.agentui_choices_deny,
        "once" to R.string.agentui_choices_once,
        "session" to R.string.agentui_choices_session,
        "always" to R.string.agentui_choices_always,
        "approve" to R.string.agentui_choices_approve,
        "decline" to R.string.agentui_choices_decline,
        "accept" to R.string.agentui_choices_accept,
        "acceptForSession" to R.string.agentui_choices_accept_for_session,
        "cancel" to R.string.agentui_choices_cancel,
    )

    // The hub labels standard buttons in English; those labels are matched back to their keys so they can be
    // translated. A label the agent wrote itself, such as propose_action's "Add tasks", stays as it is.
    private val CHOICE_LABELS = mapOf(
        "allow" to "allow",
        "deny" to "deny",
        "allow once" to "once",
        "allow for this turn" to "session",
        "always allow" to "always",
        "approve" to "approve",
        "decline" to "decline",
        "allow for this chat" to "acceptForSession",
        "cancel" to "cancel",
    )

    private val RAW_PARAM = Regex("^[a-z][a-z0-9]*(_[a-z0-9]+)+$")

    /**
     * What an approval card shows. What the user approves (the values) is shown exactly as the agent sent it; only
     * a proposal loses the `<unsafe_content>` tags the hub keeps for the agent. A detail that only repeats a field
     * value is left out.
     */
    fun approval(item: Item.Approval, name: String): ShownApproval {
        val shown: (String) -> String = if (item.kind == ApprovalKind.PROPOSAL) Unsafe::untag else { v -> v }
        val tool = item.tool
        val title: Txt = when {
            tool != null && tool.kind in TITLES -> Txt.Res(TITLES.getValue(tool.kind), listOf(name))
            tool != null && tool.kind == ToolKind.MCP && (!tool.server.isNullOrEmpty() || !tool.tool.isNullOrEmpty()) ->
                Txt.Res(R.string.agentui_approval_tool, listOf(name, listOfNotNull(tool.server, tool.tool).filter { it.isNotEmpty() }.joinToString(" · ")))
            tool != null && tool.name.isNotEmpty() -> Txt.Res(R.string.agentui_approval_tool, listOf(name, ToolNames.mcpLabel(tool.name) ?: tool.name))
            else -> Txt.Raw(shown(item.title))
        }
        val fields = item.fields.map { field(it, shown) }
        val detail = shown(item.detail).let { d -> if (d.isNotBlank() && fields.any { it.value.trim() == d.trim() }) "" else d }
        val choices = item.choices.map { choice(it, item.kind) }
        return ShownApproval(title, detail, fields, choices)
    }

    private fun field(f: ApprovalField, shown: (String) -> String): ShownField {
        val label: Txt = FIELDS[f.key]?.let { Txt.Res(it) } ?: shown(f.label).let { raw ->
            // A raw parameter name ("output_mode") reads as words.
            if (RAW_PARAM.matches(raw)) Txt.Raw(raw.replaceFirstChar(Char::uppercaseChar).replace('_', ' ')) else Txt.Raw(raw)
        }
        return ShownField(label, shown(f.value), f.key, f.truncated ?: 0)
    }

    private fun choice(c: ApprovalChoice, kind: ApprovalKind): ShownChoice {
        val key = if (kind == ApprovalKind.RUNTIME && c.id in CHOICES) c.id else CHOICE_LABELS[c.label.trim().lowercase()]
        val label = key?.let { CHOICES[it] }?.let { Txt.Res(it) } ?: Txt.Raw(c.label)
        return ShownChoice(c.id, label, c.kind)
    }

    private val RUKOO_DONE = mapOf(
        "get_context" to R.string.agentui_tools_get_context,
        "read_message" to R.string.agentui_tools_read_message,
        "search_mail" to R.string.agentui_tools_search_mail,
        "write_draft" to R.string.agentui_tools_write_draft,
        "get_draft" to R.string.agentui_tools_get_draft,
        "show_plan" to R.string.agentui_tools_show_plan,
        "show_sources" to R.string.agentui_tools_show_sources,
        "propose_action" to R.string.agentui_tools_propose_action,
        "mail_action" to R.string.agentui_tools_mail_action,
        "read_attachment" to R.string.agentui_tools_read_attachment,
        "read_chat_file" to R.string.agentui_tools_read_chat_file,
        "read_skill" to R.string.agentui_tools_read_skill,
    )

    private val RUKOO_RUNNING = mapOf(
        "get_context" to R.string.agentui_tools_running_get_context,
        "read_message" to R.string.agentui_tools_running_read_message,
        "search_mail" to R.string.agentui_tools_running_search_mail,
        "write_draft" to R.string.agentui_tools_running_write_draft,
        "get_draft" to R.string.agentui_tools_running_get_draft,
        "show_plan" to R.string.agentui_tools_running_show_plan,
        "show_sources" to R.string.agentui_tools_running_show_sources,
        "propose_action" to R.string.agentui_tools_running_propose_action,
        "mail_action" to R.string.agentui_tools_running_mail_action,
        "read_attachment" to R.string.agentui_tools_running_read_attachment,
        "read_chat_file" to R.string.agentui_tools_running_read_chat_file,
        "read_skill" to R.string.agentui_tools_running_read_skill,
    )

    private val GENERIC_DONE = mapOf(
        "command" to R.string.agentui_tools_generic_command,
        "code" to R.string.agentui_tools_generic_code,
        "webSearch" to R.string.agentui_tools_generic_web_search,
        "webPage" to R.string.agentui_tools_generic_web_page,
        "browser" to R.string.agentui_tools_generic_browser,
        "readFile" to R.string.agentui_tools_generic_read_file,
        "changeFiles" to R.string.agentui_tools_generic_change_files,
        "subagent" to R.string.agentui_tools_generic_subagent,
        "findFiles" to R.string.agentui_tools_generic_find_files,
        "todo" to R.string.agentui_tools_generic_todo,
        "lookupTools" to R.string.agentui_tools_generic_lookup_tools,
        "memory" to R.string.agentui_tools_generic_memory,
        "skill" to R.string.agentui_tools_generic_skill,
        "pastChats" to R.string.agentui_tools_generic_past_chats,
        "schedule" to R.string.agentui_tools_generic_schedule,
        "sendMessage" to R.string.agentui_tools_generic_send_message,
        "image" to R.string.agentui_tools_generic_image,
        "vision" to R.string.agentui_tools_generic_vision,
    )

    private val GENERIC_RUNNING = mapOf(
        "command" to R.string.agentui_tools_running_generic_command,
        "code" to R.string.agentui_tools_running_generic_code,
        "webSearch" to R.string.agentui_tools_running_generic_web_search,
        "webPage" to R.string.agentui_tools_running_generic_web_page,
        "browser" to R.string.agentui_tools_running_generic_browser,
        "readFile" to R.string.agentui_tools_running_generic_read_file,
        "changeFiles" to R.string.agentui_tools_running_generic_change_files,
        "subagent" to R.string.agentui_tools_running_generic_subagent,
        "findFiles" to R.string.agentui_tools_running_generic_find_files,
        "todo" to R.string.agentui_tools_running_generic_todo,
        "lookupTools" to R.string.agentui_tools_running_generic_lookup_tools,
        "memory" to R.string.agentui_tools_running_generic_memory,
        "skill" to R.string.agentui_tools_running_generic_skill,
        "pastChats" to R.string.agentui_tools_running_generic_past_chats,
        "schedule" to R.string.agentui_tools_running_generic_schedule,
        "sendMessage" to R.string.agentui_tools_running_generic_send_message,
        "image" to R.string.agentui_tools_running_generic_image,
        "vision" to R.string.agentui_tools_running_generic_vision,
    )

    fun tool(label: ToolLabel): Txt = when (label) {
        is ToolLabel.Rukoo -> (if (label.running) RUKOO_RUNNING else RUKOO_DONE)[label.tool]?.let { Txt.Res(it) } ?: unknownTool(label.running)
        is ToolLabel.Generic -> (if (label.running) GENERIC_RUNNING else GENERIC_DONE)[label.key]?.let { Txt.Res(it) } ?: unknownTool(label.running)
        is ToolLabel.Literal -> Txt.Raw(label.text)
        is ToolLabel.Unknown -> unknownTool(label.running)
    }

    private fun unknownTool(running: Boolean) = Txt.Res(if (running) R.string.agentui_tools_running_unknown else R.string.agentui_tools_unknown)

    private val ACTION_LABELS = mapOf(
        "reply" to R.string.agentui_actions_reply_label,
        "brief" to R.string.agentui_actions_brief_label,
        "tasks" to R.string.agentui_actions_tasks_label,
        "team" to R.string.agentui_actions_team_label,
        "update" to R.string.agentui_actions_update_label,
        "unsubscribe" to R.string.agentui_actions_unsubscribe_label,
        "summary" to R.string.agentui_actions_summary_label,
        "triage" to R.string.agentui_actions_triage_label,
    )

    private val ACTION_DESCRIPTIONS = mapOf(
        "reply" to R.string.agentui_actions_reply_description,
        "brief" to R.string.agentui_actions_brief_description,
        "tasks" to R.string.agentui_actions_tasks_description,
        "team" to R.string.agentui_actions_team_description,
        "update" to R.string.agentui_actions_update_description,
        "unsubscribe" to R.string.agentui_actions_unsubscribe_description,
        "summary" to R.string.agentui_actions_summary_description,
        "triage" to R.string.agentui_actions_triage_description,
    )

    /** A quick action's label: the user's own, else Rukoo's in the interface language. */
    fun actionLabel(action: QuickAction): Txt =
        action.label?.takeIf { it.isNotBlank() }?.let { Txt.Raw(it) } ?: ACTION_LABELS[action.key]?.let { Txt.Res(it) } ?: Txt.Raw(action.key)

    /** Under a renamed Rukoo action its own name; a shortcut of the user's repeats its label (actions.js makeShortcut). */
    fun actionDescription(action: QuickAction): Txt = when {
        action.custom -> action.description?.takeIf { it.isNotBlank() }?.let { Txt.Raw(it) } ?: actionLabel(action)
        !action.label.isNullOrBlank() -> ACTION_LABELS[action.key]?.let { Txt.Res(it) } ?: Txt.Raw(action.key)
        else -> ACTION_DESCRIPTIONS[action.key]?.let { Txt.Res(it) } ?: Txt.Raw(action.description.orEmpty())
    }

    private val EFFORTS = mapOf(
        "minimal" to R.string.agentui_effort_minimal,
        "low" to R.string.agentui_effort_low,
        "medium" to R.string.agentui_effort_medium,
        "high" to R.string.agentui_effort_high,
        "xhigh" to R.string.agentui_effort_xhigh,
        "max" to R.string.agentui_effort_max,
        "ultra" to R.string.agentui_effort_ultra,
    )

    fun effort(effort: String): Txt = EFFORTS[effort]?.let { Txt.Res(it) } ?: Txt.Raw(effort)

    fun plan(status: TaskStatus): Txt = Txt.Res(
        when (status) {
            TaskStatus.PROPOSED -> R.string.agentui_plan_proposed
            TaskStatus.TODO -> R.string.agentui_plan_todo
            TaskStatus.RUNNING -> R.string.agentui_plan_running
            TaskStatus.DONE -> R.string.agentui_plan_done
            TaskStatus.FAILED -> R.string.agentui_plan_failed
            TaskStatus.SKIPPED -> R.string.agentui_plan_skipped
        },
    )

    fun draft(mode: DraftMode): Txt = Txt.Res(
        when (mode) {
            DraftMode.REPLY -> R.string.agentui_draft_reply
            DraftMode.REPLY_ALL -> R.string.agentui_draft_reply_all
            DraftMode.FORWARD -> R.string.agentui_draft_forward
            DraftMode.NEW -> R.string.agentui_draft_new
        },
    )
}
