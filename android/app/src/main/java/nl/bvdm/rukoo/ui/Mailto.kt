package nl.bvdm.rukoo.ui

import nl.bvdm.rukoo.core.UriComponent
import nl.bvdm.rukoo.mail.model.Address

/** The fields a new message starts with from a mailto: link. */
data class MailtoFields(
    val to: List<Address> = emptyList(),
    val cc: List<Address> = emptyList(),
    val bcc: List<Address> = emptyList(),
    val subject: String = "",
    val body: String = "",
) {
    fun toComposer(): ComposerState = ComposerState(to = to, cc = cc, bcc = bcc, subject = subject, body = body)
}

/**
 * mailto: links (RFC 6068), ported from desktop's src/main/mailto.js: from a link in a message,
 * another app or an unsubscribe header. Only to, cc, bcc, subject and body are read.
 */
object Mailto {
    private const val MAX_RECIPIENTS = 100
    private val ESCAPES = Regex("(?:%[0-9a-fA-F]{2})+")
    private val PARTS = Regex("(?:\"[^\"]*\"|<[^>]*>|[^,])+")
    private val NAMED = Regex("^(.*?)<([^>]+)>$")

    fun isMailto(url: String?): Boolean = url?.startsWith("mailto:", ignoreCase = true) == true

    // A malformed escape stays as it is instead of dropping the link; "+" stays a plus (not a form encoding).
    private fun decode(text: String): String =
        UriComponent.decode(text) ?: ESCAPES.replace(text) { UriComponent.decode(it.value) ?: it.value }

    private fun addresses(text: String): List<Address> = PARTS.findAll(text).mapNotNull { match ->
        val item = match.value.trim()
        if (item.isEmpty()) return@mapNotNull null
        val named = NAMED.find(item)
        val address = (named?.groupValues?.get(2) ?: item).trim()
        if (address.isEmpty()) return@mapNotNull null
        val name = named?.groupValues?.get(1)?.trim()?.removeSurrounding("\"").orEmpty()
        Address(name, address)
    }.toList()

    fun parse(url: String?): MailtoFields {
        if (!isMailto(url)) return MailtoFields()
        val rest = url!!.substring("mailto:".length).substringBefore('#')
        val q = rest.indexOf('?')
        val to = addresses(decode(if (q < 0) rest else rest.substring(0, q))).toMutableList()
        val cc = mutableListOf<Address>()
        val bcc = mutableListOf<Address>()
        var subject = ""
        var body = ""
        if (q >= 0) {
            for (pair in rest.substring(q + 1).split('&')) {
                val eq = pair.indexOf('=')
                val name = decode(if (eq < 0) pair else pair.substring(0, eq)).lowercase()
                val value = decode(if (eq < 0) "" else pair.substring(eq + 1))
                when (name) {
                    "to" -> to += addresses(value)
                    "cc" -> cc += addresses(value)
                    "bcc" -> bcc += addresses(value)
                    // The first subject and body count; RFC 6068 leaves repeats undefined.
                    "subject" -> if (subject.isEmpty()) subject = value
                    "body" -> if (body.isEmpty()) body = value
                }
            }
        }
        return MailtoFields(
            to.take(MAX_RECIPIENTS),
            cc.take(MAX_RECIPIENTS),
            bcc.take(MAX_RECIPIENTS),
            subject,
            body.replace(Regex("\r\n?"), "\n"),
        )
    }

    /**
     * Android's compose-email intent (ACTION_SENDTO to `mailto:`) may carry the fields as extras: EXTRA_EMAIL,
     * EXTRA_CC and EXTRA_BCC join the link's recipients; EXTRA_SUBJECT and EXTRA_TEXT count when the link has
     * no subject or body of its own, as in other mail apps.
     */
    fun withExtras(
        fields: MailtoFields,
        to: Array<String>? = null,
        cc: Array<String>? = null,
        bcc: Array<String>? = null,
        subject: String? = null,
        text: String? = null,
    ): MailtoFields {
        fun join(list: List<Address>, extra: Array<String>?): List<Address> {
            val more = extra.orEmpty().flatMap { addresses(it) }
            return (list + more).distinctBy { it.address.lowercase() }.take(MAX_RECIPIENTS)
        }
        return fields.copy(
            to = join(fields.to, to),
            cc = join(fields.cc, cc),
            bcc = join(fields.bcc, bcc),
            subject = fields.subject.ifEmpty { subject.orEmpty() },
            body = fields.body.ifEmpty { text.orEmpty().replace(Regex("\r\n?"), "\n") },
        )
    }
}
