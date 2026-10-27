package nl.bvdm.rukoo.categories

import java.text.Normalizer
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.MessageSummary

/** How sure the rules are: STRONG when the mail says so itself, WEAK when it is a guess Jev should make instead. */
enum class Strength { STRONG, WEAK }

data class RuleResult(val preset: String, val strength: Strength)

/**
 * Inbox categories without a model: what the headers, Gmail's tab, the sender and the subject say. A port of
 * desktop's src/main/categories/rules.js. These rules only know Rukoo's own five categories (the presets);
 * categories people add get mail from Jev or from their own rules.
 *
 * JavaScript's regular expressions and Java's differ at the edges, so the patterns here spell out what desktop's
 * mean: whole-string matches where desktop anchors with ^ and $, ASCII word boundaries for \b, and JavaScript's
 * Unicode spaces for \s.
 */
object CategoryRules {
    val PRESETS = listOf("needs-you", "to-read", "money", "updates", "promotions")
    val PRESET_COLORS = mapOf("needs-you" to "#ff5d73", "to-read" to "#4a7dff", "money" to "#2fd6c0", "updates" to "#f5c542", "promotions" to "#c56cf0")

    // Senders that are machines by their name before the @.
    private val MACHINE = Regex(
        "(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer(-daemon)?|bounces?|updates?|automated|system|postmaster|security|accounts?)([+._-].*)?",
        RegexOption.IGNORE_CASE,
    )

    // Senders that send newsletters and offers by their name before the @.
    private val MARKETING = Regex("(news(letter)?s?|nieuwsbrief|marketing|promo(tions?)?|offers?|deals|aanbiedingen|acties)([+._-].*)?", RegexOption.IGNORE_CASE)

    // Subjects about money, in English and Dutch. \b in JavaScript is a boundary of [A-Za-z0-9_].
    private const val W = "A-Za-z0-9_"
    private val MONEY = Regex(
        "(?<![$W])(invoices?|factu(u|)r(en)?|receipts?|kassabon|betaal(verzoek|bewijs)?|betaling(en)?|payments?|paid|betaald|order confirmation|" +
            "orderbevestiging|bestelbevestiging|bill(ing)?|aanmaning|incasso|refunds?|terugbetaling|(bank)?afschrift|statement|belastingdienst|" +
            "aangifte|btw|vat|tikkie|declaratie|creditnota|credit note|subscription renew(al|ed)|abonnement verlengd)(?![$W])",
        RegexOption.IGNORE_CASE,
    )

    // JavaScript's \s.
    private val SPACES = Regex("[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")
    private val WORD = Regex("[a-z][a-z'-]+")
    private val MARKS = Regex("[\\u0300-\\u036f]")

    fun localPart(address: String?): String = address.orEmpty().split('@')[0]

    fun domainOf(address: String?): String = address.orEmpty().split('@').getOrNull(1).orEmpty()

    fun isMachine(from: Address?): Boolean = MACHINE.matches(localPart(from?.address))

    /** A display name of two or more words whose first or last word is in the address: "Sanne de Vries" <sanne@...>. */
    fun looksLikePerson(from: Address?): Boolean {
        val words = MARKS.replace(Normalizer.normalize(from?.name.orEmpty().lowercase(), Normalizer.Form.NFKD), "")
            .split(SPACES)
            .filter { WORD.matches(it) }
        if (words.size < 2) return false
        val local = localPart(from?.address).lowercase()
        return listOf(words.first(), words.last()).any { it.length >= 3 && local.contains(it) }
    }

    /** Whether this account's own address is among the To recipients. */
    fun toMe(m: MessageSummary, own: List<String>): Boolean {
        val mine = own.map { it.lowercase() }
        return m.to.any { it.address.lowercase() in mine }
    }

    /**
     * The preset a message fits, and how sure the rules are. [own]: the account's addresses; [vip]: whether the
     * sender is a VIP; [known]: whether the sender is someone the person has written to.
     */
    fun presetFor(m: MessageSummary, own: List<String> = emptyList(), vip: Boolean = false, known: Boolean = false): RuleResult {
        val s = m.signals ?: MailSignals()
        val tab = m.gmailTab
        val from = m.from
        val local = localPart(from.address)
        fun personal(strength: Strength) = RuleResult(if (toMe(m, own)) "needs-you" else "to-read", strength)
        if (vip) return RuleResult("needs-you", Strength.STRONG)
        if (s.campaign || tab == "promotions" || MARKETING.matches(local)) return RuleResult("promotions", Strength.STRONG)
        if (MONEY.containsMatchIn(m.subject)) return RuleResult("money", Strength.WEAK)
        if (isMachine(from) || s.auto) return RuleResult("updates", Strength.STRONG)
        if (tab == "social" || tab == "updates" || tab == "forums") return RuleResult("updates", Strength.WEAK)
        // Mail with an unsubscribe link: a newsletter, unless it comes from someone you write to (a mailing list).
        if (s.list) return if (known) personal(Strength.WEAK) else RuleResult("promotions", Strength.WEAK)
        if (s.bulk) return RuleResult("updates", Strength.WEAK)
        // A person: someone you write to, a colleague, or a name that matches the address.
        val colleague = own.any { domainOf(it).lowercase() == domainOf(from.address).lowercase() }
        if (known || colleague || looksLikePerson(from) || Sites.siteOf(from.address) == null) return personal(Strength.WEAK)
        // Anything else from a company's own domain is usually a message from its systems.
        return RuleResult("updates", Strength.WEAK)
    }
}

/**
 * The site an address belongs to, from desktop's logos.js siteOf: "nieuwsbrieven.anwb.nl" is "anwb.nl",
 * "mail.bbc.co.uk" is "bbc.co.uk". Free-mail providers give null: their domain says nothing about the sender.
 */
object Sites {
    private val PERSONAL = setOf(
        "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.nl", "live.com", "live.nl", "msn.com",
        "yahoo.com", "yahoo.nl", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "mail.com", "gmx.com",
        "gmx.net", "gmx.de", "web.de", "proton.me", "protonmail.com", "pm.me", "tutanota.com", "fastmail.com", "hey.com",
        "duck.com", "ziggo.nl", "kpnmail.nl", "kpnplanet.nl", "planet.nl", "home.nl", "hetnet.nl", "xs4all.nl",
        "telfort.nl", "casema.nl", "chello.nl", "upcmail.nl", "quicknet.nl", "tele2.nl", "online.nl", "zonnet.nl",
        "freedom.nl", "caiway.nl", "solcon.nl", "onsbrabantnet.nl", "telenet.be", "skynet.be",
    )
    private val SECOND_LEVEL = setOf("co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc")
    private val DOMAIN = Regex("[a-z0-9.-]+\\.[a-z]{2,}", RegexOption.IGNORE_CASE)

    fun siteOf(address: String?): String? {
        val domain = address.orEmpty().split('@').getOrNull(1)
        if (domain.isNullOrEmpty() || !DOMAIN.matches(domain)) return null
        val labels = domain.lowercase().split('.')
        val take = if (labels.size > 2 && labels.last().length == 2 && labels[labels.size - 2] in SECOND_LEVEL) 3 else 2
        val site = labels.takeLast(take).joinToString(".")
        return if (site in PERSONAL || domain.lowercase() in PERSONAL) null else site
    }
}
