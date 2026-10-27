package nl.bvdm.rukoo.mail.session

import kotlinx.coroutines.runBlocking
import nl.bvdm.rukoo.mail.TestStrings
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.AccountType
import nl.bvdm.rukoo.mail.model.AuthKind
import nl.bvdm.rukoo.mail.model.ServerConfig
import nl.bvdm.rukoo.mail.session.FakeImap.Msg
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A new message nested too deeply for Angus Mail's recursive BODYSTRUCTURE parser doesn't stall its folder's sync
 * (#92). It overflows the stack of the thread that reads the reply, which loses the whole batch; the sync then finds
 * that message, lists it by its envelope alone and keeps it, so no later sync asks for it again.
 *
 * On the real 32 MB threads that takes a message of several megabytes; these threads have a 256 KB stack, where
 * 200 KB of nesting overflows just as well.
 */
class ImapDeepSyncTest {
    private val threads = ImapThreads.withStack(256L * 1024)
    private val servers = mutableListOf<FakeImap>()
    private val sessions = mutableListOf<ImapSession>()

    @After
    fun tearDown() = runBlocking {
        sessions.forEach { it.close() }
        servers.forEach { it.close() }
        threads.close()
    }

    private fun session(server: FakeImap): ImapSession {
        val config = ServerConfig("127.0.0.1", server.port, secure = false, user = "me@example.com")
        val account = Account("acc", AccountType.IMAP, "other", AuthKind.PASSWORD, "me@example.com", "Me", imap = config, smtp = config)
        return ImapSession(account, Credentials.Password("secret"), TestStrings, connectTimeoutMs = 5_000, socketTimeoutMs = 10_000, commandThreads = threads)
            .also { sessions += it }
    }

    /** A plain text part inside [levels] multiparts: 20,000 levels make a 200 KB BODYSTRUCTURE. */
    private fun nested(levels: Int) = "(".repeat(levels) + FakeImap.TEXT_PLAIN + " \"mixed\")".repeat(levels)

    private val deep = nested(20_000)

    private fun plain(uid: Long) = Msg(uid, "Message $uid", text = "Hello from $uid")

    private fun server(messages: List<Msg>) = FakeImap(messages, "IMAP4rev1").also { servers += it }

    @Test
    fun `messages too deep to parse are listed by their envelope while the rest of the folder syncs as usual`() = runBlocking {
        val server = server(listOf(plain(1), Msg(2, "Deep one", structure = deep), plain(3), plain(4), Msg(5, "Deep two", structure = deep), plain(6)))
        val s = session(server)
        val res = s.syncFolder("INBOX", 10, emptyMap(), null)

        assertEquals((1L..6L).toList(), res.messages.map { it.uid })
        val byUid = res.messages.associateBy { it.uid }
        for (uid in listOf(1L, 3L, 4L, 6L)) {
            assertEquals("Message $uid", byUid.getValue(uid).subject)
            assertEquals("Hello from $uid", byUid.getValue(uid).preview)
        }
        for ((uid, subject) in listOf(2L to "Deep one", 5L to "Deep two")) {
            val m = byUid.getValue(uid)
            assertEquals(subject, m.subject)
            assertEquals("s@example.com", m.from.address)
            assertEquals(105L, m.size)
            assertEquals("", m.preview)
            assertFalse(m.hasAttachments)
        }
        val fetches = server.commands.filter { it.startsWith("UID FETCH") && it.contains("ENVELOPE") }
        assertEquals(
            listOf(
                "UID FETCH 1:6 (UID ENVELOPE BODYSTRUCTURE INTERNALDATE RFC822.SIZE)",
                "UID FETCH 1,3:4,6 (UID ENVELOPE BODYSTRUCTURE INTERNALDATE RFC822.SIZE)",
                "UID FETCH 2,5 (UID ENVELOPE INTERNALDATE RFC822.SIZE)",
            ),
            fetches,
        )
        // Halves of 1:6 fetched with nothing but their structure, down to the two that overflow alone.
        val probes = server.commands.filter { it.endsWith(" (UID BODYSTRUCTURE)") }.map { it.removePrefix("UID FETCH ").substringBefore(' ') }
        assertEquals(listOf("1:3", "1:2", "1", "2", "3", "4:6", "4:5", "4", "5", "6"), probes)

        // The next sync has them all cached: only flags are asked, and the deep ones stay listed.
        server.commands.clear()
        val again = s.syncFolder("INBOX", 10, res.messages.associateBy { it.uid }, res.uidValidity)
        assertFalse(server.commands.toString(), server.commands.any { it.contains("BODYSTRUCTURE") || it.contains("ENVELOPE") })
        assertEquals(res.messages, again.messages)

        // A deep message that arrives alone needs no search.
        server.messages += Msg(7, "Deep three", structure = deep)
        server.commands.clear()
        val third = s.syncFolder("INBOX", 10, again.messages.associateBy { it.uid }, again.uidValidity)
        assertEquals("Deep three", third.messages.last().subject)
        assertTrue(server.commands.none { it.endsWith(" (UID BODYSTRUCTURE)") })
        assertTrue(server.commands.contains("UID FETCH 7 (UID ENVELOPE INTERNALDATE RFC822.SIZE)"))
    }
}
