package nl.bvdm.rukoo.agents.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Agent ids on the phone. Computer-hosted agents carry the pairing id: `computer:<pairingId>:claude`. */
object AgentIds {
    const val CLARK = "clark"
    const val OPENCLAW = "openclaw"
    const val FAKE = "fake"
    private const val COMPUTER = "computer:"

    fun computer(pairingId: String, program: ComputerProgram) = "$COMPUTER$pairingId:${program.wire}"

    /** The pairing id and program of a computer agent id, or null for any other id. */
    fun parseComputer(agent: String): Pair<String, ComputerProgram>? {
        if (!agent.startsWith(COMPUTER)) return null
        val parts = agent.removePrefix(COMPUTER).split(':')
        if (parts.size != 2 || parts[0].isEmpty()) return null
        val program = ComputerProgram.entries.firstOrNull { it.wire == parts[1] } ?: return null
        return parts[0] to program
    }

    /** Whether a stored conversation's agent is one this app can talk to; load skips the rest, as desktop does. */
    fun isKnown(agent: String) = agent == CLARK || agent == OPENCLAW || agent == FAKE || parseComputer(agent) != null
}

/** The programs a paired computer runs for the phone. [wire] is desktop's agent id. */
enum class ComputerProgram(val wire: String) { CLAUDE("claude"), CODEX("codex") }

/** Desktop's agent states (hub.js:44), plus CHECKING while the first probe runs. */
@Serializable
enum class AgentState {
    @SerialName("ready") READY,
    @SerialName("offline") OFFLINE,
    @SerialName("unconfigured") UNCONFIGURED,
    @SerialName("disabled") DISABLED,
    @SerialName("missing") MISSING,
    @SerialName("unauthorized") UNAUTHORIZED,
    @SerialName("unknown") UNKNOWN,
    @SerialName("checking") CHECKING,
}

/** An agent's status for the picker and the chat header; [detail] is a short English reason. */
@Serializable
data class AgentStatus(val state: AgentState = AgentState.UNKNOWN, val detail: String = "")

enum class AgentKind { HERMES, OPENCLAW, CLAUDE, CODEX, FAKE }

/**
 * An agent the user can chat with. [name] is the display name ("Clark", "OpenClaw", "Claude Code");
 * [subtitle] says where it runs ("on office-pc"), empty for agents the phone reaches itself.
 */
data class AgentDescriptor(
    val id: String,
    val kind: AgentKind,
    val name: String,
    val subtitle: String = "",
    val enabled: Boolean = true,
    val status: AgentStatus = AgentStatus(AgentState.CHECKING),
)

/** One model an agent offers (hub.js loadModels): its efforts, and the default effort if it has one. */
@Serializable
data class ModelOption(
    val id: String,
    val label: String = id,
    val group: String? = null,
    val tag: String? = null,
    val route: Boolean = false,
    val isDefault: Boolean = false,
    val efforts: List<String> = emptyList(),
    val defaultEffort: String = "",
)

/**
 * The model menu of an agent (desktop models(agent)): [efforts] of the default model, [custom] the
 * efforts for a model typed by hand, [defaultModel] the model in Settings, [error] why the list failed.
 */
@Serializable
data class ModelOptions(
    val agent: String,
    val models: List<ModelOption> = emptyList(),
    val efforts: List<String> = emptyList(),
    val custom: List<String> = emptyList(),
    val defaultModel: String = "",
    val error: AgentErrorInfo? = null,
) {
    companion object {
        /** Desktop's EFFORTS (config.js:15), weakest first. */
        val EFFORTS = listOf("minimal", "low", "medium", "high", "xhigh", "max", "ultra")
    }
}

/** A skill of the agent itself, offered as `$name` (ownskills.js cleanList). */
@Serializable
data class OwnSkill(val name: String, val description: String = "", val scope: String? = null)

@Serializable
data class OwnSkills(val agent: String, val skills: List<OwnSkill> = emptyList(), val error: AgentErrorInfo? = null)

/**
 * A Rukoo skill, offered as `/name` (skills.js): bundled (`rukoo`) or the user's own (`user`). [body] is SKILL.md
 * after its frontmatter, the instructions a `/name` turn carries; read_skill gets the whole file from
 * [nl.bvdm.rukoo.agents.AgentHub.readSkill].
 */
data class RukooSkill(val name: String, val description: String, val source: String, val body: String)

/**
 * What the hub needs to show an approval card (desktop requestApproval input). [key] is the adapter's
 * own id for it (Hermes `request_id`, the computer host's approval id), to expire it later.
 */
data class ApprovalRequest(
    val title: String,
    val detail: String = "",
    val fields: List<ApprovalField> = emptyList(),
    val choices: List<ApprovalChoice> = emptyList(),
    val source: String,
    val kind: ApprovalKind = ApprovalKind.RUNTIME,
    val key: String? = null,
    val mail: MailApproval? = null,
    val tool: ApprovalTool? = null,
)
