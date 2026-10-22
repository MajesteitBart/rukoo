package nl.bvdm.rukoo.desktop

import kotlin.coroutines.cancellation.CancellationException
import nl.bvdm.rukoo.agents.AgentSettings
import nl.bvdm.rukoo.agents.AgentSettingsStore
import nl.bvdm.rukoo.agents.ClarkSettings
import nl.bvdm.rukoo.agents.OpenClawSettings
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.ComputerProgram
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.MailException
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.AccountType
import nl.bvdm.rukoo.mail.model.AuthKind
import nl.bvdm.rukoo.mail.model.GoogleClient
import nl.bvdm.rukoo.mail.model.ImportedAccount
import nl.bvdm.rukoo.mail.model.MailPrefs
import nl.bvdm.rukoo.mail.model.SortOrder
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.settings.Density
import nl.bvdm.rukoo.settings.Language
import nl.bvdm.rukoo.settings.SettingsStore
import nl.bvdm.rukoo.settings.ThemeMode

/** An account the export carried that the phone couldn't take. */
data class SkippedAccount(val email: String, val reason: SkipReason)

enum class SkipReason {
    /** The computer couldn't decrypt its password or Google sign-in (another Windows user, a new keyring). */
    NO_SECRET,
}

/**
 * What an import brought over, for the summary. [added] are the accounts that are new on this phone;
 * [alreadyHere] counts the ones it had (same address). [localOnly] names agents whose address only works on
 * the computer itself (127.0.0.1), which the phone can't reach.
 */
data class ImportResult(
    val added: List<Account> = emptyList(),
    val alreadyHere: Int = 0,
    val skipped: List<SkippedAccount> = emptyList(),
    val clark: Boolean = false,
    val openclaw: Boolean = false,
    val localOnly: List<String> = emptyList(),
    val googleClient: Boolean = false,
    /** Set when the accounts couldn't be added; the agent and app settings came over all the same. */
    val accountError: MailException? = null,
)

/** The agent settings an import produces, and what it took over. */
data class AgentImport(val settings: AgentSettings, val clark: Boolean, val openclaw: Boolean, val localOnly: List<String>)

/**
 * Turns desktop Rukoo's export (spec 3 §7.10) into this phone's accounts, agent settings and app settings.
 * The mapping functions are pure; [apply] runs them against the stores in the order that keeps a half-done
 * import useful.
 */
object DesktopImport {
    /**
     * The accounts to hand to [MailEngine.importAccounts]. The demo account stays on the computer (the phone
     * has its own), and accounts without a secret are reported instead of added. An account on the computer's
     * general signature stays on it: the engine keeps the general signature too ([prefs]).
     */
    fun accounts(bundle: ExportBundle): Pair<List<ImportedAccount>, List<SkippedAccount>> {
        val skipped = mutableListOf<SkippedAccount>()
        val out = mutableListOf<ImportedAccount>()
        for (a in bundle.accounts) {
            if (a.type == AccountType.DEMO || a.auth == AuthKind.NONE) continue
            val secret = if (a.auth == AuthKind.OAUTH2) a.refreshToken else a.password
            if (a.secretError != null || secret.isNullOrEmpty()) {
                skipped += SkippedAccount(a.email, SkipReason.NO_SECRET)
                continue
            }
            out += a
        }
        return out to skipped
    }

    /**
     * The mail settings desktop keeps in settings.json, for [MailEngine.updatePrefs]: the computer's VIPs and spam
     * addresses join the phone's, and its general signature replaces the phone's when it has one.
     */
    fun prefs(exported: ExportedSettings, current: MailPrefs): MailPrefs {
        fun join(a: List<String>, b: List<String>) = (a + b).map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct()
        val text = exported.signature.orEmpty()
        val html = exported.signatureHtml.orEmpty()
        val signed = text.isNotBlank() || html.isNotBlank()
        return current.copy(
            vips = join(current.vips, exported.vips),
            spam = join(current.spam, exported.spam),
            signature = if (signed) text else current.signature,
            signatureHtml = if (signed) html else current.signatureHtml,
        )
    }

    /** The Google client, when the computer has a complete one. */
    fun googleClient(bundle: ExportBundle): GoogleClient? =
        bundle.google?.takeIf { it.clientId.isNotBlank() && it.clientSecret.isNotBlank() }

    /**
     * The agent settings after the import. Clark and OpenClaw come over when the computer has an address for
     * them that the phone can reach; a key the export leaves empty keeps the phone's key for the same server.
     * The phone's own switches (OpenClaw's phone tools) stay as they are. The default agent maps desktop's
     * Claude Code and Codex onto this computer.
     */
    fun agents(bundle: ExportBundle, current: AgentSettings, pairingId: String): AgentImport {
        val exported = bundle.agents
        val localOnly = mutableListOf<String>()
        var clark = current.clark
        var tookClark = false
        exported.clark?.takeIf { it.url.isNotBlank() }?.let { c ->
            if (UrlHosts.isLoopback(c.url)) {
                localOnly += c.name.ifBlank { "Hermes" }
            } else {
                val url = c.url.trim().trimEnd('/')
                val key = c.key.ifBlank { if (sameServer(current.clark.url, url)) current.clark.key else "" }
                clark = ClarkSettings(enabled = c.enabled, name = c.name.trim().ifBlank { "Hermes" }, url = url, key = key, model = c.model.trim())
                tookClark = true
            }
        }
        var openclaw = current.openclaw
        var tookOpenClaw = false
        exported.openclaw?.takeIf { it.url.isNotBlank() }?.let { o ->
            if (UrlHosts.isLoopback(o.url)) {
                // Desktop's default gateway address; only a gateway that set a token is one the user really uses.
                if (o.key.isNotBlank()) localOnly += "OpenClaw"
            } else {
                val url = o.url.trim().trimEnd('/')
                val token = o.key.ifBlank { if (sameServer(current.openclaw.url, url)) current.openclaw.token else "" }
                openclaw = OpenClawSettings(
                    enabled = o.enabled,
                    url = url,
                    token = token,
                    agentId = o.agent.trim(),
                    model = o.model.trim(),
                    remote = current.openclaw.remote,
                )
                tookOpenClaw = true
            }
        }
        val default = when (exported.defaultAgent) {
            AgentIds.CLARK -> AgentIds.CLARK.takeIf { clark.configured }
            AgentIds.OPENCLAW -> AgentIds.OPENCLAW.takeIf { openclaw.configured }
            ComputerProgram.CLAUDE.wire -> AgentIds.computer(pairingId, ComputerProgram.CLAUDE)
            ComputerProgram.CODEX.wire -> AgentIds.computer(pairingId, ComputerProgram.CODEX)
            else -> null
        } ?: current.defaultAgent
        val settings = current.copy(
            defaultAgent = default,
            autoMailActions = exported.autoMailActions,
            shortcuts = exported.shortcuts ?: current.shortcuts,
            clark = clark,
            openclaw = openclaw,
        )
        return AgentImport(settings, tookClark, tookOpenClaw, localOnly)
    }

    /**
     * The app settings after the import. The language only comes over while the phone follows the system,
     * and becomes System again when it is the phone's own language anyway: desktop starts in English, so a
     * Dutch phone would otherwise switch to English for a choice nobody made. [systemLanguage] is the
     * phone's language code (`nl`); [accountIds] maps the computer's account ids to this phone's.
     */
    fun appSettings(exported: ExportedSettings, current: AppSettings, systemLanguage: String?, accountIds: Map<String, String>): AppSettings {
        val language = when (exported.language?.lowercase()?.substringBefore('-')) {
            "en" -> Language.EN
            "nl" -> Language.NL
            else -> null
        }?.takeIf { current.language == Language.SYSTEM }?.let { wanted ->
            if (wanted.tag?.substringBefore('-') == systemLanguage?.lowercase()) Language.SYSTEM else wanted
        } ?: current.language
        val theme = when (exported.theme) {
            "system" -> ThemeMode.SYSTEM
            "light" -> ThemeMode.LIGHT
            "dark" -> ThemeMode.DARK
            else -> current.theme
        }
        val density = when (exported.density) {
            "standard" -> Density.STANDARD
            "compact" -> Density.COMPACT
            else -> current.density
        }
        return current.copy(
            theme = theme,
            language = language,
            darkEmails = exported.darkEmails ?: current.darkEmails,
            swipeActions = exported.swipeActions ?: current.swipeActions,
            notifyMail = exported.notifications ?: current.notifyMail,
            syncMinutes = exported.syncInterval?.coerceIn(0, 24 * 60) ?: current.syncMinutes,
            density = density,
            sort = SortOrder.entries.firstOrNull { it.wire == exported.sort } ?: current.sort,
            defaultAccountId = exported.defaultAccountId?.let(accountIds::get) ?: current.defaultAccountId,
        )
    }

    /**
     * Runs an import: agents, the Google client and the mail settings first, then the accounts, then the app
     * settings. The accounts go late because adding the first one closes the setup screen; the language goes last
     * because changing it recreates the activity. A mail failure doesn't undo the rest.
     */
    suspend fun apply(
        bundle: ExportBundle,
        pairingId: String,
        mail: MailEngine,
        agentStore: AgentSettingsStore,
        settingsStore: SettingsStore,
        systemLanguage: String?,
    ): ImportResult {
        var agentImport: AgentImport? = null
        agentStore.update { current -> agents(bundle, current, pairingId).also { agentImport = it }.settings }
        val client = googleClient(bundle)
        val clientSet = client != null && runCatching { mail.setGoogleClient(client) }.isSuccess
        importPrefs(bundle.settings, mail)
        val (accounts, skipped) = accounts(bundle)
        val before = mail.accounts.value.map { it.email.lowercase() }.toSet()
        var accountError: MailException? = null
        if (accounts.isNotEmpty()) {
            try {
                mail.importAccounts(accounts, client)
            } catch (e: MailException) {
                accountError = e
            }
        }
        val now = mail.accounts.value
        val added = now.filter { it.email.lowercase() !in before }
        val byEmail = now.associateBy { it.email.lowercase() }
        val ids = bundle.accounts.mapNotNull { a -> byEmail[a.email.lowercase()]?.let { a.id to it.id } }.toMap()
        settingsStore.update { appSettings(bundle.settings, it, systemLanguage, ids) }
        val taken = agentImport!!
        return ImportResult(
            added = added,
            alreadyHere = accounts.count { it.email.lowercase() in before },
            skipped = skipped,
            clark = taken.clark,
            openclaw = taken.openclaw,
            localOnly = taken.localOnly,
            googleClient = clientSet,
            accountError = accountError,
        )
    }

    /**
     * VIPs, spam addresses and the general signature. The engine refuses an HTML signature it can't keep (too
     * large); the lists and the signature's text still come over then. Never fails the import.
     */
    private suspend fun importPrefs(exported: ExportedSettings, mail: MailEngine) {
        try {
            mail.updatePrefs { prefs(exported, it) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: MailException) {
            AppLog.w(TAG, "the computer's HTML signature didn't come over", e)
            try {
                mail.updatePrefs { prefs(exported.copy(signatureHtml = null), it) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                AppLog.w(TAG, "the computer's mail settings didn't come over", e)
            }
        } catch (e: Exception) {
            AppLog.w(TAG, "the computer's mail settings didn't come over", e)
        }
    }

    private const val TAG = "DesktopImport"

    private fun sameServer(a: String, b: String) = a.trim().trimEnd('/').equals(b.trim().trimEnd('/'), ignoreCase = true)
}

/** Reading the host of a URL the user or the computer gave. */
object UrlHosts {
    /** The lower-cased host of an http(s) URL, without brackets; null when there is none. */
    fun host(raw: String): String? {
        val s = raw.trim()
        val rest = s.substringAfter("://", "").ifEmpty { return null }
        val authority = rest.substringBefore('/').substringBefore('?').substringBefore('#').substringAfterLast('@')
        val host = if (authority.startsWith("[")) authority.substringAfter('[').substringBefore(']') else authority.substringBefore(':')
        return host.lowercase().trimEnd('.').takeIf { it.isNotEmpty() }
    }

    /** A URL that points at the device it is used on: from another device it reaches nothing. */
    fun isLoopback(raw: String): Boolean {
        val host = host(raw) ?: return false
        return host == "localhost" || host.endsWith(".localhost") || host == "::1" || host == "0.0.0.0" || host.startsWith("127.")
    }
}
