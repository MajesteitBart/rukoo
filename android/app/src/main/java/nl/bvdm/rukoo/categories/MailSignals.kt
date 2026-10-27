package nl.bvdm.rukoo.categories

import kotlinx.serialization.Serializable

/**
 * What kind of mail a message is, from the few headers mailing software adds: the signals inbox categories start
 * from (CategoryRules). A port of desktop's src/main/categories/signals.js. Kept small, because every cached inbox
 * message carries them. [list]: on a mailing list or with an unsubscribe link; [bulk]: sent in bulk (marked so, or
 * with the Feedback-ID large senders add); [auto]: sent by a machine; [campaign]: sent by campaign software.
 * Notifications from a bank or an app are bulk too; campaign is the one that points to marketing.
 */
@Serializable
data class MailSignals(
    val list: Boolean = false,
    val bulk: Boolean = false,
    val auto: Boolean = false,
    val campaign: Boolean = false,
) {
    companion object {
        /** The headers a sync fetches for this (ImapSession). */
        val HEADERS = listOf("list-id", "list-unsubscribe", "precedence", "auto-submitted", "feedback-id", "x-campaign", "x-mailer")

        // Mailing services whose X-Mailer gives away a campaign.
        private val BULK_MAILERS = Regex(
            "mailchimp|sendgrid|mailgun|hubspot|marketo|salesforce|klaviyo|brevo|sendinblue|mailjet|customer\\.io|campaign|newsletter|" +
                "mailerlite|constant ?contact|acoustic|exacttarget|emarsys|selligent|spotler|laposta",
            RegexOption.IGNORE_CASE,
        )
        private val PRECEDENCE = Regex("bulk|list|junk", RegexOption.IGNORE_CASE)
        private val NO = Regex("no", RegexOption.IGNORE_CASE)
        private val FOLD = Regex("\\r?\\n[ \\t]+")
        private val LINE = Regex("\\r?\\n")

        /** Header names (lower case) to values, from raw header text. A later header of the same name wins. */
        fun headerMap(raw: String?): Map<String, String> {
            if (raw.isNullOrEmpty()) return emptyMap()
            val out = LinkedHashMap<String, String>()
            for (line in FOLD.replace(raw, " ").split(LINE)) {
                val i = line.indexOf(':')
                if (i > 0) out[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
            }
            return out
        }

        /** The signals of raw header text, as a sync fetches it. */
        fun parse(raw: String?): MailSignals = of(headerMap(raw))

        /** The signals of header fields by name, as the demo account keeps them; names in any case. */
        fun fromHeaders(headers: Map<String, String>?): MailSignals = of(headers.orEmpty().mapKeys { it.key.lowercase() })

        private fun of(h: Map<String, String>): MailSignals {
            // JavaScript reads an empty header value as false; so does this.
            fun has(name: String) = !h[name].isNullOrEmpty()
            return MailSignals(
                list = has("list-id") || has("list-unsubscribe"),
                bulk = PRECEDENCE.matches(h["precedence"].orEmpty()) || has("feedback-id"),
                auto = has("auto-submitted") && !NO.matches(h.getValue("auto-submitted")),
                campaign = has("x-campaign") || BULK_MAILERS.containsMatchIn(h["x-mailer"].orEmpty()),
            )
        }
    }
}
