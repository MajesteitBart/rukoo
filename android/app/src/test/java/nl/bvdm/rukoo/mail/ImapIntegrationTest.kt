package nl.bvdm.rukoo.mail

import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import nl.bvdm.rukoo.mail.mime.ComposedMail
import nl.bvdm.rukoo.mail.mime.MailAttachment
import nl.bvdm.rukoo.mail.mime.MimeComposer
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.AccountType
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.AuthKind
import nl.bvdm.rukoo.mail.model.DeleteOutcome
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.ImapAccountInput
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.OutgoingMessage
import nl.bvdm.rukoo.mail.model.ServerConfig
import nl.bvdm.rukoo.mail.model.ViewKind
import nl.bvdm.rukoo.mail.session.Credentials
import nl.bvdm.rukoo.mail.session.ImapSession
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The real IMAP and SMTP path against a disposable Ethereal mailbox (ethereal.email), created through
 * its API like nodemailer's createTestAccount. Skips when the service can't be reached, so offline
 * runs stay green.
 */
class ImapIntegrationTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private class Ethereal(val user: String, val pass: String, val imap: ServerConfig, val smtp: ServerConfig)

    private fun testAccount(): Ethereal? = runCatching {
        val client = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build()
        val body = "{\"requestor\":\"rukoo-android-test\",\"version\":\"1.0.0\"}".toRequestBody("application/json".toMediaType())
        client.newCall(Request.Builder().url("https://api.nodemailer.com/user").post(body).build()).execute().use { res ->
            if (!res.isSuccessful) return null
            val json = Json.parseToJsonElement(res.body!!.string()).jsonObject
            if (json["status"]?.jsonPrimitive?.content != "success") return null
            fun server(key: String) = json.getValue(key).jsonObject.let {
                ServerConfig(it.getValue("host").jsonPrimitive.content, it.getValue("port").jsonPrimitive.int, it.getValue("secure").jsonPrimitive.boolean)
            }
            Ethereal(json.getValue("user").jsonPrimitive.content, json.getValue("pass").jsonPrimitive.content, server("imap"), server("smtp"))
        }
    }.getOrNull()

    @Test(timeout = 240_000)
    fun `a real account adds, syncs, previews, flags, sends, appends, moves, undoes and deletes`() = runBlocking {
        val eth = testAccount()
        assumeTrue("Ethereal not reachable", eth != null)
        eth!!
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val dir = tmp.root
        val engine = RukooMailEngine(dir, File(dir, "attachments"), scope, FakeCipher, TestStrings, OkHttpClient(), saveDelayMs = 5)
        try {
            val input = ImapAccountInput(eth.user, "Integration", "wrong-password", eth.imap, eth.smtp)
            try {
                engine.addImapAccount(input)
                fail("a wrong password must be refused")
            } catch (e: MailException) {
                assertTrue(e.message, e.message!!.startsWith("IMAP: "))
            }

            val acc = engine.addImapAccount(input.copy(password = eth.pass))
            engine.refresh(acc.id)
            val folders = engine.folders.value[acc.id].orEmpty()
            assertTrue("inbox found in $folders", folders.any { it.role == FolderRole.INBOX })
            assertTrue("trash found in $folders", folders.any { it.role == FolderRole.TRASH })

            // A multipart message with an attachment, straight into the inbox.
            val raw = MimeComposer.compose(
                ComposedMail(
                    from = Address("Integration test", "test@example.com"),
                    to = listOf(Address("", eth.user)),
                    subject = "Integration €",
                    text = "Plain text with café and a link https://example.com",
                    html = "<p>HTML with <b>café</b></p>",
                    date = System.currentTimeMillis(),
                    messageId = "<integration-${System.nanoTime()}@example.com>",
                    attachments = listOf(MailAttachment("note.txt", "text/plain", "hello".toByteArray())),
                ),
            )
            val direct = ImapSession(
                Account(acc.id, AccountType.IMAP, "other", AuthKind.PASSWORD, eth.user, "x", imap = eth.imap, smtp = eth.smtp),
                Credentials.Password(eth.pass),
                TestStrings,
            )
            direct.append("INBOX", raw)
            engine.refresh(acc.id)
            val msg = engine.listMessages(MailView(ViewKind.INBOX)).first { it.subject == "Integration €" }
            assertTrue(msg.unread)
            assertTrue(msg.hasAttachments)
            assertTrue(msg.preview, msg.preview.startsWith("Plain text with café"))

            val full = engine.fullMessage(msg.id)
            assertTrue(full.html.contains("café"))
            assertEquals("note.txt", full.attachments.single().filename)
            assertEquals("hello", String(engine.attachment(msg.id, full.attachments.single().index).bytes))

            engine.setFlags(listOf(msg.id), unread = false, starred = true)
            val onServer = direct.syncFolder("INBOX", 100, emptyMap(), null).messages.first { it.uid == msg.uid }
            assertFalse("seen flag persisted on the server", onServer.unread)
            assertTrue("flagged flag persisted on the server", onServer.starred)

            // SMTP send; Ethereal captures it and shows it over IMAP.
            engine.send(OutgoingMessage(acc.id, Address("", eth.user), to = listOf(Address("", eth.user)), subject = "Sent via SMTP", text = "Hi"))
            var delivered = false
            for (i in 0 until 20) {
                engine.refresh(acc.id)
                if (engine.listMessages(MailView(ViewKind.INBOX)).any { it.subject == "Sent via SMTP" }) {
                    delivered = true
                    break
                }
                delay(1500)
            }
            assertTrue("the sent message arrived", delivered)

            // A draft on the server, found again by the uid the server reports.
            val draft = engine.saveDraft(OutgoingMessage(acc.id, Address("", eth.user), to = listOf(Address("", "x@example.com")), subject = "Draft", text = "Later"))
            assertNotNull(draft)
            assertEquals("Later", engine.fullMessage(draft!!).text.trim())
            engine.discardDraft(draft)

            // Delete moves to Trash with an undo (UIDPLUS); undo brings it back.
            val deleted = engine.delete(listOf(msg.id))
            assertEquals(DeleteOutcome.TRASHED, deleted.outcome)
            val moved = deleted.move.moved.single()
            assertTrue("the server reported the new uid", moved.undoable)
            assertFalse(engine.listMessages(MailView(ViewKind.INBOX)).any { it.id == msg.id })
            val back = engine.undoMove(listOf(msg.id))
            assertTrue(back.failed.toString(), back.failed.isEmpty())
            val restored = back.restored.single()
            assertEquals("INBOX", MessageIds.decode(restored)!!.folder)
            engine.refresh(acc.id)
            assertTrue(engine.listMessages(MailView(ViewKind.INBOX)).any { it.id == restored })

            // Deleted for good from Trash.
            val again = engine.delete(listOf(restored)).move.moved.single().newId!!
            engine.refresh(acc.id)
            assertEquals(DeleteOutcome.DELETED, engine.delete(listOf(again), force = true).outcome)
            engine.refresh(acc.id)
            assertFalse(engine.listMessages(MailView(ViewKind.EVERYTHING)).any { it.subject == "Integration €" })
            direct.close()
        } finally {
            engine.close()
            scope.cancel()
        }
    }
}
