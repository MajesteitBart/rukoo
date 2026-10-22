package nl.bvdm.rukoo.mcp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.agents.PairedComputer
import nl.bvdm.rukoo.appContainer
import nl.bvdm.rukoo.core.AppLog

/**
 * Debug builds only: sets up phone tools from adb, for testing on the emulator without the settings screen.
 *
 * ```
 * adb shell am broadcast -n nl.bvdm.rukoo.debug/nl.bvdm.rukoo.mcp.DebugMcpReceiver \
 *   --ez enable true --ei port 47801 --es clark_key <test key> --es advertise 100.71.32.55:47801
 * ```
 * Extras, each optional: `enable`, `port`, `advertise` (`host:port`, empty clears it), `clark_key`,
 * `openclaw_token` with `openclaw_remote`, and `computer_id` with `computer_token` (and `computer_name`) for a
 * pretend paired computer whose forwarded calls the server then accepts.
 */
class DebugMcpReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val container = context.appContainer
        val pending = goAsync()
        CoroutineScope(Dispatchers.Default).launch {
            try {
                if (intent.hasExtra("advertise")) McpDebug.setAdvertised(context, intent.getStringExtra("advertise"))
                if (intent.hasExtra("enable") || intent.hasExtra("port")) {
                    container.settings.update { s ->
                        s.copy(
                            mcpEnabled = if (intent.hasExtra("enable")) intent.getBooleanExtra("enable", s.mcpEnabled) else s.mcpEnabled,
                            mcpPort = if (intent.hasExtra("port")) intent.getIntExtra("port", s.mcpPort).coerceIn(1024, 65535) else s.mcpPort,
                        )
                    }
                }
                container.agentSettings.update { a ->
                    var next = a
                    intent.getStringExtra("clark_key")?.let { next = next.copy(clark = next.clark.copy(key = it.trim(), enabled = true)) }
                    intent.getStringExtra("openclaw_token")?.let { next = next.copy(openclaw = next.openclaw.copy(token = it.trim())) }
                    if (intent.hasExtra("openclaw_remote")) next = next.copy(openclaw = next.openclaw.copy(remote = intent.getBooleanExtra("openclaw_remote", false)))
                    val id = intent.getStringExtra("computer_id")
                    val token = intent.getStringExtra("computer_token")
                    if (!id.isNullOrBlank() && !token.isNullOrBlank()) {
                        val name = intent.getStringExtra("computer_name") ?: "test-computer"
                        next = next.copy(computers = next.computers.filterNot { it.pairingId == id } + PairedComputer(id, name, "127.0.0.1", mcpToken = token))
                    }
                    next
                }
                container.mcp.restart()
                AppLog.i("Mcp", "debug settings applied")
            } finally {
                pending.finish()
            }
        }
    }
}
