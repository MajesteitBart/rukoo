package nl.bvdm.rukoo.mail

import androidx.annotation.StringRes
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.model.ServerConfig

/**
 * A provider tile on the add-account screen. [label] is a brand name; [labelRes] replaces it when set
 * ("Other"). [manual] presets have no servers and show the server fields from the start.
 */
data class ProviderPreset(
    val id: String,
    val label: String,
    @param:StringRes val labelRes: Int?,
    @param:StringRes val noteRes: Int,
    val manual: Boolean,
    val imap: ServerConfig,
    val smtp: ServerConfig,
)

/** Desktop's server presets (src/main/providers.js, spec 4 §5), in the order of the setup tiles. */
object Providers {
    val ALL: List<ProviderPreset> = listOf(
        ProviderPreset(
            "google", "Google", null, R.string.engine_setup_providers_google_note, false,
            ServerConfig("imap.gmail.com", 993, true), ServerConfig("smtp.gmail.com", 465, true),
        ),
        ProviderPreset(
            "yahoo", "Yahoo", null, R.string.engine_setup_providers_yahoo_note, false,
            ServerConfig("imap.mail.yahoo.com", 993, true), ServerConfig("smtp.mail.yahoo.com", 465, true),
        ),
        ProviderPreset(
            "outlook", "Outlook", null, R.string.engine_setup_providers_outlook_note, false,
            ServerConfig("outlook.office365.com", 993, true), ServerConfig("smtp-mail.outlook.com", 587, false),
        ),
        ProviderPreset(
            "exchange", "Exchange", null, R.string.engine_setup_providers_exchange_note, true,
            ServerConfig("", 993, true), ServerConfig("", 587, false),
        ),
        ProviderPreset(
            "office365", "Office365", null, R.string.engine_setup_providers_office365_note, false,
            ServerConfig("outlook.office365.com", 993, true), ServerConfig("smtp.office365.com", 587, false),
        ),
        ProviderPreset(
            "other", "Other", R.string.engine_setup_providers_other_label, R.string.engine_setup_providers_other_note, false,
            ServerConfig("", 993, true), ServerConfig("", 465, true),
        ),
    )

    /** Domains that map to a known provider, so "Other" still gets the right servers. */
    val DOMAIN_HINTS: Map<String, String> = mapOf(
        "gmail.com" to "google", "googlemail.com" to "google", "yahoo.com" to "yahoo", "ymail.com" to "yahoo",
        "outlook.com" to "outlook", "hotmail.com" to "outlook", "live.com" to "outlook", "live.nl" to "outlook",
        "hotmail.nl" to "outlook", "msn.com" to "outlook",
    )

    fun byId(id: String): ProviderPreset = ALL.firstOrNull { it.id == id } ?: ALL.last()

    /**
     * The servers for [providerId] and [email] (providers.js serverDefaults): "other" follows a known
     * domain, unknown ids fall back to "other", and empty hosts become imap.<domain> / smtp.<domain>.
     */
    fun serverDefaults(providerId: String, email: String): Pair<ServerConfig, ServerConfig> {
        val domain = email.substringAfter('@', "").trim()
        val hinted = DOMAIN_HINTS[domain.lowercase()]
        val preset = byId(if (providerId == "other" && hinted != null) hinted else providerId)
        val imap = if (preset.imap.host.isEmpty() && domain.isNotEmpty()) preset.imap.copy(host = "imap.$domain") else preset.imap
        val smtp = if (preset.smtp.host.isEmpty() && domain.isNotEmpty()) preset.smtp.copy(host = "smtp.$domain") else preset.smtp
        return imap to smtp
    }
}
