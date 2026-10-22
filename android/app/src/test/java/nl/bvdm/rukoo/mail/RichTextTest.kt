package nl.bvdm.rukoo.mail

import kotlin.random.Random
import kotlinx.serialization.json.Json
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.mail.compose.Block
import nl.bvdm.rukoo.mail.compose.ComposeBody
import nl.bvdm.rukoo.mail.compose.LinkRange
import nl.bvdm.rukoo.mail.compose.Mark
import nl.bvdm.rukoo.mail.compose.MarkRange
import nl.bvdm.rukoo.mail.compose.Quote
import nl.bvdm.rukoo.mail.compose.ReplyBuilder
import nl.bvdm.rukoo.mail.compose.RichDoc
import nl.bvdm.rukoo.mail.compose.RichText
import nl.bvdm.rukoo.mail.compose.toOutgoing
import nl.bvdm.rukoo.mail.engine.MailViews
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.AccountType
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.AuthKind
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.mail.model.Signature
import nl.bvdm.rukoo.ui.ComposerState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RichTextTest {
    // "Hi Sanne," / "" / bullets "one", "two" / a heading / numbered "a", "b" / "See the plan." with a link.
    private val sample = RichDoc(
        text = "Hi Sanne,\n\none\ntwo with bold\nNext steps\na\nb\nSee the plan.",
        marks = listOf(MarkRange(3, 8, Mark.BOLD), MarkRange(24, 28, Mark.BOLD), MarkRange(24, 28, Mark.ITALIC)),
        links = listOf(LinkRange(52, 56, "https://example.com/plan")),
        blocks = listOf(Block.TEXT, Block.TEXT, Block.BULLET, Block.BULLET, Block.HEADING, Block.NUMBER, Block.NUMBER, Block.TEXT),
    )

    @Test
    fun `the html is desktop's line structure with lists, a heading and inline tags`() {
        assertEquals(
            "<div>Hi <b>Sanne</b>,</div><div><br></div><ul><li>one</li><li>two with <b><i>bold</i></b></li></ul>" +
                "${RichText.HEADING_OPEN}Next steps</h2><ol><li>a</li><li>b</li></ol><div>See the <a href=\"https://example.com/plan\">plan</a>.</div>",
            RichText.toHtml(sample),
        )
        assertEquals("<div><br></div>", RichText.toHtml(RichDoc("")))
        // An empty item keeps its line; spaces HTML would collapse stay.
        assertEquals("<ul><li><br></li></ul><div>&nbsp;a &nbsp;b&nbsp;</div>", RichText.toHtml(RichDoc("\n a  b ", blocks = listOf(Block.BULLET))))
        assertEquals("<div>1 &lt; 2 &amp; &quot;x&quot; &#39;y&#39;</div>", RichText.toHtml(RichDoc("1 < 2 & \"x\" 'y'")))
    }

    @Test
    fun `html round-trips to the same document`() {
        assertEquals(sample, RichText.parse(RichText.toHtml(sample)))
        val overlapping = RichDoc(
            "plain bold both italic link",
            marks = listOf(MarkRange(6, 15, Mark.BOLD), MarkRange(11, 22, Mark.ITALIC), MarkRange(23, 27, Mark.UNDERLINE), MarkRange(23, 27, Mark.STRIKE)),
            links = listOf(LinkRange(18, 27, "mailto:sanne@example.com")),
        )
        assertEquals(canonical(overlapping), RichText.parse(RichText.toHtml(overlapping)))
    }

    @Test
    fun `random documents round-trip`() {
        val random = Random(7)
        val alphabet = "abc xyz,.<>&\"'éß"
        repeat(400) {
            val lines = (0 until random.nextInt(1, 6)).map { (0 until random.nextInt(0, 12)).map { alphabet[random.nextInt(alphabet.length)] }.joinToString("") }
            val text = lines.joinToString("\n")
            fun range(): Pair<Int, Int>? {
                if (text.isEmpty()) return null
                val a = random.nextInt(text.length)
                val b = random.nextInt(a, text.length + 1)
                return if (a < b) a to b else null
            }
            val marks = (0 until random.nextInt(0, 4)).mapNotNull { range()?.let { (a, b) -> MarkRange(a, b, Mark.entries[random.nextInt(4)]) } }
            val links = listOfNotNull(range()?.takeIf { random.nextBoolean() }?.let { (a, b) -> LinkRange(a, b, "https://x.nl/${random.nextInt(3)}") })
            val blocks = lines.map { Block.entries[random.nextInt(Block.entries.size)] }
            val doc = canonical(RichDoc(text, marks, links, blocks))
            val html = RichText.toHtml(doc)
            assertEquals(html, doc, RichText.parse(html))
            assertEquals(html, RichText.plain(doc), RichText.plain(RichText.parse(html)))
        }
    }

    @Test
    fun `desktop's editor writes bold and italic as css on spans`() {
        val html = Quote.WRAPPER_OPEN +
            "<div>Hi <span style=\"font-weight: bold;\">Sanne</span>,</div><div><br></div>" +
            "<ul><li><span style=\"font-style: italic;\">one</span></li><li>two <span style=\"text-decoration-line: underline;\">u</span></li></ul>" +
            "<ol><li>first</li></ol><div><a href=\"https://bvdm.ai\">bvdm</a> <span style=\"color: rgb(214, 51, 108);\">red</span></div></div>"
        val doc = RichText.parse(html)
        assertEquals("Hi Sanne,\n\none\ntwo u\nfirst\nbvdm red", doc.text)
        assertEquals(listOf(Block.TEXT, Block.TEXT, Block.BULLET, Block.BULLET, Block.NUMBER, Block.TEXT), doc.blocks)
        assertEquals(listOf(MarkRange(3, 8, Mark.BOLD), MarkRange(11, 14, Mark.ITALIC), MarkRange(19, 20, Mark.UNDERLINE)), doc.marks)
        assertEquals(listOf(LinkRange(27, 31, "https://bvdm.ai")), doc.links)
        assertEquals("Hi Sanne,\n\n * one\n * two u\n1. first\nbvdm red", RichText.plain(doc))
    }

    @Test
    fun `other clients' html maps onto the subset and keeps every word`() {
        // Gmail: a dir wrapper with divs, <b> and <i>.
        assertEquals(
            RichDoc("Hi\n\nbold it", listOf(MarkRange(4, 8, Mark.BOLD), MarkRange(9, 11, Mark.ITALIC)), blocks = listOf(Block.TEXT, Block.TEXT, Block.TEXT)),
            RichText.parse("<div dir=\"ltr\">Hi<div><br></div><div><b>bold</b> <i>it</i></div></div>"),
        )
        // Paragraphs with margins leave an empty line; Outlook's MsoNormal ones don't.
        assertEquals("One\n\nTwo", RichText.parse("<p>One</p><p>Two</p>").text)
        assertEquals("One\nTwo", RichText.parse("<p class=MsoNormal>One</p><p class=MsoNormal>Two</p>").text)
        // Scripts, styles, images and form controls go with their contents; unsafe links keep only their text.
        val hostile = RichText.parse("<style>p{}</style><script>alert(1)</script><p>Click <a href=\"javascript:alert(1)\">here</a><img src=x onerror=y> <button>Hidden</button>now</p>")
        assertEquals("Click here now", hostile.text)
        assertTrue(hostile.links.isEmpty())
        // Strong, em, del; a <b> that a style makes normal again (Google Docs) isn't bold.
        assertEquals(
            listOf(MarkRange(0, 1, Mark.BOLD), MarkRange(2, 3, Mark.ITALIC), MarkRange(4, 5, Mark.STRIKE)),
            RichText.parse("<strong>a</strong> <em>b</em> <del>c</del> <b style=\"font-weight:normal\">d</b>").marks,
        )
        // Nested lists become one level; headings of any level are the heading; a quote's lines start with "> ".
        val nested = RichText.parse("<h1>Title</h1><ul><li>one<ul><li>inner</li></ul></li><li>two</li></ul><blockquote><div>said</div></blockquote><pre>a  b\nc</pre>")
        assertEquals("Title\none\ninner\ntwo\n> said\na  b\nc", nested.text)
        assertEquals(listOf(Block.HEADING, Block.BULLET, Block.BULLET, Block.BULLET, Block.TEXT, Block.TEXT, Block.TEXT), nested.blocks)
        // Quotes nested thousands deep keep every word, with at most three marks a line, so the text can't balloon.
        val deep = RichText.parse("<blockquote>x".repeat(7000) + "</blockquote>".repeat(7000))
        assertEquals(7000, deep.text.count { it == 'x' })
        assertTrue(deep.text.length < 7000 * 8)
        assertEquals("> > > x", deep.text.lines().last())
        // Table cells each get a line, as in the plain-text view.
        assertEquals("Name\nPhone", RichText.parse("<table><tr><td>Name</td></tr><tr><td>Phone</td></tr></table>").text)
        // Empty and blank input are one empty line.
        assertEquals(RichDoc(""), RichText.parse(""))
        assertEquals("", RichText.parse("<div> </div>").text)
    }

    @Test
    fun `the plain projection numbers lists and keeps link text`() {
        assertEquals("Hi Sanne,\n\n * one\n * two with bold\nNext steps\n1. a\n2. b\nSee the plan.", RichText.plain(sample))
        // A numbered list starts again after other text.
        val two = RichDoc("a\nb\nx\nc", blocks = listOf(Block.NUMBER, Block.NUMBER, Block.TEXT, Block.NUMBER))
        assertEquals("1. a\n2. b\nx\n1. c", RichText.plain(two))
        assertTrue(RichText.sameText(" * a\n * b  \n\n", " * a\n * b"))
        assertFalse(RichText.sameText(" * a", " * b"))
    }

    @Test
    fun `the text part writes lists and link addresses`() {
        val part = RichText.textPart(RichText.toHtml(sample))
        assertEquals("Hi Sanne,\n\n * one\n * two with bold\n\nNext steps\n\n1. a\n2. b\n\nSee the plan [https://example.com/plan].", part)
        // A mail link shows the address without its scheme; a link whose text is its address isn't written twice.
        assertEquals("Mail Sanne [sanne@example.com]", RichText.textPart("<div>Mail <a href=\"mailto:sanne@example.com\">Sanne</a></div>"))
        assertEquals("bvdm.ai and sanne@example.com", RichText.textPart("<a href=\"https://bvdm.ai/\">bvdm.ai</a> and <a href=\"mailto:sanne@example.com\">sanne@example.com</a>"))
    }

    @Test
    fun `trimming drops empty plain lines at the ends but keeps empty items`() {
        val doc = RichDoc("\n\nHi\n\n\n", blocks = listOf(Block.TEXT, Block.TEXT, Block.TEXT, Block.TEXT, Block.TEXT, Block.TEXT))
        assertEquals(RichDoc("Hi", blocks = listOf(Block.TEXT)), RichText.trim(doc))
        assertEquals("\n\nHi", RichText.trimEnd(doc).text)
        val item = RichDoc("a\n", blocks = listOf(Block.BULLET, Block.BULLET))
        assertEquals(item, RichText.trim(item))
    }

    @Test
    fun `typed link addresses get a scheme`() {
        assertEquals("https://bvdm.ai", RichText.linkTarget(" bvdm.ai "))
        assertEquals("http://x.nl/a?b=1", RichText.linkTarget("http://x.nl/a?b=1"))
        assertEquals("mailto:sanne@example.com", RichText.linkTarget("sanne@example.com"))
        assertEquals("mailto:sanne@example.com", RichText.linkTarget("mailto:sanne@example.com"))
        assertEquals("https://localhost:8080", RichText.linkTarget("localhost:8080"))
        assertNull(RichText.linkTarget("javascript:alert(1)"))
        assertNull(RichText.linkTarget("two words"))
        assertNull(RichText.linkTarget(""))
    }

    private val me = Address("Demo User", "demo@example.com")
    private val account = Account(id = "acc", type = AccountType.IMAP, provider = "other", auth = AuthKind.PASSWORD, email = "demo@example.com", name = "Demo User")

    @Test
    fun `a formatted body goes out as html with a plain-text part, between the signature and the quote`() {
        val signature = Signature("Bart", "<b>Bart</b>")
        val quote = Quote.block("-------- Original message --------\nFrom: Sanne", "<p>Old</p>")
        val html = RichText.toHtml(sample) + "<script>bad()</script>"
        val body = ComposeBody.build(RichText.plain(sample), signature, quote, html)
        assertTrue(body.html.startsWith(Quote.WRAPPER_OPEN + RichText.toHtml(sample) + "<div><br></div><div class=\"signature\"><b>Bart</b></div>"))
        assertFalse(body.html.contains("script"))
        assertTrue(body.html.endsWith("</blockquote></div>"))
        assertTrue(body.text.startsWith("Hi Sanne,\n\n * one\n * two with bold\n\nNext steps\n\n1. a\n2. b\n\nSee the plan [https://example.com/plan].\n\nBart\n\n-------- Original message --------"))
        // Empty lines typed at the end don't go along, as with plain text.
        val trailing = ComposeBody.build("Hi\n\n", null, "", "<div><b>Hi</b></div><div><br></div><div><br></div>")
        assertEquals(Quote.WRAPPER_OPEN + "<div><b>Hi</b></div></div>", trailing.html)
        // Without formatting nothing changes.
        assertEquals(ComposeBody.build("Hi\nthere", null, ""), ComposeBody.build("Hi\nthere", null, "", null))
        assertEquals(Quote.WRAPPER_OPEN + "<div>Hi<br>there</div></div>", ComposeBody.build("Hi\nthere", null, "").html)
    }

    @Test
    fun `a formatted draft saved on the phone reopens formatted`() {
        val state = ComposerState(accountId = "acc", from = me, to = listOf(Address("Sanne", "sanne@example.com")), subject = "Plan", body = RichText.plain(sample), bodyHtml = RichText.toHtml(sample))
        val out = state.toOutgoing("acc", me)
        assertEquals(RichText.toHtml(sample), out.html)
        val saved = ComposeBody.build(out.text, Signature("Bart", "<b>Bart</b>"), out.quote, out.html)
        val draft = FullMessage(
            summary = MessageSummary(id = "acc:Drafts:3", accountId = "acc", folder = "Drafts", uid = 3, subject = "Plan", from = me, to = out.to),
            html = saved.html,
            isHtml = true,
            text = saved.text,
        )
        val reopened = ReplyBuilder.build(ReplyKind.DRAFT, draft, account, MailViews.identities(account))
        assertEquals(RichText.plain(sample), reopened.body)
        assertEquals(RichText.toHtml(sample), reopened.bodyHtml)
        assertFalse(reopened.signatureExcluded)
        assertEquals(RichText.toHtml(sample), reopened.toComposerState().richHtml())
        // A plain draft reopens plain.
        val plain = draft.copy(html = Quote.WRAPPER_OPEN + "<div>Just text.</div></div>")
        assertNull(ReplyBuilder.build(ReplyKind.DRAFT, plain, account, MailViews.identities(account)).bodyHtml)
    }

    @Test
    fun `html the body no longer matches is not used`() {
        val state = ComposerState(body = RichText.plain(sample), bodyHtml = RichText.toHtml(sample))
        assertEquals(RichText.toHtml(sample), state.richHtml())
        assertEquals(sample, state.richDoc())
        // Something set only the body (a mailto link, an Undo): the old formatting is stale.
        val stale = state.copy(body = "New words")
        assertNull(stale.richHtml())
        assertEquals(RichDoc("New words"), stale.richDoc())
        assertNull(stale.toOutgoing("acc", me).html)
    }

    @Test
    fun `drafts kept by the previous version still load`() {
        val old = """{"id":"x","subject":"Hi","body":"Plain words","dirty":true}"""
        val state = RukooJson.decodeFromString(ComposerState.serializer(), old)
        assertEquals("Plain words", state.body)
        assertNull(state.bodyHtml)
        val again = RukooJson.decodeFromString(ComposerState.serializer(), RukooJson.encodeToString(ComposerState.serializer(), state.copy(bodyHtml = "<div><b>Plain</b> words</div>")))
        assertEquals("<div><b>Plain</b> words</div>", again.bodyHtml)
        assertTrue(Json.parseToJsonElement(RukooJson.encodeToString(ComposerState.serializer(), state)).toString().isNotEmpty())
    }

    // The document as parse gives it back: marks and links cut at line breaks, touching ones joined, sorted.
    private fun canonical(doc: RichDoc): RichDoc {
        val starts = RichText.paragraphStarts(doc.text)
        fun pieces(start: Int, end: Int): List<Pair<Int, Int>> = starts.toList().mapNotNull { ps ->
            val pe = RichText.paragraphEnd(doc.text, ps)
            val a = maxOf(start, ps)
            val b = minOf(end, pe)
            if (a < b) a to b else null
        }
        val marks = Mark.entries.flatMap { mark ->
            val cut = doc.marks.filter { it.mark == mark }.flatMap { pieces(it.start, it.end) }.sortedBy { it.first }
            val merged = ArrayList<Pair<Int, Int>>()
            for (p in cut) {
                val last = merged.lastOrNull()
                if (last != null && p.first <= last.second) merged[merged.size - 1] = last.first to maxOf(last.second, p.second) else merged += p
            }
            merged.map { MarkRange(it.first, it.second, mark) }
        }.sortedWith(compareBy({ it.start }, { it.mark }))
        // One link per character: the first that covers it, as the html nests them.
        val owner = arrayOfNulls<String>(doc.text.length)
        for (l in doc.links) for ((a, b) in pieces(l.start, l.end)) for (i in a until b) if (owner[i] == null) owner[i] = l.url
        val links = ArrayList<LinkRange>()
        var i = 0
        while (i < owner.size) {
            val url = owner[i]
            if (url == null) {
                i++
                continue
            }
            var j = i
            while (j < owner.size && owner[j] == url) j++
            links += LinkRange(i, j, url)
            i = j
        }
        return RichDoc(doc.text, marks, links, starts.indices.map { doc.block(it) })
    }
}
