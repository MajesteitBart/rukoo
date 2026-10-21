package nl.bvdm.rukoo.mail.demo

import java.time.LocalDateTime
import java.time.ZoneId
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import nl.bvdm.rukoo.core.Change
import nl.bvdm.rukoo.mail.model.AccountPatch
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.DeleteOutcome
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.MessagePin
import nl.bvdm.rukoo.mail.model.OutgoingMessage
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.mail.model.ViewKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PreviewMailEngineTest {
    private val zone = ZoneId.of("Europe/Amsterdam")
    private val now = LocalDateTime.of(2026, 10, 22, 16, 0).atZone(zone).toInstant().toEpochMilli()
    private fun engine() = PreviewMailEngine({ now }, null, zone)
    private fun id(folder: String, uid: Long) = MessageIds.encode("demo", folder, uid)

    @Test
    fun seedsDesktopsDemoMailbox() = runTest {
        val e = engine()
        val inbox = e.listMessages(MailView.AllInboxes)
        assertEquals(16, inbox.size)
        assertEquals(7, e.unreadCount.value)
        // Spec 4 §7.5: Message-ID number = uid + 1.
        val call = e.summary(id("INBOX", 12))!!
        assertEquals("Call on Thursday", call.subject)
        assertEquals("<demo-13@example.com>", call.messageId)
        assertTrue(call.hasAttachments)
        assertEquals("<demo-19@example.com>", e.summary(id("INBOX", 15))!!.inReplyTo)
        assertEquals("<demo-13@example.com>", e.summary(id("Sent", 17))!!.inReplyTo)
        assertEquals(listOf("Proposal-v3.pdf"), e.fullMessage(call.id).attachments.map { it.filename })
        assertEquals(listOf(id("INBOX", 11), id("INBOX", 15)), e.listMessages(MailView(ViewKind.STARRED)).map { it.id }.sorted())
        // Newest first; today's mail before yesterday's.
        assertEquals("Traffic fines in 2027: what you will pay", inbox.first().subject)
    }

    @Test
    fun newslettersCarryListUnsubscribe() = runTest {
        val e = engine()
        val withHeader = e.listMessages(MailView(ViewKind.EVERYTHING)).filter { e.fullMessage(it.id).unsubscribe != null }.map { it.uid }.sorted()
        assertEquals(listOf(1L, 2L, 10L, 11L), withHeader)
        val anwb = e.fullMessage(id("INBOX", 1))
        assertTrue(anwb.isHtml)
        assertTrue(anwb.html.contains("https://example.com/Top%2010%20cheapest%20new%20cars"))
        assertTrue(e.fullMessage(id("INBOX", 2)).html.contains("https://example.com/The%20music%20industry%20can't%20agree%20on%20AI"))
    }

    @Test
    fun todaysMailIsSqueezedBeforeThreeOClock() {
        val morning = LocalDateTime.of(2026, 10, 22, 9, 0).atZone(zone).toInstant().toEpochMilli()
        val seeded = PreviewData.seed(morning, zone)
        assertTrue(seeded.all { it.date <= morning })
        val today = seeded.filter { it.folder == "INBOX" }.take(11).map { it.date }
        assertEquals(today.sortedDescending(), today)
    }

    @Test
    fun flagsMovesAndUndo() = runTest {
        val e = engine()
        e.setFlags(listOf(id("INBOX", 1)), unread = false)
        assertEquals(6, e.unreadCount.value)
        val moved = e.archive(listOf(id("INBOX", 3)))
        val newId = moved.moved.single().newId!!
        assertEquals("Archive", MessageIds.decode(newId)!!.folder)
        assertNull(e.summary(id("INBOX", 3)))
        assertEquals(newId, e.findMoved("demo", "<demo-4@example.com>"))
        assertTrue(e.canUndo(id("INBOX", 3)))
        val undone = e.undoMove(moved.undoIds)
        assertEquals("INBOX", MessageIds.decode(undone.restored.single())!!.folder)
        assertFalse(e.canUndo(id("INBOX", 3)))
        assertEquals(16, e.listMessages(MailView.AllInboxes).size)
    }

    @Test
    fun movingToTheSameFolderChangesNothing() = runTest {
        val e = engine()
        val result = e.move(listOf(id("INBOX", 12)), "INBOX")
        assertEquals(id("INBOX", 12), result.moved.single().newId)
        assertTrue(result.undoIds.isEmpty())
        assertNotNull(e.summary(id("INBOX", 12)))
        assertEquals(16, e.listMessages(MailView.AllInboxes).size)
    }

    @Test
    fun pinsAndAccountPatches() = runTest {
        val e = engine()
        val pin = e.pinOf(id("INBOX", 12))!!
        assertEquals(MessagePin("<demo-13@example.com>", "1"), pin)
        assertTrue(pin.matches(MessagePin("<DEMO-13@example.com>", "1")))
        assertFalse(pin.matches(MessagePin("<demo-13@example.com>", "2")))
        assertFalse(pin.matches(MessagePin("<other@example.com>", null)))
        assertTrue(MessagePin(null, null).matches(pin))
        val signed = e.updateAccount("demo", AccountPatch(signature = Change("Groet, Demo")))
        assertEquals("Groet, Demo", signed.signature)
        assertEquals("Groet, Demo", e.updateAccount("demo", AccountPatch(name = "Demo")).signature)
        assertNull(e.updateAccount("demo", AccountPatch(signature = Change(null))).signature)
    }

    @Test
    fun deletingFromTrashAsksFirst() = runTest {
        val e = engine()
        assertEquals(DeleteOutcome.NEEDS_CONFIRM, e.delete(listOf(id("Trash", 23))).outcome)
        assertEquals(DeleteOutcome.DELETED, e.delete(listOf(id("Trash", 23)), force = true).outcome)
        assertEquals(DeleteOutcome.TRASHED, e.delete(listOf(id("INBOX", 16))).outcome)
        assertEquals(1, e.listMessages(MailView(ViewKind.TRASH)).size)
    }

    @Test
    fun sendingAppendsToSentAndAnswers() = runTest {
        val e = engine()
        val me = Address("Demo User", "demo@example.com")
        e.send(
            OutgoingMessage(
                "demo", me, listOf(Address("Sanne de Vries", "sanne@example.com")), subject = "Re: Call on Thursday", text = "Works for me",
                inReplyTo = "<demo-13@example.com>", replyKind = ReplyKind.REPLY, sourceMessageId = id("INBOX", 12),
            ),
        )
        val sent = e.listMessages(MailView(ViewKind.SENT))
        assertEquals(4, sent.size)
        assertEquals("Works for me", e.fullMessage(sent.first().id).text)
        assertTrue(e.summary(id("INBOX", 12))!!.answered)
        // Mail to the demo address arrives in its inbox.
        e.send(OutgoingMessage("demo", me, listOf(me), subject = "Note to self", text = "x"))
        assertEquals(8, e.unreadCount.value)
    }

    @Test
    fun searchAndCounts() = runTest {
        val e = engine()
        assertEquals(listOf("Call on Thursday"), e.listMessages(MailView.AllInboxes, "sanne").map { it.subject })
        // Cc isn't searched, like desktop.
        assertTrue(e.listMessages(MailView.AllInboxes, "joris@example.com").none { it.subject == "Call on Thursday" })
        val counts = e.counts().first()
        assertEquals(7, counts.all)
        assertEquals(3, counts.views[ViewKind.DRAFTS])
        assertNotNull(e.contacts().firstOrNull { it.address == "sanne@example.com" })
    }
}
