package nl.bvdm.rukoo.mcp

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The phone's MCP server state. [address] is the Tailscale address it listens on, null while it isn't;
 * [error] a code for why it isn't (`no-tailnet`, `port-in-use`, `disabled`, `failed`), translated by the UI
 * ([McpTexts.status] has the wording). [agents] names who may connect now, for the settings screen.
 */
data class McpStatus(
    val running: Boolean = false,
    val address: String? = null,
    val port: Int = 0,
    val error: String? = null,
    /**
     * Debug builds only: `host:port` other devices reach this phone at instead of its Tailscale address (an
     * emulator behind `adb forward` and a relay). The server treats it as its own address.
     */
    val advertised: String? = null,
    /** The agents that may connect now, by name ("Clark", "OpenClaw", "Claude Code and Codex on desktop-zolder"). */
    val agents: List<String> = emptyList(),
    /** The detail of a `failed` error, for logs and the settings screen; never contains a secret. */
    val detail: String? = null,
) {
    /** The endpoint agents use, e.g. `http://100.64.0.3:47800/mcp`; the computer host sends it as `mcp.url`. */
    val url: String?
        get() = when {
            !running -> null
            advertised != null -> "http://$advertised/mcp"
            address != null -> "http://$address:$port/mcp"
            else -> null
        }

    companion object {
        const val ERROR_DISABLED = "disabled"
        const val ERROR_NO_TAILNET = "no-tailnet"
        const val ERROR_PORT_IN_USE = "port-in-use"
        const val ERROR_FAILED = "failed"
    }
}

/** Starts and stops the server that serves Rukoo's tools on this phone (the foreground service does the work). */
interface McpController {
    val status: StateFlow<McpStatus>

    /** Starts serving when "Let agents use Rukoo on this phone" is on; safe to call again. */
    fun start()

    fun stop()

    /**
     * What "Copy OpenClaw setup" copies: `openclaw mcp set rukoo '{...}'` with this phone's address and the
     * OpenClaw remote token. Null while there is no gateway token or no address to put in it.
     */
    fun openClawSetup(): String? = null

    /** A short note for Clark's setup, in the user's language, with this phone's URL when it has one. */
    fun hermesNote(): String = ""
}

/** Never listens: for previews and tests. */
class StubMcpController : McpController {
    private val _status = MutableStateFlow(McpStatus(error = McpStatus.ERROR_DISABLED))
    override val status: StateFlow<McpStatus> = _status.asStateFlow()

    override fun start() = Unit

    override fun stop() = Unit
}
