package nl.bvdm.rukoo.mail.sync

import java.io.File
import nl.bvdm.rukoo.MainActivity
import nl.bvdm.rukoo.NotificationRoute
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.MessageSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class WaitingMailTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun mail(id: String, account: String = "a", date: Long = 1) =
        MessageSummary(id = id, accountId = account, folder = "INBOX", uid = 1, subject = id, from = Address("", "x@example.com"), date = date)

    @Test
    fun aLaterProcessAddsToTheNotificationInsteadOfStartingOver() {
        val file = File(tmp.root, WaitingMail.FILE_NAME)
        val first = WaitingMail(file)
        assertEquals(setOf("a"), first.add(listOf(mail("m1", date = 1), mail("m2", date = 2))))
        // The background sync's process is gone; the next one reads what is in the shade.
        val next = WaitingMail(file)
        assertEquals(setOf("a"), next.add(listOf(mail("m3", date = 3), mail("m2", date = 2))))
        assertEquals(listOf("m3", "m2", "m1"), next.of("a").map { it.id })
        assertTrue(next.add(listOf(mail("m3", date = 3))).isEmpty())
    }

    @Test
    fun readMailLeavesAndOpeningTheAppClearsWhateverProcessPostedIt() {
        val file = File(tmp.root, WaitingMail.FILE_NAME)
        val w = WaitingMail(file)
        w.add(listOf(mail("m1"), mail("m2"), mail("b1", account = "b")))
        val checked = w.ids
        // New mail arrives while the read state of the others is looked up: it stays.
        w.add(listOf(mail("m3", date = 5)))
        // m2 was read on another device; b's only one too.
        assertEquals(setOf("a", "b"), w.drop(setOf("m2", "b1").intersect(checked.toSet())))
        assertEquals(listOf("m3", "m1"), w.of("a").map { it.id })
        assertEquals(setOf("a"), w.accountIds)
        assertTrue(w.drop(setOf("m2")).isEmpty())
        WaitingMail(file).clear()
        assertFalse(file.exists())
        assertTrue(WaitingMail(file).ids.isEmpty())
    }

    @Test
    fun aTapOpensTheOneMessageOrTheAccountsInbox() {
        val one = MailNotifier.extras("a", listOf(mail("m1")))
        // The same keys MainActivity reads, not a set of the notifier's own.
        assertEquals(mapOf(MainActivity.EXTRA_ACCOUNT_ID to "a", MainActivity.EXTRA_MESSAGE_ID to "m1"), one)
        assertEquals(NotificationRoute.Message("m1"), NotificationRoute.of({ one[it] }, { false }))
        val several = MailNotifier.extras("a", listOf(mail("m1"), mail("m2")))
        assertEquals(NotificationRoute.Inbox("a"), NotificationRoute.of({ several[it] }, { false }))
    }
}
