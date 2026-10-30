package nl.bvdm.rukoo.categories

import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.account.AccountHttp
import nl.bvdm.rukoo.account.AccountService
import nl.bvdm.rukoo.account.PlainSecrets
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.AccountType
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.AuthKind
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.sync.MailNotices
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Notifications per inbox category: MailNotices with the real Categories, the cases of desktop's test/categories.test.js
 * for notices.js, against an account without a server and a Jev that answers when the test says so.
 *
 * Turning categories on sorts at once on the phone, so a test that wants Jev asked sets the key first.
 */
class NoticesTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val scopes = mutableListOf<CoroutineScope>()
    private val closers = mutableListOf<() -> Unit>()

    @After
    fun tearDown() {
        closers.forEach { it() }
        scopes.forEach { it.cancel() }
    }

    private class FakeMail(var inbox: List<MessageSummary>) : CategoryMail {
        val account = Account("acc1", AccountType.IMAP, "other", AuthKind.PASSWORD, "me@work.example", "Me")
        override val accounts get() = listOf(account)

        override suspend fun inboxes() = listOf(account to inbox)

        override fun writtenTo(): Set<String> = emptySet()

        override val changes = MutableSharedFlow<Unit>()
    }

    /** A Jev that answers, or fails, when the test says so, by subject. */
    private class HeldJev : JevApi {
        override val model = "jev-test"
        val asked = ConcurrentHashMap<String, CompletableDeferred<JevAnswer>>()

        override suspend fun classify(key: String, m: MessageSummary, categories: List<Category>, toMe: Boolean): JevAnswer =
            asked.getOrPut(m.subject) { CompletableDeferred() }.await()

        fun answer(subject: String, category: String) = asked.getOrPut(subject) { CompletableDeferred() }.complete(JevAnswer(category, 0.9, model))

        fun fail(subject: String, code: String) = asked.getOrPut(subject) { CompletableDeferred() }.completeExceptionally(JevError(code))
    }

    /** What MailNotices put in the notifications: each call's senders, and the accounts it asked to stay quiet. */
    private class Shown {
        val calls = CopyOnWriteArrayList<Pair<List<String>, Set<String>>>()
        val show: (List<MessageSummary>, Set<String>) -> Set<String> = { list, quiet ->
            calls += list.map { it.from.name } to quiet
            list.map { it.accountId }.toSet()
        }

        fun senders() = calls.map { it.first }
    }

    private class Setup(val cats: Categories, val account: AccountService, val mail: FakeMail, val jev: HeldJev, val notices: MailNotices, val shown: Shown, val dir: File, val scope: CoroutineScope) {
        fun muted(): List<String> = Json.parseToJsonElement(File(dir, "categories.json").readText()).jsonObject["muted"]?.jsonArray.orEmpty().map { it.jsonPrimitive.content }
    }

    private fun setup(messages: List<MessageSummary>, hold: Long = 60_000): Setup {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        val dir = tmp.newFolder()
        val account = AccountService(dir, PlainSecrets, "", "desk", AccountHttp { _, _, _, _, _, _ -> null }, scope, pushAfterMs = 60_000, saveAfterMs = 1000)
        val mail = FakeMail(messages)
        val jev = HeldJev()
        val cats = Categories(account, mail, PlainSecrets, dir, jev, EnglishPresets, scope, sortAfterMs = 60_000)
        val shown = Shown()
        val notices = MailNotices({ cats }, shown.show, scope, hold)
        closers += { notices.close() }
        closers += { cats.close() }
        closers += { account.close() }
        return Setup(cats, account, mail, jev, notices, shown, dir, scope)
    }

    private fun msg(uid: Int, from: Address, subject: String, date: Long, signals: MailSignals? = MailSignals()) =
        MessageSummary(id = "acc1:INBOX:$uid", accountId = "acc1", folder = "INBOX", role = FolderRole.INBOX, uid = uid.toLong(), messageId = "<$uid@x>", from = from, to = listOf(Address("", "me@work.example")), subject = subject, date = date, signals = signals)

    // Sanne's question goes to Jev; the shop's offer (Promotions) and the login alert (Updates) are strong rules.
    private fun inbox() = listOf(
        msg(1, Address("Sanne de Vries", "sanne@studio.example"), "Can you sign this?", 3),
        msg(2, Address("Shop", "news@shop.example"), "Sale", 2, signals = MailSignals(list = true)),
        msg(3, Address("App", "noreply@app.example"), "New login", 1),
    )

    // A mailing list the rules aren't sure about: they say Promotions.
    private fun club() = msg(4, Address("Club", "board@club.example"), "Meeting notes", 0, signals = MailSignals(list = true))

    private suspend fun until(what: String, ms: Long = 5_000, check: () -> Boolean) {
        try {
            withTimeout(ms) { while (!check()) delay(10) }
        } catch (e: TimeoutCancellationException) {
            throw AssertionError("timed out waiting until $what")
        }
    }

    private suspend fun settled(s: Setup, ms: Long = 1_000) = try {
        withTimeout(ms) { s.notices.settle() }
    } catch (e: TimeoutCancellationException) {
        throw AssertionError("a notification is still waiting")
    }

    @Test
    fun `with no category muted, new mail notifies at once, as without categories`() = runBlocking {
        val s = setup(inbox())
        // Categories off.
        s.notices.add(s.mail.inbox)
        // On, with Jev about to sort Sanne's email.
        s.cats.setJev(on = true, key = "KEY")
        s.cats.setEnabled(true)
        until("Jev is asked") { s.jev.asked.containsKey("Can you sign this?") }
        s.notices.add(s.mail.inbox)
        // A muted category counts only while categories are on.
        s.cats.setNotify("promotions", false)
        s.cats.setEnabled(false)
        s.notices.add(s.mail.inbox)
        assertEquals(List(3) { listOf("Sanne de Vries", "Shop", "App") }, s.shown.senders())
        settled(s)
    }

    @Test
    fun `a muted category's mail that the rules are sure about sends no notification`() = runBlocking {
        val lunch = msg(5, Address("Sanne de Vries", "sanne@studio.example"), "Lunch?", 5)
        val s = setup(inbox() + lunch)
        s.cats.setJev(on = true, key = "KEY")
        s.cats.setEnabled(true)
        until("Jev is asked") { s.jev.asked.containsKey("Can you sign this?") }
        s.cats.setNotify("promotions", false)
        s.cats.setNotify("updates", false)
        // The shop's offer and the login alert: strong rules, so no Jev and no wait.
        s.notices.add(listOf(s.mail.inbox[1], s.mail.inbox[2]))
        settled(s)
        // A sender rule places mail at once too, also mail Jev was about to sort.
        s.account.put("sender", "sanne@studio.example", buildJsonObject { put("category", "promotions") })
        s.notices.add(listOf(lunch))
        settled(s)
        assertEquals(emptyList<List<String>>(), s.shown.senders())
    }

    @Test
    fun `a held notification goes by the category Jev gives the email, and its account doesn't sound twice`() = runBlocking {
        val s = setup(inbox() + club())
        s.cats.setJev(on = true, key = "KEY")
        s.cats.setEnabled(true)
        s.cats.setNotify("money", false)
        until("Jev is asked for both") { s.jev.asked.keys.containsAll(listOf("Can you sign this?", "Meeting notes")) }
        // Sanne's email and the club's wait for Jev; the login alert is sure, and shows at once, with a sound.
        s.notices.add(s.mail.inbox.filter { it.uid in setOf(1L, 3L, 4L) })
        assertEquals(listOf(listOf("App") to emptySet<String>()), s.shown.calls.toList())
        s.jev.answer("Can you sign this?", "money")
        delay(200)
        assertEquals("the batch waits for its last answer", 1, s.shown.calls.size)
        s.jev.answer("Meeting notes", "to-read")
        settled(s, 5_000)
        // Jev put Sanne's email in Money, which is muted; the club joins the account's notification without a sound.
        assertEquals(listOf(listOf("App") to emptySet(), listOf("Club") to setOf("acc1")), s.shown.calls.toList())
    }

    @Test
    fun `after the wait for Jev, the category the email has then decides`() = runBlocking {
        val s = setup(inbox() + club(), hold = 400)
        s.cats.setJev(on = true, key = "KEY")
        s.cats.setEnabled(true)
        s.cats.setNotify("needs-you", false)
        until("Jev is asked") { s.jev.asked.keys.containsAll(listOf("Can you sign this?", "Meeting notes")) }
        // TypeSafe never answers.
        s.notices.add(s.mail.inbox.filter { it.uid in setOf(1L, 4L) })
        delay(100)
        assertEquals(emptyList<List<String>>(), s.shown.senders())
        settled(s, 5_000)
        // The rules put Sanne's email in Needs you, which is muted, and the club's in Promotions.
        assertEquals(listOf(listOf("Club") to emptySet<String>()), s.shown.calls.toList())
    }

    @Test
    fun `without Jev to wait for, the category decides at once`() = runBlocking {
        val s = setup(inbox())
        s.cats.setEnabled(true)
        s.cats.setNotify("needs-you", false)
        val batch = listOf(s.mail.inbox[0], s.mail.inbox[2])
        // No key.
        s.notices.add(batch)
        // TypeSafe refused the key, for the re-sort that sends Sanne's email to Jev.
        s.jev.fail("Can you sign this?", "key")
        s.cats.setJev(on = true, key = "BAD")
        s.cats.sortAgain()
        until("the key is refused") { s.cats.state.value.jev.error == "key" }
        s.notices.add(batch)
        // TypeSafe is busy, for a new key: the re-sort's email goes to Jev again.
        s.jev.asked.clear()
        s.jev.fail("Can you sign this?", "busy")
        s.cats.setJev(key = "NEW")
        until("TypeSafe is busy") { s.cats.state.value.jev.error == "busy" }
        s.notices.add(batch)
        // Sanne's email is in Needs you by the rules each time.
        assertEquals(List(3) { listOf("App") }, s.shown.senders())
        settled(s)
    }

    @Test
    fun `a notification waiting for Jev goes as soon as Jev gives up or is turned off`() = runBlocking {
        val s = setup(inbox())
        s.cats.setJev(on = true, key = "KEY")
        s.cats.setEnabled(true)
        s.cats.setNotify("money", false)
        until("Jev is asked") { s.jev.asked.containsKey("Can you sign this?") }
        // TypeSafe is busy: the rules' Needs you decides.
        s.notices.add(listOf(s.mail.inbox[0]))
        assertEquals(emptyList<List<String>>(), s.shown.senders())
        s.jev.fail("Can you sign this?", "busy")
        settled(s, 5_000)
        assertEquals(listOf(listOf("Sanne de Vries")), s.shown.senders())

        // Jev turned off while it sorts the club's new email: the rules' Promotions decides.
        s.jev.asked.clear()
        s.mail.inbox = s.mail.inbox + club()
        s.cats.setJev(on = true, key = "KEY")
        until("Jev is asked for the club") { s.jev.asked.containsKey("Meeting notes") }
        s.notices.add(listOf(club()))
        delay(100)
        assertEquals(1, s.shown.calls.size)
        s.cats.setJev(on = false)
        settled(s, 5_000)
        assertEquals(listOf("Club"), s.shown.senders()[1])
        // The answer on its way when Jev went off changes nothing.
        s.jev.answer("Meeting notes", "money")
        delay(100)
        assertEquals(2, s.shown.calls.size)
    }

    @Test
    fun `a notification that comes in while Jev answers still hears the answer`() = runBlocking {
        val s = setup(inbox())
        s.cats.setJev(on = true, key = "KEY")
        s.cats.setEnabled(true)
        s.cats.setNotify("money", false)
        until("Jev is asked") { s.jev.asked.containsKey("Can you sign this?") }
        // Whichever comes first, the answer or the notification, the email ends up decided.
        s.jev.answer("Can you sign this?", "to-read")
        s.notices.add(listOf(s.mail.inbox[0]))
        settled(s, 5_000)
        assertEquals(listOf(listOf("Sanne de Vries")), s.shown.senders())
    }

    @Test
    fun `notifications per category stay on this phone, and a deleted category's setting goes with it`() {
        val s = setup(inbox())
        s.cats.setEnabled(true)
        assertEquals(emptyList<String>(), s.cats.state.value.muted)
        s.cats.setNotify("promotions", false)
        assertEquals("in the categories' order", listOf("updates", "promotions"), s.cats.setNotify("updates", false).muted)
        assertTrue("not in the synced records", s.account.list("category").all { (_, v) -> (v as JsonObject).keys.none { it == "muted" || it == "notify" } })
        assertEquals(listOf("promotions", "updates"), s.muted())
        s.cats.setNotify("updates", true)
        try {
            s.cats.setNotify("nope", false)
            throw AssertionError("expected invalid")
        } catch (e: CategoryException) {
            assertEquals("invalid", e.code)
        }
        // A new category can start muted: the switch lands on that one.
        val state = s.cats.saveCategory(name = TextEdit.To("Kids"), notify = false)
        val kids = state.categories.first { it.name == "Kids" }.id
        assertEquals(listOf("promotions", kids), state.muted)
        // After a restart.
        s.cats.close()
        val again = Categories(s.account, s.mail, PlainSecrets, s.dir, s.jev, EnglishPresets, s.scope, sortAfterMs = 60_000)
        closers += { again.close() }
        assertEquals(listOf("promotions", kids), again.state.value.muted)
        again.removeCategory("promotions")
        assertEquals(listOf(kids), s.muted())
        assertEquals(listOf(kids), again.state.value.muted)
    }
}
