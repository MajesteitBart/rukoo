package nl.bvdm.rukoo.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.desktop.ImportResult
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkTextField
import nl.bvdm.rukoo.ui.components.Spinner
import nl.bvdm.rukoo.ui.settings.SetupModel.PairStep
import nl.bvdm.rukoo.ui.theme.Rk

/**
 * Pairing with Rukoo on a computer, then the offer to bring its accounts and agents over (spec 3 §7.3,
 * §7.10). The steps live in [SetupModel], so the flow survives the setup screen closing when the first
 * account arrives. [onDone] leaves the flow; [onAddAccount] offers the account setup when nothing came over.
 */
@Composable
fun PairComputerFlow(model: SetupModel, onDone: () -> Unit, modifier: Modifier = Modifier, onAddAccount: (() -> Unit)? = null) {
    val ui by model.pair.collectAsStateWithLifecycle()
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        when (ui.step) {
            PairStep.FORM, PairStep.PAIRING -> PairForm(model, ui)
            PairStep.PAIRED, PairStep.CHECKING -> ImportOffer(model, ui, onDone)
            PairStep.IMPORTING -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Spinner(size = 14.dp)
                Text(stringResource(R.string.settings_import_running), style = Rk.type.text13, color = Rk.colors.text2)
            }
            PairStep.DONE -> {
                ui.result?.let { ImportSummary(it, ui.computer?.name.orEmpty()) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                    if (onAddAccount != null && ui.result?.added.isNullOrEmpty()) {
                        RkButton(stringResource(R.string.settings_accounts_add), onAddAccount, kind = RkButtonKind.SECONDARY)
                    }
                    RkButton(stringResource(R.string.settings_done), onDone, kind = RkButtonKind.PRIMARY)
                }
            }
        }
    }
}

@Composable
private fun PairForm(model: SetupModel, ui: SetupModel.PairUi) {
    var address by rememberDraft(model, SetupModel.DRAFT_PAIR + "address") { ui.address }
    // The code is a short-lived secret: a draft in memory, never in the saved state.
    var code by rememberDraft(model, SetupModel.DRAFT_PAIR + "code") { "" }
    val pairing = ui.step == PairStep.PAIRING
    val submit = { if (address.isNotBlank() && code.isNotBlank()) model.pair(address, code) }
    NoteBox(stringResource(R.string.settings_pair_steps))
    RkTextField(
        value = address,
        onValueChange = { address = it },
        label = stringResource(R.string.settings_pair_address),
        placeholder = stringResource(R.string.settings_pair_address_placeholder),
        help = stringResource(R.string.settings_pair_address_help),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
        enabled = !pairing,
    )
    RkTextField(
        value = code,
        onValueChange = { code = it.uppercase().take(12) },
        label = stringResource(R.string.settings_pair_code),
        placeholder = stringResource(R.string.settings_pair_code_placeholder),
        mono = true,
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.Characters,
            keyboardType = KeyboardType.Ascii,
            imeAction = ImeAction.Done,
            autoCorrectEnabled = false,
        ),
        keyboardActions = KeyboardActions(onDone = { submit() }),
        enabled = !pairing,
    )
    ui.error?.let { ErrorLine(errorText(it, address = address.trim())) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
        if (pairing) Spinner(size = 14.dp)
        RkButton(
            label = stringResource(if (pairing) R.string.settings_pair_pending else R.string.settings_pair_action),
            onClick = submit,
            kind = RkButtonKind.PRIMARY,
            enabled = !pairing && address.isNotBlank() && code.isNotBlank(),
        )
    }
}

@Composable
private fun ImportOffer(model: SetupModel, ui: SetupModel.PairUi, onDone: () -> Unit) {
    val name = ui.computer?.name.orEmpty()
    val checking = ui.step == PairStep.CHECKING
    NoteBox(stringResource(R.string.settings_pair_paired, name), tone = NoteTone.OK)
    if (ui.exportOpen) {
        Text(stringResource(R.string.settings_import_offer, name), style = Rk.type.text13, color = Rk.colors.text2)
    } else {
        Text(stringResource(R.string.settings_import_closed, name), style = Rk.type.text13, color = Rk.colors.text2)
    }
    ui.error?.let { ErrorLine(errorText(it, address = ui.computer?.address, name = name)) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
        if (checking) Spinner(size = 14.dp)
        if (ui.exportOpen) {
            RkButton(stringResource(R.string.settings_import_not_now), onDone, kind = RkButtonKind.SECONDARY)
            RkButton(stringResource(R.string.settings_import_action), model::importFrom, kind = RkButtonKind.PRIMARY, enabled = !checking)
        } else {
            RkButton(stringResource(R.string.settings_done), onDone, kind = RkButtonKind.SECONDARY)
            RkButton(stringResource(R.string.settings_import_check), model::checkExport, kind = RkButtonKind.PRIMARY, enabled = !checking)
        }
    }
}

/** What came over, as short lines in the past tense. */
@Composable
fun ImportSummary(result: ImportResult, computer: String) {
    val lines = importLines(result, computer)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        NoteBox(lines.first(), tone = if (result.accountError != null) NoteTone.WARN else NoteTone.OK)
        for (line in lines.drop(1)) Text(line, style = Rk.type.text13, color = Rk.colors.text2)
        result.accountError?.let { ErrorLine(errorText(it)) }
    }
}

/** The summary of an import: what was added first, then what stayed behind and why. */
@Composable
fun importLines(result: ImportResult, computer: String): List<String> {
    val lines = mutableListOf<String>()
    val added = result.added.size
    lines += when {
        added > 0 -> pluralStringResource(R.plurals.settings_import_accounts_added, added, added)
        // The error itself follows the lines; this says what it means.
        result.accountError != null -> stringResource(R.string.settings_import_accounts_failed)
        result.alreadyHere > 0 -> stringResource(R.string.settings_import_accounts_here)
        else -> stringResource(R.string.settings_import_no_accounts, computer)
    }
    val agents = listOfNotNull(
        stringResource(R.string.settings_import_agent_clark).takeIf { result.clark },
        stringResource(R.string.settings_import_agent_openclaw).takeIf { result.openclaw },
    )
    if (agents.isNotEmpty()) lines += stringResource(R.string.settings_import_agents, agents.joinToString(stringResource(R.string.settings_list_and)))
    if (result.googleClient) lines += stringResource(R.string.settings_setup_google_ready)
    if (result.skipped.isNotEmpty()) {
        lines += pluralStringResource(
            R.plurals.settings_import_skipped,
            result.skipped.size,
            result.skipped.joinToString(", ") { it.email },
            computer,
        )
    }
    if (result.localOnly.isNotEmpty()) {
        lines += pluralStringResource(
            R.plurals.settings_import_local_only,
            result.localOnly.size,
            result.localOnly.joinToString(stringResource(R.string.settings_list_and)),
            computer,
        )
    }
    return lines
}
