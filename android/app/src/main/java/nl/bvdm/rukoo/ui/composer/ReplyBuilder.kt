package nl.bvdm.rukoo.ui.composer

import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.Identity
import nl.bvdm.rukoo.mail.model.OutgoingAttachment
import nl.bvdm.rukoo.mail.model.OutgoingMessage
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.ui.ComposerState
import org.jsoup.nodes.Entities

/** The translated lines of a quote header (composer.quote.*) and how its date reads (quoteDate). */
class QuoteLabels(
    val marker: String,
    val from: (String) -> String,
    val date: (String) -> String,
    val to: (String) -> String,
    val subject: (String) -> String,
    val formatDate: (Long) -> String,
)

/**
 * Builds the composer's fields for a reply or a forward, and the message Send hands the engine. Track A's
 * builders in mail/compose are meant to replace [LocalReplyBuilder]; the composer only talks to this.
 */
interface ReplyBuilder {
    /**
     * The composer for answering or forwarding [message]. [identities] are the addresses of the message's
     * account, primary first; [defaultFrom] is the account's preferred From; [signature] goes under the
     * empty first lines.
     */
    fun reply(
        message: FullMessage,
        kind: ReplyKind,
        identities: List<Identity>,
        defaultFrom: Address?,
        signature: String?,
        labels: QuoteLabels,
    ): ComposerState

    /** The message to send. [originalHtml] is the quoted message's HTML when it could still be loaded. */
    fun outgoing(state: ComposerState, accountId: String, from: Address, originalHtml: String?): OutgoingMessage
}

/** Desktop's composer rules (composer.js:18-237, spec 4 §3.6), for a plain-text editor. */
object LocalReplyBuilder : ReplyBuilder {
    private val RE = Regex("^(re|antw|aw)\\s*:", RegexOption.IGNORE_CASE)
    private val FWD = Regex("^(fwd?|doorst)\\s*:", RegexOption.IGNORE_CASE)

    /** "Re: " and "Fwd: " unless the subject has one already, in any of the usual languages. Never translated. */
    fun prefixed(subject: String, prefix: String): String {
        val re = if (prefix == "Re") RE else FWD
        return if (re.containsMatchIn(subject.trim())) subject else "$prefix: $subject"
    }

    private fun same(a: String?, b: String?) = !a.isNullOrBlank() && a.trim().equals(b?.trim(), ignoreCase = true)

    private fun uniq(list: List<Address>): List<Address> {
        val seen = HashSet<String>()
        return list.filter { it.address.isNotBlank() && seen.add(it.address.trim().lowercase()) }
    }

    /** replyEnvelope: who a reply goes to. Reply never fills Cc; reply all keeps the others, without you. */
    fun envelope(m: FullMessage, kind: ReplyKind, identities: List<Identity>): Pair<List<Address>, List<Address>> {
        fun own(address: String?) = identities.any { same(it.address, address) }
        val fromSelf = own(m.from.address)
        var to = if (fromSelf) m.to else (m.replyTo.ifEmpty { listOf(m.from) }).filter { it.address.isNotBlank() }
        var cc = emptyList<Address>()
        if (kind == ReplyKind.REPLY_ALL) {
            val extra = if (fromSelf) emptyList() else m.to.filter { !own(it.address) }
            to = uniq(to + extra)
            cc = uniq(m.cc.filter { a -> !own(a.address) && to.none { same(it.address, a.address) } })
        }
        return uniq(to) to cc
    }

    /**
     * replyFrom: the identity that sent the original, else the first alias among To and Cc, else the
     * account's own address when it is there, else the default From.
     */
    fun replyFrom(m: FullMessage, identities: List<Identity>, defaultFrom: Address?): Address? {
        fun addr(i: Identity) = Address(i.name, i.address)
        identities.firstOrNull { same(it.address, m.from.address) }?.let { return addr(it) }
        val recipients = m.to + m.cc
        identities.firstOrNull { i -> !i.primary && recipients.any { same(it.address, i.address) } }?.let { return addr(it) }
        identities.firstOrNull { i -> i.primary && recipients.any { same(it.address, i.address) } }?.let { return addr(it) }
        return defaultFrom ?: identities.firstOrNull()?.let(::addr)
    }

    /** formatAddress: "Name <address>", or the address alone. */
    fun formatAddress(a: Address): String = if (a.name.isNotBlank()) "${a.name.trim()} <${a.address}>" else a.address

    /** The quote header (quoteHeader): marker, From, Date, To, an untranslated Cc when there is one, Subject. */
    fun quoteHeader(m: FullMessage, labels: QuoteLabels): String = buildList {
        add(labels.marker)
        add(labels.from(formatAddress(m.from)))
        add(labels.date(labels.formatDate(m.date)))
        add(labels.to(m.to.joinToString(", ", transform = ::formatAddress)))
        if (m.cc.isNotEmpty()) add("Cc: " + m.cc.joinToString(", ", transform = ::formatAddress))
        add(labels.subject(m.subject))
    }.joinToString("\n")

    override fun reply(
        message: FullMessage,
        kind: ReplyKind,
        identities: List<Identity>,
        defaultFrom: Address?,
        signature: String?,
        labels: QuoteLabels,
    ): ComposerState {
        val forward = kind == ReplyKind.FORWARD
        val (to, cc) = if (forward) emptyList<Address>() to emptyList() else envelope(message, kind, identities)
        val quote = quoteHeader(message, labels) + "\n\n" + message.text.trim()
        return ComposerState(
            accountId = message.accountId,
            from = replyFrom(message, identities, defaultFrom),
            to = to,
            cc = cc,
            subject = prefixed(message.subject, if (forward) "Fwd" else "Re"),
            body = signature?.takeIf { it.isNotBlank() }?.let { "\n\n$it" } ?: "",
            quote = quote,
            replyKind = kind,
            sourceMessageId = message.id,
            inReplyTo = if (forward) null else message.messageId,
            references = if (forward) emptyList() else (message.references + listOfNotNull(message.messageId)).distinct(),
            // A forward takes the original's attachments along; the engine fetches them when it sends.
            attachments = if (forward) {
                message.attachments.map {
                    OutgoingAttachment(it.filename, it.contentType, path = "", size = it.size, sourceMessageId = message.id, sourceIndex = it.index)
                }
            } else {
                emptyList()
            },
        )
    }

    /** One `<div>` per line, `<div><br></div>` for an empty one, as desktop turns plain text into the editor's HTML. */
    fun textToHtml(text: String): String =
        text.replace("\r\n", "\n").split('\n').joinToString("") { line ->
            if (line.isEmpty()) "<div><br></div>" else "<div>${Entities.escape(line)}</div>"
        }

    private fun escapeLines(text: String) = Entities.escape(text).replace("\n", "<br>")

    override fun outgoing(state: ComposerState, accountId: String, from: Address, originalHtml: String?): OutgoingMessage {
        val quoted = state.quote.isNotBlank() && !state.quoteExcluded
        val header = state.quote.substringBefore("\n\n")
        val quotedText = state.quote.substringAfter("\n\n", "")
        val body = state.body.trimEnd()
        val text = if (quoted) {
            body + "\n\n" + header + "\n\n" + quotedText.lines().joinToString("\n") { if (it.isEmpty()) ">" else "> $it" }
        } else {
            body
        }
        // The markers desktop looks for when it reopens a draft (composer.js:822-828, splitQuote).
        val quoteHtml = if (quoted) {
            "<br><div data-rukoo-quote style=\"font-size:13px;color:#555\">${escapeLines(header)}</div><br>" +
                "<blockquote style=\"margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex\">${originalHtml ?: textToHtml(quotedText)}</blockquote>"
        } else {
            ""
        }
        val html = "<div style=\"font-family:'Segoe UI',Arial,sans-serif;font-size:12pt\">${textToHtml(body)}$quoteHtml</div>"
        return OutgoingMessage(
            accountId = accountId,
            from = from,
            to = state.to,
            cc = state.cc,
            bcc = state.bcc,
            subject = state.subject,
            text = text,
            html = html,
            inReplyTo = state.inReplyTo,
            references = state.references,
            attachments = state.attachments,
            replyKind = state.replyKind,
            sourceMessageId = state.sourceMessageId,
        )
    }
}
