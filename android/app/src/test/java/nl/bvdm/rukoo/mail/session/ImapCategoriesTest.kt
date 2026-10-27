package nl.bvdm.rukoo.mail.session

import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import nl.bvdm.rukoo.categories.MailSignals
import nl.bvdm.rukoo.mail.TestStrings
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.AccountType
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.AuthKind
import nl.bvdm.rukoo.mail.model.CachedMessage
import nl.bvdm.rukoo.mail.model.ServerConfig
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The inbox sync's category work over a real IMAP conversation (desktop's test/imap.test.js, its last two tests): the
 * signal headers are fetched once per message, and Gmail's tabs are searched on every sync where the server has
 * Gmail's extension. A small scripted IMAP server answers on a local socket.
 */
class ImapCategoriesTest {
    /** One message on the fake server: its uid, flags and the header lines a header fetch returns. */
    private class Msg(val uid: Long, val subject: String, val headers: String = "", val flags: String = "")

    private class FakeImap(val messages: List<Msg>, var capabilities: String, val tabs: Map<String, List<Long>>) : AutoCloseable {
        val commands = CopyOnWriteArrayList<String>()
        private val server = ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
        val port: Int get() = server.localPort

        init {
            thread(isDaemon = true) {
                while (!server.isClosed) {
                    val socket = runCatching { server.accept() }.getOrNull() ?: break
                    thread(isDaemon = true) { runCatching { serve(socket) } }
                }
            }
        }

        override fun close() = server.close()

        private fun expand(set: String): List<Long> = set.split(',').flatMap { range ->
            val a = range.substringBefore(':').toLong()
            val b = range.substringAfter(':', range).toLong()
            (a..b).toList()
        }

        private fun serve(socket: Socket) {
            val input = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.ISO_8859_1))
            val out: OutputStream = socket.getOutputStream()
            fun send(text: String) {
                out.write(text.toByteArray(Charsets.ISO_8859_1))
                out.flush()
            }
            send("* OK [CAPABILITY $capabilities] ready\r\n")
            while (true) {
                val line = input.readLine() ?: break
                val tag = line.substringBefore(' ')
                val command = line.substringAfter(' ')
                val verb = command.substringBefore(' ').uppercase()
                commands += command
                when {
                    verb == "CAPABILITY" -> send("* CAPABILITY $capabilities\r\n$tag OK done\r\n")
                    verb == "LOGIN" -> send("$tag OK [CAPABILITY $capabilities] logged in\r\n")
                    verb == "LOGOUT" -> {
                        send("* BYE bye\r\n$tag OK done\r\n")
                        socket.close()
                        return
                    }
                    verb == "LIST" -> send("* LIST (\\HasNoChildren) \"/\" INBOX\r\n$tag OK done\r\n")
                    verb == "EXAMINE" || verb == "SELECT" -> send(
                        "* ${messages.size} EXISTS\r\n* 0 RECENT\r\n* FLAGS (\\Seen \\Flagged \\Answered)\r\n* OK [UIDVALIDITY 9] ok\r\n" +
                            "* OK [UIDNEXT ${messages.maxOf { it.uid } + 1}] ok\r\n$tag OK [${if (verb == "EXAMINE") "READ-ONLY" else "READ-WRITE"}] done\r\n",
                    )
                    verb == "FETCH" -> {
                        val sb = StringBuilder()
                        messages.forEachIndexed { i, m -> sb.append("* ${i + 1} FETCH (UID ${m.uid} FLAGS (${m.flags}))\r\n") }
                        send("$sb$tag OK done\r\n")
                    }
                    command.startsWith("UID FETCH") -> {
                        val set = command.split(' ')[2]
                        val sb = StringBuilder()
                        for (uid in expand(set)) {
                            val i = messages.indexOfFirst { it.uid == uid }
                            if (i < 0) continue
                            val m = messages[i]
                            when {
                                command.contains("HEADER.FIELDS") -> {
                                    val section = command.substringAfter("BODY.PEEK[").substringBefore("]")
                                    // A partial fetch (<0.n>) gets the first n bytes, as a server sends them.
                                    val most = Regex("\\]<0\\.(\\d+)>").find(command)?.groupValues?.get(1)?.toInt()
                                    val body = (m.headers + "\r\n").let { if (most != null) it.take(most) else it }
                                    val origin = if (most != null) "<0>" else ""
                                    sb.append("* ${i + 1} FETCH (UID ${m.uid} BODY[$section]$origin {${body.length}}\r\n$body)\r\n")
                                }
                                command.contains("ENVELOPE") -> sb.append(
                                    "* ${i + 1} FETCH (UID ${m.uid} RFC822.SIZE 105 INTERNALDATE \"01-Jan-2026 10:00:00 +0000\" " +
                                        "ENVELOPE (\"Thu, 1 Jan 2026 10:00:00 +0000\" \"${m.subject}\" ((\"Sender\" NIL \"s\" \"example.com\")) " +
                                        "((\"Sender\" NIL \"s\" \"example.com\")) NIL ((NIL NIL \"me\" \"example.com\")) NIL NIL NIL \"<m${m.uid}@example.com>\") " +
                                        "BODYSTRUCTURE (\"text\" \"plain\" (\"charset\" \"utf-8\") NIL NIL \"7bit\" 5 1 NIL NIL NIL NIL))\r\n",
                                )
                                // Previews: this server has no body text to give.
                                else -> Unit
                            }
                        }
                        send("$sb$tag OK done\r\n")
                    }
                    command.startsWith("UID SEARCH") -> {
                        val tab = Regex("category:(\\w+)").find(command)?.groupValues?.get(1)
                        val from = Regex("UID (\\d+):\\*").find(command)?.groupValues?.get(1)?.toLong() ?: 0
                        val uids = tabs[tab].orEmpty().filter { it >= from }
                        send("* SEARCH${uids.joinToString("") { " $it" }}\r\n$tag OK done\r\n")
                    }
                    else -> send("$tag OK done\r\n")
                }
            }
        }
    }

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
