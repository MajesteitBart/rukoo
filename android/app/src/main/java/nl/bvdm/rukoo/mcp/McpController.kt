package nl.bvdm.rukoo.mcp

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The phone's MCP server state. [address] is the Tailscale address it listens on, null while it isn't;
 * [error] a code for why it isn't (`no-tailnet`, `port-in-use`, `disabled`), translated by the UI.
 */
data class McpStatus(
    val running: Boolean = false,
    val address: String? = null,
    val port: Int = 0,
    val error: String? = null,
) {
    /** The endpoint agents use, e.g. `http://100.64.0.3:47800/mcp`. */
    val url: String? get() = if (running && address != null) "http://$address:$port/mcp" else null
}

/** Starts and stops the server that serves Rukoo's tools on this phone (the foreground service does the work). */
interface McpController {
    val status: StateFlow<McpStatus>

    /** Starts serving when "Let agents use Rukoo on this phone" is on; safe to call again. */
    fun start()

    fun stop()
}

/** Until the MCP track lands: never listens. */
class StubMcpController : McpController {
    private val _status = MutableStateFlow(McpStatus(error = "disabled"))
    override val status: StateFlow<McpStatus> = _status.asStateFlow()

    override fun start() = Unit

    override fun stop() = Unit
}
