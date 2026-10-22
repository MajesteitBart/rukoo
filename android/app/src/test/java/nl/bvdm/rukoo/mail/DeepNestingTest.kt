package nl.bvdm.rukoo.mail

import jakarta.mail.Session
import jakarta.mail.internet.MimeMessage
import java.io.ByteArrayInputStream
import java.io.OutputStream
import java.io.PrintStream
import java.util.Properties
import nl.bvdm.rukoo.mail.html.MailHtml
import nl.bvdm.rukoo.mail.mime.MailText
import nl.bvdm.rukoo.mail.mime.MimeParser
import nl.bvdm.rukoo.mail.mime.PartNode
import nl.bvdm.rukoo.mail.mime.Structure
import nl.bvdm.rukoo.mail.session.ImapSession
import nl.bvdm.rukoo.mcp.tools.PlainText
import nl.bvdm.rukoo.ui.reader.MailFrame
import org.eclipse.angus.mail.iap.Protocol
import org.eclipse.angus.mail.imap.protocol.BODYSTRUCTURE
import org.eclipse.angus.mail.imap.protocol.FetchResponse
import org.eclipse.angus.mail.imap.protocol.IMAPResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Small mail nested deep enough to exhaust the stack reads as mail, not as a StackOverflowError. */
class DeepNestingTest {
    /**
     * [block] on a thread with a 256 KB stack, rethrowing what it threw. Android gives background threads about
     * 1 MB and ART's frames are larger than HotSpot's; a quarter of that overflows on any JVM without the limits.
     */
    private fun <T> onSmallStack(block: () -> T): T {
        var result: Result<T>? = null
        val thread = Thread(null, { result = runCatching(block) }, "small-stack", 256L * 1024)
        thread.start()
        thread.join()
        return result!!.getOrThrow()
    }

    /** [levels] multiparts inside each other with a text part at the bottom; 2,000 levels make 138 KB. */
    private fun nestedMultiparts(levels: Int): ByteArray {
        val sb = StringBuilder("From: a@example.com\r\nSubject: Deep\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b0\"\r\n\r\n")
        for (i in 0 until levels - 1) sb.append("--b$i\r\nContent-Type: multipart/mixed; boundary=\"b${i + 1}\"\r\n\r\n")
        sb.append("--b${levels - 1}\r\nContent-Type: text/plain\r\n\r\nHello from the bottom\r\n")
        for (i in levels - 1 downTo 0) sb.append("--b$i--\r\n")
        return sb.toString().toByteArray()
    }

    /** "Hi café" in quoted-printable with [breaks] soft line breaks between the words; 50,000 make 150 KB. */
    private fun softBreaks(breaks: Int) = "Hi" + "=\r\n".repeat(breaks) + " caf=C3=A9"

    private fun softBreakMessage(breaks: Int, attachment: Boolean): ByteArray {
        val type = if (attachment) {
            "Content-Type: application/pdf; name=\"a.pdf\"\r\nContent-Disposition: attachment; filename=\"a.pdf\"\r\n"
        } else {
            "Content-Type: text/plain; charset=utf-8\r\n"
        }
        return (
            "From: a@example.com\r\nSubject: Soft\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n" +
                "--b\r\n${type}Content-Transfer-Encoding: quoted-printable\r\n\r\n${softBreaks(breaks)}\r\n--b--\r\n"
            ).toByteArray()
    }

    @Test
    fun `quoted-printable made of 50,000 soft line breaks decodes as text, as an attachment and as a whole message`() {
        val single = (
            "From: a@example.com\r\nSubject: Soft\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n" +
                "Content-Transfer-Encoding: quoted-printable\r\n\r\n${softBreaks(50_000)}\r\n"
            ).toByteArray()
        // Angus Mail's decoder calls itself once per soft line break and runs out of stack on this.
        val angus = onSmallStack {
            runCatching { MimeMessage(Session.getInstance(Properties()), ByteArrayInputStream(single)).inputStream.use { it.readBytes() } }.exceptionOrNull()
        }
        assertTrue(angus is StackOverflowError)

        assertEquals("Hi café", onSmallStack { MimeParser.parse(single) }.text?.trim())
        assertEquals("Hi café", onSmallStack { MimeParser.parse(softBreakMessage(50_000, attachment = false)) }.text?.trim())
        val pdf = onSmallStack { MimeParser.parse(softBreakMessage(50_000, attachment = true)) }.attachments.single()
        assertEquals("a.pdf", pdf.filename)
        assertEquals("Hi café", String(pdf.bytes, Charsets.UTF_8))
    }

    /** 4,000 nested divs: 44 KB. */
    private val deepDivs = "<div>".repeat(4000) + "Deep text" + "</div>".repeat(4000)

    @Test
    fun `a message nested 2,000 multiparts deep parses with its headers and without the parts below the limit`() {
        val raw = nestedMultiparts(2000)
        assertEquals(138_776, raw.size)
        val p = onSmallStack { MimeParser.parse(raw) }
        assertEquals("Deep", p.subject)
        assertEquals("a@example.com", p.from.single().address)
        assertNull(p.text)
        assertNull(p.html)
        assertTrue(p.attachments.isEmpty())

        // Nesting up to the limit still reads.
        assertEquals("Hello from the bottom", onSmallStack { MimeParser.parse(nestedMultiparts(Structure.MAX_DEPTH)) }.text?.trim())
    }

    @Test
    fun `the server's structure of a deep message stops at the same limit, and walking any tree is a loop`() {
        val protocol = Protocol(ByteArrayInputStream(ByteArray(0)), PrintStream(OutputStream.nullOutputStream()), Properties(), false)
        fun structure(levels: Int): PartNode {
            val text = "(\"text\" \"plain\" (\"charset\" \"us-ascii\") NIL NIL \"7bit\" 21 1)"
            val response = IMAPResponse("* 1 FETCH (BODYSTRUCTURE ${"(".repeat(levels)}$text${" \"mixed\")".repeat(levels)})")
            return ImapSession.partNode(FetchResponse(response, null, protocol).getItem(BODYSTRUCTURE::class.java), null)
        }
        assertEquals("1".repeat(Structure.MAX_DEPTH).toList().joinToString("."), Structure.findPreviewPart(structure(Structure.MAX_DEPTH))?.part)
        assertNull(Structure.findPreviewPart(structure(Structure.MAX_DEPTH + 50)))

        var tree = PartNode("x", "text/plain")
        repeat(2000) { tree = PartNode("x", "multipart/mixed", children = listOf(tree)) }
        assertEquals("text/plain", onSmallStack { Structure.findPreviewPart(tree) }?.type)
    }

    @Test
    fun `html nested 4,000 divs deep becomes text and a safe reader page`() {
        assertEquals(44_009, deepDivs.length)
        assertEquals("Deep text", onSmallStack { MailText.htmlToPlain(deepDivs) })
        assertEquals("Deep text", onSmallStack { PlainText.fromHtml(deepDivs) })
        // The sanitizer and the reader's page go through jsoup's own loops; they keep all of it.
        val clean = onSmallStack { MailHtml.sanitize(deepDivs) }
        assertTrue(clean.contains("Deep text"))
        assertTrue(onSmallStack { MailFrame.document(clean, isHtml = true, light = true, darkEmails = false) }.contains("Deep text"))
        assertTrue(onSmallStack { MailHtml.fragment(deepDivs) }.contains("Deep text"))

        // Within the limit the layout stays: blocks on lines of their own.
        assertEquals("a\nb", MailText.htmlToPlain("<div>".repeat(50) + "<div>a</div><div>b</div>" + "</div>".repeat(50)))
    }

    @Test
    fun `past the limit text keeps its spaces and line breaks and still leaves out what is hidden`() {
        val inline = "a" + "<span>".repeat(102) + " b <title>Hidden</title><style>p{}</style>" + "</span>".repeat(102) + "c"
        assertEquals("a b c", MailText.htmlToPlain(inline))
        assertEquals("a b c", PlainText.fromHtml(inline))
        val blocks = "<div>".repeat(102) + "<div>one</div><div>two<br>three</div>" + "</div>".repeat(102)
        assertEquals("one\ntwo\nthree", MailText.htmlToPlain(blocks))
        assertEquals("one\ntwo\nthree", PlainText.fromHtml(blocks))
        // A list item right at the limit keeps its text beside its bullet.
        assertEquals("* item", MailText.htmlToPlain("<div>".repeat(99) + "<ul><li>item</li></ul>" + "</div>".repeat(99)))
        assertEquals("1. item", MailText.htmlToPlain("<div>".repeat(99) + "<ol><li>item</li></ol>" + "</div>".repeat(99)))
    }
}
