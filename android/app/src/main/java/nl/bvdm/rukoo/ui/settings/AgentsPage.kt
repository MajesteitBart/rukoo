package nl.bvdm.rukoo.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.AgentSettings
import nl.bvdm.rukoo.agents.PairedComputer
import nl.bvdm.rukoo.agents.model.AgentDescriptor
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.ComputerProgram
import nl.bvdm.rukoo.desktop.DesktopErrors
import nl.bvdm.rukoo.desktop.DesktopException
import nl.bvdm.rukoo.desktop.HostAgentInfo
import nl.bvdm.rukoo.ui.components.LocalRkToast
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkTextField
import nl.bvdm.rukoo.ui.components.SectionTitle
import nl.bvdm.rukoo.ui.components.SettingsCard
import nl.bvdm.rukoo.ui.components.SettingsChevron
import nl.bvdm.rukoo.ui.components.SettingsRow
import nl.bvdm.rukoo.ui.components.SettingsSwitchRow
import nl.bvdm.rukoo.ui.components.SheetDivider
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.components.Spinner
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.agent.AgentText
import nl.bvdm.rukoo.ui.agent.text
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.theme.Rk

/**
 * Agents (settings.js agentsHtml, adapted): the default agent and mail actions, a card each for Clark and
 * OpenClaw with their form, status and connection test, and the computers that run Claude Code and Codex.
 */
@Composable
fun AgentsPage(app: AppViewModel, model: SetupModel, nav: SettingsNav) {
    val s = app.services
    val stored by s.agentSettings.settings.collectAsStateWithLifecycle()
    val agents by s.agents.agents.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var defaultSheet by remember { mutableStateOf(false) }
    val computers = stored.computers.associate { it.pairingId to it.name }

    SettingsPageBody {
        SettingsIntro(stringResource(R.string.settings_agents_help))
        SectionTitle(stringResource(R.string.settings_groups_general))
        SettingsCard {
            val default = agents.firstOrNull { it.id == stored.defaultAgent }
            SettingsRow(
                title = stringResource(R.string.settings_agents_default),
                value = default?.let { agentLabel(it, computers) } ?: stringResource(R.string.settings_agents_default_none),
                onClick = { defaultSheet = true },
            )
            SettingsRow(
                title = stringResource(R.string.settings_agents_shortcuts),
                description = stringResource(R.string.settings_agents_shortcuts_help),
                trailing = { SettingsChevron() },
                onClick = { nav.push(SettingsRoutes.SHORTCUTS) },
            )
            SettingsSwitchRow(
                title = stringResource(R.string.settings_agents_auto_mail),
                description = stringResource(R.string.settings_agents_auto_mail_help),
                checked = stored.autoMailActions,
                onCheckedChange = { on -> scope.launch { s.agentSettings.update { it.copy(autoMailActions = on) } } },
            )
        }
        ClarkCard(app, model, stored, agents.firstOrNull { it.id == AgentIds.CLARK })
        OpenClawCard(app, model, stored, agents.firstOrNull { it.id == AgentIds.OPENCLAW })
        ComputersCard(model, stored.computers, agents, nav)
    }

    if (defaultSheet) {
        ChoiceSheet(
            title = stringResource(R.string.settings_agents_default),
            choices = agents.filter { it.enabled }.map { Choice(it.id, agentLabel(it, computers), stringResource(agentStateLabel(it.status.state))) },
            selected = stored.defaultAgent,
            onSelect = { id -> scope.launch { s.agentSettings.update { it.copy(defaultAgent = id) } } },
            onDismiss = { defaultSheet = false },
        )
    }
}

/** "Claude Code on office-pc" in the interface language, or just the name for agents the phone reaches itself. */
@Composable
private fun agentLabel(agent: AgentDescriptor, computers: Map<String, String>): String {
    val where = AgentText.place(agent, computers)?.text() ?: return agent.name
    return "${agent.name} $where"
}

/** The status row of an agent card: the test result while there is one, else the hub's status. */
@Composable
private fun AgentStatusRow(status: AgentStatus?, testing: Boolean) {
    val shown = if (testing) AgentStatus(AgentState.CHECKING) else status ?: AgentStatus(AgentState.CHECKING)
    val label = if (testing) stringResource(R.string.settings_agents_testing) else stringResource(agentStateLabel(shown.state))
    StatusLine(
        label = label,
        tone = agentStateTone(shown.state),
        detail = shown.detail.takeIf { shown.state != AgentState.READY },
        pulsing = testing,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
    )
}

@Composable
private fun ClarkCard(app: AppViewModel, setup: SetupModel, stored: AgentSettings, descriptor: AgentDescriptor?) {
    val s = app.services
    val scope = rememberCoroutineScope()
    val toast = LocalRkToast.current
    val clark = stored.clark
    // Edits are drafts in the model, so folding keeps them. One base for the whole card: when what is stored
    // changes (an import), a key typed for another server goes too. The "Use" switch isn't a form field, so
    // flipping it keeps the edits. The key stays in memory only, masked until the user taps the eye.
    val k = SetupModel.DRAFT_AGENT + "clark:"
    val base = clark.copy(enabled = true)
    remember(base) { setup.rebaseDrafts(k, base) }
    var name by rememberDraft(setup, k + "name", base) { clark.name }
    var url by rememberDraft(setup, k + "url", base) { clark.url }
    var model by rememberDraft(setup, k + "model", base) { clark.model }
    var key by rememberDraft(setup, k + "key", base) { clark.key }
    var badUrl by remember { mutableStateOf(false) }
    var testing by remember { mutableStateOf(false) }
    var tested by remember { mutableStateOf<AgentStatus?>(null) }
    val dirty = name != clark.name || url != clark.url || key != clark.key || model != clark.model
    val saved = stringResource(R.string.settings_agents_saved)

    suspend fun save(): Boolean {
        if (!AgentUrls.isValid(url)) {
            badUrl = true
            return false
        }
        badUrl = false
        val next = s.agentSettings.update {
            it.copy(clark = it.clark.copy(name = name.trim().ifBlank { "Hermes" }, url = AgentUrls.normalize(url), key = key.trim(), model = model.trim()))
        }.clark
        // The fields show what was saved, normalized; the drafts' base stays, so later edits survive a fold.
        name = next.name
        url = next.url
        key = next.key
        model = next.model
        tested = null
        return true
    }

    AgentGroupTitle(clark.name.ifBlank { "Hermes" }, stringResource(R.string.settings_agents_product_hermes))
    SettingsCard {
        AgentStatusRow(tested ?: descriptor?.status, testing)
        SettingsSwitchRow(
            title = stringResource(R.string.settings_agents_enabled, clark.name.ifBlank { "Hermes" }),
            checked = clark.enabled,
            onCheckedChange = { on -> scope.launch { s.agentSettings.update { it.copy(clark = it.clark.copy(enabled = on)) } } },
        )
        AgentForm {
            RkTextField(name, { name = it }, label = stringResource(R.string.settings_agents_name), placeholder = "Hermes")
            RkTextField(
                url,
                {
                    url = it
                    badUrl = false
                },
                label = stringResource(R.string.settings_agents_url),
                placeholder = "http://100.64.0.1:8642",
                error = if (badUrl) stringResource(R.string.settings_agents_bad_url) else null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
            )
            if (AgentUrls.isInsecureRemote(url)) NoteBox(stringResource(R.string.settings_agents_insecure_url), tone = NoteTone.WARN)
            RkTextField(
                key,
                { key = it },
                label = stringResource(R.string.settings_agents_key),
                placeholder = stringResource(R.string.settings_agents_key_placeholder),
                password = true,
                showPasswordLabel = stringResource(R.string.settings_agents_key_show),
                hidePasswordLabel = stringResource(R.string.settings_agents_key_hide),
                help = if (clark.key.isNotEmpty() && key == clark.key) stringResource(R.string.settings_agents_key_stored) else null,
            )
            RkTextField(model, { model = it }, label = stringResource(R.string.settings_agents_model), placeholder = stringResource(R.string.settings_agents_optional))
            FormButtons(
                testing = testing,
                dirty = dirty,
                onSave = { scope.launch { if (save()) toast.showToast(saved) } },
                onTest = {
                    scope.launch {
                        if (dirty && !save()) return@launch
                        testing = true
                        tested = runCatching { s.agents.test(AgentIds.CLARK) }.getOrElse { AgentStatus(AgentState.UNKNOWN, it.message.orEmpty()) }
                        testing = false
                    }
                },
            )
        }
    }
}

@Composable
private fun OpenClawCard(app: AppViewModel, setup: SetupModel, stored: AgentSettings, descriptor: AgentDescriptor?) {
    val s = app.services
    val scope = rememberCoroutineScope()
    val toast = LocalRkToast.current
    val o = stored.openclaw
    val k = SetupModel.DRAFT_AGENT + "openclaw:"
    // The "Use" and phone-tools switches aren't form fields: flipping them keeps the edits.
    val base = o.copy(enabled = true, remote = false)
    remember(base) { setup.rebaseDrafts(k, base) }
    var url by rememberDraft(setup, k + "url", base) { o.url }
    var agentId by rememberDraft(setup, k + "agent", base) { o.agentId }
    var model by rememberDraft(setup, k + "model", base) { o.model }
    var token by rememberDraft(setup, k + "token", base) { o.token }
    var badUrl by remember { mutableStateOf(false) }
    var badAgent by remember { mutableStateOf(false) }
    var testing by remember { mutableStateOf(false) }
    var tested by remember { mutableStateOf<AgentStatus?>(null) }
    val dirty = url != o.url || token != o.token || agentId != o.agentId || model != o.model
    val saved = stringResource(R.string.settings_agents_saved)

    suspend fun save(): Boolean {
        badUrl = !AgentUrls.isValid(url)
        badAgent = !AgentUrls.isValidOpenClawAgent(agentId.trim())
        if (badUrl || badAgent) return false
        val next = s.agentSettings.update {
            it.copy(openclaw = it.openclaw.copy(url = AgentUrls.normalize(url), token = token.trim(), agentId = agentId.trim(), model = model.trim()))
        }.openclaw
        url = next.url
        token = next.token
        agentId = next.agentId
        model = next.model
        tested = null
        return true
    }

    AgentGroupTitle("OpenClaw", null)
    SettingsCard {
        AgentStatusRow(tested ?: descriptor?.status, testing)
        SettingsSwitchRow(
            title = stringResource(R.string.settings_agents_enabled, "OpenClaw"),
            checked = o.enabled,
            onCheckedChange = { on -> scope.launch { s.agentSettings.update { it.copy(openclaw = it.openclaw.copy(enabled = on)) } } },
        )
        AgentForm {
            RkTextField(
                url,
                {
                    url = it
                    badUrl = false
                },
                label = stringResource(R.string.settings_agents_gateway_url),
                placeholder = "http://100.64.0.2:18789",
                error = if (badUrl) stringResource(R.string.settings_agents_bad_url) else null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
            )
            if (AgentUrls.isInsecureRemote(url)) NoteBox(stringResource(R.string.settings_agents_insecure_url_token), tone = NoteTone.WARN)
            RkTextField(
                token,
                { token = it },
                label = stringResource(R.string.settings_agents_token),
                placeholder = stringResource(R.string.settings_agents_token_placeholder),
                password = true,
                showPasswordLabel = stringResource(R.string.settings_agents_token_show),
                hidePasswordLabel = stringResource(R.string.settings_agents_token_hide),
                help = if (o.token.isNotEmpty() && token == o.token) stringResource(R.string.settings_agents_token_stored) else null,
            )
            RkTextField(
                agentId,
                {
                    agentId = it
                    badAgent = false
                },
                label = stringResource(R.string.settings_agents_openclaw_agent),
                placeholder = stringResource(R.string.settings_agents_openclaw_agent_hint),
                error = if (badAgent) stringResource(R.string.settings_agents_bad_agent) else null,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
            )
            RkTextField(model, { model = it }, label = stringResource(R.string.settings_agents_model), placeholder = stringResource(R.string.settings_agents_model_hint, "openai/gpt-5.4"))
            FormButtons(
                testing = testing,
                dirty = dirty,
                onSave = { scope.launch { if (save()) toast.showToast(saved) } },
                onTest = {
                    scope.launch {
                        if (dirty && !save()) return@launch
                        testing = true
                        tested = runCatching { s.agents.test(AgentIds.OPENCLAW) }.getOrElse { AgentStatus(AgentState.UNKNOWN, it.message.orEmpty()) }
                        testing = false
                    }
                },
            )
        }
    }
}

@Composable
private fun AgentForm(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) { content() }
}

@Composable
private fun FormButtons(testing: Boolean, dirty: Boolean, onSave: () -> Unit, onTest: () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
        if (testing) Spinner(size = 14.dp)
        RkButton(stringResource(R.string.settings_agents_test_connection), onTest, kind = RkButtonKind.SECONDARY, enabled = !testing)
        // Filled only while this card has edits: the page holds two cards and one filled button.
        RkButton(stringResource(R.string.common_actions_save), onSave, kind = if (dirty) RkButtonKind.PRIMARY else RkButtonKind.DEFAULT, enabled = dirty && !testing)
    }
}

/** The paired computers, with their Claude Code and Codex status from the hub, and pairing another. */
@Composable
private fun ComputersCard(model: SetupModel, computers: List<PairedComputer>, agents: List<AgentDescriptor>, nav: SettingsNav) {
    val hellos by model.hellos.collectAsStateWithLifecycle()
    val testing by model.testingComputers.collectAsStateWithLifecycle()
    var open by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(computers.map { it.pairingId }) { computers.forEach { model.refreshHello(it.pairingId) } }
    val locale = currentLocale()

    AgentGroupTitle(stringResource(R.string.settings_computers_title), stringResource(R.string.settings_computers_product))
    SettingsCard {
        if (computers.isEmpty()) {
            SettingsRow(title = stringResource(R.string.settings_computers_empty), description = stringResource(R.string.settings_computers_empty_help), enabled = true)
        }
        for (c in computers) {
            val state = hellos[c.pairingId]
            val claude = agents.firstOrNull { it.id == AgentIds.computer(c.pairingId, ComputerProgram.CLAUDE) }
            val codex = agents.firstOrNull { it.id == AgentIds.computer(c.pairingId, ComputerProgram.CODEX) }
            val seen = c.lastSeenAt?.let { stringResource(R.string.settings_computers_last_seen, formatDate(it, locale), formatTime(it, locale)) }
                ?: stringResource(R.string.settings_computers_never_seen)
            SettingsRow(
                title = c.name,
                description = listOfNotNull(computerStatus(state, claude, codex, c.pairingId in testing), seen).joinToString("\n"),
                leading = { RowIcon(PanelIcons.Terminal) },
                onClick = { open = c.pairingId },
            )
        }
        SettingsRow(
            title = stringResource(R.string.settings_computers_pair),
            description = stringResource(R.string.settings_computers_pair_help),
            leading = { AddIcon() },
            onClick = {
                model.resetPair()
                nav.push(SettingsRoutes.PAIR)
            },
        )
    }

    computers.firstOrNull { it.pairingId == open }?.let { c ->
        ComputerSheet(model, c, hellos[c.pairingId], nav, onDismiss = { open = null })
    }
}

/**
 * "Claude Code: Ready · Codex: Not installed" as the hub knows them, "Testing..." while Check runs, or why the
 * computer itself turned the phone away (removed there, phones off), which goes for both of its agents.
 */
@Composable
private fun computerStatus(state: SetupModel.HelloUi?, claude: AgentDescriptor?, codex: AgentDescriptor?, testing: Boolean): String? {
    val hello = state?.hello
    val error = state?.error
    val refused = when ((error as? DesktopException)?.code) {
        DesktopErrors.UNAUTHORIZED -> stringResource(R.string.settings_computers_removed_there)
        DesktopErrors.NOT_ENABLED -> stringResource(R.string.settings_computers_off_there)
        else -> null
    }
    return when {
        refused != null -> refused
        testing -> stringResource(R.string.settings_agents_testing)
        claude != null && codex != null -> "Claude Code: ${stringResource(agentStateLabel(claude.status.state))} · Codex: ${stringResource(agentStateLabel(codex.status.state))}"
        hello != null -> "Claude Code: ${hostAgentLabel(hello.agents["claude"])} · Codex: ${hostAgentLabel(hello.agents["codex"])}"
        error != null -> stringResource(if ((error as? DesktopException)?.code == DesktopErrors.OFFLINE) R.string.settings_agent_status_offline else R.string.settings_agent_status_unknown)
        state?.loading == true -> stringResource(R.string.settings_server_checking)
        else -> null
    }
}

@Composable
private fun hostAgentLabel(info: HostAgentInfo?): String = when {
    info == null -> stringResource(R.string.settings_agent_status_unknown)
    !info.enabled -> stringResource(R.string.settings_agent_status_disabled)
    else -> stringResource(agentStateLabel(hostState(info.state)))
}

@Composable
private fun ComputerSheet(model: SetupModel, c: PairedComputer, state: SetupModel.HelloUi?, nav: SettingsNav, onDismiss: () -> Unit) {
    var confirm by remember { mutableStateOf(false) }
    val toast = LocalRkToast.current
    val forgotten = stringResource(R.string.settings_computers_forgotten, c.name)
    val open = state?.hello?.exportUntil != null || (state?.hello == null && c.exportUntil != null)
    RkBottomSheet(onDismissRequest = onDismiss, title = c.name) {
        SheetRow(
            label = stringResource(R.string.settings_import_from_computer),
            hint = if (open) stringResource(R.string.settings_computers_export_open) else stringResource(R.string.settings_computers_export_again, c.name),
            icon = RukooIcons.Download,
            onClick = {
                model.offerImport(c)
                nav.push(SettingsRoutes.IMPORT)
                dismiss()
            },
        )
        SheetRow(
            label = stringResource(R.string.settings_computers_check),
            hint = "http://${c.address}:${c.port}" + if (c.version.isNotBlank()) " · Rukoo ${c.version}" else "",
            icon = RukooIcons.Sync,
            onClick = {
                model.testComputer(c.pairingId)
                dismiss()
            },
        )
        SheetDivider()
        SheetRow(label = stringResource(R.string.settings_computers_forget), icon = RukooIcons.Trash, danger = true, onClick = { confirm = true })
    }
    if (confirm) {
        RkDialog(
            title = stringResource(R.string.settings_computers_forget_title, c.name),
            text = stringResource(R.string.settings_computers_forget_help, c.name),
            confirmLabel = stringResource(R.string.settings_computers_forget_ok),
            danger = true,
            onDismiss = { confirm = false },
            onConfirm = {
                confirm = false
                onDismiss()
                model.forget(c.pairingId) { toast.showToast(forgotten) }
            },
        )
    }
}
