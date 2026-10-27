package nl.bvdm.rukoo.ui.settings

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.text.format.Formatter
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import nl.bvdm.rukoo.BuildConfig
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.settings.Density
import nl.bvdm.rukoo.settings.Language
import nl.bvdm.rukoo.settings.ThemeMode
import nl.bvdm.rukoo.ui.components.SectionTitle
import nl.bvdm.rukoo.ui.components.SettingsCard
import nl.bvdm.rukoo.ui.components.SettingsRow
import nl.bvdm.rukoo.ui.components.SettingsSwitchRow
import nl.bvdm.rukoo.ui.components.SettingsTrailingValue
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.theme.Rk

/** Notifications for new mail and agent replies, and Android 13's permission they need. */
@Composable
fun NotificationsPage(app: AppViewModel) {
    val s = app.services
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val settings by s.settingsSnapshot.collectAsStateWithLifecycle()
    val needsPermission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
    var granted by remember { mutableStateOf(NotificationPermission.granted(context)) }
    var asked by remember { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // The user can change it in the system settings and come back.
    LaunchedEffect(lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { granted = NotificationPermission.granted(context) } }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        asked = true
    }
    // Turning a notification on is when it needs the permission: Android asks once, then only its settings can.
    fun turnedOn() {
        if (!asked && NotificationPermission.shouldAsk(Build.VERSION.SDK_INT, granted, wanted = true)) request.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    SettingsPageBody {
        Spacer(Modifier.height(12.dp))
        SettingsCard {
            if (needsPermission && !granted) {
                SettingsRow(
                    title = stringResource(R.string.settings_notifications_allow),
                    description = stringResource(R.string.settings_notifications_allow_help),
                    leading = { RowIcon(RukooIcons.Bell, Rk.colors.warn) },
                    onClick = {
                        // After a refusal Android doesn't ask again; its settings page is the only way.
                        if (asked) openNotificationSettings(context) else request.launch(Manifest.permission.POST_NOTIFICATIONS)
                    },
                )
            }
            SettingsSwitchRow(
                title = stringResource(R.string.settings_notifications_new_mail),
                description = stringResource(R.string.settings_notifications_new_mail_help),
                checked = settings.notifyMail,
                onCheckedChange = { on ->
                    scope.launch { s.settings.update { it.copy(notifyMail = on) } }
                    if (on) turnedOn()
                },
            )
            SettingsSwitchRow(
                title = stringResource(R.string.settings_notifications_agents_row),
                description = stringResource(R.string.settings_notifications_agents_help),
                checked = settings.notifyAgents,
                onCheckedChange = { on ->
                    scope.launch { s.settings.update { it.copy(notifyAgents = on) } }
                    if (on) turnedOn()
                },
            )
        }
        Spacer(Modifier.height(10.dp))
        SettingsCard {
            SettingsRow(
                title = stringResource(R.string.settings_notifications_system),
                description = stringResource(R.string.settings_notifications_system_help),
                onClick = { openNotificationSettings(context) },
            )
        }
    }
}

private fun openNotificationSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
    runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

/** Theme, dark emails, swipe actions and list density. */
@Composable
fun AppearancePage(app: AppViewModel) {
    val s = app.services
    val scope = rememberCoroutineScope()
    val settings by s.settingsSnapshot.collectAsStateWithLifecycle()
    var sheet by remember { mutableStateOf<String?>(null) }
    val densityLabel = stringResource(if (settings.density == Density.COMPACT) R.string.settings_density_compact else R.string.settings_density_standard)

    SettingsPageBody {
        Spacer(Modifier.height(12.dp))
        SettingsCard {
            SettingsRow(title = stringResource(R.string.settings_general_theme), value = themeLabel(settings.theme), onClick = { sheet = "theme" })
            SettingsRow(title = stringResource(R.string.settings_general_density), value = densityLabel, onClick = { sheet = "density" })
            SettingsSwitchRow(
                title = stringResource(R.string.settings_general_dark_emails),
                description = stringResource(R.string.settings_general_dark_emails_help),
                checked = settings.darkEmails,
                onCheckedChange = { on -> scope.launch { s.settings.update { it.copy(darkEmails = on) } } },
            )
            SettingsSwitchRow(
                title = stringResource(R.string.settings_general_swipe),
                description = stringResource(R.string.settings_general_swipe_help),
                checked = settings.swipeActions,
                onCheckedChange = { on -> scope.launch { s.settings.update { it.copy(swipeActions = on) } } },
            )
        }
    }

    when (sheet) {
        "theme" -> ChoiceSheet(
            title = stringResource(R.string.settings_general_theme),
            choices = listOf(ThemeMode.DARK, ThemeMode.LIGHT, ThemeMode.SYSTEM).map { Choice(it, themeLabel(it)) },
            selected = settings.theme,
            onSelect = { mode -> scope.launch { s.settings.update { it.copy(theme = mode) } } },
            onDismiss = { sheet = null },
        )
        "density" -> ChoiceSheet(
            title = stringResource(R.string.settings_general_density),
            choices = listOf(
                Choice(Density.STANDARD, stringResource(R.string.settings_density_standard), stringResource(R.string.settings_density_standard_hint)),
                Choice(Density.COMPACT, stringResource(R.string.settings_density_compact), stringResource(R.string.settings_density_compact_hint)),
            ),
            selected = settings.density,
            onSelect = { d -> scope.launch { s.settings.update { it.copy(density = d) } } },
            onDismiss = { sheet = null },
        )
    }
}

/**
 * The interface language, per app through LocaleManager (AppContainer applies the setting). English and
 * Nederlands are written in their own language, as language pickers do.
 */
@Composable
fun LanguagePage(app: AppViewModel) {
    val s = app.services
    val scope = rememberCoroutineScope()
    val settings by s.settingsSnapshot.collectAsStateWithLifecycle()
    SettingsPageBody {
        SettingsIntro(stringResource(R.string.settings_general_language_help))
        Spacer(Modifier.height(12.dp))
        SettingsCard {
            for (language in listOf(Language.SYSTEM, Language.EN, Language.NL)) {
                val on = settings.language == language
                SettingsRow(
                    title = languageLabel(language),
                    trailing = if (on) ({ RowIcon(RukooIcons.Check, Rk.colors.accent) }) else null,
                    onClick = { scope.launch { s.settings.update { it.copy(language = language) } } },
                )
            }
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            Spacer(Modifier.height(10.dp))
            NoteBox(stringResource(R.string.settings_language_old_android))
        }
    }
}

/** A library Rukoo ships, with its license and where to read it. */
private data class License(val name: String, val license: String, val url: String)

private val LICENSES = listOf(
    License("Rukoo Mail", "MIT", "https://github.com/MajesteitBart/rukoo"),
    License("Inter", "SIL Open Font License 1.1", "https://github.com/rsms/inter"),
    License("JetBrains Mono", "SIL Open Font License 1.1", "https://github.com/JetBrains/JetBrainsMono"),
    License("Beautiful UI", "MIT", "https://www.beautifului.dev"),
    License("dudan", "MIT", "https://github.com/MajesteitBart/dudan"),
    License("Angus Mail", "EPL 2.0 or GPL 2.0 with Classpath Exception", "https://eclipse-ee4j.github.io/angus-mail/"),
    License("jsoup", "MIT", "https://jsoup.org/license"),
    License("commonmark-java", "BSD 2-Clause", "https://github.com/commonmark/commonmark-java"),
    License("autolink-java", "MIT", "https://github.com/robinst/autolink-java"),
    License("OkHttp", "Apache 2.0", "https://square.github.io/okhttp/"),
    License("Bouncy Castle", "MIT", "https://www.bouncycastle.org/about/license/"),
    License("AndroidX, Jetpack Compose, Kotlin", "Apache 2.0", "https://developer.android.com/jetpack/androidx"),
)

/** Version, what the app stores on this phone, and the open-source licenses. */
@Composable
fun AboutPage() {
    val context = LocalContext.current
    val size by produceState<Long?>(null) { value = withContext(Dispatchers.IO) { folderSize(context.dataDir) + folderSize(context.externalCacheDir) } }
    SettingsPageBody {
        Spacer(Modifier.height(12.dp))
        SettingsCard {
            SettingsRow(
                title = stringResource(R.string.app_name),
                description = stringResource(R.string.settings_about_tagline),
                trailing = { SettingsTrailingValue(BuildConfig.VERSION_NAME + if (BuildConfig.DEBUG) " (debug)" else "") },
            )
            SettingsRow(
                title = stringResource(R.string.settings_about_storage),
                description = stringResource(R.string.settings_about_storage_help),
                trailing = { SettingsTrailingValue(size?.let { Formatter.formatShortFileSize(context, it) } ?: "…") },
            )
        }
        SectionTitle(stringResource(R.string.settings_about_licenses))
        SettingsCard {
            for (l in LICENSES) {
                SettingsRow(
                    title = l.name,
                    description = l.license,
                    trailing = { RowIcon(PanelIcons.ArrowOut, Rk.colors.text3) },
                    onClick = { openWebPage(context, l.url) },
                )
            }
        }
    }
}

private fun folderSize(dir: File?): Long = dir?.walkBottomUp()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L
