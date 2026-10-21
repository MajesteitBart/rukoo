package nl.bvdm.rukoo.agents

import nl.bvdm.rukoo.agents.model.AdapterEvent
import nl.bvdm.rukoo.agents.model.AgentErrorInfo
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.TurnStatus

/** A file attached to a turn, as the adapter gets it (hub.js:1304-1338). [inline] marks an image small enough to send as is. */
data class TurnFile(
    val id: String,
    val name: String,
    val type: String,
    val kind: String,
    val size: Long,
    val path: String,
    val inline: Boolean = false,
)

/**
 * Where the agent reaches Rukoo's tools for this turn. Hermes and OpenClaw find the phone themselves
 * (the bridge, the OpenClaw MCP entry), so for them [url] is empty. A computer host gets the phone's
 * Tailscale endpoint and the token the phone issued for that computer.
 */
data class McpGrant(val url: String = "", val token: String = "") {
    override fun toString() = "McpGrant(url=$url)"
}

/**
 * The turn an adapter runs: the port of desktop's handle (spec 3 §3.1). Stopping the turn cancels the
 * coroutine running [AgentAdapter.runTurn]; adapters clean up in `finally` and let the cancellation through.
 */
interface TurnHandle {
    /** `t_<10>`. */
    val id: String

    /** The chat as it was when the turn started. */
    val conversation: Conversation

    /** The turn text built by the hub (spec 1 §2.3). Changes after [startOver]. */
    val input: String

    /** Rukoo's instructions, the same every turn (spec 1 §2.2.1). */
    val instructions: String

    /** The user's own text. */
    val text: String

    val action: String?

    /** `$name` mentions that name the agent's own skills, in order. */
    val skills: List<String>

    val firstTurn: Boolean
    val model: String?
    val effort: String?
    val files: List<TurnFile>

    /** Rukoo ids of attached emails. */
    val emails: List<String>

    val mcp: McpGrant

    fun emit(event: AdapterEvent)

    /** Shows a runtime approval card and suspends until the user picks; returns the choice id, `cancel` when it expired. */
    suspend fun approve(request: ApprovalRequest): String

    /** Expires a pending approval of this turn by its item id or the adapter's key (Hermes request_id, host approval id). */
    fun expireApproval(itemOrKey: String)

    /** Merges adapter state into the conversation's provider map and saves it (sessionId, threadId ...). */
    fun setProvider(patch: Map<String, String>)

    /** The agent accepted the input: the turn counts as reached even before it streams. */
    fun accepted()

    /** The agent lost its session: the hub rebuilds the input as a first turn with a recap and returns it. */
    suspend fun startOver(): String
}

/** How [AgentAdapter.runTurn] ended. A turn that throws counts as an error with code `unknown`. */
data class TurnResult(val status: TurnStatus, val error: AgentErrorInfo? = null) {
    companion object {
        val DONE = TurnResult(TurnStatus.DONE)
        val STOPPED = TurnResult(TurnStatus.STOPPED)

        fun error(code: String, detail: String = "") = TurnResult(TurnStatus.ERROR, AgentErrorInfo(code, detail))
    }
}

/** One agent the hub can run turns on: Hermes, OpenClaw, a computer's Claude Code or Codex, or the fake agent. */
interface AgentAdapter {
    /** The agent id this adapter serves. */
    val id: String

    /** [force] skips any cached answer (the Test button). */
    suspend fun status(force: Boolean = false): AgentStatus

    suspend fun runTurn(turn: TurnHandle): TurnResult

    suspend fun models(): ModelOptions

    /** The agent's own skills for `$name`; empty when it has none. */
    suspend fun skills(): List<OwnSkill> = emptyList()

    /** The chat is gone: drop any session state kept for it. */
    suspend fun forget(conversationId: String) {}
}
