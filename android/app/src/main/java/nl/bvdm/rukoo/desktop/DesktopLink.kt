package nl.bvdm.rukoo.desktop

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.map
import nl.bvdm.rukoo.agents.AgentSettingsStore
import nl.bvdm.rukoo.agents.PairedComputer
import nl.bvdm.rukoo.agents.model.HostLine
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.OwnSkills

/**
 * A failure talking to a paired computer. [code] is the route's `error` (`wrong-code`, `expired`,
 * `rate-limited`, `export-closed`, `unauthorized`, `busy`) or one of [DesktopErrors]' own codes, such as
 * `offline` when it couldn't be reached. [retryAfterSeconds] comes from a 429's Retry-After.
 */
class DesktopException(
    val code: String,
    val detail: String = "",
    val status: Int = 0,
    val retryAfterSeconds: Int? = null,
) : Exception("$code: $detail")

/** Error codes of [DesktopException]: the desktop's own, and the ones this client adds. */
object DesktopErrors {
    // From the computer (phonehost.js).
    const val WRONG_CODE = "wrong-code"
    const val EXPIRED = "expired"
    const val FULL = "full"
    const val RATE_LIMITED = "rate-limited"
    const val EXPORT_CLOSED = "export-closed"
    const val UNAUTHORIZED = "unauthorized"
    const val BUSY = "busy"
    const val INVALID = "invalid"
    const val DISABLED = "disabled"
    const val TOO_LARGE = "too-large"
    /** An unknown turn, approval or start-over request (`not-found`, with a dash). */
    const val NOT_FOUND = "not-found"
    const val UNKNOWN = "unknown"

    // Added here.
    /** No answer: Rukoo is closed, Tailscale is off, or the address is wrong. */
    const val OFFLINE = "offline"
    /**
     * The computer answered `404 {"error":"not found"}`: phones aren't allowed there (the switch is off, or the
     * request didn't come over Tailscale), which the desktop deliberately doesn't tell apart from a wrong path.
     */
    const val NOT_ENABLED = "not-enabled"
    /** The answer wasn't what the contract says. */
    const val PROTOCOL = "protocol"
    const val INVALID_ADDRESS = "invalid-address"
    const val INVALID_CODE = "invalid-code"
    /** No pairing with that id on this phone. */
    const val UNKNOWN_COMPUTER = "unknown-computer"
}

/**
 * The phone's client for desktop Rukoo on a paired computer (spec 3 §7): pairing, the account export,
 * and the computer-host routes that run Claude Code and Codex turns for the phone. Throws [DesktopException].
 */
interface DesktopLink {
    /** Paired computers, from AgentSettings. */
    val computers: Flow<List<PairedComputer>>

    /**
     * Pairs with the computer at [address] (`100.x.y.z`, a MagicDNS name, or `host:port`) using the code
     * shown in its Settings, stores the pairing with a fresh MCP token for that computer, and returns it.
     */
    suspend fun pair(address: String, code: String): PairedComputer

    suspend fun hello(pairingId: String): HelloResponse

    /** The one-shot export: accounts, Google client, agent settings. Fails with `export-closed` outside the window. */
    suspend fun export(pairingId: String): ExportBundle

    /** Unpairs on the computer (best effort) and removes the pairing here. */
    suspend fun forget(pairingId: String)

    suspend fun models(pairingId: String, agent: String, refresh: Boolean = false): ModelOptions

    suspend fun skills(pairingId: String, agent: String, refresh: Boolean = false): OwnSkills

    /** Starts a turn and streams its NDJSON lines until `done`; cancelling the collector closes the stream. */
    fun startTurn(pairingId: String, request: HostTurnRequest): Flow<HostLine>

    /** Reattaches to a running turn after a dropped stream, from the line after [afterSeq]. */
    fun reattach(pairingId: String, turnId: String, afterSeq: Long): Flow<HostLine>

    suspend fun answerApproval(pairingId: String, turnId: String, approvalId: String, choice: String)

    suspend fun stopTurn(pairingId: String, turnId: String)

    suspend fun startOver(pairingId: String, turnId: String, requestId: String, input: String)

    /** The phone dropped this chat: the computer forgets its session. */
    suspend fun forgetConversation(pairingId: String, agent: String, conversationId: String)
}

/** Until the desktop track lands: lists stored pairings and refuses everything else as offline. */
class StubDesktopLink(private val store: AgentSettingsStore) : DesktopLink {
    override val computers: Flow<List<PairedComputer>> = store.settings.map { it.computers }

    private fun offline(): Nothing = throw DesktopException("offline", "not implemented yet")

    override suspend fun pair(address: String, code: String): PairedComputer = offline()

    override suspend fun hello(pairingId: String): HelloResponse = offline()

    override suspend fun export(pairingId: String): ExportBundle = offline()

    override suspend fun forget(pairingId: String) {
        store.update { s -> s.copy(computers = s.computers.filterNot { it.pairingId == pairingId }) }
    }

    override suspend fun models(pairingId: String, agent: String, refresh: Boolean): ModelOptions = offline()

    override suspend fun skills(pairingId: String, agent: String, refresh: Boolean): OwnSkills = offline()

    override fun startTurn(pairingId: String, request: HostTurnRequest): Flow<HostLine> = emptyFlow()

    override fun reattach(pairingId: String, turnId: String, afterSeq: Long): Flow<HostLine> = emptyFlow()

    override suspend fun answerApproval(pairingId: String, turnId: String, approvalId: String, choice: String) = offline()

    override suspend fun stopTurn(pairingId: String, turnId: String) = Unit

    override suspend fun startOver(pairingId: String, turnId: String, requestId: String, input: String) = offline()

    override suspend fun forgetConversation(pairingId: String, agent: String, conversationId: String) = Unit
}
