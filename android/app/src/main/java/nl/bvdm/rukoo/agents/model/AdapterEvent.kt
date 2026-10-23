@file:OptIn(ExperimentalSerializationApi::class)

package nl.bvdm.rukoo.agents.model

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import nl.bvdm.rukoo.core.RukooJson

/** An agent error: a code from [ErrorCodes] and a short English detail. */
@Serializable
data class AgentErrorInfo(val code: String = ErrorCodes.UNKNOWN, val detail: String = "")

/** Desktop's error codes (hub.js:59-73); the UI translates by code. */
object ErrorCodes {
    const val OFFLINE = "offline"
    const val UNAUTHORIZED = "unauthorized"
    const val NOT_CONFIGURED = "not-configured"
    const val NOT_INSTALLED = "not-installed"
    const val DISABLED = "disabled"
    const val SPAWN_FAILED = "spawn-failed"
    const val BUSY = "busy"
    const val WINDOW = "window"
    const val TIMEOUT = "timeout"
    const val PROTOCOL = "protocol"
    const val RATE_LIMITED = "rate-limited"
    const val STOPPED = "stopped"
    const val UNKNOWN = "unknown"
    const val INVALID = "invalid"

    /** English fallbacks for error notices, verbatim from desktop. */
    val TEXT = mapOf(
        OFFLINE to "Could not reach the agent.",
        UNAUTHORIZED to "The agent rejected the key or token.",
        NOT_CONFIGURED to "The agent is not set up yet.",
        NOT_INSTALLED to "The agent program was not found.",
        DISABLED to "The agent is turned off.",
        SPAWN_FAILED to "The agent program stopped unexpectedly.",
        BUSY to "The agent is still working on the previous message.",
        WINDOW to "Rukoo's window is closed.",
        TIMEOUT to "The agent did not respond in time.",
        PROTOCOL to "The agent sent something Rukoo did not understand.",
        RATE_LIMITED to "The agent is rate limited. Try again in a moment.",
        STOPPED to "Stopped.",
        UNKNOWN to "Something went wrong.",
    )
}

/**
 * What an adapter reports during a turn (spec 3 §3.2), shared by Hermes, OpenClaw, the computer host
 * and the fake agent. The hub turns these into transcript items (onAdapterEvent). `text`,
 * `commentary`, `thinking` and `tool-start` mean the turn reached the agent.
 */
@Serializable
@JsonClassDiscriminator("type")
sealed class AdapterEvent {
    /** More of the streaming answer. */
    @Serializable
    @SerialName("text")
    data class Text(val delta: String) : AdapterEvent()

    /** A finished message between tool calls; shown as an interim assistant item. */
    @Serializable
    @SerialName("commentary")
    data class Commentary(val text: String) : AdapterEvent()

    @Serializable
    @SerialName("thinking")
    data class Thinking(val delta: String) : AdapterEvent()

    @Serializable
    @SerialName("thinking-done")
    data object ThinkingDone : AdapterEvent()

    /** A tool call began; [key] pairs it with its [ToolEnd]. */
    @Serializable
    @SerialName("tool-start")
    data class ToolStart(val key: String, val name: String, val detail: String = "") : AdapterEvent()

    @Serializable
    @SerialName("tool-end")
    data class ToolEnd(val key: String, val error: Boolean = false, val detail: String? = null) : AdapterEvent()

    @Serializable
    @SerialName("error")
    data class Error(val code: String = ErrorCodes.UNKNOWN, val detail: String = "") : AdapterEvent()

    /**
     * A one-line notice, e.g. code `new-session` when the agent started over. [params] carries what the UI needs to
     * word it by code (`approval-too-long` has the card's title), like the notice item's own params.
     */
    @Serializable
    @SerialName("notice")
    data class Notice(val text: String, val tone: Tone = Tone.INFO, val code: String? = null, val params: NoticeParams? = null) : AdapterEvent()

    /** Token counts; the hub ignores them. */
    @Serializable
    @SerialName("usage")
    data object Usage : AdapterEvent()
}

/** How a turn ended. */
@Serializable
enum class TurnStatus {
    @SerialName("done") DONE,
    @SerialName("stopped") STOPPED,
    @SerialName("error") ERROR,
}

/** An approval card as desktop Rukoo sends it for a computer-hosted turn (spec 3 §7.7, approvalCard()). */
@Serializable
data class ApprovalCard(
    val title: String,
    val detail: String = "",
    val fields: List<ApprovalField> = emptyList(),
    val tool: ApprovalTool? = null,
    val choices: List<ApprovalChoice> = emptyList(),
    val source: String = "",
    val kind: ApprovalKind = ApprovalKind.RUNTIME,
)

/**
 * The events only a computer host sends (spec 3 §7.7), next to the [AdapterEvent]s it relays. One NDJSON
 * line each; [HostStream.parse] tells them apart.
 */
@Serializable
@JsonClassDiscriminator("type")
sealed class HostEvent {
    @Serializable
    @SerialName("started")
    data class Started(val turnId: String, val conversationId: String = "", val agent: String = "") : HostEvent()

    /** Merge into the conversation's provider state and save (sessionId or threadId). */
    @Serializable
    @SerialName("provider")
    data class Provider(val patch: Map<String, String> = emptyMap()) : HostEvent()

    /** The agent accepted the input: the turn reached it. */
    @Serializable
    @SerialName("accepted")
    data object Accepted : HostEvent()

    /** A runtime approval: pending, or already denied by the computer because its input was too long. */
    @Serializable
    @SerialName("approval")
    data class Approval(
        val approvalId: String,
        val card: ApprovalCard,
        val status: ApprovalStatus = ApprovalStatus.PENDING,
        val decision: String? = null,
        val declinedBy: String? = null,
    ) : HostEvent()

    @Serializable
    @SerialName("approval-decided")
    data class ApprovalDecided(val approvalId: String, val decision: String) : HostEvent()

    @Serializable
    @SerialName("approval-expired")
    data class ApprovalExpired(val approvalId: String) : HostEvent()

    /** The agent lost its session: post the first-turn input with the recap to start-over/[requestId]. */
    @Serializable
    @SerialName("start-over")
    data class StartOver(val requestId: String) : HostEvent()

    @Serializable
    @SerialName("done")
    data class Done(val status: TurnStatus = TurnStatus.DONE, val error: AgentErrorInfo? = null) : HostEvent()

    /** Heartbeat every 15 s; no seq. */
    @Serializable
    @SerialName("ping")
    data object Ping : HostEvent()

    /** On reattach: buffered events were dropped; carry on. */
    @Serializable
    @SerialName("gap")
    data object Gap : HostEvent()
}

/** One line of the computer host's NDJSON stream: its [seq] (absent for pings) and either kind of event. */
data class HostLine(val seq: Long?, val event: AdapterEvent? = null, val host: HostEvent? = null)

object HostStream {
    private val HOST_TYPES = setOf(
        "started", "provider", "accepted", "approval", "approval-decided", "approval-expired", "start-over", "done", "ping", "gap",
    )
    private val ADAPTER_TYPES = setOf("text", "commentary", "thinking", "thinking-done", "tool-start", "tool-end", "error", "notice", "usage")

    /** Null for a blank line, bad JSON or a type this version doesn't know (skipped, like desktop's cleanEvent). */
    fun parse(line: String): HostLine? {
        if (line.isBlank()) return null
        val obj = runCatching { RukooJson.parseToJsonElement(line) as? JsonObject }.getOrNull() ?: return null
        val type = (obj["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        val seq = (obj["seq"] as? JsonPrimitive)?.longOrNull
        return runCatching {
            when (type) {
                in HOST_TYPES -> HostLine(seq, host = RukooJson.decodeFromJsonElement(HostEvent.serializer(), obj))
                in ADAPTER_TYPES -> HostLine(seq, event = RukooJson.decodeFromJsonElement(AdapterEvent.serializer(), obj))
                else -> null
            }
        }.getOrNull()
    }
}
