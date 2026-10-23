package nl.bvdm.rukoo.mail

import nl.bvdm.rukoo.mail.mime.ComposedMail
import nl.bvdm.rukoo.mail.mime.MailAttachment
import nl.bvdm.rukoo.mail.mime.MimeComposer
import nl.bvdm.rukoo.mail.mime.MimeParser
import nl.bvdm.rukoo.mail.model.Address
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MimeTest {
    private val png = java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

    private fun mail(keepBcc: Boolean) = ComposedMail(
        from = Address("Zoë Tester", "zoe@example.com"),
        to = listOf(Address("Sanne de Vries", "sanne@example.com")),
        cc = listOf(Address("", "joris@example.com")),
        bcc = listOf(Address("", "secret@example.com")),
        subject = "Integratie € café",
        text = "Plain with café",
        html = "<p>HTML with <b>café</b><img src=\"cid:logo1@rukoo\"></p>",
        inReplyTo = "<parent@example.com>",
        references = listOf("<root@example.com>", "<parent@example.com>"),
        date = 1_760_000_000_000,
        messageId = "<abc-123@example.com>",
        attachments = listOf(
            MailAttachment("note.txt", "text/plain", "hello".toByteArray()),
            MailAttachment("logo.png", "image/png", png, cid = "logo1@rukoo"),
            MailAttachment("Offerte über €.pdf", "application/pdf", "%PDF-1.4".toByteArray()),
        ),
        keepBcc = keepBcc,
    )

    @Test
    fun `a composed message parses back with its headers, bodies and parts`() {
        val raw = MimeComposer.compose(mail(keepBcc = false))
        val text = String(raw, Charsets.ISO_8859_1)
        assertFalse("sent mail never carries Bcc", text.contains("secret@example.com"))
        assertTrue(text.contains("Message-ID: <abc-123@example.com>"))

        val p = MimeParser.parse(raw)
        assertEquals("Integratie € café", p.subject)
        assertEquals(listOf(Address("Zoë Tester", "zoe@example.com")), p.from)
        assertEquals(listOf(Address("Sanne de Vries", "sanne@example.com")), p.to)
        assertEquals(listOf(Address("", "joris@example.com")), p.cc)
        assertTrue(p.bcc.isEmpty())
        assertEquals("<abc-123@example.com>", p.messageId)
        assertEquals("<parent@example.com>", p.inReplyTo)
        assertEquals(listOf("<root@example.com>", "<parent@example.com>"), p.references)
        assertEquals(1_760_000_000_000, p.date)
        assertEquals("Plain with café", p.text)
        assertTrue(p.html!!.contains("<b>café</b>"))

        // The inline image sits in the readable part, before the attached files.
        assertEquals(listOf("logo.png", "note.txt", "Offerte über €.pdf"), p.attachments.map { it.filename })
        assertEquals(listOf(0, 1, 2), p.attachments.map { it.index })
        assertEquals(listOf(true, false, false), p.attachments.map { it.related })
        assertEquals(png.toList(), p.attachments[0].bytes.toList())
        assertEquals("hello", String(p.attachments[1].bytes))
        assertTrue(p.inlineImages().getValue("logo1@rukoo").startsWith("data:image/png;base64,iVBOR"))
    }

    @Test
    fun `drafts keep their Bcc`() {
        val p = MimeParser.parse(MimeComposer.compose(mail(keepBcc = true)))
        assertEquals(listOf(Address("", "secret@example.com")), p.bcc)
    }

    @Test
    fun `html-only and text-only messages have one part`() {
        val html = MimeParser.parse(MimeComposer.compose(ComposedMail(from = Address("", "a@example.com"), html = "<p>Only HTML</p>", date = 0, messageId = "<h@x>")))
        assertNull(html.text)
        assertEquals("<p>Only HTML</p>", html.html)
        val text = MimeParser.parse(MimeComposer.compose(ComposedMail(from = Address("", "a@example.com"), text = "Only text", date = 0, messageId = "<t@x>")))
        assertNull(text.html)
        assertEquals("Only text", text.text)
    }

    @Test
    fun `a message from another client parses leniently`() {
        val raw = (
            "From: =?UTF-8?B?Sm9yaXMgQsOka2tlcg==?= <joris@example.com>\r\n" +
                "To: undisclosed-recipients:;, Team: a@example.com, b@example.com;\r\n" +
                "Subject: =?ISO-8859-1?Q?Caf=E9?=\r\n" +
                "Message-ID: <m1@example.com>\r\n" +
                "References: <a@x> <b@x>\r\n <c@x>\r\n" +
                "List-Unsubscribe: <mailto:leave@example.com?subject=stop>, <https://example.com/u?id=1>\r\n" +
                "List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n" +
                "MIME-Version: 1.0\r\n" +
                "Content-Type: multipart/mixed; boundary=\"b1\"\r\n\r\n" +
                "--b1\r\nContent-Type: text/plain; charset=windows-1252\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nPrijs: =80 5\r\n" +
                "--b1\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf\r\n" +
                "Content-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--b1--\r\n"
            ).toByteArray(Charsets.ISO_8859_1)
        val p = MimeParser.parse(raw)
        assertEquals("Joris Bäkker", p.from.single().name)
        assertEquals(listOf("a@example.com", "b@example.com"), p.to.map { it.address }.filter { it.isNotEmpty() })
        assertEquals("Café", p.subject)
        assertEquals(listOf("<a@x>", "<b@x>", "<c@x>"), p.references)
        assertEquals("Prijs: € 5", p.text?.trim())
        assertEquals("résumé.pdf", p.attachments.single().filename)
        assertEquals("%PDF-", String(p.attachments.single().bytes))
        val u = p.unsubscribe!!
        assertEquals("https://example.com/u?id=1", u.url)
        assertEquals("mailto:leave@example.com?subject=stop", u.mail)
        assertTrue(u.oneClick)
    }

    @Test
    fun `one-click needs https and the post header`() {
        assertEquals(false, MimeParser.unsubscribeInfo("<http://example.com/u>", "List-Unsubscribe=One-Click")!!.oneClick)
        assertEquals(false, MimeParser.unsubscribeInfo("<https://example.com/u>", null)!!.oneClick)
        assertNull(MimeParser.unsubscribeInfo("<ftp://example.com/u>", null))
        assertNull(MimeParser.unsubscribeInfo(null, null))
    }
}
