package nl.bvdm.rukoo.mail.session

import kotlinx.coroutines.runBlocking
import nl.bvdm.rukoo.mail.TestStrings
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.AccountType
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.AuthKind
import nl.bvdm.rukoo.mail.model.CachedMessage
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.ServerConfig
import nl.bvdm.rukoo.mail.session.FakeImap.Msg
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #230 over a real IMAP conversation (desktop's test/imap.test.js): a sync keeps each message's References, which the
 * envelope leaves out, so related mail finds a later reply that names an email only there. A cache from before Rukoo
 * kept them gets them in one header fetch, without its window fetched again.
 */
class ImapReferencesTest {
    private val servers = mutableListOf<FakeImap>()
    private val sessions = mutableListOf<ImapSession>()

    @After
    fun tearDown() = runBlocking {
        sessions.forEach { it.close() }
        servers.forEach { it.close() }
    }

    private fun session(server: FakeImap): ImapSession {
        val config = ServerConfig("127.0.0.1", server.port, secure = false, user = "me@example.com")
        val account = Account("acc", AccountType.IMAP, "other", AuthKind.PASSWORD, "me@example.com", "Me", imap = config, smtp = config)
        return ImapSession(account, Credentials.Password("secret"), TestStrings, connectTimeoutMs = 5_000, socketTimeoutMs = 10_000).also { sessions += it }
    }

    /** A message cached before Rukoo kept References: the field is null. */
    private fun storedBefore(uid: Long, subject: String) = CachedMessage(uid = uid, messageId = "<m$uid@example.com>", subject = subject, from = Address("Sender", "s@example.com"), date = 1)

    @Test
    fun `a cache from before References syncs with one header fetch and no envelopes, and the next sync asks nothing more`() = runBlocking {
        val long = (1..60).joinToString(" ") { "<r$it@example.com>" }
        val server = FakeImap(
            listOf(
                // Folded over two lines, next to a header line that isn't asked for.
                Msg(3, "old reply", "Subject: old reply\r\nReferences: <a@example.com>\r\n <b@example.com>\r\nList-Id: <l@example.com>"),
                Msg(4, "old, no References"),
                Msg(5, "new, long thread", "References: $long"),
            ),
            "IMAP4rev1",
        ).also { servers += it }
        val s = session(server)
        val known = mapOf(3L to storedBefore(3, "cached reply"), 4L to storedBefore(4, "cached 4"))
        val res = s.syncFolder("Archive", 10, known, "9")

        assertEquals("only the new message's envelope", listOf("UID FETCH 5 "), server.commands.filter { it.contains("ENVELOPE") }.map { it.take(12) })
        assertEquals(
            listOf("UID FETCH 3:5 (UID BODY.PEEK[HEADER.FIELDS (REFERENCES)]<0.${ImapSession.REFERENCE_BYTES}>)"),
            server.commands.filter { it.contains("HEADER.FIELDS") },
        )
        val byUid = res.messages.associateBy { it.uid }
        assertEquals(listOf("<a@example.com>", "<b@example.com>"), byUid.getValue(3).references)
        assertEquals("cached reply", byUid.getValue(3).subject)
        assertEquals("none, so not asked again", emptyList<String>(), byUid.getValue(4).references)
        val kept = byUid.getValue(5).references!!
        assertEquals("the newest 50 of a long thread", 50, kept.size)
        assertEquals(listOf("<r11@example.com>", "<r60@example.com>"), listOf(kept.first(), kept.last()))

        server.commands.clear()
        val again = s.syncFolder("Archive", 10, byUid, "9")
        assertEquals(emptyList<String>(), server.commands.filter { it.startsWith("UID FETCH") })
        assertEquals(listOf("<a@example.com>", "<b@example.com>"), again.messages.first { it.uid == 3L }.references)
    }

    @Test
    fun `a References line longer than one fetch is read on, and keeps the newest 50 ids as desktop does`() = runBlocking {
        // 600 ids over about 22 KB, folded five to a line, as a long mailing-list thread has them.
        val ids = (1..600).map { "<reference-$it@lists.example.com>" }
        val value = ids.chunked(5).joinToString("\r\n ") { it.joinToString(" ") }
        val server = FakeImap(listOf(Msg(7, "long thread", "References: $value"), Msg(8, "short", "References: <a@example.com>")), "IMAP4rev1").also { servers += it }
        val res = session(server).syncFolder("INBOX", 10, emptyMap(), "9")

        val parts = server.commands.filter { it.contains("HEADER.FIELDS (REFERENCES)") }
        assertEquals(
            listOf(
                "UID FETCH 7:8 (UID BODY.PEEK[HEADER.FIELDS (REFERENCES)]<0.16384>)",
                "UID FETCH 7 (UID BODY.PEEK[HEADER.FIELDS (REFERENCES)]<16384.16384>)",
            ),
            parts,
        )
        val byUid = res.messages.associateBy { it.uid }
        assertEquals(ids.takeLast(50), byUid.getValue(7).references)
        assertEquals("the same as reading the whole line", MessageIds.referenceIds(value), byUid.getValue(7).references)
        assertEquals(listOf("<a@example.com>"), byUid.getValue(8).references)
    }

    @Test
    fun `a References line without angle brackets longer than one fetch keeps its newest ids too`() = runBlocking {
        // Ids without angle brackets, as some mailers write them, comma-separated over about 25 KB.
        val ids = (1..700).map { "reference-$it@lists.example.com" }
        val value = ids.chunked(5).joinToString(",\r\n ") { it.joinToString(", ") }
        val server = FakeImap(listOf(Msg(7, "long thread", "References: $value")), "IMAP4rev1").also { servers += it }
        val res = session(server).syncFolder("INBOX", 10, emptyMap(), "9")

        assertEquals(2, server.commands.count { it.contains("HEADER.FIELDS (REFERENCES)") })
        val kept = res.messages.single().references
        assertEquals(ids.takeLast(50), kept)
        assertEquals("the same as reading the whole line, as desktop does", MessageIds.referenceIds(value), kept)
    }
}
