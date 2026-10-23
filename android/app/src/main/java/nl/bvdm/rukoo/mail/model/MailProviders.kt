package nl.bvdm.rukoo.mail.model

/**
 * An account setup preset (desktop providers.js, spec 4 §5). [manual] presets have no servers of their
 * own, so setup shows the server fields at once. [label] is null for `other`, which the UI translates.
 */
data class ProviderPreset(
    val id: String,
    val label: String?,
    val imap: ServerConfig,
    val smtp: ServerConfig,
    val manual: Boolean = false,
)

/** The presets in setup's tile order (setup.js:5), and desktop's server defaults for a typed address. */
object MailProviders {
    val all: List<ProviderPreset> = listOf(
        ProviderPreset("google", "Google", ServerConfig("imap.gmail.com", 993, true), ServerConfig("smtp.gmail.com", 465, true)),
        ProviderPreset("yahoo", "Yahoo", ServerConfig("imap.mail.yahoo.com", 993, true), ServerConfig("smtp.mail.yahoo.com", 465, true)),
        ProviderPreset("outlook", "Outlook", ServerConfig("outlook.office365.com", 993, true), ServerConfig("smtp-mail.outlook.com", 587, false)),
        ProviderPreset("exchange", "Exchange", ServerConfig("", 993, true), ServerConfig("", 587, false), manual = true),
        ProviderPreset("office365", "Office365", ServerConfig("outlook.office365.com", 993, true), ServerConfig("smtp.office365.com", 587, false)),
        ProviderPreset("other", null, ServerConfig("", 993, true), ServerConfig("", 465, true)),
    )

    /** Domains that pick a preset when the user chose Other (providers.js DOMAIN_HINTS). */
    val domainHints: Map<String, String> = mapOf(
        "gmail.com" to "google", "googlemail.com" to "google", "yahoo.com" to "yahoo", "ymail.com" to "yahoo",
        "outlook.com" to "outlook", "hotmail.com" to "outlook", "live.com" to "outlook", "live.nl" to "outlook",
        "hotmail.nl" to "outlook", "msn.com" to "outlook",
    )

    fun preset(id: String): ProviderPreset = all.firstOrNull { it.id == id } ?: all.last()

    /**
     * providers.js serverDefaults: for `other`, a known domain switches to its preset; unknown ids are
     * `other`; an empty host becomes `imap.<domain>` / `smtp.<domain>`. The user is the email address.
     */
    fun serverDefaults(providerId: String, email: String): Pair<ServerConfig, ServerConfig> {
        val domain = email.substringAfterLast('@', "").trim().lowercase()
        var preset = preset(providerId)
        if (preset.id == "other") domainHints[domain]?.let { preset = preset(it) }
        val user = email.trim()
        fun fill(c: ServerConfig, prefix: String) =
            c.copy(host = c.host.ifEmpty { if (domain.isEmpty()) "" else "$prefix.$domain" }, user = user)
        return fill(preset.imap, "imap") to fill(preset.smtp, "smtp")
    }
}
