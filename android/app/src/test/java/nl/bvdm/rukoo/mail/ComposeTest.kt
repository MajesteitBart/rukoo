package nl.bvdm.rukoo.mail

import java.time.ZoneId
import java.util.Locale
import nl.bvdm.rukoo.mail.compose.ComposeBody
import nl.bvdm.rukoo.mail.compose.Quote
import nl.bvdm.rukoo.mail.compose.QuoteLabels
import nl.bvdm.rukoo.mail.compose.ReplyBuilder
import nl.bvdm.rukoo.mail.compose.toOutgoing
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.AccountType
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.Alias
import nl.bvdm.rukoo.mail.model.AttachmentInfo
import nl.bvdm.rukoo.mail.model.AuthKind
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.mail.model.Signature
import nl.bvdm.rukoo.mail.engine.MailViews
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposeTest {
    private val me = Address("Demo User", "demo@example.com")
    private val sanne = Address("Sanne de Vries", "sanne@example.com")
    private val joris = Address("Joris Bakker", "joris@example.com")
    private val account = Account(
        id = "acc", type = AccountType.IMAP, provider = "other", auth = AuthKind.PASSWORD, email = "demo@example.com", name = "Demo User",
        aliases = listOf(Alias("hello@example.com", "Hello desk")),
    )
    private val identities = MailViews.identities(account)
    private val zone = ZoneId.of("Europe/Amsterdam")

    // 2026-10-21 16:12 in Amsterdam (CEST, +02:00).
    private val call = FullMessage(
        summary = MessageSummary(
            id = "acc:INBOX:12", accountId = "acc", folder = "INBOX", uid = 12, messageId = "<demo-13@example.com>",
            subject = "Call on Thursday", from = sanne, to = listOf(me), cc = listOf(joris),
            date = java.time.Instant.parse("2026-10-21T16:12:00Z").toEpochMilli(),
        ),
        references = listOf("<older@example.com>"),
        html = "<html><head><style>p{margin:0}</style></head><body><p>Shall we have a call?</p></body></html>",
        isHtml = true,
        text = "Shall we have a call?",
        attachments = listOf(AttachmentInfo(1, "Proposal-v3.pdf", "application/pdf", 210)),
    )

    @Test
    fun `subjects get one Re or Fwd prefix, also after Dutch and German ones`() {
        assertEquals("Re: Call", ReplyBuilder.prefixed("Call", "Re"))
        assertEquals("Re: Call", ReplyBuilder.prefixed("Re: Call", "Re"))
        assertEquals("Antw: Call", ReplyBuilder.prefixed("Antw: Call", "Re"))
        assertEquals("AW: Call", ReplyBuilder.prefixed("AW: Call", "Re"))
        assertEquals("Fwd: Call", ReplyBuilder.prefixed("Call", "Fwd"))
        assertEquals("Doorst: Call", ReplyBuilder.prefixed("Doorst: Call", "Fwd"))
        assertEquals("Fwd: Re: Call", ReplyBuilder.prefixed("Re: Call", "Fwd"))
        assertEquals("Re: ", ReplyBuilder.prefixed(null, "Re"))
    }

    @Test
    fun `reply goes to the sender, reply-all adds everyone but you`() {
        val reply = ReplyBuilder.build(ReplyKind.REPLY, call, account, identities, QuoteLabels.ENGLISH, zone, Locale.UK)
        assertEquals(listOf(sanne), reply.to)
        assertTrue(reply.cc.isEmpty())
        assertEquals("Re: Call on Thursday", reply.subject)
        assertEquals("<demo-13@example.com>", reply.inReplyTo)
        assertEquals(listOf("<older@example.com>", "<demo-13@example.com>"), reply.references)
        assertEquals("acc:INBOX:12", reply.sourceMessageId)
        assertEquals(me, reply.from)

        val all = ReplyBuilder.build(ReplyKind.REPLY_ALL, call, account, identities, QuoteLabels.ENGLISH, zone, Locale.UK)
        assertEquals(listOf(sanne), all.to)
        assertEquals(listOf(joris), all.cc)
    }

    @Test
    fun `reply-to wins, mail you sent is answered to its recipients, and an alias answers from itself`() {
        val withReplyTo = call.copy(replyTo = listOf(Address("", "list@example.com")))
        assertEquals(listOf(Address("", "list@example.com")), ReplyBuilder.replyEnvelope(identities, withReplyTo, all = false).first)

        val mine = call.copy(from = me, to = listOf(sanne, joris), cc = listOf(Address("", "SANNE@example.com"), Address("", "x@example.com")))
        val (to, cc) = ReplyBuilder.replyEnvelope(identities, mine, all = true)
        assertEquals(listOf(sanne, joris), to)
        assertEquals(listOf(Address("", "x@example.com")), cc)

        val toAlias = call.copy(to = listOf(Address("", "Hello@example.com")))
        assertEquals("hello@example.com", ReplyBuilder.replyFrom(account, identities, toAlias))
        assertEquals("demo@example.com", ReplyBuilder.replyFrom(account, identities, call))
        assertEquals(null, ReplyBuilder.replyFrom(account, identities, call.copy(to = listOf(joris), cc = emptyList())))
    }

    @Test
    fun `the quote has desktop's header and markers`() {
        val header = Quote.header(call, QuoteLabels.ENGLISH, zone, Locale.UK)
        assertEquals(
            "-------- Original message --------\n" +
                "From: Sanne de Vries <sanne@example.com>\n" +
                "Date: 21/10/2026 18:12 (GMT+02:00)\n" +
                "To: Demo User <demo@example.com>\n" +
                "Cc: Joris Bakker <joris@example.com>\n" +
                "Subject: Call on Thursday",
            header,
        )
        assertEquals("21-10-2026 18:12 (GMT+02:00)", Quote.quoteDate(call.date, zone, Locale.forLanguageTag("nl-NL")))
        val block = Quote.of(call, QuoteLabels.ENGLISH, zone, Locale.UK)
        assertTrue(block.startsWith("<br><div data-rukoo-quote style=\"font-size:13px;color:#555\">-------- Original message --------<br>From: Sanne de Vries &lt;sanne@example.com&gt;<br>"))
        assertTrue(block.endsWith("<br><blockquote style=\"margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex\"><style>p{margin:0}</style><p>Shall we have a call?</p></blockquote>"))
    }

    @Test
    fun `forward carries the attachments and no threading headers`() {
        val fwd = ReplyBuilder.build(ReplyKind.FORWARD, call, account, identities, QuoteLabels.ENGLISH, zone, Locale.UK)
        assertEquals("Fwd: Call on Thursday", fwd.subject)
        assertTrue(fwd.to.isEmpty())
        assertEquals(null, fwd.inReplyTo)
        assertTrue(fwd.references.isEmpty())
        assertEquals(1, fwd.attachments.size)
        assertEquals("acc:INBOX:12", fwd.attachments[0].sourceMessageId)
        assertEquals(1, fwd.attachments[0].sourceIndex)
    }

    @Test
    fun `a reply starts empty and the formatted signature goes between the text and the quote`() {
        val signature = Signature("Bart\nbvdm.ai", "<b>Bart</b><br><a href=\"https://bvdm.ai\">bvdm.ai</a>")
        val reply = ReplyBuilder.build(ReplyKind.REPLY, call, account, identities, QuoteLabels.ENGLISH, zone, Locale.UK)
        // The signature isn't text an agent's draft could replace: the composer keeps it apart.
        assertEquals("", reply.body)
        assertFalse(reply.signatureExcluded)

        val body = ComposeBody.build("Thursday works.\n", signature, reply.quote)
        assertTrue(body.html.startsWith("<div style=\"font-family:'Segoe UI',Arial,sans-serif;font-size:12pt\"><div>Thursday works.</div><div><br></div><div class=\"signature\"><b>Bart</b>"))
        assertTrue(body.html.indexOf("class=\"signature\"") < body.html.indexOf("<div data-rukoo-quote"))
        assertTrue(body.html.endsWith("</blockquote></div>"))
        assertTrue(body.text.startsWith("Thursday works.\n\nBart\nbvdm.ai\n\n-------- Original message --------"))
        assertTrue(body.text.contains("> Shall we have a call?"))

        val without = ComposeBody.build("Thursday works.", null, "")
        assertFalse(without.html.contains("class=\"signature\""))
        assertEquals("Thursday works.", without.text)
    }

    @Test
    fun `a plain-text quote from an agent tool is escaped into desktop's block`() {
        val plain = "-------- Original message --------\nFrom: Sanne\n\nHi <img src=x onerror=alert(1)> there"
        val body = ComposeBody.build("Sure.", null, plain)
        assertTrue(body.html.contains("<div data-rukoo-quote"))
        assertTrue(body.html.contains("Hi &lt;img src=x onerror=alert(1)&gt; there"))
        assertFalse(body.html.contains("<img"))
        assertEquals("-------- Original message --------\nFrom: Sanne" to "Hi <img src=x onerror=alert(1)> there", Quote.parts(plain))
        // Desktop's block itself passes through untouched.
        val block = Quote.block("-------- Original message --------", "<p>Hi</p>")
        assertEquals(block, Quote.normalize(block))
    }

    @Test
    fun `a signature with only a logo goes along too`() {
        val logo = Signature("", "<img src=\"https://bvdm.ai/logo.png\" width=\"80\">")
        val body = ComposeBody.build("Hi", logo, "")
        assertTrue(body.html.contains("<div>Hi</div><div><br></div><div class=\"signature\"><img src=\"https://bvdm.ai/logo.png\" width=\"80\"></div>"))
        assertEquals("Hi", body.text)
    }

    @Test
    fun `a desktop draft reopens without its signature block and keeps From and attachments`() {
        val html = Quote.WRAPPER_OPEN + "<div>See the PDF.</div><div><br></div><div class=\"signature\"><b>Hello desk</b></div>" +
            Quote.block("-------- Original message --------\nFrom: Sanne", "<p>Old</p>") + "</div>"
        val draft = call.copy(
            summary = call.summary.copy(id = "acc:Drafts:7", folder = "Drafts", from = Address("Hello desk", "hello@example.com")),
            from = Address("Hello desk", "hello@example.com"),
            html = html,
        )
        val reopened = ReplyBuilder.build(ReplyKind.DRAFT, draft, account, identities)
        assertEquals("See the PDF.", reopened.body)
        assertFalse(reopened.signatureExcluded)
        assertEquals("hello@example.com", reopened.from.address)
        assertEquals(listOf("acc:Drafts:7" to 1), reopened.attachments.map { it.sourceMessageId to it.sourceIndex })
        assertTrue(reopened.quote.contains("<blockquote"))

        // A draft saved without a signature doesn't get one.
        val bare = draft.copy(html = Quote.WRAPPER_OPEN + "<div>Just text.</div></div>")
        assertTrue(ReplyBuilder.build(ReplyKind.DRAFT, bare, account, identities).signatureExcluded)

        // Opening it twice gives the same composer key, so its composer comes to the front instead of a second one.
        assertEquals(reopened.toComposerState().id, reopened.toComposerState().id)
        val out = reopened.toComposerState().copy(quoteExcluded = true).toOutgoing("acc", me)
        assertEquals("acc:Drafts:7", out.draftId)
        assertEquals("", out.quote)
        assertTrue(out.signature)
        assertEquals("hello@example.com", out.from.address)
    }

    @Test
    fun `a saved reply reopens with its quote split off and round-trips`() {
        val reply = ReplyBuilder.build(ReplyKind.REPLY, call, account, identities, QuoteLabels.ENGLISH, zone, Locale.UK)
        val html = ComposeBody.build("Yes, 10:00 is fine.", null, reply.quote).html
        val draft = call.copy(
            summary = call.summary.copy(id = "acc:Drafts:5", folder = "Drafts", from = me, to = listOf(sanne), cc = emptyList(), subject = "Re: Call on Thursday"),
            from = me,
            to = listOf(sanne),
            cc = emptyList(),
            subject = "Re: Call on Thursday",
            html = html,
            inReplyTo = "<demo-13@example.com>",
            references = reply.references,
            attachments = emptyList(),
        )
        val reopened = ReplyBuilder.build(ReplyKind.DRAFT, draft, account, identities)
        assertEquals("Yes, 10:00 is fine.", reopened.body)
        assertEquals("acc:Drafts:5", reopened.draftId)
        assertEquals(reply.quote.substringAfter("<blockquote"), reopened.quote.substringAfter("<blockquote"))
        assertTrue(reopened.quote.contains("-------- Original message --------<br>From: Sanne de Vries"))
        assertEquals(listOf(sanne), reopened.to)
        assertEquals("<demo-13@example.com>", reopened.inReplyTo)

        val state = reopened.toComposerState()
        assertEquals("acc:Drafts:5", state.draftId)
        // Saved without a signature, it stays without one.
        assertTrue(state.signatureExcluded)
        val outgoing = state.toOutgoing("acc", me)
        assertEquals("acc:Drafts:5", outgoing.draftId)
        assertEquals(reopened.quote, outgoing.quote)
        assertFalse(outgoing.signature)
    }

    @Test
    fun `older Dutch drafts without the marker attribute split too`() {
        val html = "<div>Tekst</div><br><div style=\"font-size:13px\">-------- Oorspronkelijk bericht --------<br>Van: Sanne</div><br><blockquote>Oud</blockquote>"
        val split = Quote.split(html)
        assertEquals("<div>Tekst</div>", split.body)
        assertEquals("-------- Oorspronkelijk bericht --------\nVan: Sanne", split.head)
        assertEquals("Oud", split.quoteHtml)
    }

    @Test
    fun `inline data images go out as one cid attachment each`() {
        val png = "iVBORw0KGgo="
        val (html, attachments) = ComposeBody.inlineDataImages(
            "<img src=\"data:image/png;base64,$png\"><img alt=\"x\" src='data:image/png;base64,$png'><img src=\"data:image/jpg;base64,/9j/\">",
        )
        assertEquals(2, attachments.size)
        assertEquals("image-1.png", attachments[0].filename)
        assertEquals("image/png", attachments[0].contentType)
        assertEquals("image-2.jpg", attachments[1].filename)
        assertEquals("image/jpeg", attachments[1].contentType)
        assertTrue(attachments[0].cid!!.matches(Regex("[0-9a-f]{20}@rukoo")))
        assertEquals(2, Regex("cid:${Regex.escape(attachments[0].cid!!)}").findAll(html).count())
        assertFalse(html.contains("data:image"))
    }
}
