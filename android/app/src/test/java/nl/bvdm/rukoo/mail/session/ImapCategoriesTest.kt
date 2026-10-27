package nl.bvdm.rukoo.mail.session

import kotlinx.coroutines.runBlocking
import nl.bvdm.rukoo.categories.MailSignals
import nl.bvdm.rukoo.mail.TestStrings
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.AccountType
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.AuthKind
import nl.bvdm.rukoo.mail.model.CachedMessage
import nl.bvdm.rukoo.mail.model.ServerConfig
import nl.bvdm.rukoo.mail.session.FakeImap.Msg
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The inbox sync's category work over a real IMAP conversation (desktop's test/imap.test.js, its last two tests): the
 * signal headers are fetched once per message, and Gmail's tabs are searched on every sync where the server has
 * Gmail's extension. A small scripted IMAP server (FakeImap) answers on a local socket.
 */
class ImapCategoriesTest {
    private val servers = mutableListOf<FakeImap>()
    private val sessions = mutableListOf<ImapSession>()

    @After
    fun tearDown() = runBlocking {
        sessions.forEach { it.close() }
        servers.forEach { it.close() }
    }

    private fun session(server: FakeImap): ImapSession {
        val config = ServerConfig("127.0.0.1", server.port, secure = false, user = "me@example.com")
        val account = Account("acc", AccountType.IMAP, "google", AuthKind.PASSWORD, "me@example.com", "Me", imap = config, smtp = config)
        return ImapSession(account, Credentials.Password("secret"), TestStrings, connectTimeoutMs = 5_000, socketTimeoutMs = 10_000).also { sessions += it }
    }

    private fun stored(uid: Long, subject: String) = CachedMessage(uid = uid, messageId = "<m$uid@example.com>", subject = subject, from = Address("Sender", "s@example.com"), date = 1)

    private fun inbox(capabilities: String) = FakeImap(
        listOf(
            Msg(3, "old newsletter", "List-Unsubscribe: <https://x>"),
            Msg(4, "old, kinds known"),
            Msg(5, "new", "Auto-Submitted: auto-generated"),
        ),
        capabilities,
        mapOf("promotions" to listOf(3L), "updates" to listOf(5L)),
    ).also { servers += it }

    @Test
    fun `an inbox sync collects the mail-kind headers once and asks Gmail for its tabs every time`() = runBlocking {
        val server = inbox("IMAP4rev1 X-GM-EXT-1 UIDPLUS")
        val s = session(server)
        val known = mapOf(3L to stored(3, "cached"), 4L to stored(4, "cached 4").copy(signals = MailSignals(bulk = true), gmailTab = "social"))
        val res = s.syncFolder("INBOX", 10, known, "9", signals = true, gmailTabs = true)

        val headers = server.commands.filter { it.contains("HEADER.FIELDS") }
        assertEquals(1, headers.size)
        assertTrue("not for the message whose kind is known: ${headers[0]}", headers[0].startsWith("UID FETCH 3,5 "))
        assertTrue(headers[0].contains("HEADER.FIELDS (LIST-ID LIST-UNSUBSCRIBE PRECEDENCE AUTO-SUBMITTED FEEDBACK-ID X-CAMPAIGN X-MAILER)"))
        val searches = server.commands.filter { it.startsWith("UID SEARCH") }
        assertEquals(
            listOf("promotions", "social", "updates", "forums").map { "UID SEARCH UID 3:* X-GM-RAW \"category:$it\"" },
            searches,
        )
        val byUid = res.messages.associateBy { it.uid }
        assertEquals(MailSignals(list = true), byUid.getValue(3).signals)
        assertEquals(MailSignals(bulk = true), byUid.getValue(4).signals)
        assertEquals(MailSignals(auto = true), byUid.getValue(5).signals)
        assertEquals(listOf("promotions", "primary", "updates"), listOf(3L, 4L, 5L).map { byUid.getValue(it).gmailTab })
        assertEquals("new", byUid.getValue(5).subject)

        // Without Gmail's extension the tabs aren't asked, and what the cache had stays.
        server.capabilities = "IMAP4rev1 UIDPLUS"
        val plain = session(server)
        server.commands.clear()
        val again = plain.syncFolder("INBOX", 10, res.messages.associateBy { it.uid }, "9", signals = true, gmailTabs = true)
        assertFalse(server.commands.any { it.startsWith("UID SEARCH") })
        assertFalse("every message's kind is known now", server.commands.any { it.contains("HEADER.FIELDS") })
        assertEquals("promotions", again.messages.first { it.uid == 3L }.gmailTab)
    }

    @Test
    fun `huge headers are read only as far as their first 8 KiB`() = runBlocking {
        val server = FakeImap(
            listOf(Msg(7, "huge", "Precedence: bulk\r\nX-Mailer: ${"x".repeat(100_000)}\r\nList-Id: <later@example.com>")),
            "IMAP4rev1",
            emptyMap(),
        ).also { servers += it }
        val res = session(server).syncFolder("INBOX", 10, emptyMap(), "9", signals = true)
        val headers = server.commands.single { it.contains("HEADER.FIELDS") }
        assertTrue(headers, headers.endsWith("]<0.${ImapSession.SIGNAL_BYTES}>)"))
        // What came after the cut isn't known; what came before is.
        assertEquals(MailSignals(bulk = true), res.messages.single().signals)
    }

    @Test
    fun `a sync of another folder asks for neither`() = runBlocking {
        val server = inbox("IMAP4rev1 X-GM-EXT-1")
        val res = session(server).syncFolder("Sent", 10, emptyMap(), "9")
        assertFalse(server.commands.any { it.contains("HEADER.FIELDS") })
        assertFalse(server.commands.any { it.startsWith("UID SEARCH") })
        assertNull(res.messages.first().signals)
        assertNull(res.messages.first().gmailTab)
    }

    @Test
    fun `SEARCH answers become uids, also past the range of an Int`() {
        val responses = arrayOf<org.eclipse.angus.mail.iap.Response>(
            org.eclipse.angus.mail.imap.protocol.IMAPResponse("* SEARCH 3 7 4294967295"),
            org.eclipse.angus.mail.imap.protocol.IMAPResponse("* OK [UIDNEXT 9] x"),
            org.eclipse.angus.mail.imap.protocol.IMAPResponse("* SEARCH"),
        )
        assertEquals(listOf(3L, 7L, 4294967295L), ImapSession.searchUids(responses))
    }
}
