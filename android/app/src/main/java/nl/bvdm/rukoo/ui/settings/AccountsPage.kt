package nl.bvdm.rukoo.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import nl.bvdm.rukoo.ui.components.RkLinkButton
import nl.bvdm.rukoo.ui.components.Spinner
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.AuthKind
import nl.bvdm.rukoo.ui.components.AccountAvatar
import nl.bvdm.rukoo.ui.components.LocalRkToast
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.SectionTitle
import nl.bvdm.rukoo.ui.components.SettingsCard
import nl.bvdm.rukoo.ui.components.SettingsRow
import nl.bvdm.rukoo.ui.components.SheetDivider
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.theme.AccountColors
import nl.bvdm.rukoo.ui.theme.Rk

/** The sync choices desktop offers (settings.sync.*), in minutes; 0 is manual. */
private val SYNC_CHOICES = listOf(0, 1, 5, 15, 30, 60)

@Composable
fun syncLabel(minutes: Int): String = when (minutes) {
    0 -> stringResource(R.string.settings_sync_manual)
    1 -> stringResource(R.string.settings_sync_minute)
    5 -> stringResource(R.string.settings_sync_five_minutes)
    15 -> stringResource(R.string.settings_sync_fifteen_minutes)
    30 -> stringResource(R.string.settings_sync_thirty_minutes)
    60 -> stringResource(R.string.settings_sync_hour)
    else -> pluralStringResource(R.plurals.settings_sync_every, minutes, minutes)
}

/** Accounts: each account with its color and last sync, add account, and the sync schedule. */
@Composable
fun AccountsPage(app: AppViewModel, model: SetupModel, nav: SettingsNav) {
    val s = app.services
    val accounts by s.mail.accounts.collectAsStateWithLifecycle()
    val sync by s.mail.sync.collectAsStateWithLifecycle()
    val settings by s.settingsSnapshot.collectAsStateWithLifecycle()
    val computers by s.agentSettings.settings.collectAsStateWithLifecycle()
    val add by model.add.collectAsStateWithLifecycle()
    // Outlives the sheets on this page, which close as soon as a choice is made.
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf<String?>(null) }
    var syncSheet by remember { mutableStateOf(false) }
    val locale = currentLocale()
    val defaultId = settings.defaultAccountId?.takeIf { id -> accounts.any { it.id == id } } ?: accounts.firstOrNull()?.id

    SettingsPageBody {
        // Signing an account in to Google again starts from its menu; its progress and failure show here.
        if (add.working == SetupModel.AddKind.GOOGLE) {
            Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Spinner(size = 14.dp)
                Text(stringResource(R.string.settings_setup_google_wait), style = Rk.type.text13, color = Rk.colors.text2, modifier = Modifier.weight(1f))
                RkLinkButton(stringResource(R.string.common_actions_cancel), model::cancelAdd)
            }
        } else {
            add.error?.let { ErrorLine(errorText(it), Modifier.padding(top = 10.dp)) }
        }
        Spacer(Modifier.height(12.dp))
        SettingsCard {
            for (account in accounts) {
                val title = account.label.ifBlank { account.email } + if (account.id == defaultId) stringResource(R.string.settings_account_default_suffix) else ""
                val last = sync.lastSync[account.id]
                val description = when {
                    account.id in sync.running -> stringResource(R.string.settings_account_syncing)
                    sync.errors[account.id] != null -> sync.errors[account.id]
                    last != null -> stringResource(R.string.settings_account_last_sync, formatDate(last, locale), formatTime(last, locale))
                    else -> null
                }
                SettingsRow(
                    title = title,
                    description = description,
                    leading = { AccountAvatar(account.label.ifBlank { account.email }, AccountColors.parse(account.color)) },
                    onClick = { open = account.id },
                )
            }
            SettingsRow(
                title = stringResource(R.string.settings_accounts_add),
                leading = { AddIcon() },
                onClick = { nav.push(SettingsRoutes.ADD_ACCOUNT) },
            )
        }
        if (computers.computers.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            SettingsCard {
                SettingsRow(
                    title = stringResource(R.string.settings_import_from_computer),
                    description = stringResource(R.string.settings_import_from_computer_help),
                    leading = { RowIcon(RukooIcons.Download) },
                    onClick = { pairOrImport(app, model, nav) },
                )
            }
        }
        SectionTitle(stringResource(R.string.settings_general_sync))
        SettingsCard {
            SettingsRow(
                title = stringResource(R.string.settings_general_sync),
                description = stringResource(R.string.settings_sync_help),
                value = syncLabel(settings.syncMinutes),
                onClick = { syncSheet = true },
            )
        }
    }

    accounts.firstOrNull { it.id == open }?.let { account ->
        AccountSheet(model, account, isDefault = account.id == defaultId, onDismiss = { open = null })
    }
    if (syncSheet) {
        ChoiceSheet(
            title = stringResource(R.string.settings_general_sync),
            choices = SYNC_CHOICES.map { Choice(it, syncLabel(it)) },
            selected = settings.syncMinutes,
            onSelect = { minutes -> scope.launch { s.settings.update { it.copy(syncMinutes = minutes) } } },
            onDismiss = { syncSheet = false },
        )
    }
}

/** An account's menu: make it the default, sync it, sign in to Google again, or remove it. */
@Composable
private fun AccountSheet(model: SetupModel, account: Account, isDefault: Boolean, onDismiss: () -> Unit) {
    val toast = LocalRkToast.current
    val context = LocalContext.current
    var confirm by remember { mutableStateOf(false) }
    val removed = stringResource(R.string.settings_account_removed)
    val res = context.resources
    RkBottomSheet(onDismissRequest = onDismiss, title = account.email) {
        if (!isDefault) {
            SheetRow(
                label = stringResource(R.string.settings_account_make_default),
                hint = stringResource(R.string.settings_account_make_default_help),
                icon = RukooIcons.Check,
                onClick = {
                    model.setDefaultAccount(account.id)
                    dismiss()
                },
            )
        }
        SheetRow(
            label = stringResource(R.string.settings_account_sync),
            icon = RukooIcons.Sync,
            onClick = {
                model.syncAccount(account.id)
                dismiss()
            },
        )
        if (account.auth == AuthKind.OAUTH2) {
            SheetRow(
                label = stringResource(R.string.settings_account_google_reauth),
                hint = stringResource(R.string.settings_account_google_reauth_help),
                icon = RukooIcons.Person,
                onClick = {
                    model.signInWithGoogle({ url -> openSignInPage(context, url) }, reauthAccountId = account.id)
                    dismiss()
                },
            )
        }
        SheetDivider()
        SheetRow(
            label = stringResource(R.string.settings_account_remove),
            icon = RukooIcons.Trash,
            danger = true,
            onClick = { confirm = true },
        )
    }
    if (confirm) {
        RkDialog(
            title = stringResource(R.string.settings_account_remove_title),
            text = stringResource(R.string.settings_account_remove_help, account.email),
            confirmLabel = stringResource(R.string.settings_account_remove),
            danger = true,
            onDismiss = { confirm = false },
            onConfirm = {
                confirm = false
                onDismiss()
                model.removeAccount(account.id) { failure ->
                    if (failure == null) toast.showToast(removed) else toast.showError(ErrorTexts.of(res, failure))
                }
            },
        )
    }
}

/** Adding an account: the provider tiles, bringing accounts from the computer, or the demo. */
@Composable
fun AddAccountPage(app: AppViewModel, model: SetupModel, nav: SettingsNav) {
    val add by model.add.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { if (add.working == null) model.clearAddError() }
    SettingsPageBody {
        SectionTitle(stringResource(R.string.settings_setup_choose_provider))
        ProviderGrid(onPick = { id -> nav.push(if (id == "google") SettingsRoutes.GOOGLE else SettingsRoutes.IMAP + id) })
        Spacer(Modifier.height(18.dp))
        SettingsCard {
            SettingsRow(
                title = stringResource(R.string.settings_import_from_computer),
                description = stringResource(R.string.settings_import_from_computer_help),
                leading = { RowIcon(RukooIcons.Download) },
                onClick = { pairOrImport(app, model, nav) },
            )
            SettingsRow(
                title = stringResource(R.string.settings_setup_demo_action),
                description = stringResource(R.string.settings_setup_demo_help),
                leading = { RowIcon(RukooIcons.Sparkle) },
                enabled = add.working == null,
                onClick = model::addDemo,
            )
        }
        add.error?.takeIf { add.working == null }?.let {
            Spacer(Modifier.height(10.dp))
            ErrorLine(errorText(it))
        }
    }
}
