package nl.bvdm.rukoo.categories

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.MessageSummary
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Signals, the rules and Jev's request: the cases of desktop's test/categories.test.js that need no account. */
class CategoryRulesTest {
    @Test
    fun `mail headers become a few signals`() {
        val raw = "List-Unsubscribe: <https://example.com/u>,\r\n <mailto:u@example.com>\r\nPrecedence: bulk\r\nX-Mailer: MailChimp Mailer\r\nAuto-Submitted: no\r\n"
        assertEquals(MailSignals(list = true, bulk = true, campaign = true), MailSignals.parse(raw))
        assertEquals(MailSignals(bulk = true, auto = true), MailSignals.fromHeaders(mapOf("Auto-Submitted" to "auto-generated", "Feedback-ID" to "1:2:3")))
        assertEquals(MailSignals(), MailSignals.parse(null))
        assertEquals(MailSignals(), MailSignals.fromHeaders(null))
        assertEquals(MailSignals(), MailSignals.parse("Subject: hello\r\n"))
        // A folded header joins its lines, and header names are read in any case.
        assertEquals("a b", MailSignals.headerMap("X-Test: a\r\n\tb\r\n")["x-test"])
        assertEquals(MailSignals(list = true), MailSignals.parse("LIST-ID: <club.example>\n"))
        assertEquals(MailSignals(campaign = true), MailSignals.parse("X-Campaign: 123\r\n"))
        assertEquals(MailSignals(), MailSignals.parse("Precedence: bulky\r\nList-Id:\r\n"))
    }

    private val own = listOf("me@work.example")

    private fun msg(from: Address, subject: String = "Hello", to: List<Address> = listOf(Address("", "me@work.example")), cc: List<Address> = emptyList(), signals: MailSignals? = null, tab: String? = null) =
        MessageSummary(id = "a:INBOX:1", accountId = "a", folder = "INBOX", uid = 1, from = from, to = to, cc = cc, subject = subject, signals = signals, gmailTab = tab)

    private fun pick(m: MessageSummary, vip: Boolean = false, known: Boolean = false) = CategoryRules.presetFor(m, own, vip, known)

    @Test
    fun `the rules place mail by what it says about itself`() {
        assertEquals(RuleResult("needs-you", Strength.STRONG), pick(msg(Address("Boss", "boss@corp.example")), vip = true))
        assertEquals("promotions", pick(msg(Address("Shop", "hi@shop.example"), signals = MailSignals(campaign = true))).preset)
        assertEquals("promotions", pick(msg(Address("Shop", "hi@shop.example"), tab = "promotions")).preset)
        assertEquals("promotions", pick(msg(Address("ANWB", "newsletter@anwb.nl"))).preset)
        assertEquals("money", pick(msg(Address("Energy", "hi@energy.example"), subject = "Your invoice for October")).preset)
        assertEquals("money", pick(msg(Address("Energie", "hi@energie.example"), subject = "Je factuur van oktober")).preset)
        assertEquals(RuleResult("updates", Strength.STRONG), pick(msg(Address("App", "no-reply@app.example"))))
        assertEquals("updates", pick(msg(Address("App", "hi@app.example"), signals = MailSignals(auto = true))).preset)
        assertEquals("updates", pick(msg(Address("Forum", "hi@forum.example"), tab = "forums")).preset)
        // A newsletter, unless the sender is someone you write to.
        assertEquals("promotions", pick(msg(Address("Club", "board@club.example"), signals = MailSignals(list = true))).preset)
        assertEquals("needs-you", pick(msg(Address("Club", "board@club.example"), signals = MailSignals(list = true)), known = true).preset)
        assertEquals("updates", pick(msg(Address("Bank", "service@bank.example"), signals = MailSignals(bulk = true))).preset)
        // People: to you directly needs you, copied is to read.
        assertEquals("needs-you", pick(msg(Address("Sanne de Vries", "sanne@studio.example"))).preset)
        assertEquals("to-read", pick(msg(Address("Sanne de Vries", "sanne@studio.example"), to = listOf(Address("", "team@studio.example")), cc = listOf(Address("", "me@work.example")))).preset)
        assertEquals("needs-you", pick(msg(Address("Colleague", "x@work.example"))).preset)
        assertEquals("needs-you", pick(msg(Address("Friend", "friend@gmail.com"))).preset)
        assertEquals("updates", pick(msg(Address("Vandebron", "support@vandebron.nl"))).preset)
        assertEquals("needs-you", pick(msg(Address("Vandebron", "support@vandebron.nl")), known = true).preset)
    }

    @Test
    fun `when the rules find several categories, the one higher in the person's order wins`() {
        val m = msg(Address("Shop", "hi@shop.example"), subject = "Your invoice", to = emptyList(), signals = MailSignals(campaign = true))
        assertEquals("Money is above Promotions by default", "money", CategoryRules.presetFor(m).preset)
        assertEquals("promotions", CategoryRules.presetFor(m, order = listOf("promotions", "money")).preset)
        val alert = msg(Address("Bank", "noreply@bank.example"), subject = "Payment received", to = emptyList())
        assertEquals("money", CategoryRules.presetFor(alert).preset)
        assertEquals("updates", CategoryRules.presetFor(alert, order = listOf("needs-you", "updates", "money")).preset)
        assertEquals(listOf("money", "updates"), CategoryRules.presetsFor(alert).map { it.preset })
    }

    @Test
    fun `the patterns read words as desktop's do`() {
        // \b is a boundary of ASCII word characters: "factuur" inside a longer word is no money word, and an accented
        // letter before it is no word character to JavaScript.
        assertFalse(pick(msg(Address("A", "a@b.example"), subject = "Factuurnummer 12")).preset == "money")
        assertEquals("money", pick(msg(Address("A", "a@b.example"), subject = "Uw BTW-aangifte")).preset)
        assertEquals("money", pick(msg(Address("A", "a@b.example"), subject = "éfactuur")).preset)
        // A machine's name must be the whole local part, apart from a +tag.
        assertTrue(CategoryRules.isMachine(Address("", "noreply+abc@x.example")))
        assertFalse(CategoryRules.isMachine(Address("", "noreplyteam@x.example")))
        assertFalse(CategoryRules.isMachine(Address("", "noreply\n@x.example")))
    }

    @Test
    fun `a person is a name of two words that matches the address`() {
        assertTrue(CategoryRules.looksLikePerson(Address("Sanne de Vries", "sanne.devries@x.example")))
        assertTrue(CategoryRules.looksLikePerson(Address("Joris Bakker", "jbakker@x.example")))
        assertTrue(CategoryRules.looksLikePerson(Address("José Müller", "jose@x.example")))
        assertFalse(CategoryRules.looksLikePerson(Address("Matthew Berman", "newsletter@x.example")))
        assertFalse(CategoryRules.looksLikePerson(Address("Vandebron", "vandebron@x.example")))
        // JavaScript's \s takes in a non-breaking space.
        assertTrue(CategoryRules.looksLikePerson(Address("Joris Bakker", "jbakker@x.example")))
    }

    @Test
    fun `a site is the domain an address belongs to, and free mail has none`() {
        assertEquals("anwb.nl", Sites.siteOf("info@nieuwsbrieven.anwb.nl"))
        assertEquals("bbc.co.uk", Sites.siteOf("news@mail.bbc.co.uk"))
        assertNull(Sites.siteOf("friend@gmail.com"))
        assertNull(Sites.siteOf("someone@hotmail.nl"))
        assertNull(Sites.siteOf("no-at-sign"))
        assertNull(Sites.siteOf("x@localhost"))
    }

    private val categories = listOf(
        Category("needs-you", "needs-you", "Needs you", "Asks you to act", false, true, "#ff5d73", 0),
        Category("c-1", null, "Needs you", "A duplicate name", true, true, "#4a7dff", 1),
        Category("money", "money", "Geldzaken", "Facturen", true, true, "#2fd6c0", 2),
    )

    @Test
    fun `Jev gets one choice question with the categories as options`() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setResponseCode(200).setBody("""{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"geldzaken","confidence":0.82,"probabilities":{}}}}"""))
            val jev = Jev(OkHttpClient(), server.url("/v1/systemone").toString())
            val m = MessageSummary(
                id = "a:INBOX:1", accountId = "a", folder = "INBOX", uid = 1,
                from = Address("A", "a@x.example"), subject = "Factuur", preview = "x".repeat(5000),
                signals = MailSignals(list = true), gmailTab = "updates",
            )
            assertEquals(JevAnswer("money", 0.82, "jev-1.13.0"), jev.classify("KEY", m, categories, toMe = true))
            val sent = server.takeRequest()
            assertEquals("Bearer KEY", sent.getHeader("Authorization"))
            val body = RukooJson.parseToJsonElement(sent.body.readUtf8()).jsonObject
            assertEquals(Jev.MODEL, body["model"]?.jsonPrimitive?.content)
            val question = body.getValue("questions").jsonObject.getValue("category").jsonObject
            assertEquals("choice", question["type"]?.jsonPrimitive?.content)
            assertEquals(listOf("needs_you", "needs_you_2", "geldzaken"), question.getValue("criteria").jsonObject.keys.toList())
            assertEquals("Facturen", question.getValue("criteria").jsonObject["geldzaken"]?.jsonPrimitive?.content)
            val state = body.getValue("state") as JsonObject
            assertEquals(Jev.TEXT_CHARS, state["text"]?.jsonPrimitive?.content?.length)
            assertEquals("true", state["addressed_to_me"]?.jsonPrimitive?.content)
            assertEquals("true", state["mailing_list"]?.jsonPrimitive?.content)
            assertEquals("updates", state["gmail_tab"]?.jsonPrimitive?.content)
        }
        assertEquals("https://api.typesafe.ai/v1/systemone", Jev.ENDPOINT)
    }

    @Test
    fun `a Jev answer cut off halfway is a network error, not a wait forever`() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(
                MockResponse().setResponseCode(200).setHeader("content-length", "500").setBody("{\"answers\":")
                    .setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY),
            )
            try {
                Jev(OkHttpClient(), server.url("/").toString()).classify("K", MessageSummary(id = "a", accountId = "a", folder = "INBOX", uid = 1), categories.take(1), false)
                fail("a cut-off answer")
            } catch (e: JevError) {
                assertEquals("network", e.code)
            }
        }
    }

    @Test
    fun `Jev errors say what went wrong`() = runBlocking {
        for ((status, code) in listOf(401 to "key", 403 to "key", 429 to "busy", 529 to "busy", 500 to "server")) {
            MockWebServer().use { server ->
                server.start()
                server.enqueue(MockResponse().setResponseCode(status).setBody("""{"error":"x"}"""))
                try {
                    Jev(OkHttpClient(), server.url("/").toString()).classify("K", MessageSummary(id = "a", accountId = "a", folder = "INBOX", uid = 1), categories.take(1), false)
                    fail("expected $code for $status")
                } catch (e: JevError) {
                    assertEquals(code, e.code)
                }
            }
        }
        // A choice it wasn't offered.
        try {
            Jev.answer(RukooJson.parseToJsonElement("""{"answers":{"category":{"choice":"other"}}}""").jsonObject, mapOf("a" to "a"))
            fail("an unknown choice")
        } catch (e: JevError) {
            assertEquals("answer", e.code)
        }
    }

    @Test
    fun `option names are lowercase words, made unique`() {
        val names = Jev.optionNames(
            listOf(
                Category("x", null, "Été & co!", "", true, false, "#000000", 0),
                Category("y", null, "", "", false, false, "#000000", 1),
                Category("z", null, "***", "", true, false, "#000000", 2),
            ),
        )
        assertEquals(listOf("ete_co", "y", "category"), names.values.toList())
    }
}
