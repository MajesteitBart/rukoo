package nl.bvdm.rukoo.ui.settings

import android.content.ClipData
import android.content.ClipboardManager
import android.text.format.Formatter
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.account.AccountDevice
import nl.bvdm.rukoo.account.AccountError
import nl.bvdm.rukoo.account.AccountStatus
import nl.bvdm.rukoo.account.ServerInfo
import nl.bvdm.rukoo.ui.components.LocalRkToast
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkButtonSize
import nl.bvdm.rukoo.ui.components.RkTextField
import nl.bvdm.rukoo.ui.components.SectionTitle
import nl.bvdm.rukoo.ui.components.SettingsCard
import nl.bvdm.rukoo.ui.components.SettingsChevron
import nl.bvdm.rukoo.ui.components.SettingsRow
import nl.bvdm.rukoo.ui.components.Spinner
import nl.bvdm.rukoo.ui.components.popIn
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.mail.MailCheckbox
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooMono
import nl.bvdm.rukoo.ui.theme.rkSurface

private const val PROTOCOL_URL = "https://github.com/MajesteitBart/rukoo/blob/main/server/PROTOCOL.md"
private const val SELF_HOST_URL = "https://github.com/MajesteitBart/rukoo/blob/main/server/README.md"

/** The words for an account error code (desktop's account.errors.*); codes Rukoo doesn't know read as `server`. */
@StringRes
fun accountErrorRes(code: String?): Int = when (AccountError.known(code)) {
    "invalid" -> R.string.account_errors_invalid
    "unauthorized" -> R.string.account_errors_unauthorized
    "wrong_password" -> R.string.account_errors_wrong_password
    "locked" -> R.string.account_errors_locked
    "rate_limited" -> R.string.account_errors_rate_limited
    "exists" -> R.string.account_errors_exists
    "signups_closed" -> R.string.account_errors_signups_closed
    "invite_required" -> R.string.account_errors_invite_required
    "quota" -> R.string.account_errors_quota
    "too_large" -> R.string.account_errors_too_large
    "not_configured" -> R.string.account_errors_not_configured
    "network" -> R.string.account_errors_network
    "invalid_email" -> R.string.account_errors_invalid_email
    "weak_password" -> R.string.account_errors_weak_password
    "recovery_key" -> R.string.account_errors_recovery_key
    "weak_kdf" -> R.string.account_errors_weak_kdf
    "heavy_kdf" -> R.string.account_errors_heavy_kdf
    "no_server" -> R.string.account_errors_no_server
    "protocol" -> R.string.account_errors_protocol
    "signed_in" -> R.string.account_errors_signed_in
    "signed_out" -> R.string.account_errors_signed_out
    else -> R.string.account_errors_server
}

/** The server by its address: `rukoo.io`, or `10.0.2.2:8790`. */
fun hostOf(url: String): String = runCatching { java.net.URI(url).let { u -> u.host?.let { h -> if (u.port > 0) "$h:${u.port}" else h } } }.getOrNull() ?: url

@Composable
private fun whereText(info: ServerInfo?): String = stringResource(
    when (info?.hosting?.jurisdiction) {
        "eu" -> R.string.settings_rukoo_where_eu
        "us" -> R.string.settings_rukoo_where_us
        "fedramp" -> R.string.settings_rukoo_where_fedramp
        else -> R.string.settings_rukoo_where_any
    },
)

@Composable
private fun platformName(platform: String): String = when (platform) {
    "win32" -> stringResource(R.string.settings_rukoo_platform_win32)
    "darwin" -> stringResource(R.string.settings_rukoo_platform_darwin)
    "linux" -> stringResource(R.string.settings_rukoo_platform_linux)
    "android" -> stringResource(R.string.settings_rukoo_platform_android)
    else -> platform
}

@Composable
fun rukooAccountModel(app: AppViewModel): RukooAccountModel = viewModel { RukooAccountModel(app.services) }

/** The row on the Settings overview: signed in as whom, or what an account is for, and a sync error. */
@Composable
fun rukooAccountSummary(status: AccountStatus?): String {
    if (status == null || !status.signedIn) return stringResource(R.string.settings_rukoo_row_signed_out)
    val line = stringResource(R.string.settings_rukoo_row_signed_in, status.email.orEmpty())
    return if (status.error != null) "$line · ${stringResource(accountErrorRes(status.error))}" else line
}

/** A paragraph between the cards (desktop's `.settings-text`): 13px `text2`. */
@Composable
private fun SettingsText(text: String, modifier: Modifier = Modifier, error: Boolean = false) {
    Text(
        text,
        modifier.padding(start = 4.dp, end = 4.dp, top = 12.dp, bottom = 2.dp),
        style = Rk.type.text13.copy(lineHeight = Rk.type.text13.fontSize * 1.5f),
        color = if (error) Rk.colors.danger else Rk.colors.text2,
    )
}

@Composable
private fun StaticRow(title: String, description: String? = null) = SettingsRow(title = title, description = description)

/** Settings > Rukoo account: signed out, the intro and the server; signed in, the account and what can be done with it. */
@Composable
fun RukooAccountPage(app: AppViewModel, nav: SettingsNav) {
    val model = rukooAccountModel(app)
    val account = model.account ?: return
    val status by account.status.collectAsStateWithLifecycle()
    val ui by model.ui.collectAsStateWithLifecycle()
    LaunchedEffect(status.signedIn) { model.fill(SettingsRoutes.RUKOO) }
    if (status.signedIn) SignedInPage(app, model, nav, status, ui) else SignedOutPage(model, nav, status, ui)
    ui.recoveryKey?.let { RecoveryKeyDialog(it, onDone = model::recoveryKeyShown) }
}

@Composable
private fun ServerRow(model: RukooAccountModel, status: AccountStatus, ui: RukooAccountModel.Ui) {
    val toast = LocalRkToast.current
    val res = LocalContext.current.resources
    var prompt by remember { mutableStateOf(false) }
    val info = ui.info ?: status.info
    val server = status.server
    val description = when {
        server.isNotEmpty() && ui.infoFailed && info == null -> stringResource(R.string.settings_rukoo_server_unreachable)
        server.isNotEmpty() && info != null ->
            "${stringResource(R.string.settings_rukoo_server_run_by, info.operator?.name ?: hostOf(server))} · ${whereText(info)}"
        else -> null
    }
    SettingsCard {
        SettingsRow(
            title = if (server.isNotEmpty()) hostOf(server) else stringResource(R.string.settings_rukoo_server_none),
            description = description,
            trailing = { SettingsChevron() },
            onClick = { prompt = true },
        )
    }
    if (prompt) {
        var value by remember { mutableStateOf(server) }
        val saved = stringResource(R.string.settings_rukoo_server_saved)
        RkDialog(
            title = stringResource(R.string.settings_rukoo_server_prompt),
            confirmLabel = stringResource(R.string.common_actions_save),
            onDismiss = { prompt = false },
            onConfirm = {
                prompt = false
                model.setServer(value, failed = { toast.showError(res.getString(accountErrorRes(it))) }) {
                    toast.showToast(saved)
                    model.fill(SettingsRoutes.RUKOO)
                }
            },
        ) {
            RkTextField(
                value = value,
                onValueChange = { value = it },
                placeholder = "https://",
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
            )
        }
    }
}

@Composable
private fun SignedOutPage(model: RukooAccountModel, nav: SettingsNav, status: AccountStatus, ui: RukooAccountModel.Ui) {
    SettingsPageBody {
        SettingsText(stringResource(R.string.settings_rukoo_intro))
        if (status.error == "signed_out") SettingsText(stringResource(R.string.account_errors_signed_out), error = true)
        SectionTitle(stringResource(R.string.settings_rukoo_server))
        ServerRow(model, status, ui)
        Spacer(Modifier.height(16.dp))
        SettingsCard {
            SettingsRow(title = stringResource(R.string.settings_rukoo_sign_up), trailing = { SettingsChevron() }, onClick = { nav.push(SettingsRoutes.RUKOO_SIGNUP) })
            SettingsRow(title = stringResource(R.string.settings_rukoo_sign_in), trailing = { SettingsChevron() }, onClick = { nav.push(SettingsRoutes.RUKOO_SIGNIN) })
            SettingsRow(title = stringResource(R.string.settings_rukoo_forgot), trailing = { SettingsChevron() }, onClick = { nav.push(SettingsRoutes.RUKOO_RECOVER) })
        }
        Spacer(Modifier.height(16.dp))
        SettingsCard {
            SettingsRow(
                title = stringResource(R.string.settings_rukoo_privacy),
                description = stringResource(R.string.settings_rukoo_privacy_help),
                trailing = { SettingsChevron() },
                onClick = { nav.push(SettingsRoutes.RUKOO_PRIVACY) },
            )
        }
    }
}

@Composable
private fun syncLine(status: AccountStatus): String {
    val locale = currentLocale()
    if (status.syncing) return stringResource(R.string.settings_rukoo_syncing)
    if (status.error != null) return stringResource(accountErrorRes(status.error))
    val last = status.lastSync?.let { stringResource(R.string.settings_account_last_sync, formatDate(it, locale), formatTime(it, locale)) }
        ?: stringResource(R.string.settings_rukoo_never_synced)
    return if (status.pending > 0) "${pluralStringResource(R.plurals.settings_rukoo_pending, status.pending, status.pending)} · $last" else last
}

private enum class Ask { NONE, PASSWORD, NEW_KEY, SIGN_OUT, DELETE }

@Composable
private fun SignedInPage(app: AppViewModel, model: RukooAccountModel, nav: SettingsNav, status: AccountStatus, ui: RukooAccountModel.Ui) {
    val toast = LocalRkToast.current
    val context = LocalContext.current
    val res = context.resources
    var ask by remember { mutableStateOf(Ask.NONE) }
    var device by remember { mutableStateOf<AccountDevice?>(null) }
    val failed: (String) -> Unit = { toast.showError(res.getString(accountErrorRes(it))) }
    val exportFile = stringResource(R.string.settings_rukoo_export_file)
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if (uri != null) {
            model.export(context.contentResolver, uri) { ok ->
                if (ok) toast.showToast(res.getString(R.string.settings_rukoo_exported)) else toast.showError(res.getString(R.string.settings_rukoo_export_failed))
            }
        }
    }
    val info = ui.info ?: status.info
    val by = info?.operator?.name?.let { " · " + stringResource(R.string.settings_rukoo_server_run_by, it) }.orEmpty()

    SettingsPageBody {
        SectionTitle(stringResource(R.string.settings_rukoo_account))
        SettingsCard {
            StaticRow(status.email.orEmpty(), hostOf(status.server) + by)
            SettingsRow(
                title = stringResource(R.string.settings_rukoo_sync_now),
                description = syncLine(status),
                trailing = if (status.syncing) ({ Spinner(size = 14.dp) }) else null,
                onClick = { model.run({ it.sync() }, failed) { toast.showToast(res.getString(R.string.settings_rukoo_synced)) } },
            )
        }
        SectionTitle(stringResource(R.string.settings_rukoo_devices))
        SettingsCard {
            val details = ui.details
            when {
                details == null && ui.detailsFailed -> StaticRow(stringResource(R.string.settings_rukoo_devices_unavailable))
                details == null -> Row(Modifier.fillMaxWidth().padding(16.dp)) { Spinner(size = 14.dp) }
                else -> {
                    val list = details.devices.sortedWith(compareByDescending<AccountDevice> { it.current }.thenByDescending { it.lastSeenAt ?: 0 })
                    val locale = currentLocale()
                    for (d in list) {
                        if (d.current) {
                            StaticRow(d.name, "${stringResource(R.string.settings_rukoo_this_device)} · ${platformName(d.platform)}")
                        } else {
                            SettingsRow(
                                title = d.name,
                                description = "${stringResource(R.string.settings_rukoo_last_seen, formatDate(d.lastSeenAt ?: d.createdAt, locale))} · ${platformName(d.platform)}",
                                onClick = { device = d },
                            )
                        }
                    }
                }
            }
        }
        SectionTitle(stringResource(R.string.settings_rukoo_security))
        SettingsCard {
            SettingsRow(
                title = stringResource(R.string.settings_rukoo_change_password),
                description = stringResource(R.string.settings_rukoo_change_password_help),
                onClick = { ask = Ask.PASSWORD },
            )
            SettingsRow(
                title = stringResource(R.string.settings_rukoo_new_key),
                description = stringResource(R.string.settings_rukoo_new_key_help),
                onClick = { ask = Ask.NEW_KEY },
            )
        }
        SectionTitle(stringResource(R.string.settings_rukoo_your_data))
        SettingsCard {
            SettingsRow(
                title = stringResource(R.string.settings_rukoo_privacy),
                description = stringResource(R.string.settings_rukoo_privacy_help),
                trailing = { SettingsChevron() },
                onClick = { nav.push(SettingsRoutes.RUKOO_PRIVACY) },
            )
            SettingsRow(
                title = stringResource(R.string.settings_rukoo_export),
                description = stringResource(R.string.settings_rukoo_export_help),
                onClick = { export.launch(exportFile) },
            )
        }
        Spacer(Modifier.height(16.dp))
        SettingsCard {
            SettingsRow(
                title = stringResource(R.string.settings_rukoo_sign_out),
                description = stringResource(R.string.settings_rukoo_sign_out_help),
                onClick = { ask = Ask.SIGN_OUT },
            )
            SettingsRow(
                title = stringResource(R.string.settings_rukoo_delete),
                description = stringResource(R.string.settings_rukoo_delete_help),
                titleColor = Rk.colors.danger,
                onClick = { ask = Ask.DELETE },
            )
        }
    }

    device?.let { d ->
        RkDialog(
            title = stringResource(R.string.settings_rukoo_remove_device, d.name),
            text = stringResource(R.string.settings_rukoo_remove_device_help, d.name),
            confirmLabel = stringResource(R.string.settings_rukoo_remove_device_action),
            danger = true,
            onDismiss = { device = null },
            onConfirm = {
                device = null
                model.run({ it.removeDevice(d.id) }, failed) { toast.showToast(res.getString(R.string.settings_rukoo_device_removed)) }
            },
        )
    }
    when (ask) {
        Ask.NONE -> Unit
        Ask.PASSWORD -> ChangePasswordDialog(onDismiss = { ask = Ask.NONE }) { current, next ->
            ask = Ask.NONE
            model.run({ it.changePassword(current, next) }, failed) { toast.showToast(res.getString(R.string.settings_rukoo_password_changed)) }
        }
        Ask.NEW_KEY -> PasswordDialog(
            title = stringResource(R.string.settings_rukoo_new_key),
            help = stringResource(R.string.settings_rukoo_new_key_help),
            confirmLabel = stringResource(R.string.settings_rukoo_continue),
            onDismiss = { ask = Ask.NONE },
        ) { password ->
            ask = Ask.NONE
            model.newRecoveryKey(password, failed)
        }
        Ask.SIGN_OUT -> RkDialog(
            title = stringResource(R.string.settings_rukoo_sign_out),
            text = stringResource(R.string.settings_rukoo_sign_out_help),
            confirmLabel = stringResource(R.string.settings_rukoo_sign_out),
            onDismiss = { ask = Ask.NONE },
            onConfirm = {
                ask = Ask.NONE
                model.run({ it.signOut() }, failed) { toast.showToast(res.getString(R.string.settings_rukoo_signed_out)) }
            },
        )
        Ask.DELETE -> PasswordDialog(
            title = stringResource(R.string.settings_rukoo_delete),
            help = stringResource(R.string.settings_rukoo_delete_help),
            confirmLabel = stringResource(R.string.settings_rukoo_delete),
            danger = true,
            onDismiss = { ask = Ask.NONE },
        ) { password ->
            ask = Ask.NONE
            model.run({ it.deleteAccount(password) }, failed) { toast.showToast(res.getString(R.string.settings_rukoo_deleted)) }
        }
    }
}

/** Asks for the password before something that needs it again. */
@Composable
private fun PasswordDialog(title: String, help: String, confirmLabel: String, onDismiss: () -> Unit, danger: Boolean = false, onPassword: (String) -> Unit) {
    var password by remember { mutableStateOf("") }
    RkDialog(
        title = title,
        text = help,
        confirmLabel = confirmLabel,
        danger = danger,
        confirmEnabled = password.isNotEmpty(),
        onDismiss = onDismiss,
        onConfirm = { if (password.isNotEmpty()) onPassword(password) },
    ) {
        RkTextField(
            value = password,
            onValueChange = { password = it },
            label = stringResource(R.string.settings_setup_fields_password),
            password = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (password.isNotEmpty()) onPassword(password) }),
        )
    }
}

@Composable
private fun ChangePasswordDialog(onDismiss: () -> Unit, onChange: (String, String) -> Unit) {
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var repeat by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<Int?>(null) }
    fun submit() {
        error = when {
            current.isEmpty() -> null
            next.codePointCount(0, next.length) < nl.bvdm.rukoo.account.AccountService.MIN_PASSWORD -> R.string.account_errors_weak_password
            next != repeat -> R.string.settings_rukoo_mismatch
            else -> return onChange(current, next)
        }
    }
    RkDialog(
        title = stringResource(R.string.settings_rukoo_change_password),
        text = stringResource(R.string.settings_rukoo_change_password_help),
        confirmLabel = stringResource(R.string.settings_rukoo_change_password),
        confirmEnabled = current.isNotEmpty(),
        onDismiss = onDismiss,
        onConfirm = ::submit,
    ) {
        RkTextField(current, { current = it }, label = stringResource(R.string.settings_rukoo_current_password), password = true)
        RkTextField(next, { next = it }, label = stringResource(R.string.settings_rukoo_new_password), password = true, help = stringResource(R.string.settings_rukoo_password_help))
        RkTextField(repeat, { repeat = it }, label = stringResource(R.string.settings_rukoo_repeat), password = true)
        error?.let { ErrorLine(stringResource(it)) }
    }
}

/** The recovery key, shown once: it can be copied, and the dialog stays until "I saved it". */
@Composable
fun RecoveryKeyDialog(key: String, onDone: () -> Unit) {
    val context = LocalContext.current
    val toast = LocalRkToast.current
    val copied = stringResource(R.string.settings_rukoo_copied)
    Dialog(onDismissRequest = {}, properties = DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false)) {
        val c = Rk.colors
        val shape = Rk.shapes.window
        Column(
            Modifier
                .popIn(140)
                .widthIn(max = 480.dp)
                .fillMaxWidth()
                .rkSurface(Rk.elevation.overlay, shape, c.raised)
                .border(1.dp, c.border, shape)
                .padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.settings_rukoo_key_title), style = Rk.type.dialogTitle, color = c.text)
            Text(stringResource(R.string.settings_rukoo_key_help), style = Rk.type.text13.copy(lineHeight = Rk.type.text13.fontSize * 1.5f), color = c.text2)
            BoxWithConstraints(
                Modifier
                    .fillMaxWidth()
                    .background(c.panel2, Rk.shapes.control)
                    .border(1.dp, c.borderStrong, Rk.shapes.control)
                    .padding(horizontal = 12.dp, vertical = 14.dp),
            ) {
                // One line where it fits, as on desktop; on the cover screen two lines of four groups.
                val shown = if (maxWidth >= 380.dp) key else key.split('-').chunked(4).joinToString("\n") { it.joinToString("-") }
                SelectionContainer {
                    Text(
                        shown,
                        Modifier.fillMaxWidth(),
                        style = Rk.type.mono.copy(fontFamily = RukooMono, fontSize = 15.sp, letterSpacing = 0.04.sp * 15, lineHeight = 24.sp),
                        color = c.text,
                        textAlign = TextAlign.Center,
                        softWrap = false,
                    )
                }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                RkButton(stringResource(R.string.settings_rukoo_copy), {
                    copySensitive(context, "Rukoo", key)
                    toast.showToast(copied)
                }, kind = RkButtonKind.SECONDARY, size = RkButtonSize.SMALL)
                Spacer(Modifier.weight(1f))
                RkButton(stringResource(R.string.settings_rukoo_key_saved), onDone, kind = RkButtonKind.PRIMARY)
            }
        }
    }
}

/** A check box with its label, the whole row toggling it. */
@Composable
private fun CheckRow(text: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .toggleable(checked, enabled = enabled, role = Role.Checkbox, interactionSource = null, indication = Rk.indication(Rk.shapes.control), onValueChange = onChange)
            .padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MailCheckbox(checked)
        Text(text, style = Rk.type.text13, color = Rk.colors.text, modifier = Modifier.weight(1f))
    }
}

/** Create an account, Sign in and Forgot your password?: one form each, as desktop has them. */
@Composable
fun RukooFormPage(app: AppViewModel, nav: SettingsNav, form: RukooAccountModel.Form) {
    val model = rukooAccountModel(app)
    val account = model.account ?: return
    val ui by model.ui.collectAsStateWithLifecycle()
    val status by account.status.collectAsStateWithLifecycle()
    val toast = LocalRkToast.current
    val res = LocalContext.current.resources
    val route = when (form) {
        RukooAccountModel.Form.SIGN_UP -> SettingsRoutes.RUKOO_SIGNUP
        RukooAccountModel.Form.SIGN_IN -> SettingsRoutes.RUKOO_SIGNIN
        RukooAccountModel.Form.RECOVER -> SettingsRoutes.RUKOO_RECOVER
    }
    LaunchedEffect(Unit) {
        model.clearFormError()
        model.fill(route)
    }
    val info = ui.info ?: status.info
    val working = ui.working
    fun field(name: String) = model.fields[name].orEmpty()
    fun set(name: String, value: String) {
        model.fields[name] = value
    }
    fun submit() = model.submit(form) { text ->
        // A new account shows its recovery key first; the page goes back, and says so, once it is saved.
        if (form != RukooAccountModel.Form.SIGN_UP) {
            nav.pop()
            toast.showToast(res.getString(text))
        }
    }

    // The recovery key of a new account, then back to the account's page.
    ui.recoveryKey?.let {
        RecoveryKeyDialog(it) {
            model.recoveryKeyShown()
            nav.pop()
            toast.showToast(res.getString(R.string.settings_rukoo_welcome))
        }
    }

    SettingsPageBody {
        if (form == RukooAccountModel.Form.SIGN_UP && info?.signups == "closed") {
            SettingsText(stringResource(R.string.settings_rukoo_closed))
            return@SettingsPageBody
        }
        if (form == RukooAccountModel.Form.RECOVER) SettingsText(stringResource(R.string.settings_rukoo_recover_help))
        Spacer(Modifier.height(12.dp))
        Column(
            Modifier.fillMaxWidth().rkSurface(null, Rk.shapes.panel, Rk.colors.panel).border(1.dp, Rk.colors.border, Rk.shapes.panel).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            RkTextField(
                value = field("email"),
                onValueChange = { set("email", it) },
                label = stringResource(R.string.settings_setup_fields_email),
                placeholder = stringResource(R.string.settings_setup_fields_email_example),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                enabled = !working,
            )
            if (form == RukooAccountModel.Form.RECOVER) {
                RkTextField(
                    value = field("recoveryKey"),
                    onValueChange = { set("recoveryKey", it) },
                    label = stringResource(R.string.settings_rukoo_recovery_key_field),
                    placeholder = "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
                    mono = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                    enabled = !working,
                )
            }
            RkTextField(
                value = field("password"),
                onValueChange = { set("password", it) },
                label = stringResource(if (form == RukooAccountModel.Form.RECOVER) R.string.settings_rukoo_new_password else R.string.settings_setup_fields_password),
                help = if (form == RukooAccountModel.Form.SIGN_IN) null else stringResource(R.string.settings_rukoo_password_help),
                password = true,
                keyboardOptions = KeyboardOptions(imeAction = if (form == RukooAccountModel.Form.SIGN_IN) ImeAction.Done else ImeAction.Next),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                enabled = !working,
            )
            if (form != RukooAccountModel.Form.SIGN_IN) {
                RkTextField(
                    value = field("repeat"),
                    onValueChange = { set("repeat", it) },
                    label = stringResource(R.string.settings_rukoo_repeat),
                    password = true,
                    keyboardOptions = KeyboardOptions(imeAction = if (form == RukooAccountModel.Form.SIGN_UP && info?.signups == "invite") ImeAction.Next else ImeAction.Done),
                    enabled = !working,
                )
            }
            if (form == RukooAccountModel.Form.SIGN_UP && info?.signups == "invite") {
                RkTextField(
                    value = field("invite"),
                    onValueChange = { set("invite", it) },
                    label = stringResource(R.string.settings_rukoo_invite),
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                    enabled = !working,
                )
            }
            if (form == RukooAccountModel.Form.SIGN_UP) {
                CheckRow(stringResource(R.string.settings_rukoo_understand), field("understand") == "on", enabled = !working) { set("understand", if (it) "on" else "") }
            }
            ui.formError?.let { e ->
                ErrorLine(
                    when (e) {
                        is RukooAccountModel.FormError.Code -> stringResource(accountErrorRes(e.code))
                        is RukooAccountModel.FormError.Text -> stringResource(e.res)
                    },
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Spacer(Modifier.weight(1f))
                if (working) Spinner(size = 14.dp)
                RkButton(
                    label = stringResource(
                        when {
                            working -> R.string.settings_rukoo_working
                            form == RukooAccountModel.Form.SIGN_UP -> R.string.settings_rukoo_create
                            form == RukooAccountModel.Form.SIGN_IN -> R.string.settings_rukoo_sign_in
                            else -> R.string.settings_rukoo_recover_submit
                        },
                    ),
                    onClick = ::submit,
                    kind = RkButtonKind.PRIMARY,
                    enabled = !working,
                )
            }
        }
    }
}

/** What's stored and shared: the counts, what the server can and can't see, and who handles the data. */
@Composable
fun RukooPrivacyPage(app: AppViewModel) {
    val model = rukooAccountModel(app)
    val account = model.account ?: return
    val status by account.status.collectAsStateWithLifecycle()
    val ui by model.ui.collectAsStateWithLifecycle()
    val jevOn = app.services.categories?.state?.collectAsStateWithLifecycle()?.value?.jev?.on == true
    val context = LocalContext.current
    LocalConfiguration.current
    LaunchedEffect(status.signedIn) { model.fill(SettingsRoutes.RUKOO_PRIVACY) }
    val counts = status.counts
    val corrections = (counts["override"] ?: 0) + (counts["sender"] ?: 0)
    val info = ui.info ?: status.info
    val operator = info?.operator?.name
    val hosting = info?.hosting
    val country = if (hosting?.country == "US") stringResource(R.string.settings_rukoo_country_us) else hosting?.country.orEmpty()
    val where = whereText(info)

    SettingsPageBody {
        SectionTitle(stringResource(if (status.signedIn) R.string.settings_rukoo_stored else R.string.settings_rukoo_stored_local))
        SettingsCard {
            StaticRow(pluralStringResource(R.plurals.settings_rukoo_count_category, counts["category"] ?: 0, counts["category"] ?: 0))
            StaticRow(pluralStringResource(R.plurals.settings_rukoo_count_classification, counts["classification"] ?: 0, counts["classification"] ?: 0))
            StaticRow(pluralStringResource(R.plurals.settings_rukoo_count_correction, corrections, corrections))
            val usage = ui.details?.usage
            if (status.signedIn && usage != null) StaticRow(stringResource(R.string.settings_rukoo_server_usage, Formatter.formatShortFileSize(context, usage.bytes)))
        }
        SettingsText(stringResource(R.string.settings_rukoo_stored_help))
        SectionTitle(stringResource(R.string.settings_rukoo_can_see))
        SettingsCard {
            StaticRow(stringResource(R.string.settings_rukoo_see_email))
            StaticRow(stringResource(R.string.settings_rukoo_see_devices))
            StaticRow(stringResource(R.string.settings_rukoo_see_records))
            StaticRow(stringResource(R.string.settings_rukoo_see_ip))
        }
        SectionTitle(stringResource(R.string.settings_rukoo_cant_see))
        SettingsCard { StaticRow(stringResource(R.string.settings_rukoo_cant_see_help)) }
        SectionTitle(stringResource(R.string.settings_rukoo_services))
        SettingsCard {
            if (info != null) {
                StaticRow(operator ?: hostOf(status.server), stringResource(R.string.settings_rukoo_operator_help))
            } else {
                StaticRow(stringResource(if (status.server.isNotEmpty()) R.string.settings_rukoo_server_unreachable else R.string.settings_rukoo_server_none))
            }
            if (info != null && hosting?.company != null) {
                val law = if (hosting.country == "US") " " + stringResource(R.string.settings_rukoo_us_law) else ""
                StaticRow(hosting.company, stringResource(R.string.settings_rukoo_host_help, country, where) + law)
            }
            if (jevOn) StaticRow(stringResource(R.string.settings_rukoo_typesafe), stringResource(R.string.settings_rukoo_typesafe_help))
            StaticRow(stringResource(R.string.settings_rukoo_mail_providers), stringResource(R.string.settings_rukoo_mail_providers_help))
            StaticRow(stringResource(R.string.settings_rukoo_nobody_else), stringResource(R.string.settings_rukoo_nobody_else_help))
        }
        Spacer(Modifier.height(16.dp))
        SettingsCard {
            val policy = info?.operator?.privacy
            if (policy != null) {
                LinkRow(stringResource(R.string.settings_rukoo_policy), stringResource(R.string.settings_rukoo_policy_help, operator ?: hostOf(status.server))) { openWebPage(context, policy) }
            }
            LinkRow(stringResource(R.string.settings_rukoo_protocol), stringResource(R.string.settings_rukoo_protocol_help)) { openWebPage(context, PROTOCOL_URL) }
            LinkRow(stringResource(R.string.settings_rukoo_self_host), stringResource(R.string.settings_rukoo_self_host_help)) { openWebPage(context, SELF_HOST_URL) }
        }
    }
}

@Composable
private fun LinkRow(title: String, description: String, onClick: () -> Unit) {
    SettingsRow(title = title, description = description, trailing = { RowIcon(PanelIcons.ArrowOut, Rk.colors.text3) }, onClick = onClick)
}
