@file:OptIn(ExperimentalSerializationApi::class)

package nl.bvdm.rukoo.agents.model

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.MessagePin

@Serializable
enum class AssistantStatus {
    @SerialName("streaming") STREAMING,
    @SerialName("done") DONE,
    @SerialName("stopped") STOPPED,
}

@Serializable
enum class ThinkingStatus {
    @SerialName("running") RUNNING,
    @SerialName("done") DONE,
}

@Serializable
enum class ToolStatus {
    @SerialName("running") RUNNING,
    @SerialName("done") DONE,
    @SerialName("error") ERROR,
}

@Serializable
enum class ApprovalStatus {
    @SerialName("pending") PENDING,
    @SerialName("approved") APPROVED,
    @SerialName("denied") DENIED,
    @SerialName("expired") EXPIRED,
}

/** runtime: the agent's own permission prompt (Hermes, Claude, Codex); proposal: propose_action; mail: mail_action. */
@Serializable
enum class ApprovalKind {
    @SerialName("runtime") RUNTIME,
    @SerialName("proposal") PROPOSAL,
    @SerialName("mail") MAIL,
}

@Serializable
enum class ChoiceKind {
    @SerialName("primary") PRIMARY,
    @SerialName("danger") DANGER,
    @SerialName("default") DEFAULT,
}

/** What a runtime approval is about; the UI words the card by it. */
@Serializable
enum class ToolKind {
    @SerialName("command") COMMAND,
    @SerialName("readFile") READ_FILE,
    @SerialName("changeFiles") CHANGE_FILES,
    @SerialName("web") WEB,
    @SerialName("mcp") MCP,
    @SerialName("permissions") PERMISSIONS,
    @SerialName("other") OTHER,
}

@Serializable
enum class Tone {
    @SerialName("info") INFO,
    @SerialName("success") SUCCESS,
    @SerialName("error") ERROR,
}

/** write_draft's modes. */
@Serializable
enum class DraftMode {
    @SerialName("reply") REPLY,
    @SerialName("reply_all") REPLY_ALL,
    @SerialName("forward") FORWARD,
    @SerialName("new") NEW,
}

/** show_plan's task statuses (tools.js:63). */
@Serializable
enum class TaskStatus {
    @SerialName("proposed") PROPOSED,
    @SerialName("todo") TODO,
    @SerialName("running") RUNNING,
    @SerialName("done") DONE,
    @SerialName("failed") FAILED,
    @SerialName("skipped") SKIPPED,
}

/** A file shown on a user message (chatfiles.shown): no path. */
@Serializable
data class ShownFile(val id: String, val name: String, val size: Long = 0, val type: String = "", val kind: String = "file")

/**
 * An email attached to a user message. Subject and sender come from Rukoo's cache, never from the UI. [messageId]
 * and [accountId] find it again after it moved, as the chat's own email's do; chats saved before have neither.
 */
@Serializable
data class AttachedEmail(
    val id: String,
    val subject: String = "",
    val from: Address? = null,
    val messageId: String? = null,
    val accountId: String? = null,
)

/** One row of an approval card. [key] names what the value is (command, url, diff ...); [truncated] counts the characters cut. */
@Serializable
data class ApprovalField(val label: String, val value: String, val key: String? = null, val truncated: Int? = null)

@Serializable
data class ApprovalTool(val name: String, val kind: ToolKind = ToolKind.OTHER, val server: String? = null, val tool: String? = null)

@Serializable
data class ApprovalChoice(val id: String, val label: String, val kind: ChoiceKind = ChoiceKind.DEFAULT)

/** The mail action an approval card of kind `mail` carries out when approved. */
@Serializable
data class MailApproval(val action: String, val ids: List<String>, val folder: String? = null, val pins: List<MessagePin> = emptyList())

/** A notice's undo: messages Rukoo moved, by the ids they had before. */
@Serializable
data class NoticeUndo(val kind: String = "move", val ids: List<String>)

@Serializable
data class NoticeParams(val title: String? = null)

/** Marks a notice that reports a mail action's outcome (tools.js:1505-1523); only these enter a recap. */
@Serializable
data class NoticeMail(
    val action: String,
    val count: Int = 0,
    val failed: Int = 0,
    val folder: String? = null,
    val mailed: Int? = null,
    val to: String? = null,
    val opened: Int? = null,
    val sender: String? = null,
)

@Serializable
data class PlanTask(
    val id: String,
    val title: String = "",
    val detail: String = "",
    val system: String = "",
    val status: TaskStatus = TaskStatus.TODO,
    val url: String? = null,
    val owner: String = "",
    val due: String = "",
)

@Serializable
data class SourceRef(
    val title: String,
    val source: String = "",
    val snippet: String = "",
    val url: String? = null,
    /** The Rukoo id when the source is an email. */
    val messageId: String? = null,
    /** The email's Message-ID header, to find it again after it moved. */
    val messageHeader: String? = null,
    val accountId: String? = null,
)

/**
 * One entry of a chat transcript, with desktop's types and field names (spec 1 §1.4). Serialized with
 * a `type` discriminator, so conversations.json has the desktop's shape. [id] is `i_<10>`, [at] ms.
 */
@Serializable
@JsonClassDiscriminator("type")
sealed class Item {
    abstract val id: String
    abstract val at: Long

    /** The same item with another id and time: the hub stamps items that tools build. */
    abstract fun stamped(id: String, at: Long): Item

    /**
     * What the user sent. [text] is the display text, untagged: a quick action shows its label, a skill
     * `/name`, an approval the proposal's title. [action]: null, `approved`, `declined`, `skill`,
     * `shortcut` or a quick action key.
     */
    @Serializable
    @SerialName("user")
    data class User(
        override val id: String,
        override val at: Long,
        val text: String,
        val action: String? = null,
        val files: List<ShownFile>? = null,
        val emails: List<AttachedEmail>? = null,
    ) : Item() {
        override fun stamped(id: String, at: Long) = copy(id = id, at = at)
    }

    /** The agent's answer. [interim] is commentary between tool calls: lighter, left out of recaps and previews. */
    @Serializable
    @SerialName("assistant")
    data class Assistant(
        override val id: String,
        override val at: Long,
        val text: String,
        val status: AssistantStatus = AssistantStatus.DONE,
        val interim: Boolean = false,
    ) : Item() {
        override fun stamped(id: String, at: Long) = copy(id = id, at = at)
    }

    @Serializable
    @SerialName("thinking")
    data class Thinking(
        override val id: String,
        override val at: Long,
        val text: String = "",
        val status: ThinkingStatus = ThinkingStatus.RUNNING,
        val startedAt: Long = at,
        val endedAt: Long? = null,
    ) : Item() {
        override fun stamped(id: String, at: Long) = copy(id = id, at = at)
    }

    /** A tool call. [label] is the English fallback from toolLabel(name); [rukoo] marks Rukoo's own tools. */
    @Serializable
    @SerialName("tool")
    data class Tool(
        override val id: String,
        override val at: Long,
        val name: String,
        val label: String = name,
        val detail: String = "",
        val status: ToolStatus = ToolStatus.RUNNING,
        val startedAt: Long = at,
        val endedAt: Long? = null,
        val rukoo: Boolean = false,
    ) : Item() {
        override fun stamped(id: String, at: Long) = copy(id = id, at = at)
    }

    /** An approval card. [source] is the agent id or `rukoo`; [declinedBy] `rukoo` when its input was too long to show. */
    @Serializable
    @SerialName("approval")
    data class Approval(
        override val id: String,
        override val at: Long,
        val title: String,
        val detail: String = "",
        val fields: List<ApprovalField> = emptyList(),
        val tool: ApprovalTool? = null,
        val choices: List<ApprovalChoice> = emptyList(),
        val status: ApprovalStatus = ApprovalStatus.PENDING,
        val decision: String? = null,
        val declinedBy: String? = null,
        val source: String = "rukoo",
        val kind: ApprovalKind = ApprovalKind.RUNTIME,
        val mail: MailApproval? = null,
    ) : Item() {
        override fun stamped(id: String, at: Long) = copy(id = id, at = at)
    }

    /** A line from Rukoo: errors, mail-action results (with [mail] and maybe [undo]), kept approvals. */
    @Serializable
    @SerialName("notice")
    data class Notice(
        override val id: String,
        override val at: Long,
        val text: String,
        val detail: String? = null,
        val tone: Tone = Tone.INFO,
        val code: String? = null,
        val undo: NoticeUndo? = null,
        val params: NoticeParams? = null,
        val mail: NoticeMail? = null,
    ) : Item() {
        override fun stamped(id: String, at: Long) = copy(id = id, at = at)
    }

    /** write_draft put a draft in the composer. [composerKey] names that composer; [undone] is the one field the UI may change. */
    @Serializable
    @SerialName("draft")
    data class Draft(
        override val id: String,
        override val at: Long,
        val mode: DraftMode = DraftMode.NEW,
        val to: List<Address> = emptyList(),
        val subject: String = "",
        val summary: String = "",
        val messageRef: String? = null,
        val composerKey: String? = null,
        val undone: Boolean = false,
        val draftId: String? = null,
    ) : Item() {
        override fun stamped(id: String, at: Long) = copy(id = id, at = at)
    }

    /** show_plan. Later calls update it in place by [planId]. */
    @Serializable
    @SerialName("plan")
    data class Plan(
        override val id: String,
        override val at: Long,
        val planId: String,
        val title: String = "",
        val tasks: List<PlanTask> = emptyList(),
    ) : Item() {
        override fun stamped(id: String, at: Long) = copy(id = id, at = at)
    }

    @Serializable
    @SerialName("sources")
    data class Sources(
        override val id: String,
        override val at: Long,
        val title: String = "",
        val sources: List<SourceRef> = emptyList(),
    ) : Item() {
        override fun stamped(id: String, at: Long) = copy(id = id, at = at)
    }
}
