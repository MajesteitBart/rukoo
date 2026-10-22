package nl.bvdm.rukoo.agents

import android.content.Context
import java.io.File
import kotlinx.coroutines.CoroutineScope
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.desktop.DesktopLink
import okhttp3.OkHttpClient

/** What adapters need from the app. The phone's MCP endpoint for a computer turn comes from the hub ([TurnHandle.mcp]). */
class AdapterDeps(
    val context: Context,
    val settings: AgentSettingsStore,
    val desktop: DesktopLink,
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
