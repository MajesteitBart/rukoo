package nl.bvdm.rukoo.mail.sync

import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import nl.bvdm.rukoo.account.AccountHttp
import nl.bvdm.rukoo.account.AccountService
import nl.bvdm.rukoo.account.PlainSecrets
import nl.bvdm.rukoo.categories.Categories
import nl.bvdm.rukoo.categories.Category
import nl.bvdm.rukoo.categories.EngineCategoryMail
import nl.bvdm.rukoo.categories.EnglishPresets
import nl.bvdm.rukoo.categories.JevAnswer
import nl.bvdm.rukoo.categories.JevApi
import nl.bvdm.rukoo.categories.JevError
import nl.bvdm.rukoo.mail.FakeCipher
import nl.bvdm.rukoo.mail.FakeServer
import nl.bvdm.rukoo.mail.RukooMailEngine
import nl.bvdm.rukoo.mail.ServerMessage
import nl.bvdm.rukoo.mail.TestStrings
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.ImapAccountInput
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.model.ServerConfig
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * New mail from a sync on its way to the notifications, as MailModule wires it: the engine's new mail goes through
 * MailNotices, which asks the real categories of that engine's inbox.
 */
class EngineNoticesTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After
    fun stop() = scope.cancel()

    private object NoJev : JevApi {
        override val model = "jev-test"

        override suspend fun classify(key: String, m: MessageSummary, categories: List<Category>, toMe: Boolean): JevAnswer = throw JevError("network")
    }

    @Test
    fun aSyncsNewMailLeavesTheMutedCategoryOutAndShowsTheRestAtOnce() = runBlocking {
        val server = FakeServer(FakeServer.STANDARD).apply { add("INBOX", ServerMessage(1, "Welcome", date = 1_700_000_000_000)) }
        val shown = CopyOnWriteArrayList<List<String>>()
        lateinit var notices: MailNotices
        val engine = RukooMailEngine(
            dir = tmp.newFolder("mail"),
            attachmentsDir = tmp.newFolder("attachments"),
            scope = scope,
            cipher = FakeCipher,
            strings = TestStrings,
            http = OkHttpClient(),
            sessionFactory = { _, _ -> server.session() },
            saveDelayMs = 5,
            onNewMail = { notices.add(it) },
        )
        val dir = tmp.newFolder("account")
        val account = AccountService(dir, PlainSecrets, "", "phone", AccountHttp { _, _, _, _, _, _ -> null }, scope, pushAfterMs = 60_000, saveAfterMs = 1000)
        val cats = Categories(account, EngineCategoryMail(engine, scope), PlainSecrets, dir, NoJev, EnglishPresets, scope, sortAfterMs = 60_000)
        notices = MailNotices({ cats }, { list, _ -> shown += list.map { it.subject }; list.map { it.accountId }.toSet() }, scope)
        try {
            val acc = engine.addImapAccount(ImapAccountInput("me@example.com", "Me", "pw", ServerConfig("imap.example.com", 993), ServerConfig("smtp.example.com", 465)))
            engine.refresh(acc.id)
            cats.setEnabled(true)
            cats.setNotify("updates", false)

            // A login alert from an automatic sender goes to Updates, which is muted; Sanne's question to Needs you.
            server.add("INBOX", ServerMessage(2, "New login", from = Address("App", "noreply@app.example"), date = 1_700_000_100_000))
            server.add("INBOX", ServerMessage(3, "Can you sign this?", from = Address("Sanne de Vries", "sanne@studio.example"), date = 1_700_000_200_000))
            engine.refresh(acc.id)
            withTimeout(5_000) { notices.settle() }
            assertEquals(listOf(listOf("Can you sign this?")), shown.toList())

            // Every category notifying again: at once, as without categories.
            cats.setNotify("updates", true)
            server.add("INBOX", ServerMessage(4, "Another login", from = Address("App", "noreply@app.example"), date = 1_700_000_300_000))
            engine.refresh(acc.id)
            assertEquals(listOf(listOf("Can you sign this?"), listOf("Another login")), shown.toList())
        } finally {
            notices.close()
            cats.close()
            account.close()
            engine.close()
        }
    }
}
