package nl.bvdm.rukoo.ui.settings

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.core.Tailnet
import nl.bvdm.rukoo.mcp.McpStatus
import nl.bvdm.rukoo.ui.components.DotTone
import nl.bvdm.rukoo.ui.components.LocalRkToast
import nl.bvdm.rukoo.ui.components.SectionTitle
import nl.bvdm.rukoo.ui.components.SettingsCard
import nl.bvdm.rukoo.ui.components.SettingsRow
import nl.bvdm.rukoo.ui.components.SettingsSwitchRow
import nl.bvdm.rukoo.ui.components.StatusDot
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.root.AppViewModel

/**
 * Phone tools: the MCP server on this phone's Tailscale address that lets agents read the mail here and
 * put drafts on its screen. Who can connect, OpenClaw's setup, and the battery setting Samsung needs.
 */
@Composable
fun PhoneToolsPage(app: AppViewModel) {
    val s = app.services
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val toast = LocalRkToast.current
    val settings by s.settingsSnapshot.collectAsStateWithLifecycle()
    val agentSettings by s.agentSettings.settings.collectAsStateWithLifecycle()
    val status by s.mcp.status.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var tailnet by remember { mutableStateOf<String?>(null) }
    var unrestricted by remember { mutableStateOf(true) }
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            unrestricted = isUnrestricted(context)
            // Tailscale can connect while this page is open.
            while (true) {
                tailnet = withContext(Dispatchers.IO) { Tailnet.ownAddress()?.hostAddress }
                delay(3_000)
            }
        }
    }
    val clark = agentSettings.clark
    val openclaw = agentSettings.openclaw
    val address = status.address ?: tailnet
    val port = if (status.running && status.port > 0) status.port else settings.mcpPort

    SettingsPageBody {
        SettingsIntro(stringResource(R.string.settings_phone_tools_intro))
        Spacer(Modifier.height(12.dp))
        SettingsCard {
            SettingsSwitchRow(
                title = stringResource(R.string.settings_phone_tools_toggle),
                description = stringResource(R.string.settings_phone_tools_toggle_help),
                checked = settings.mcpEnabled,
                onCheckedChange = { on ->
                    scope.launch {
                        s.settings.update { it.copy(mcpEnabled = on) }
                        if (on) s.mcp.start() else s.mcp.stop()
                    }
                },
            )
            if (settings.mcpEnabled) {
                val (label, tone) = serverStatus(status, tailnet)
                StatusLine(label, tone, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), pulsing = tone == DotTone.BUSY)
            }
        }

        SectionTitle(stringResource(R.string.settings_phone_tools_who))
        SettingsCard {
            val clarkName = clark.name.ifBlank { "Hermes" }
            SettingsRow(
                title = stringResource(R.string.settings_phone_tools_clark, clarkName),
                description = stringResource(if (clark.configured && clark.enabled) R.string.settings_phone_tools_clark_help else R.string.settings_phone_tools_clark_off, clarkName),
                leading = { StatusDot(if (settings.mcpEnabled && clark.configured && clark.enabled) DotTone.READY else DotTone.MUTED, size = 8.dp) },
            )
            for (c in agentSettings.computers) {
                SettingsRow(
                    title = stringResource(R.string.settings_phone_tools_computer, c.name),
                    description = stringResource(if (settings.mcpEnabled) R.string.settings_phone_tools_computer_help else R.string.settings_phone_tools_computer_off),
                    leading = { StatusDot(if (settings.mcpEnabled) DotTone.READY else DotTone.MUTED, size = 8.dp) },
                )
            }
            SettingsSwitchRow(
                title = stringResource(R.string.settings_phone_tools_openclaw),
                description = stringResource(if (openclaw.configured) R.string.settings_phone_tools_openclaw_help else R.string.settings_phone_tools_openclaw_needs_token),
                checked = openclaw.remote && openclaw.configured,
                enabled = openclaw.configured,
                onCheckedChange = { on -> scope.launch { s.agentSettings.update { it.copy(openclaw = it.openclaw.copy(remote = on)) } } },
            )
            val needToken = stringResource(R.string.settings_agents_token_first)
            val noAddress = stringResource(R.string.settings_phone_tools_no_tailnet)
            val copyLabel = stringResource(R.string.settings_agents_copy_open_claw)
            SettingsRow(
                title = copyLabel,
                description = stringResource(R.string.settings_phone_tools_copy_open_claw_help),
                leading = { RowIcon(PanelIcons.Copy) },
                enabled = openclaw.configured,
                onClick = {
                    when {
                        !openclaw.configured -> toast.showError(needToken)
                        address == null -> toast.showError(noAddress)
                        else -> {
                            copySensitive(context, copyLabel, OpenClawSetup.command(address, port, openclaw.token))
                            toast.showToast(context.getString(R.string.settings_phone_tools_copied_open_claw, OpenClawSetup.url(address, port)), durationMs = 6000)
                        }
                    }
                },
            )
        }

        SectionTitle(stringResource(R.string.settings_phone_tools_battery))
        SettingsCard {
            SettingsRow(
                title = stringResource(R.string.settings_phone_tools_battery_row),
                description = stringResource(R.string.settings_phone_tools_battery_help),
                value = stringResource(if (unrestricted) R.string.settings_phone_tools_battery_unrestricted else R.string.settings_phone_tools_battery_optimized),
                leading = { RowIcon(PanelIcons.Bolt) },
                onClick = { openBatterySettings(context) },
            )
        }
    }
}

/** What the server is doing, in words and a dot. */
@Composable
private fun serverStatus(status: McpStatus, tailnet: String?): Pair<String, DotTone> = when {
    status.running && status.url != null -> stringResource(R.string.settings_phone_tools_reachable, status.url!!) to DotTone.READY
    status.error == "no-tailnet" || (tailnet == null && !status.running) -> stringResource(R.string.settings_phone_tools_no_tailnet) to DotTone.OFFLINE
    status.error == "port-in-use" -> stringResource(R.string.settings_phone_tools_port_in_use, status.port.takeIf { it > 0 }?.toString() ?: "47800") to DotTone.OFFLINE
    status.error != null && status.error != "disabled" -> stringResource(R.string.settings_phone_tools_failed, status.error!!) to DotTone.OFFLINE
    else -> stringResource(R.string.settings_phone_tools_starting) to DotTone.BUSY
}

private fun isUnrestricted(context: Context): Boolean =
    context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true

/**
 * The app's battery page, where Samsung offers Unrestricted. Android has no public intent for it, so this
 * tries the page Settings itself opens, then the app's info page that links to it.
 */
@SuppressLint("BatteryLife")
private fun openBatterySettings(context: Context) {
    val uri = "package:${context.packageName}".toUri()
    val tries = listOf(
        Intent("android.settings.VIEW_ADVANCED_POWER_USAGE_DETAIL", uri),
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri),
    )
    for (intent in tries) {
        if (runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess) return
    }
}
