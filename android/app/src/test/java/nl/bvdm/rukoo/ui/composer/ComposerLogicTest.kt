package nl.bvdm.rukoo.ui.composer

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.AttachmentInfo
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.Identity
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.ui.ComposerController
import nl.bvdm.rukoo.ui.ComposerState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ComposerLogicTest {
    private val me = Identity("demo@example.com", "Demo User", primary = true)
    private val alias = Identity("hello@example.com", "Demo", primary = false)
    private val sanne = Address("Sanne de Vries", "sanne@studio.nl")
    private val joris = Address("Joris Bakker", "joris@studio.nl")

    private val labels = QuoteLabels(
        marker = "-------- Original message --------",
        from = { "From: $it" },
        date = { "Date: $it" },
        to = { "To: $it" },
        subject = { "Subject: $it" },
        formatDate = { "08/10/2026 16:12 (GMT+02:00)" },
    )

    private fun message(
        from: Address = sanne,
        to: List<Address> = listOf(Address("Demo User", "demo@example.com"), joris),
        cc: List<Address> = emptyList(),
        replyTo: List<Address> = emptyList(),
    ) = FullMessage(
        summary = MessageSummary(id = "demo:INBOX:7", accountId = "demo", folder = "INBOX", role = FolderRole.INBOX, uid = 7, subject = "Call on Thursday", from = from, to = to, cc = cc, replyTo = replyTo, date = 1),
        references = listOf("<a@x>"),
        messageId = "<call@studio.nl>",
        text = "Hi!\nShall we have a call?",
        attachments = listOf(AttachmentInfo(0, "Proposal-v3.pdf", "application/pdf", 192)),
    )

    @Test
    fun prefixesInTheUsualLanguagesAreKept() {
        assertEquals("Re: Call", LocalReplyBuilder.prefixed("Call", "Re"))
        assertEquals("RE: Call", LocalReplyBuilder.prefixed("RE: Call", "Re"))
        assertEquals("Antw: Call", LocalReplyBuilder.prefixed("Antw: Call", "Re"))
        assertEquals("Fwd: Call", LocalReplyBuilder.prefixed("Call", "Fwd"))
        assertEquals("Doorst: Call", LocalReplyBuilder.prefixed("Doorst: Call", "Fwd"))
        assertEquals("Re: Fwd: Call", LocalReplyBuilder.prefixed("Fwd: Call", "Re"))
    }

    @Test
    fun replyGoesToTheSenderAndReplyAllToTheOthersWithoutYou() {
        val (to, cc) = LocalReplyBuilder.envelope(message(cc = listOf(Address("Eva", "eva@x.nl"), Address("", "DEMO@example.com"))), ReplyKind.REPLY, listOf(me))
        assertEquals(listOf(sanne), to)
        assertTrue(cc.isEmpty())
        val (allTo, allCc) = LocalReplyBuilder.envelope(message(cc = listOf(Address("Eva", "eva@x.nl"), Address("", "DEMO@example.com"))), ReplyKind.REPLY_ALL, listOf(me))
        assertEquals(listOf(sanne, joris), allTo)
        assertEquals(listOf(Address("Eva", "eva@x.nl")), allCc)
        // Reply-To wins over From; your own sent mail answers its recipients.
        assertEquals(listOf(Address("", "list@x.nl")), LocalReplyBuilder.envelope(message(replyTo = listOf(Address("", "list@x.nl"))), ReplyKind.REPLY, listOf(me)).first)
        assertEquals(listOf(Address("", "x@y.nl")), LocalReplyBuilder.envelope(message(from = Address("Demo", "demo@example.com"), to = listOf(Address("", "x@y.nl"))), ReplyKind.REPLY, listOf(me)).first)
    }

    @Test
    fun replyFromPicksTheAddressTheMailCameTo() {
        val toAlias = message(to = listOf(Address("", "hello@example.com")))
        assertEquals("hello@example.com", LocalReplyBuilder.replyFrom(toAlias, listOf(me, alias), null)!!.address)
        assertEquals("demo@example.com", LocalReplyBuilder.replyFrom(message(), listOf(me, alias), null)!!.address)
        assertEquals("hello@example.com", LocalReplyBuilder.replyFrom(message(to = listOf(joris)), listOf(me, alias), Address("Demo", "hello@example.com"))!!.address)
    }

    @Test
    fun aReplyCarriesThreadingAndTheQuote() {
        val d = LocalReplyBuilder.reply(message(), ReplyKind.REPLY, listOf(me), null, "Demo\nRukoo", labels)
        assertEquals("Re: Call on Thursday", d.subject)
        assertEquals("<call@studio.nl>", d.inReplyTo)
        assertEquals(listOf("<a@x>", "<call@studio.nl>"), d.references)
        assertEquals("\n\nDemo\nRukoo", d.body)
        assertEquals(
            "-------- Original message --------\nFrom: Sanne de Vries <sanne@studio.nl>\nDate: 08/10/2026 16:12 (GMT+02:00)\n" +
                "To: Demo User <demo@example.com>, Joris Bakker <joris@studio.nl>\nSubject: Call on Thursday\n\nHi!\nShall we have a call?",
            d.quote,
        )
        assertTrue(d.attachments.isEmpty())
    }

    @Test
    fun aForwardTakesTheAttachmentsAndNoThreading() {
        val d = LocalReplyBuilder.reply(message(), ReplyKind.FORWARD, listOf(me), null, null, labels)
        assertEquals("Fwd: Call on Thursday", d.subject)
        assertTrue(d.to.isEmpty())
        assertNull(d.inReplyTo)
        assertEquals("demo:INBOX:7", d.attachments.single().sourceMessageId)
        assertEquals(0, d.attachments.single().sourceIndex)
    }

    @Test
    fun theOutgoingMailHasDesktopsQuoteMarkers() {
        val d = LocalReplyBuilder.reply(message(), ReplyKind.REPLY, listOf(me), null, null, labels).copy(body = "Works for me.\n\n<b>me</b>")
        val out = LocalReplyBuilder.outgoing(d, "demo", Address("Demo User", "demo@example.com"), "<p>Hi!</p>")
        assertTrue(out.html!!.startsWith("<div style=\"font-family:'Segoe UI',Arial,sans-serif;font-size:12pt\"><div>Works for me.</div><div><br></div><div>&lt;b&gt;me&lt;/b&gt;</div>"))
        assertTrue(out.html!!.contains("<br><div data-rukoo-quote style=\"font-size:13px;color:#555\">-------- Original message --------<br>From: Sanne de Vries &lt;sanne@studio.nl&gt;"))
        assertTrue(out.html!!.contains("<blockquote style=\"margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex\"><p>Hi!</p></blockquote>"))
        assertTrue(out.text.startsWith("Works for me.\n\n<b>me</b>\n\n-------- Original message --------"))
        assertTrue(out.text.endsWith("> Hi!\n> Shall we have a call?"))
        assertEquals("demo:INBOX:7", out.sourceMessageId)
        // Excluded, the quote stays out of both parts.
        val bare = LocalReplyBuilder.outgoing(d.copy(quoteExcluded = true), "demo", Address("", "demo@example.com"), "<p>Hi!</p>")
        assertFalse(bare.html!!.contains("data-rukoo-quote"))
        assertEquals("Works for me.\n\n<b>me</b>", bare.text)
    }

    @Test
    fun recipientsFromTyping() {
        assertEquals(listOf(Address("Last, First", "a@b.nl"), Address("", "c@d.nl")), Recipients.parse("\"Last, First\" <a@b.nl>; c@d.nl"))
        assertEquals(listOf(Address("", "a@b.nl")) to "jo", Recipients.split("a@b.nl, jo"))
        // A comma inside a quoted name or angle brackets doesn't end the recipient.
        assertEquals(emptyList<Address>() to "\"Last, First\" <a@b.nl>", Recipients.split("\"Last, First\" <a@b.nl>"))
        assertEquals(listOf(Address("Last, First", "a@b.nl")) to "", Recipients.split("\"Last, First\" <a@b.nl>,"))
        assertEquals(emptyList<Address>() to "Odd <a,b@c.nl>", Recipients.split("Odd <a,b@c.nl>"))
        assertEquals(listOf(Address("", "a@b.nl")) to "", Recipients.split("a@b.nl "))
        assertEquals(emptyList<Address>() to "Sanne ", Recipients.split("Sanne "))
        assertTrue(Recipients.isValid("sanne@studio.nl"))
        assertFalse(Recipients.isValid("sanne@studio"))
        assertFalse(Recipients.isValid("san ne@studio.nl"))
        val merged = Recipients.merge(listOf(sanne), listOf(Address("", "SANNE@studio.nl"), joris))
        assertEquals(listOf(sanne, joris), merged)
        val contacts = listOf(sanne, joris, Address("Eva", "eva@x.nl"))
        assertEquals(listOf(joris), Recipients.suggest(contacts, "jor", emptyList()))
        assertEquals(listOf(joris), Recipients.suggest(contacts, "studio", listOf(sanne)))
        assertTrue(Recipients.suggest(contacts, " ", emptyList()).isEmpty())
    }

    @Test
    fun undoingAnAgentsDraftBringsBackWhatWasThere() {
        val composer = ComposerController()
        val mine = composer.open(ComposerState(subject = "Re: Call", body = "my words", dirty = true))
        composer.update { it.copy(body = "agent words", draftedBy = "Clark") }
        assertTrue(composer.undoAgentDraft())
        assertEquals("my words", composer.current()!!.body)
        assertEquals(mine, composer.current()!!.id)
        assertNull(composer.current()!!.draftedBy)
        // The agent opened the composer itself: undo keeps the fields and drops its text.
        composer.close()
        composer.open(ComposerState(to = listOf(sanne), subject = "Re: Call", body = "agent", draftedBy = "Clark"))
        composer.update { it.copy(body = "agent, again") }
        assertTrue(composer.undoAgentDraft())
        assertEquals("", composer.current()!!.body)
        assertEquals(listOf(sanne), composer.current()!!.to)
        assertFalse(composer.undoAgentDraft())
    }

    @Test
    fun anAgentRewritingItsDraftKeepsTheFirstSnapshot() {
        val composer = ComposerController()
        composer.open(ComposerState(body = "mine"))
        composer.update { it.copy(body = "v1", draftedBy = "Clark") }
        composer.update { it.copy(body = "v2", draftedBy = "Clark") }
        assertTrue(composer.undoAgentDraft())
        assertEquals("mine", composer.current()!!.body)
    }

    @Test
    fun draftsKeepTheNewestOnTopAndSurviveARestart() = runTest {
        val dir = Files.createTempDirectory("drafts").toFile()
        val file = File(dir, DraftStore.FILE_NAME)
        var clock = 1000L
        val io = StandardTestDispatcher(testScheduler)
        val store = DraftStore(file, io, now = { clock })
        assertTrue(store.save(ComposerState(id = "a", subject = "A", dirty = true)))
        clock = 2000L
        assertTrue(store.save(ComposerState(id = "b", subject = "B")))
        assertTrue(store.save(ComposerState(id = "a", subject = "A2")))
        assertEquals(listOf("a", "b"), store.drafts.value.map { it.id })
        assertEquals("A2", store.get("a")!!.subject)
        assertFalse(store.get("a")!!.dirty)
        assertEquals(2000L, store.get("a")!!.savedAt)
        assertTrue(store.remove("a"))
        assertEquals(listOf("b"), store.drafts.value.map { it.id })
        // On disk once save returned: a new store (the next process) reads it back.
        assertEquals(listOf("b"), DraftStore(file).drafts.value.map { it.id })
        dir.deleteRecursively()
    }

    @Test
    fun aDraftThatCantBeWrittenIsNotReportedKept() = runTest {
        // A directory where the file should be: the write fails.
        val dir = Files.createTempDirectory("drafts").toFile()
        val blocked = File(dir, DraftStore.FILE_NAME).apply { mkdirs() }
        File(blocked, "x").writeText("keeps the directory non-empty")
        val store = DraftStore(blocked, StandardTestDispatcher(testScheduler))
        assertFalse(store.save(ComposerState(id = "a", body = "words")))
        assertTrue(store.drafts.value.isEmpty())
        dir.deleteRecursively()
    }
}
