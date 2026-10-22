package nl.bvdm.rukoo.mail.compose

import java.time.ZoneId
import java.util.Locale
import java.util.UUID
import nl.bvdm.rukoo.core.Ids
import nl.bvdm.rukoo.mail.mime.MailText
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.Identity
import nl.bvdm.rukoo.mail.model.OutgoingAttachment
import nl.bvdm.rukoo.mail.model.OutgoingMessage
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.ui.ComposerState
import org.jsoup.Jsoup

/**
 * What the composer starts with for a new message, reply, forward or reopened draft. [body] is plain
 * text without the signature, which the engine adds when sending unless [signatureExcluded]; [quote] is
 * the HTML quote block, '' for none. Forwarded and draft attachments point at their source message by
 * index and are fetched when sending.
 */
data class ComposerFields(
    val accountId: String,
    val from: Address,
    val to: List<Address> = emptyList(),
    val cc: List<Address> = emptyList(),
    val bcc: List<Address> = emptyList(),
    val subject: String = "",
    val body: String = "",
    val quote: String = "",
    val replyKind: ReplyKind,
    /** The message replied to or forwarded; for a reopened draft, the draft itself. */
    val sourceMessageId: String? = null,
    val inReplyTo: String? = null,
    val references: List<String> = emptyList(),
    val attachments: List<OutgoingAttachment> = emptyList(),
    /** The stored draft these fields came from; sending or saving again replaces it. */
    val draftId: String? = null,
    /** A reopened draft that was saved without a signature stays without one. */
    val signatureExcluded: Boolean = false,
    /** [body] with its formatting (RichText's subset), null for plain text: a reopened formatted draft. */
    val bodyHtml: String? = null,
) {
    /**
     * The composer for these fields. A stored draft gets a composer key of its own, so opening the same
     * draft again brings its composer to the front instead of a second copy.
     */
    fun toComposerState(): ComposerState = ComposerState(
        id = draftId?.let { UUID.nameUUIDFromBytes("draft|$it".toByteArray()).toString() } ?: Ids.uuid(),
        accountId = accountId,
        from = from,
        to = to,
        cc = cc,
        bcc = bcc,
        subject = subject,
        body = body,
        quote = quote,
        replyKind = replyKind,
        sourceMessageId = sourceMessageId,
        inReplyTo = inReplyTo,
        references = references,
        attachments = attachments,
        signatureExcluded = signatureExcluded,
        draftId = draftId,
        bodyHtml = bodyHtml,
    )
}

/**
 * The message to send (or save) from the composer's state, from [accountId] (the composer's, or the
 * default account when it has none) as [from] unless the composer picked one. A stored draft the composer
 * edits ([ComposerState.draftId]) is replaced by it. A left-out quote or signature stays out.
 */
fun ComposerState.toOutgoing(accountId: String, from: Address): OutgoingMessage = OutgoingMessage(
    accountId = accountId,
    from = this.from ?: from,
    to = to,
    cc = cc,
    bcc = bcc,
    subject = subject,
    text = body,
    inReplyTo = inReplyTo,
    references = references,
    attachments = attachments,
    replyKind = replyKind,
    sourceMessageId = sourceMessageId,
    quote = if (quoteExcluded) "" else quote,
    signature = !signatureExcluded,
    draftId = draftId,
    html = richHtml(),
)

/** Reply, reply-all, forward and reopen-draft, ported from desktop's composer (composer.js:18-237, spec 4 §3.6, §3.8). */
object ReplyBuilder {
    /** Adds "Re: " or "Fwd: " unless the subject already starts with a reply or forward prefix (English, Dutch or German). */
    fun prefixed(subject: String?, prefix: String): String {
        val s = subject.orEmpty()
        val re = if (prefix == "Re") Regex("^(re|antw|aw)\\s*:", RegexOption.IGNORE_CASE) else Regex("^(fwd?|doorst)\\s*:", RegexOption.IGNORE_CASE)
        return if (re.containsMatchIn(MailText.jsTrim(s))) s else "$prefix: $s"
    }

    private fun same(a: String?, b: String?) = a.orEmpty().equals(b.orEmpty(), ignoreCase = true)

    /** Unique by lower-case address, dropping empty ones. */
    fun uniq(list: List<Address>): List<Address> {
        val seen = mutableSetOf<String>()
        return list.filter { a ->
            val k = a.address.lowercase()
            k.isNotEmpty() && seen.add(k)
        }
    }

    /**
     * To and Cc of a reply to [m]: the sender (or its Reply-To), and for reply-all everyone else except
     * you. Mail you sent yourself is answered to its original recipients.
     */
    fun replyEnvelope(identities: List<Identity>, m: FullMessage, all: Boolean): Pair<List<Address>, List<Address>> {
        fun own(address: String?) = identities.any { same(it.address, address) }
        val fromSelf = own(m.from.address)
        var to = if (fromSelf) m.to else (m.replyTo.ifEmpty { listOf(m.from) }).filter { it.address.isNotEmpty() || it.name.isNotEmpty() }
        var cc = emptyList<Address>()
        if (all) {
            val extra = if (fromSelf) emptyList() else m.to.filter { !own(it.address) }
            to = uniq(to + extra)
            cc = uniq(m.cc.filter { a -> !own(a.address) && to.none { same(it.address, a.address) } })
        }
        return to to cc
    }

    /** Answer from the address the mail was sent to, so mail to an alias is answered from that alias. */
    fun replyFrom(account: Account, identities: List<Identity>, m: FullMessage): String? {
        identities.firstOrNull { same(it.address, m.from.address) }?.let { return it.address }
        val recipients = m.to + m.cc
        identities.firstOrNull { i -> !i.primary && recipients.any { same(it.address, i.address) } }?.let { return it.address }
        return if (recipients.any { same(it.address, account.email) }) account.email else null
    }

    /** The From the account sends with by default: its chosen address, else its own. */
    fun defaultIdentity(account: Account, identities: List<Identity>): Identity =
        identities.firstOrNull { same(it.address, account.defaultFrom) } ?: identities.firstOrNull()
            ?: Identity(account.email, account.name, primary = true)

    private fun addressOf(identities: List<Identity>, address: String, fallback: Identity): Address {
        val identity = identities.firstOrNull { same(it.address, address) } ?: fallback
        return Address(identity.name, identity.address)
    }

    /**
     * The composer's fields for [kind] on [m]; [labels] are the quote header's texts. The body starts empty:
     * the account's signature goes under it when the mail is sent (ComposeBody.build).
     */
    fun build(
        kind: ReplyKind,
        m: FullMessage,
        account: Account,
        identities: List<Identity>,
        labels: QuoteLabels = QuoteLabels.ENGLISH,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): ComposerFields {
        val fallback = defaultIdentity(account, identities)
        return when (kind) {
            ReplyKind.REPLY, ReplyKind.REPLY_ALL -> {
                val (to, cc) = replyEnvelope(identities, m, kind == ReplyKind.REPLY_ALL)
                ComposerFields(
                    accountId = account.id,
                    from = addressOf(identities, replyFrom(account, identities, m) ?: fallback.address, fallback),
                    to = to,
                    cc = cc,
                    subject = prefixed(m.subject, "Re"),
                    quote = Quote.of(m, labels, zone, locale),
                    replyKind = kind,
                    sourceMessageId = m.id,
                    inReplyTo = m.messageId,
                    references = (m.references + listOfNotNull(m.messageId)).filter { it.isNotBlank() },
                )
            }
            ReplyKind.FORWARD -> ComposerFields(
                accountId = account.id,
                from = addressOf(identities, replyFrom(account, identities, m) ?: fallback.address, fallback),
                subject = prefixed(m.subject, "Fwd"),
                quote = Quote.of(m, labels, zone, locale),
                replyKind = kind,
                sourceMessageId = m.id,
                attachments = m.attachments.map {
                    OutgoingAttachment(it.filename, it.contentType, path = "", size = it.size, sourceMessageId = m.id, sourceIndex = it.index)
                },
            )
            ReplyKind.DRAFT -> draft(m, account, identities)
            ReplyKind.NEW -> ComposerFields(
                accountId = account.id,
                from = Address(fallback.name, fallback.address),
                replyKind = kind,
            )
        }
    }

    /**
     * A stored draft opened again (composer.js modeState 'draft'): its From when it is one of the account's
     * addresses, recipients, subject and threading headers; the text without the quote, which comes back
     * as the quote block, and without its signature block, which the account's signature replaces when it
     * goes (a draft saved without one stays without); its attachments by index. Its formatting comes back as
     * far as the composer's subset reaches (RichText.parse); the rest of the markup leaves its text.
     */
    fun draft(m: FullMessage, account: Account, identities: List<Identity>): ComposerFields {
        val fallback = defaultIdentity(account, identities)
        val split = Quote.split(m.html)
        val quote = if (split.head != null && split.quoteHtml != null) Quote.block(split.head, split.quoteHtml) else ""
        val (body, signed) = if (m.isHtml) withoutSignature(split.body) else split.body to false
        val rich = if (m.isHtml) RichText.trim(RichText.parse(body)) else null
        val text = if (rich != null) RichText.plain(rich) else m.text
        return ComposerFields(
            accountId = account.id,
            from = addressOf(identities, m.from.address, fallback),
            to = m.to,
            cc = m.cc,
            bcc = m.bcc,
            subject = m.subject,
            body = text,
            quote = quote,
            replyKind = ReplyKind.DRAFT,
            sourceMessageId = m.id,
            inReplyTo = m.inReplyTo,
            references = m.references,
            attachments = m.attachments.map {
                OutgoingAttachment(it.filename, it.contentType, path = "", size = it.size, sourceMessageId = m.id, sourceIndex = it.index)
            },
            draftId = m.id,
            signatureExcluded = !signed,
            bodyHtml = rich?.takeUnless { it.isPlain }?.let(RichText::toHtml),
        )
    }

    /**
     * Takes desktop's `<div class="signature">` and the empty line before it out of a draft's body
     * (composer.js:96-98 put them there). Returns the rest and whether there was one.
     */
    internal fun withoutSignature(bodyHtml: String): Pair<String, Boolean> {
        val doc = Jsoup.parseBodyFragment(bodyHtml)
        doc.outputSettings().prettyPrint(false)
        val sig = doc.body().selectFirst("div.signature") ?: return bodyHtml to false
        val spacer = sig.previousElementSibling()
        if (spacer != null && spacer.normalName() == "div" && spacer.text().isBlank() && spacer.select("img").isEmpty()) spacer.remove()
        sig.remove()
        return doc.body().html() to true
    }
}
