package nl.bvdm.rukoo.categories

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonObject
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
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The English texts of the presets, as the app's resources have them. */
object EnglishPresets : CategoryTexts {
    private val names = mapOf("needs-you" to "Needs you", "to-read" to "To read", "money" to "Money", "updates" to "Updates", "promotions" to "Promotions")

    override fun presetName(id: String) = names.getValue(id)

    override fun presetDescription(id: String) = "About $id"
}

/** Inbox categories: the cases of desktop's test/categories.test.js, against an account without a server. */
class CategoriesTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val scopes = mutableListOf<CoroutineScope>()
    private val closers = mutableListOf<() -> Unit>()

    @After
    fun tearDown() {
        closers.forEach { it() }
        scopes.forEach { it.cancel() }
    }

    /** One account with an inbox and a Sent folder, enough for the categories. */
    private class FakeMail(var inbox: List<MessageSummary>, var sent: List<MessageSummary> = emptyList()) : CategoryMail {
        val account = Account("acc1", AccountType.IMAP, "other", AuthKind.PASSWORD, "me@work.example", "Me")
        override val accounts get() = listOf(account)

        override suspend fun inboxes() = listOf(account to inbox)

        override fun writtenTo(): Set<String> = sent.flatMap { it.to + it.cc }.map { Categories.lower(it.address) }.filter { it.isNotEmpty() }.toSet()

        override val changes = MutableSharedFlow<Unit>()
    }

    private class Setup(val cats: Categories, val account: AccountService, val mail: FakeMail, val dir: java.io.File) {
        val acc get() = mail.account

        fun stored(m: MessageSummary): JsonObject? = account.get("classification", cats.key(acc, m)) as? JsonObject
    }

    private fun setup(messages: List<MessageSummary>, jev: JevApi = NoJev, sent: List<MessageSummary> = emptyList(), saveAfterMs: Long = 1000): Setup {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        val dir = tmp.newFolder()
        val account = AccountService(dir, PlainSecrets, "", "desk", AccountHttp { _, _, _, _, _, _ -> null }, scope, pushAfterMs = 60_000, saveAfterMs = saveAfterMs)
        val mail = FakeMail(messages, sent)
        // A long wait before sorting by itself, so each test sorts when it says so.
        val cats = Categories(account, mail, PlainSecrets, dir, jev, EnglishPresets, scope, sortAfterMs = 60_000)
        closers += { cats.close() }
        closers += { account.close() }
        return Setup(cats, account, mail, dir)
    }

    private object NoJev : JevApi {
        override val model = "jev-test"

        override suspend fun classify(key: String, m: MessageSummary, categories: List<Category>, toMe: Boolean): JevAnswer = throw JevError("network")
    }

    private fun msg(uid: Int, from: Address, subject: String, date: Long, to: List<Address> = listOf(Address("", "me@work.example")), signals: MailSignals? = MailSignals(), messageId: String? = "<$uid@x>") =
        MessageSummary(id = "acc1:INBOX:$uid", accountId = "acc1", folder = "INBOX", role = FolderRole.INBOX, uid = uid.toLong(), messageId = messageId, from = from, to = to, subject = subject, date = date, signals = signals)

    private fun inbox() = listOf(
        msg(1, Address("Sanne de Vries", "sanne@studio.example"), "Can you sign this?", 3),
        msg(2, Address("Shop", "news@shop.example"), "Sale", 2, signals = MailSignals(list = true)),
        msg(3, Address("App", "noreply@app.example"), "New login", 1),
    )

    private fun fails(code: String, block: () -> Unit) {
        try {
            block()
            fail("expected $code")
        } catch (e: CategoryException) {
            assertEquals(code, e.code)
        }
    }

    @Test
    fun `categories start off, and turning them on brings the five in order`() {
        val s = setup(inbox())
        val (a, b, c) = s.mail.inbox
        assertNull(s.cats.of(s.acc, a))
        val state = s.cats.setEnabled(true)
        assertEquals(listOf("needs-you", "to-read", "money", "updates", "promotions"), state.categories.map { it.id })
        assertEquals("Needs you", state.categories[0].name)
        assertEquals("to-read", state.unsure)
        assertEquals(listOf("needs-you", "promotions", "updates"), listOf(a, b, c).map { s.cats.of(s.acc, it) })
        // Turning them off and on again doesn't bring back a deleted preset.
        s.cats.removeCategory("money")
        s.cats.setEnabled(false)
        s.cats.setEnabled(true)
        assertFalse(s.cats.state.value.categories.any { it.id == "money" })
    }

    @Test
    fun `a list's lookup gives each inbox email its category, and nothing while categories are off`() {
        val s = setup(inbox())
        val sent = msg(8, Address("Me", "me@work.example"), "Re: hi", 8).copy(id = "acc1:Sent:8", folder = "Sent", role = FolderRole.SENT)
        val list = s.mail.inbox + sent
        assertEquals(CategoryLookup.NONE, s.cats.lookup(listOf(s.acc), list))
        s.cats.setEnabled(true)
        val lookup = s.cats.lookup(listOf(s.acc), list)
        assertEquals(s.cats.of(listOf(s.acc), list), lookup.of)
        assertEquals(listOf("needs-you", "promotions", "updates", null), list.map { lookup[it] })
    }

    @Test
    fun `mail cached before its headers were fetched waits to be sorted`() = runBlocking {
        val s = setup(inbox())
        s.mail.inbox = s.mail.inbox.mapIndexed { i, m -> if (i == 0) m.copy(signals = null) else m }
        val first = s.mail.inbox[0]
        s.cats.setEnabled(true)
        s.cats.sort()
        assertNull(s.stored(first))
        assertEquals("the rules show a category meanwhile", "needs-you", s.cats.of(s.acc, first))
        s.mail.inbox = s.mail.inbox.mapIndexed { i, m -> if (i == 0) m.copy(signals = MailSignals(campaign = true)) else m }
        s.cats.sort()
        assertEquals("promotions", s.stored(first)?.get("category")?.jsonPrimitive?.content)
    }

    @Test
    fun `the person's order of the categories decides between rule matches`() {
        // Without signals yet, so no sort stores it and the rules decide each time.
        val s = setup(listOf(msg(5, Address("Shop", "hi@shop.example"), "Your invoice", 5, to = emptyList(), signals = null).copy(gmailTab = "promotions")))
        val m = s.mail.inbox[0]
        s.cats.setEnabled(true)
        assertEquals("Money is above Promotions by default", "money", s.cats.of(s.acc, m))
        s.cats.reorder(listOf("promotions", "needs-you", "to-read", "money", "updates"))
        assertEquals("promotions", s.cats.of(s.acc, m))
    }

    @Test
    fun `a correction wins over a sender rule, which wins over the stored and the ruled category`() {
        val s = setup(inbox())
        val a = s.mail.inbox[0]
        val key = s.cats.key(s.acc, a)
        // Stored before categories are on, so the sort turning them on starts finds it there (first write wins).
        s.account.put("classification", key, buildJsonObject {
            put("category", "money")
            put("source", "jev")
        }, ifAbsent = true)
        s.cats.setEnabled(true)
        assertEquals("money", s.cats.of(s.acc, a))
        s.account.put("sender", "sanne@studio.example", buildJsonObject { put("category", "to-read") })
        assertEquals("to-read", s.cats.of(s.acc, a))
        s.cats.move(listOf(a), "updates")
        assertEquals("updates", s.cats.of(s.acc, a))
        // A category that no longer exists is skipped.
        s.cats.removeCategory("updates")
        assertEquals("to-read", s.cats.of(s.acc, a))
    }

    @Test
    fun `moving with the sender sets a rule for later mail`() {
        val s = setup(inbox())
        s.cats.setEnabled(true)
        s.cats.move(listOf(s.mail.inbox[1]), "to-read", sender = true)
        assertEquals("to-read", (s.account.get("sender", "news@shop.example") as JsonObject)["category"]?.jsonPrimitive?.content)
        val later = msg(9, Address("Shop", "News@Shop.example"), "More", 9, to = emptyList(), signals = MailSignals(list = true))
        assertEquals("to-read", s.cats.of(s.acc, later))
        assertEquals(listOf(SenderRule("news@shop.example", "to-read")), s.cats.state.value.senders)
        s.cats.forgetSender("news@shop.example")
        assertEquals("promotions", s.cats.of(s.acc, later))
    }

    @Test
    fun `the key is the account and the Message-ID, or a hash of sender, date and subject`() {
        val s = setup(inbox())
        assertEquals("me@work.example\n<1@x>", s.cats.key(s.acc.copy(email = " Me@Work.example "), s.mail.inbox[0]))
        val bare = msg(7, Address("A", " A@B.example "), "Hi", 1793000000000, messageId = null)
        // sha256("a@b.example\n1793000000000\nHi"), as desktop's crypto.createHash makes it.
        val expected = java.security.MessageDigest.getInstance("SHA-256").digest("a@b.example\n1793000000000\nHi".toByteArray()).joinToString("") { "%02x".format(it) }
        assertEquals("me@work.example\nh:$expected", s.cats.key(s.acc, bare))
        assertEquals(s.cats.key(s.acc, bare), s.cats.key(s.acc, bare.copy(messageId = "")))
    }

    @Test
    fun `a very long Message-ID is kept as its hash`() {
        val s = setup(inbox())
        val long = "<${"x".repeat(20000)}@evil.example>"
        val key = s.cats.key(s.acc, s.mail.inbox[0].copy(messageId = long))
        assertTrue(key, Regex("me@work\\.example\nm:[0-9a-f]{64}").matches(key))
        assertEquals("me@work.example\n<short@x>", s.cats.key(s.acc, s.mail.inbox[0].copy(messageId = "<short@x>")))
        // 256 characters is still a Message-ID; one more becomes its hash.
        val edge = "<" + "y".repeat(254) + ">"
        assertEquals("me@work.example\n$edge", s.cats.key(s.acc, s.mail.inbox[0].copy(messageId = edge)))
        assertTrue(s.cats.key(s.acc, s.mail.inbox[0].copy(messageId = "$edge!")).contains("\nm:"))
    }

    @Test
    fun `sorting stores the rules result once, first write wins`() = runBlocking {
        val s = setup(inbox())
        s.cats.setEnabled(true)
        // Turning categories on starts a sort; this one follows it, or comes after it.
        s.cats.sort()
        assertEquals(3, s.account.list("classification").size)
        val a = s.mail.inbox[0]
        assertEquals("needs-you", s.stored(a)?.get("category")?.jsonPrimitive?.content)
        assertEquals("rules", s.stored(a)?.get("source")?.jsonPrimitive?.content)
        assertEquals("nothing left to sort", 0, s.cats.sort())
        // Sorting again overwrites, apart from what was moved by hand.
        s.cats.move(listOf(s.mail.inbox[2]), "money")
        s.mail.inbox = s.mail.inbox.map { if (it.uid == 1L) it.copy(vip = true) else it }
        assertEquals(2, s.cats.sortAgain())
    }

    @Test
    fun `the people you wrote to count as people`() = runBlocking {
        val sent = listOf(MessageSummary(id = "acc1:Sent:1", accountId = "acc1", folder = "Sent", uid = 1, to = listOf(Address("", "Board@Club.example"))))
        val club = msg(4, Address("Club", "board@club.example"), "Meeting notes", 0, signals = MailSignals(list = true))
        val s = setup(inbox() + club, sent = sent)
        s.cats.setEnabled(true)
        s.cats.sort()
        // The rules decide here, not what that sort stored.
        s.account.remove("classification", s.cats.key(s.acc, club))
        assertEquals("a mailing list from someone you write to", "needs-you", s.cats.of(s.acc, club))
        s.mail.sent = emptyList()
        assertEquals("promotions", s.cats.of(s.acc, club))
    }

    private class FakeJev(val answer: suspend (String, MessageSummary, List<Category>) -> JevAnswer) : JevApi {
        override val model = "jev-test"
        val calls = java.util.concurrent.CopyOnWriteArrayList<Pair<String, String>>()

        override suspend fun classify(key: String, m: MessageSummary, categories: List<Category>, toMe: Boolean): JevAnswer {
            calls += key to m.subject
            return answer(key, m, categories)
        }
    }

    @Test
    fun `Jev sorts the uncertain mail, and an unsure answer goes to the unsure category`() = runBlocking {
        val fake = FakeJev { _, m, _ ->
            if (m.subject == "Can you sign this?") JevAnswer("money", 0.9, "jev-test") else JevAnswer("promotions", 0.3, "jev-test")
        }
        // From a sender whose address doesn't say it sends offers, so only the unsubscribe link points that way.
        val msgs = inbox().mapIndexed { i, m -> if (i == 1) m.copy(from = Address("Shop", "hello@shop.example")) else m } +
            msg(4, Address("Club", "board@club.example"), "Meeting notes", 0, signals = MailSignals(list = true))
        val s = setup(msgs, fake)
        s.cats.setJev(on = true, key = "SECRET")
        s.cats.setEnabled(true)
        assertTrue(s.cats.state.value.jev.on)
        val local = java.io.File(s.dir, "categories.json").readText()
        assertTrue("the key is stored through the Keystore box", !local.contains("SECRET") && local.contains("plain:"))
        s.cats.sort()
        // The noreply login alert is a strong rule and never goes to Jev.
        assertEquals(listOf("Can you sign this?", "Meeting notes", "Sale"), fake.calls.map { it.second }.sorted())
        assertEquals("SECRET", fake.calls[0].first)
        val one = s.stored(msgs[0])!!
        assertEquals("money", one["category"]?.jsonPrimitive?.content)
        assertEquals("jev", one["source"]?.jsonPrimitive?.content)
        assertEquals("0.9", one["confidence"]?.jsonPrimitive?.content)
        assertEquals("below the confidence line it goes to the unsure category", "to-read", s.stored(msgs[1])?.get("category")?.jsonPrimitive?.content)
        assertEquals("rules", s.stored(msgs[2])?.get("source")?.jsonPrimitive?.content)
    }

    @Test
    fun `the drawer can follow Jev's progress and its last decisions`() = runBlocking {
        val gate = kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.UNLIMITED)
        val fake = FakeJev { _, m, _ ->
            gate.receive()
            if (m.subject == "Sale") JevAnswer("promotions", 0.3, "jev-test") else JevAnswer("money", 0.9, "jev-test")
        }
        val msgs = inbox().mapIndexed { i, m -> if (i == 1) m.copy(from = Address("Shop", "hello@shop.example")) else m }
        val s = setup(msgs, fake)
        s.cats.setJev(on = true, key = "K")
        s.cats.setEnabled(true)
        // The rules placed the login alert straight away; two wait for Jev.
        var a = withTimeout(5_000) { s.cats.activity.first { it.running && it.asked == 2 } }
        assertEquals(listOf(true, 3, 1, 0, true), listOf(a.user, a.total, a.done, a.answered, a.jev))
        gate.send(Unit)
        a = withTimeout(5_000) { s.cats.activity.first { it.answered == 1 } }
        assertEquals(2, a.done)
        assertEquals(1, a.recent.size)
        gate.send(Unit)
        a = withTimeout(5_000) { s.cats.activity.first { !it.running && it.finishedAt > 0 } }
        assertEquals(listOf(3, 3, 0), listOf(a.done, a.sorted, a.waiting))
        val sale = a.recent.first { it.subject == "Sale" }
        assertEquals("an unsure answer shows where it went", listOf("to-read", "promotions", false, "acc1"), listOf(sale.category, sale.chose, sale.sure, sale.accountId))
        assertEquals("Sanne de Vries", a.recent.first { it.subject == "Can you sign this?" }.from)

        // A sort nobody asked for with nothing to do leaves the last one's progress alone.
        s.cats.sort()
        assertEquals(a.finishedAt, s.cats.activity.value.finishedAt)

        // Sorted again, an email shows once, with its newest decision.
        repeat(2) { gate.send(Unit) }
        s.cats.sortAgain()
        assertEquals(listOf("Can you sign this?", "Sale"), s.cats.activity.value.recent.map { it.subject }.sorted())
    }

    @Test
    fun `mail waiting for Jev is counted, with why and until when`() = runBlocking {
        val s = setup(inbox(), FakeJev { _, _, _ -> throw JevError("busy") })
        s.cats.setJev(on = true, key = "K")
        s.cats.setEnabled(true)
        s.cats.sort()
        var a = s.cats.activity.value
        assertEquals("busy", a.error)
        assertTrue(a.retryAt > System.currentTimeMillis())
        assertEquals("the email the rules are unsure about waits", 1, a.waiting)
        // While TypeSafe is busy, nothing is asked and the count stays.
        s.cats.sort()
        a = s.cats.activity.value
        assertEquals(1, a.waiting)
        assertFalse(a.running)
        // Jev off: nothing waits for it any more.
        s.cats.setJev(on = false)
        a = s.cats.activity.value
        assertEquals(listOf(false, null, 0L, 0), listOf(a.jev, a.error, a.retryAt, a.waiting))
    }

    @Test
    fun `a refused Jev key stops Jev until a new key, and busy waits, with the uncertain mail kept for Jev`() = runBlocking {
        var failing: String? = "key"
        val fake = FakeJev { _, _, list ->
            failing?.let { throw JevError(it) }
            JevAnswer(list[2].id, 0.9, "jev-test")
        }
        val s = setup(inbox(), fake)
        val (one, _, three) = s.mail.inbox
        s.cats.setJev(on = true, key = "BAD")
        s.cats.setEnabled(true)
        s.cats.sort()
        assertEquals("key", s.cats.state.value.jev.error)
        assertNull("the uncertain email waits for Jev", s.stored(one))
        assertEquals("a strong rule is stored as always", "rules", s.stored(three)?.get("source")?.jsonPrimitive?.content)
        assertEquals("the rules show a category meanwhile", "needs-you", s.cats.of(s.acc, one))

        // No more calls with the refused key, however often the inbox is sorted.
        val before = fake.calls.size
        s.cats.sort()
        s.cats.sort()
        assertEquals(before, fake.calls.size)
        assertEquals("key", s.cats.state.value.jev.error)

        // Busy: no calls during the wait, and the email still waits.
        failing = "busy"
        s.cats.setJev(key = "NEW")
        s.cats.sort()
        assertEquals("busy", s.cats.state.value.jev.error)
        assertTrue(s.cats.jevBusyUntil > System.currentTimeMillis())
        val during = fake.calls.size
        s.cats.sort()
        assertEquals(during, fake.calls.size)
        assertNull(s.stored(one))

        // After the wait, Jev sorts it.
        failing = null
        s.cats.jevBusyUntil = 0
        s.cats.sort()
        assertEquals("jev", s.stored(one)?.get("source")?.jsonPrimitive?.content)
        assertNull(s.cats.state.value.jev.error)

        // Jev turned off: the rules store what is left.
        s.cats.setJev(on = false)
        s.cats.sortAgain()
        assertEquals("rules", s.stored(one)?.get("source")?.jsonPrimitive?.content)
    }

    @Test
    fun `turning Jev off stops the emails still queued for it`() = runBlocking {
        lateinit var cats: Categories
        val fake = FakeJev { _, _, list ->
            delay(20)
            JevAnswer(list[0].id, 0.9, "jev-test")
        }
        val gate = object : JevApi by fake {
            var calls = 0

            override suspend fun classify(key: String, m: MessageSummary, categories: List<Category>, toMe: Boolean): JevAnswer {
                synchronized(this) {
                    calls++
                    if (calls == 1) cats.setJev(on = false, removeKey = true)
                }
                return fake.classify(key, m, categories, toMe)
            }
        }
        val msgs = (0 until 8).map { i -> msg(10 + i, Address("Person Name", "person$i@studio.example"), "Note $i", i.toLong(), to = emptyList()).copy(cc = listOf(Address("", "me@work.example"))) }
        val s = setup(msgs, gate)
        cats = s.cats
        s.cats.setJev(on = true, key = "KEY")
        s.cats.setEnabled(true)
        s.cats.sort()
        // Desktop's single thread lets only the first request out; here three workers start at once, and the ones
        // already on their way finish. The other five stay queued.
        assertTrue("only the requests already on their way: ${gate.calls}", gate.calls <= 3)
    }

    @Test
    fun `an answer that comes back after Jev was turned off is not stored`() = runBlocking {
        val asked = CompletableDeferred<Unit>()
        val answer = CompletableDeferred<Unit>()
        val fake = FakeJev { _, _, _ ->
            asked.complete(Unit)
            answer.await()
            JevAnswer("money", 0.9, "jev-test")
        }
        val s = setup(inbox(), fake)
        val one = s.mail.inbox[0]
        s.cats.setJev(on = true, key = "KEY")
        s.cats.setEnabled(true)
        val sorting = async { s.cats.sort() }
        asked.await()
        s.cats.setJev(on = false)
        answer.complete(Unit)
        sorting.await()
        assertTrue("the late answer from Jev was dropped", s.stored(one)?.get("source")?.jsonPrimitive?.content != "jev")
        s.cats.sort()
        assertEquals("the next sort, without Jev, sorts it", "rules", s.stored(one)?.get("source")?.jsonPrimitive?.content)
    }

    @Test
    fun `only inbox mail has a category`() {
        val s = setup(inbox())
        s.cats.setEnabled(true)
        val sent = s.mail.inbox[0].copy(id = "acc1:Sent:1", folder = "Sent", role = FolderRole.SENT)
        val archived = s.mail.inbox[1].copy(id = "acc1:Archive:2", folder = "Archive", role = FolderRole.ARCHIVE)
        val inboxMail = s.mail.inbox[2].copy(role = FolderRole.INBOX)
        val shown = s.cats.of(listOf(s.acc), listOf(sent, archived, inboxMail))
        assertEquals("a mixed selection: only the inbox email has one", setOf(inboxMail.id), shown.keys)
        assertNull(s.cats.of(s.acc, sent))
    }

    @Test
    fun `categories turned on by another device sort this phone's inbox`() = runBlocking {
        val srv = nl.bvdm.rukoo.account.FakeAccountServer().also { closers += { it.close() } }
        fun device(name: String): AccountService {
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
            return AccountService(tmp.newFolder(), PlainSecrets, srv.url, name, nl.bvdm.rukoo.account.OkHttpAccountHttp(okhttp3.OkHttpClient()), scope, devHosts = true, pushAfterMs = 60_000)
                .also { closers += { it.close() } }
        }
        val desk = device("desk")
        desk.signUp("on@example.com", "a long enough password")
        val deskCats = Categories(desk, FakeMail(emptyList()), PlainSecrets, tmp.newFolder(), NoJev, EnglishPresets, CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }, sortAfterMs = 60_000)
        closers += { deskCats.close() }
        val phone = device("phone")
        phone.signIn("on@example.com", "a long enough password")
        phone.sync()
        val mail = FakeMail(inbox())
        val phoneCats = Categories(phone, mail, PlainSecrets, tmp.newFolder(), NoJev, EnglishPresets, CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }, sortAfterMs = 60_000)
        closers += { phoneCats.close() }
        assertFalse(phoneCats.state.value.enabled)
        // The desk turns categories on; the phone learns of it with its next sync, and sorts without waiting.
        deskCats.setEnabled(true)
        desk.sync()
        phone.sync()
        withTimeout(10_000) {
            while (phone.list("classification").size < 3) delay(20)
        }
        assertTrue(phoneCats.state.value.enabled)
        assertEquals(3, phone.list("classification").size)
    }

    @Test
    fun `a refusal for a key that was replaced meanwhile leaves the new key alone`() = runBlocking {
        val refuse = CompletableDeferred<Unit>()
        val asked = CompletableDeferred<Unit>()
        val fake = FakeJev { key, _, _ ->
            if (key == "OLD") {
                asked.complete(Unit)
                refuse.await()
                throw JevError("key")
            }
            JevAnswer("money", 0.9, "jev-test")
        }
        val s = setup(inbox(), fake)
        s.cats.setJev(on = true, key = "OLD")
        s.cats.setEnabled(true)
        val sorting = async { s.cats.sort() }
        asked.await()
        s.cats.setJev(key = "NEW")
        refuse.complete(Unit)
        sorting.await()
        assertNull(s.cats.state.value.jev.error)
        assertEquals("NEW", s.cats.jevKey())
    }

    @Test
    fun `the sort after TypeSafe was busy survives other updates`() = runBlocking {
        val fake = FakeJev { _, _, _ -> throw JevError("busy") }
        val s = setup(inbox(), fake)
        s.cats.setJev(on = true, key = "KEY")
        s.cats.setEnabled(true)
        s.cats.sort()
        assertEquals("busy", s.cats.state.value.jev.error)
        val retry = s.cats.retryTimer
        assertNotNull("a sort is set for after the wait", retry)
        s.cats.soon(0)
        s.cats.sort()
        assertSame("mail updates and early sorts leave it", retry, s.cats.retryTimer)
        // Lost anyway (say, after a restart while busy): a sort during the wait sets it again.
        s.cats.retryTimer?.cancel()
        s.cats.retryTimer = null
        s.cats.sort()
        assertNotNull(s.cats.retryTimer)
    }

    @Test
    fun `sorting again finishes the emails Jev was too busy for, once it answers`() = runBlocking {
        var busy = true
        val fake = FakeJev { _, _, _ ->
            if (busy) throw JevError("busy")
            JevAnswer("money", 0.9, "jev-test")
        }
        val s = setup(inbox(), fake)
        val one = s.mail.inbox[0]
        s.cats.setEnabled(true)
        s.cats.sort()
        assertEquals("sorted by the rules before Jev was on", "rules", s.stored(one)?.get("source")?.jsonPrimitive?.content)
        s.cats.setJev(on = true, key = "KEY")
        s.cats.sortAgain()
        assertEquals("busy", s.cats.state.value.jev.error)
        assertEquals("the older category stays meanwhile", "rules", s.stored(one)?.get("source")?.jsonPrimitive?.content)
        busy = false
        s.cats.jevBusyUntil = 0
        val before = fake.calls.size
        s.cats.sort()
        assertTrue("the retry goes to Jev", fake.calls.size > before)
        assertEquals("jev", s.stored(one)?.get("source")?.jsonPrimitive?.content)
        assertTrue(s.cats.redoKeys().isEmpty())
    }

    @Test
    fun `a re-sort Jev was too busy for is finished after a restart`() = runBlocking {
        var busy = true
        val fake = FakeJev { _, _, _ ->
            if (busy) throw JevError("busy")
            JevAnswer("money", 0.9, "jev-test")
        }
        val s = setup(inbox(), fake)
        val one = s.mail.inbox[0]
        s.cats.setEnabled(true)
        s.cats.sort()
        s.cats.setJev(on = true, key = "KEY")
        s.cats.sortAgain()
        val left = s.cats.redoKeys()
        assertTrue(left.isNotEmpty())
        s.cats.close()
        // The app starts again: new Categories on the same files, with TypeSafe answering.
        busy = false
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        val again = Categories(s.account, s.mail, PlainSecrets, s.dir, fake, EnglishPresets, scope, sortAfterMs = 60_000)
        closers += { again.close() }
        assertEquals(left, again.redoKeys())
        again.sort()
        assertEquals("jev", s.stored(one)?.get("source")?.jsonPrimitive?.content)
        assertTrue(again.redoKeys().isEmpty())
        assertFalse("the finished re-sort is gone from the file too", java.io.File(s.dir, "categories.json").readText().contains("<1@x>"))
    }

    @Test
    fun `a re-sort the app is stopped during goes on after a restart`() = runBlocking {
        var category = "promotions"
        var hold = false
        val asked = CompletableDeferred<Unit>()
        val fake = FakeJev { _, _, _ ->
            if (hold) {
                asked.complete(Unit)
                CompletableDeferred<Unit>().await()
            }
            JevAnswer(category, 0.9, "jev-test")
        }
        val s = setup(inbox(), fake)
        val one = s.mail.inbox[0]
        // Jev first: turning categories on sorts at once, on another thread.
        s.cats.setJev(on = true, key = "KEY")
        s.cats.setEnabled(true)
        s.cats.sort()
        assertEquals("promotions", s.stored(one)?.get("category")?.jsonPrimitive?.content)

        // "Sort again", and Android stops the app while Jev is answering: only what is on file is left.
        hold = true
        val running = launch(Dispatchers.Default) { runCatching { s.cats.sortAgain() } }
        withTimeout(10_000) { asked.await() }
        assertTrue("the emails waiting for Jev are on file", java.io.File(s.dir, "categories.json").readText().contains("<1@x>"))
        running.cancel()
        s.cats.close()

        hold = false
        category = "money"
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        val again = Categories(s.account, s.mail, PlainSecrets, s.dir, fake, EnglishPresets, scope, sortAfterMs = 60_000)
        closers += { again.close() }
        again.sort()
        assertEquals("the re-sort replaced the old answer", "money", s.stored(one)?.get("category")?.jsonPrimitive?.content)
        assertTrue(again.redoKeys().isEmpty())
    }

    @Test
    fun `a finished re-sort's answers are on disk before the list that says it's done`() = runBlocking {
        var category = "promotions"
        val fake = FakeJev { _, _, _ -> JevAnswer(category, 0.9, "jev-test") }
        // The account saves its records only long after a change, so only what Categories writes is on disk.
        val s = setup(inbox(), fake, saveAfterMs = 60_000)
        val one = s.mail.inbox[0]
        // Jev first: turning categories on sorts at once, on another thread.
        s.cats.setJev(on = true, key = "KEY")
        s.cats.setEnabled(true)
        s.cats.sort()
        category = "money"
        s.cats.sortAgain()
        assertFalse(java.io.File(s.dir, "categories.json").readText().contains("<1@x>"))
        // Android stops the app now: a new account service reads what is on disk.
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        val account = AccountService(s.dir, PlainSecrets, "", "desk", AccountHttp { _, _, _, _, _, _ -> null }, scope, pushAfterMs = 60_000)
        closers += { account.close() }
        assertEquals("money", (account.get("classification", s.cats.key(s.acc, one)) as? JsonObject)?.get("category")?.jsonPrimitive?.content)
    }

    @Test
    fun `a re-sort whose answers the disk refuses stays on the list on disk`() = runBlocking {
        var category = "promotions"
        val fake = FakeJev { _, _, _ -> JevAnswer(category, 0.9, "jev-test") }
        val s = setup(inbox(), fake)
        // Jev first: turning categories on sorts at once, on another thread.
        s.cats.setJev(on = true, key = "KEY")
        s.cats.setEnabled(true)
        s.cats.sort()
        // The disk refuses the account's records from now on: a directory where their file goes stands in for a full
        // disk.
        val records = java.io.File(s.dir, "account-records.json")
        records.delete()
        java.io.File(records, "x").mkdirs()
        category = "money"
        s.cats.sortAgain()
        assertTrue("the email stays on the list on disk", java.io.File(s.dir, "categories.json").readText().contains("<1@x>"))
    }

    @Test
    fun `after a restart the left-over re-sort runs without any mail change`() = runBlocking {
        var busy = true
        val fake = FakeJev { _, _, _ ->
            if (busy) throw JevError("busy")
            JevAnswer("money", 0.9, "jev-test")
        }
        val s = setup(inbox(), fake)
        val one = s.mail.inbox[0]
        s.cats.setEnabled(true)
        s.cats.sort()
        s.cats.setJev(on = true, key = "KEY")
        s.cats.sortAgain()
        assertTrue(s.cats.redoKeys().isNotEmpty())
        s.cats.close()
        // The app starts again with its cache already loaded; the mail doesn't change.
        busy = false
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        val again = Categories(s.account, s.mail, PlainSecrets, s.dir, fake, EnglishPresets, scope, sortAfterMs = 20)
        closers += { again.close() }
        // Done once Jev's answer is stored and the email has left the re-sort's list, which happens right after.
        withTimeout(10_000) {
            while (s.stored(one)?.get("source")?.jsonPrimitive?.content != "jev" || again.redoKeys().isNotEmpty()) delay(20)
        }
        assertTrue(again.redoKeys().isEmpty())
    }

    @Test
    fun `the engine's inbox counts as a change the first time too`() = runBlocking {
        val engine = nl.bvdm.rukoo.mail.demo.PreviewMailEngine()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        // Loaded before the categories look at it; nothing changes afterwards.
        engine.listMessages(nl.bvdm.rukoo.mail.model.MailView.AllInboxes)
        val mail = EngineCategoryMail(engine, scope)
        withTimeout(10_000) { mail.changes.first() }
    }

    @Test
    fun `sorting again while a sort runs follows it instead of getting lost`() = runBlocking {
        val release = CompletableDeferred<Unit>()
        val waiting = CompletableDeferred<Unit>()
        val first = java.util.concurrent.atomic.AtomicBoolean(true)
        val fake = FakeJev { _, _, _ ->
            if (first.getAndSet(false)) {
                waiting.complete(Unit)
                release.await()
            }
            JevAnswer("money", 0.9, "jev-test")
        }
        val s = setup(inbox(), fake)
        val (one, _, three) = s.mail.inbox
        s.cats.setEnabled(true)
        s.cats.sort()
        assertEquals("rules", s.stored(three)?.get("source")?.jsonPrimitive?.content)
        // A new email starts an ordinary sort with Jev; "Sort again" comes while it waits on Jev.
        val fyi = msg(7, Address("Person Name", "person@studio.example"), "FYI", 7, to = emptyList()).copy(cc = listOf(Address("", "me@work.example")))
        s.mail.inbox = s.mail.inbox + fyi
        s.cats.setJev(on = true, key = "KEY")
        val running = async { s.cats.sort() }
        waiting.await()
        val again = async { s.cats.sortAgain() }
        delay(100)
        release.complete(Unit)
        running.await()
        again.await()
        assertEquals("jev", s.stored(fyi)?.get("source")?.jsonPrimitive?.content)
        assertEquals("sorted again, not left as it was", "jev", s.stored(one)?.get("source")?.jsonPrimitive?.content)
    }

    @Test
    fun `categories can be added, renamed, reordered and deleted, within limits`() {
        val s = setup(inbox())
        s.cats.setEnabled(true)
        fails("need_name") { s.cats.saveCategory(name = TextEdit.To("  ")) }
        var state = s.cats.saveCategory(name = TextEdit.To("Kids"), description = TextEdit.To("School and sports clubs"), color = "#4a7dff")
        val kids = state.categories.first { it.name == "Kids" }
        assertEquals(5, kids.order)
        state = s.cats.saveCategory("money", name = TextEdit.To("Finance"))
        assertEquals("Finance", state.categories.first { it.id == "money" }.name)
        state = s.cats.saveCategory("money", name = TextEdit.Reset)
        assertEquals("back to the preset name", "Money", state.categories.first { it.id == "money" }.name)
        state = s.cats.reorder(listOf(kids.id, "needs-you", "to-read", "money", "updates", "promotions"))
        assertEquals(kids.id, state.categories[0].id)
        fails("invalid") { s.cats.reorder(listOf("needs-you")) }
        s.cats.setUnsure(kids.id)
        state = s.cats.removeCategory(kids.id)
        assertTrue(state.unsure != kids.id)
        for (i in state.categories.size until 12) s.cats.saveCategory(name = TextEdit.To("C$i"))
        fails("too_many") { s.cats.saveCategory(name = TextEdit.To("One more")) }
        // A long name is cut at 40 characters, and an odd color is replaced.
        val list = s.cats.state.value.categories
        s.cats.removeCategory(list.last().id)
        state = s.cats.saveCategory(name = TextEdit.To("x".repeat(60)), color = "red")
        val made = state.categories.last()
        assertEquals(40, made.name.length)
        assertTrue(made.color.startsWith("#"))
    }

    @Test
    fun `the last category stays`() {
        val s = setup(inbox())
        s.cats.setEnabled(true)
        for (id in listOf("needs-you", "to-read", "money", "updates")) s.cats.removeCategory(id)
        fails("last") { s.cats.removeCategory("promotions") }
        assertEquals("the one left takes the unsure mail", "promotions", s.cats.state.value.unsure)
    }

    @Test
    fun `new mail is sorted shortly after the mail changes`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        val dir = tmp.newFolder()
        val account = AccountService(dir, PlainSecrets, "", "desk", AccountHttp { _, _, _, _, _, _ -> null }, scope)
        val mail = FakeMail(inbox())
        val cats = Categories(account, mail, PlainSecrets, dir, NoJev, EnglishPresets, scope, sortAfterMs = 20)
        closers += { cats.close() }
        cats.setEnabled(true)
        withTimeout(5_000) {
            while (account.list("classification").size < 3) {
                mail.changes.emit(Unit)
                delay(50)
            }
        }
        assertEquals(3, account.list("classification").size)
        assertTrue(account.list("classification").all { it.v.jsonObject["source"]?.jsonPrimitive?.content == "rules" })
    }
}
