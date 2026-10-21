package nl.bvdm.rukoo.agents

import android.content.Context
import java.io.File
import kotlinx.coroutines.CoroutineScope
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.desktop.DesktopLink
import nl.bvdm.rukoo.mcp.McpController
import okhttp3.OkHttpClient

/** What adapters need from the app. */
class AdapterDeps(
    val context: Context,
    val settings: AgentSettingsStore,
    val desktop: DesktopLink,
    /** The phone's own MCP endpoint for computer turns (`status.value.url`). */
    val mcp: McpController,
    val http: OkHttpClient,
    val clock: Clock,
    val filesDir: File,
    val scope: CoroutineScope,
)

/** The hub creates adapters through this, so it doesn't depend on any one agent's client. */
fun interface AdapterFactory {
    /** The adapter for an agent id (`clark`, `openclaw`, `computer:<pairingId>:claude|codex`, `fake`), or null when unknown. */
    fun create(agentId: String): AgentAdapter?
}
