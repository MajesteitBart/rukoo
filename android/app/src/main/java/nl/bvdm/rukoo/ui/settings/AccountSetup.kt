package nl.bvdm.rukoo.ui.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.MailException
import nl.bvdm.rukoo.mail.model.ImapAccountInput
import nl.bvdm.rukoo.mail.model.MailProviders
import nl.bvdm.rukoo.mail.model.ProviderPreset
import nl.bvdm.rukoo.mail.model.ServerConfig
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkLinkButton
import nl.bvdm.rukoo.ui.components.RkSwitch
import nl.bvdm.rukoo.ui.components.RkTextField
import nl.bvdm.rukoo.ui.components.Spinner
import nl.bvdm.rukoo.ui.components.pressScale
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.ProviderLogos
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.rkSurface
import nl.bvdm.rukoo.ui.theme.title

/** The provider's name on its tile: the preset's, or "Other" in the interface language. */
@Composable
fun providerLabel(preset: ProviderPreset): String = preset.label ?: stringResource(R.string.settings_setup_providers_other_label)

/** The note under a provider's sign-in form (setup.providers.*.note). */
@Composable
private fun providerNote(id: String): String = stringResource(
    when (id) {
        "google" -> R.string.settings_setup_providers_google_note
        "yahoo" -> R.string.settings_setup_providers_yahoo_note
        "outlook" -> R.string.settings_setup_providers_outlook_note
        "exchange" -> R.string.settings_setup_providers_exchange_note
        "office365" -> R.string.settings_setup_providers_office365_note
        else -> R.string.settings_setup_providers_other_note
    },
)

/**
 * The provider tiles of desktop's setup screen (01-setup): a logo on a white rounded square over the name,
 * three to a row, two on a narrow screen.
 */
@Composable
fun ProviderGrid(onPick: (String) -> Unit, modifier: Modifier = Modifier) {
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val columns = if (maxWidth >= 330.dp) 3 else 2
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            for (row in MailProviders.all.chunked(columns)) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for (preset in row) ProviderTile(preset, Modifier.weight(1f)) { onPick(preset.id) }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
private fun ProviderTile(preset: ProviderPreset, modifier: Modifier, onClick: () -> Unit) {
    val c = Rk.colors
    val shape = Rk.shapes.panel
    val logo = RoundedCornerShape(10.dp)
    val source = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
    Column(
        modifier
            .heightIn(min = 108.dp)
            .pressScale(source, 0.98f)
            .rkSurface(Rk.elevation.shadowSm, shape, c.panel)
            .border(1.dp, c.border, shape)
            .rkClickable(shape, interactionSource = source, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
    ) {
        Box(Modifier.size(44.dp).background(c.logoBackground, logo).border(1.dp, c.logoRing, logo), contentAlignment = Alignment.Center) {
            Image(ProviderLogos.forProvider(preset.id), null, Modifier.size(30.dp))
        }
        Text(providerLabel(preset), style = Rk.type.text13.medium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
    }
}

private val EMAIL = Regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")

/**
 * Signing in to an IMAP account (desktop setup.js password form): email and password, the provider's note,
 * and the server block, shown at once for Exchange, on "Manual setup", or after a failed sign-in. For Other
 * and Exchange the servers follow the typed domain until the user edits them.
 */
@Composable
fun ImapAccountForm(presetId: String, model: SetupModel, modifier: Modifier = Modifier) {
    val preset = MailProviders.preset(presetId)
    val add by model.add.collectAsStateWithLifecycle()
    // Drafts in the model, not rememberSaveable: they survive folding, and the password never reaches a Bundle.
    val k = SetupModel.DRAFT_IMAP + preset.id + ":"
    var email by rememberDraft(model, k + "email") { "" }
    var password by rememberDraft(model, k + "password") { "" }
    var manual by rememberDraft(model, k + "manual") { preset.manual }
    var edited by rememberDraft(model, k + "edited") { false }
    var user by rememberDraft(model, k + "user") { "" }
    var imapHost by rememberDraft(model, k + "imapHost") { "" }
    var imapPort by rememberDraft(model, k + "imapPort") { preset.imap.port.toString() }
    var imapSecure by rememberDraft(model, k + "imapSecure") { preset.imap.secure }
    var smtpHost by rememberDraft(model, k + "smtpHost") { "" }
    var smtpPort by rememberDraft(model, k + "smtpPort") { preset.smtp.port.toString() }
    var smtpSecure by rememberDraft(model, k + "smtpSecure") { preset.smtp.secure }
    var problem by remember { mutableStateOf<String?>(null) }
    val working = add.working == SetupModel.AddKind.IMAP

    fun follow(address: String) {
        if (edited) return
        val (imap, smtp) = MailProviders.serverDefaults(preset.id, address)
        imapHost = imap.host
        smtpHost = smtp.host
        imapPort = imap.port.toString()
        smtpPort = smtp.port.toString()
        imapSecure = imap.secure
        smtpSecure = smtp.secure
    }
    LaunchedEffect(Unit) {
        // An error from another provider's attempt doesn't belong on this form.
        if (add.working == null) model.clearAddError()
        if (imapHost.isEmpty() && !edited) follow(email)
    }
    // A failed sign-in shows the servers, as desktop does, so the user can check them.
    LaunchedEffect(add.error) { if (add.error is MailException) manual = true }

    val invalidEmail = stringResource(R.string.settings_errors_account_invalid_email)
    val needPassword = stringResource(R.string.settings_errors_account_password)
    fun submit() {
        problem = null
        model.clearAddError()
        val address = email.trim()
        when {
            !EMAIL.matches(address) -> problem = invalidEmail
            password.isEmpty() -> problem = needPassword
            else -> {
                val (defImap, defSmtp) = MailProviders.serverDefaults(preset.id, address)
                val login = user.trim().ifEmpty { address }
                val imap = if (manual) ServerConfig(imapHost.trim(), imapPort.toIntOrNull() ?: defImap.port, imapSecure, login) else defImap.copy(user = login)
                val smtp = if (manual) ServerConfig(smtpHost.trim(), smtpPort.toIntOrNull() ?: defSmtp.port, smtpSecure, login) else defSmtp.copy(user = login)
                model.addImap(ImapAccountInput(address, address.substringBefore('@'), password, imap, smtp, preset.id))
            }
        }
    }

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        NoteBox(providerNote(preset.id))
        RkTextField(
            value = email,
            onValueChange = {
                email = it
                follow(it.trim())
            },
            label = stringResource(R.string.settings_setup_fields_email),
            placeholder = stringResource(R.string.settings_setup_fields_email_example),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
            enabled = !working,
        )
        RkTextField(
            value = password,
            onValueChange = { password = it },
            label = stringResource(R.string.settings_setup_fields_password),
            placeholder = stringResource(R.string.settings_setup_fields_password_hint),
            password = true,
            keyboardOptions = KeyboardOptions(imeAction = if (manual) ImeAction.Next else ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            enabled = !working,
        )
        if (manual) {
            RkTextField(
                value = user,
                onValueChange = { user = it },
                label = stringResource(R.string.settings_setup_fields_username),
                // What is used when the field stays empty; the help line says what usually goes here.
                placeholder = email.trim().ifEmpty { null },
                help = stringResource(R.string.settings_setup_fields_username_hint),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false),
                enabled = !working,
            )
            ServerFields(
                label = stringResource(R.string.settings_setup_fields_imap),
                host = imapHost,
                port = imapPort,
                secure = imapSecure,
                enabled = !working,
                onHost = { imapHost = it; edited = true },
                onPort = { imapPort = it.filter(Char::isDigit).take(5); edited = true },
                onSecure = { imapSecure = it; edited = true },
            )
            ServerFields(
                label = stringResource(R.string.settings_setup_fields_smtp),
                host = smtpHost,
                port = smtpPort,
                secure = smtpSecure,
                enabled = !working,
                onHost = { smtpHost = it; edited = true },
                onPort = { smtpPort = it.filter(Char::isDigit).take(5); edited = true },
                onSecure = { smtpSecure = it; edited = true },
            )
        }
        val error = problem ?: add.error?.let { errorText(it) }
        if (error != null) ErrorLine(error)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (!manual) RkLinkButton(stringResource(R.string.settings_setup_manual_action), { manual = true }, enabled = !working)
            Spacer(Modifier.weight(1f))
            if (working) Spinner(size = 14.dp)
            RkButton(
                label = stringResource(if (working) R.string.settings_setup_sign_in_pending else R.string.settings_setup_sign_in_action),
                onClick = ::submit,
                kind = RkButtonKind.PRIMARY,
                enabled = !working,
            )
        }
    }
}

@Composable
private fun ServerFields(
    label: String,
    host: String,
    port: String,
    secure: Boolean,
    enabled: Boolean,
    onHost: (String) -> Unit,
    onPort: (String) -> Unit,
    onSecure: (Boolean) -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Bottom) {
        RkTextField(
            value = host,
            onValueChange = onHost,
            label = label,
            modifier = Modifier.weight(1f),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
            enabled = enabled,
        )
        RkTextField(
            value = port,
            onValueChange = onPort,
            label = stringResource(R.string.settings_setup_fields_port),
            modifier = Modifier.width(88.dp),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            enabled = enabled,
        )
    }
    Row(
        Modifier.fillMaxWidth().rkClickable(Rk.shapes.control, enabled = enabled) { onSecure(!secure) }.padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(stringResource(R.string.settings_setup_fields_ssl), style = Rk.type.text13, color = Rk.colors.text2, modifier = Modifier.weight(1f))
        RkSwitch(secure, onSecure, enabled = enabled)
    }
}

/** Opens Google's consent page in a Custom Tab (Google refuses embedded WebViews), or the browser. */
fun openSignInPage(context: Context, url: String) {
    val uri = Uri.parse(url)
    val opened = runCatching { CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri) }.isSuccess
    if (!opened) runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

/**
 * Signing in with Google. With an OAuth client the user signs in through the browser; without one the
 * page explains where to get it: from the computer, or the client file from Google Cloud.
 */
@Composable
fun GoogleSetup(model: SetupModel, onPassword: () -> Unit, onPair: (() -> Unit)?, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val add by model.add.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) {
        if (add.working == null) model.clearAddError()
        model.loadGoogleClient()
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            scope.launch {
                val text = withContext(Dispatchers.IO) {
                    runCatching {
                        context.contentResolver.openInputStream(uri)?.use { input ->
                            // A client file is a few hundred bytes; anything far larger isn't one.
                            val buffer = java.io.ByteArrayOutputStream()
                            val chunk = ByteArray(8192)
                            while (buffer.size() < 256 * 1024) {
                                val n = input.read(chunk)
                                if (n < 0) break
                                buffer.write(chunk, 0, n)
                            }
                            buffer.toString(Charsets.UTF_8.name())
                        }
                    }.getOrNull()
                }
                model.importClientFile(text.orEmpty())
            }
        }
    }
    val waiting = add.working == SetupModel.AddKind.GOOGLE
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        when {
            !add.clientLoaded -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Spinner(size = 14.dp)
                Text(stringResource(R.string.settings_server_checking), style = Rk.type.text13, color = Rk.colors.text2)
            }
            add.googleClient != null -> {
                Text(stringResource(R.string.settings_setup_google_help), style = Rk.type.text13, color = Rk.colors.text2)
                if (waiting) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Spinner(size = 14.dp)
                        Text(stringResource(R.string.settings_setup_google_wait), style = Rk.type.text13, color = Rk.colors.text2, modifier = Modifier.weight(1f))
                        RkLinkButton(stringResource(R.string.common_actions_cancel), model::cancelAdd)
                    }
                } else {
                    RkButton(
                        label = stringResource(R.string.settings_setup_google_action),
                        onClick = { model.signInWithGoogle({ url -> openSignInPage(context, url) }) },
                        kind = RkButtonKind.PRIMARY,
                        size = nl.bvdm.rukoo.ui.components.RkButtonSize.LARGE,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            else -> {
                NoteBox(stringResource(R.string.settings_setup_google_no_client))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (onPair != null) {
                        RkButton(stringResource(R.string.settings_setup_google_from_computer), onPair, kind = RkButtonKind.PRIMARY, modifier = Modifier.fillMaxWidth())
                    }
                    RkButton(
                        label = stringResource(R.string.settings_setup_google_choose_file),
                        onClick = { pick.launch(arrayOf("application/json", "text/*", "application/octet-stream")) },
                        kind = if (onPair != null) RkButtonKind.SECONDARY else RkButtonKind.PRIMARY,
                        enabled = add.working == null,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
        add.error?.let { ErrorLine(errorText(it)) }
        if (!waiting) RkLinkButton(stringResource(R.string.settings_setup_google_password_mode), onPassword)
    }
}

/** A page heading inside a setup flow: 16/650, as the desktop dialog title. */
@Composable
fun SetupHeading(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.padding(top = 4.dp), style = Rk.type.text16.title, color = Rk.colors.text)
}
