package nl.bvdm.rukoo.ui.mail

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.FakeCipher
import nl.bvdm.rukoo.mail.FakeServer
import nl.bvdm.rukoo.mail.RukooMailEngine
import nl.bvdm.rukoo.mail.ServerMessage
import nl.bvdm.rukoo.mail.TestStrings
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.ImapAccountInput
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.ServerConfig
import nl.bvdm.rukoo.mail.session.FolderRecord
import nl.bvdm.rukoo.ui.MailtoFields
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** MailUi's deletes against the real engine, whose permanent deletes report failures instead of throwing. */
class MailUiEngineTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After
    fun stop() = scope.cancel()

    private object Fake : UiStrings {
        override fun get(id: Int, vararg args: Any) = (listOf(id) + args).joinToString("|")
        override fun plural(id: Int, count: Int, vararg args: Any) = (listOf(id) + args).joinToString("|")
    }

    private object Host : MailUiHost {
        override fun detach(ids: Collection<String>) = false
        override fun reopen(id: String) = Unit
        override fun openUrl(url: String) = Unit
        override fun composeMailto(fields: MailtoFields) = Unit
        override fun showFolder(accountId: String, path: String) = Unit
    }

    private fun engine(servers: Map<String, FakeServer>, dir: File = tmp.root) = RukooMailEngine(
        dir = dir,
        attachmentsDir = File(dir, "attachments"),
        scope = scope,
        cipher = FakeCipher,
        strings = TestStrings,
        http = OkHttpClient(),
        sessionFactory = { account, _ -> servers.getValue(account.email).session() },
        saveDelayMs = 5,
    )

    private suspend fun RukooMailEngine.add(email: String): Account {
        val acc = addImapAccount(ImapAccountInput(email = email, name = "Me", password = "x", imap = ServerConfig("imap.example.com", 993), smtp = ServerConfig("smtp.example.com", 465)))
        refresh(acc.id)
        return acc
    }

    private suspend fun <T : Any> eventually(read: () -> T?): T = withTimeout(5_000) {
        var value = read()
        while (value == null) {
            delay(10)
            value = read()
        }
        value
    }

    @Test
    fun aPermanentDeleteTheServerRefusesIsReportedNotCalledDone() = runBlocking {
        val server = FakeServer(FakeServer.STANDARD).apply { add("Trash", ServerMessage(1, "Old offer")) }
        val engine = engine(mapOf("me@example.com" to server))
        val acc = engine.add("me@example.com")
        engine.openFolder(acc.id, "Trash")
        val old = eventually { runBlocking { engine.listMessages(MailView.folder(acc.id, "Trash")).firstOrNull() } }
        val ui = MailUi(engine, scope, Host).also { it.strings = Fake }
        server.failNext = "deleteForever" to IOException("Connection reset")

        ui.delete(listOf(old))
        eventually { ui.dialog }.answer(DialogChoice.CONFIRM)
        val toast = eventually { ui.toasts.current }
        // The engine put it back: an error, not "Deleted".
        assertNotEquals("${R.string.mailbox_delete_deleted_one}", toast.message)
        assertEquals(5000L, toast.durationMs)
        assertNotNull(engine.summary(old.id))
    }

    @Test
    fun confirmingTheNoTrashWarningKeepsUndoForTheEmailsThatWentToTrash() = runBlocking {
        val withTrash = FakeServer(FakeServer.STANDARD).apply { add("INBOX", ServerMessage(1, "Has a Trash")) }
        val noTrash = FakeServer(listOf(FolderRecord("INBOX", "INBOX", "/", null, FolderRole.INBOX))).apply { add("INBOX", ServerMessage(1, "No Trash")) }
        val engine = engine(mapOf("me@example.com" to withTrash, "you@example.com" to noTrash))
        engine.add("me@example.com")
        engine.add("you@example.com")
        val both = eventually { runBlocking { engine.listMessages(MailView.AllInboxes).takeIf { it.size == 2 } } }
        val ui = MailUi(engine, scope, Host).also { it.strings = Fake }

        ui.delete(both)
        val ask = eventually { ui.dialog }
        // Only the one without a Trash goes for good, so the question is about one email.
        assertEquals("${R.string.mailbox_delete_no_trash}", ask.message)
        ask.answer(DialogChoice.CONFIRM)
        val toast = eventually { ui.toasts.current }
        assertEquals("${R.string.mailbox_delete_moved_one}", toast.message)
        assertEquals("${R.string.common_actions_undo}", toast.actionLabel)
        assertNull(engine.listMessages(MailView.AllInboxes).firstOrNull())
        assertEquals(1, engine.listMessages(MailView.folder(engine.accounts.value.first { it.email == "me@example.com" }.id, "Trash")).size)
    }
}
