package nl.bvdm.rukoo.settings

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import nl.bvdm.rukoo.mail.model.SortOrder

private val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

/** [AppSettings] in DataStore Preferences. One key per field; a missing or unknown value reads as the default. */
class SettingsStore(private val store: DataStore<Preferences>) {
    constructor(context: Context) : this(context.applicationContext.settingsDataStore)

    val flow: Flow<AppSettings> = store.data.map(::fromPreferences).distinctUntilChanged()

    suspend fun current(): AppSettings = flow.first()

    /** Applies [transform] to the stored settings atomically and returns the result. */
    suspend fun update(transform: (AppSettings) -> AppSettings): AppSettings {
        var result = AppSettings()
        store.edit { prefs ->
            result = transform(fromPreferences(prefs))
            write(prefs, result)
        }
        return result
    }

    companion object {
        private val THEME = stringPreferencesKey("theme")
        private val LANGUAGE = stringPreferencesKey("language")
        private val DARK_EMAILS = booleanPreferencesKey("dark_emails")
        private val SWIPE_ACTIONS = booleanPreferencesKey("swipe_actions")
        private val SWIPE_RIGHT = stringPreferencesKey("swipe_right")
        private val SWIPE_LEFT = stringPreferencesKey("swipe_left")
        private val NOTIFY_MAIL = booleanPreferencesKey("notify_mail")
        private val NOTIFY_AGENTS = booleanPreferencesKey("notify_agents")
        private val SYNC_MINUTES = intPreferencesKey("sync_minutes")
        private val DEFAULT_ACCOUNT = stringPreferencesKey("default_account_id")
        private val MCP_ENABLED = booleanPreferencesKey("mcp_enabled")
        private val MCP_PORT = intPreferencesKey("mcp_port")
        private val DENSITY = stringPreferencesKey("density")
        private val SORT = stringPreferencesKey("sort")

        private inline fun <reified E : Enum<E>> enumOr(name: String?, default: E): E =
            name?.let { n -> enumValues<E>().firstOrNull { it.name == n } } ?: default

        fun fromPreferences(prefs: Preferences): AppSettings {
            val d = AppSettings()
            return AppSettings(
                theme = enumOr(prefs[THEME], d.theme),
                language = enumOr(prefs[LANGUAGE], d.language),
                darkEmails = prefs[DARK_EMAILS] ?: d.darkEmails,
                swipeActions = prefs[SWIPE_ACTIONS] ?: d.swipeActions,
                swipeRight = SwipeAction.of(prefs[SWIPE_RIGHT]) ?: d.swipeRight,
                swipeLeft = SwipeAction.of(prefs[SWIPE_LEFT]) ?: d.swipeLeft,
                notifyMail = prefs[NOTIFY_MAIL] ?: d.notifyMail,
                notifyAgents = prefs[NOTIFY_AGENTS] ?: d.notifyAgents,
                syncMinutes = (prefs[SYNC_MINUTES] ?: d.syncMinutes).coerceIn(0, 24 * 60),
                defaultAccountId = prefs[DEFAULT_ACCOUNT]?.takeIf { it.isNotEmpty() },
                mcpEnabled = prefs[MCP_ENABLED] ?: d.mcpEnabled,
                mcpPort = (prefs[MCP_PORT] ?: d.mcpPort).takeIf { it in 1024..65535 } ?: d.mcpPort,
                density = enumOr(prefs[DENSITY], d.density),
                sort = enumOr(prefs[SORT], SortOrder.DATE_DESC),
            )
        }

        fun write(prefs: MutablePreferences, s: AppSettings) {
            prefs[THEME] = s.theme.name
            prefs[LANGUAGE] = s.language.name
            prefs[DARK_EMAILS] = s.darkEmails
            prefs[SWIPE_ACTIONS] = s.swipeActions
            prefs[SWIPE_RIGHT] = s.swipeRight.wire
            prefs[SWIPE_LEFT] = s.swipeLeft.wire
            prefs[NOTIFY_MAIL] = s.notifyMail
            prefs[NOTIFY_AGENTS] = s.notifyAgents
            prefs[SYNC_MINUTES] = s.syncMinutes
            if (s.defaultAccountId == null) prefs.remove(DEFAULT_ACCOUNT) else prefs[DEFAULT_ACCOUNT] = s.defaultAccountId
            prefs[MCP_ENABLED] = s.mcpEnabled
            prefs[MCP_PORT] = s.mcpPort
            prefs[DENSITY] = s.density.name
            prefs[SORT] = s.sort.name
        }
    }
}
