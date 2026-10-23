package nl.bvdm.rukoo.settings

import nl.bvdm.rukoo.mail.model.SortOrder

/** System follows the phone's dark theme setting. */
enum class ThemeMode { SYSTEM, LIGHT, DARK }

/** The interface language. SYSTEM follows the phone; the others use these locale tags, as desktop does. */
enum class Language(val tag: String?) {
    SYSTEM(null),
    EN("en-GB"),
    NL("nl-NL"),
}

/** Message list density, desktop's `standard` and `compact`. */
enum class Density { STANDARD, COMPACT }

/**
 * App-wide preferences, kept in DataStore by [SettingsStore]. Agent connections and their secrets
 * are not here: they live in agents/AgentSettings (agents.json, encrypted secrets).
 */
data class AppSettings(
    val theme: ThemeMode = ThemeMode.SYSTEM,
    val language: Language = Language.SYSTEM,
    /** Show emails with a dark background in the dark theme, as desktop's `darkEmails` (default on). */
    val darkEmails: Boolean = true,
    /** Swipe a row right to toggle read, left to delete. */
    val swipeActions: Boolean = true,
    /** Notifications for new mail. */
    val notifyMail: Boolean = true,
    /** Notifications for agent replies, drafts and approvals while the chat isn't on screen. */
    val notifyAgents: Boolean = true,
    /** Sync interval while the app is open, in minutes; 0 turns periodic sync off (desktop `syncInterval`). */
    val syncMinutes: Int = 5,
    val defaultAccountId: String? = null,
    /** "Let agents use Rukoo on this phone": the MCP server on the Tailscale address. */
    val mcpEnabled: Boolean = false,
    val mcpPort: Int = DEFAULT_MCP_PORT,
    val density: Density = Density.STANDARD,
    val sort: SortOrder = SortOrder.DATE_DESC,
) {
    companion object {
        /** Desktop Rukoo's port; Clark's bridge looks for every Rukoo on it (rukoo_bridge.py). */
        const val DEFAULT_MCP_PORT = 47800
    }
}
