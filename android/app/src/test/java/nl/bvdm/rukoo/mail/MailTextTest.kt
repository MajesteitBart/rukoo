package nl.bvdm.rukoo.mail

import java.util.Base64
import nl.bvdm.rukoo.mail.mime.MailText
import nl.bvdm.rukoo.mail.mime.PartNode
import nl.bvdm.rukoo.mail.mime.Structure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MailTextTest {
    @Test
    fun `previews flatten whitespace, drop invisible spacers and stop at 200 characters`() {
        assertEquals("Hello there friend", MailText.makePreview("  Hello​\n\n there  friend﻿ "))
        assertEquals(200, MailText.makePreview("x".repeat(500)).length)
    }

    @Test
    fun `plain text becomes escaped html with clickable links`() {
        val html = MailText.textToHtml("Visit https://example.com/a?b=1&c=2. <b>no</b>")
        assertEquals(
            "<div style=\"white-space:pre-wrap;word-wrap:break-word\">Visit <a href=\"https://example.com/a?b=1&amp;c=2\">https://example.com/a?b=1&amp;c=2</a>. &lt;b&gt;no&lt;/b&gt;</div>",
            html,
        )
    }

    @Test
    fun `html to plain keeps table cells on their own lines and leaves out images, styles and link targets`() {
        val text = MailText.htmlToPlain(
            "<html><head><style>p{color:red}</style></head><body><p>Hi <a href=\"https://x.example\">there</a></p>" +
                "<table><tr><td>Jan Jansen</td><td>06-12345678</td></tr></table><img src=\"x.png\" alt=\"logo\"><h1>Title</h1></body></html>",
        )
        assertEquals("Hi there\n\nJan Jansen\n06-12345678\n\nTitle", text)
    }

    @Test
    fun `lists get bullets and line breaks stay`() {
        assertEquals("Items:\n\n * one\n * two\n\nend", MailText.htmlToPlain("Items:<ul><li>one</li><li>two</li></ul>end"))
        assertEquals("a\nb", MailText.htmlToPlain("a<br>b"))
    }

    @Test
    fun `cut-off base64 and quoted-printable previews decode what is there`() {
        val full = Base64.getEncoder().encodeToString("Hello world, this is a preview".toByteArray())
        val cut = full.substring(0, 11).toByteArray()
        // 11 characters: the last incomplete group of four goes, leaving 8 characters, 6 bytes.
        assertEquals("Hello ", String(MailText.decodeTransfer(cut, "base64")))
        assertEquals("café = fine", String(MailText.decodeTransfer("caf=C3=A9 =3D fi=\r\nne".toByteArray(), "quoted-printable"), Charsets.UTF_8))
    }

    @Test
    fun `charsets are honoured and unknown ones read as utf-8`() {
        val latin = "café".toByteArray(Charsets.ISO_8859_1)
        assertEquals("café", MailText.decodeCharset(latin, "iso-8859-1"))
        assertEquals("abc", MailText.decodeCharset("abc".toByteArray(), "x-unknown-charset"))
        assertEquals("Héllo", MailText.previewFromPart("<p>H=C3=A9llo</p>".toByteArray(), "text/html", "quoted-printable", "utf-8"))
    }

    @Test
    fun `structure rules pick the readable part and spot attachments like desktop`() {
        val root = PartNode(
            part = null, type = "multipart/mixed",
            children = listOf(
                PartNode("1", "multipart/alternative", children = listOf(PartNode("1.1", "text/plain"), PartNode("1.2", "text/html"))),
                PartNode("2", "image/png", disposition = "inline", id = "<logo@x>"),
                PartNode("3", "application/pdf", disposition = "attachment", filename = "a.pdf"),
            ),
        )
        assertEquals("1.1", Structure.findPreviewPart(root)?.part)
        assertTrue(Structure.hasAttachments(root))
        assertFalse(Structure.isAttachmentNode(root.children[1]))
        val single = PartNode(null, "text/html")
        assertEquals("1", Structure.partKey(Structure.findPreviewPart(single)!!))
        assertFalse(Structure.hasAttachments(single))
        assertTrue(Structure.isAttachmentNode(PartNode("2", "message/rfc822")))
        assertTrue(Structure.isAttachmentNode(PartNode("2", "image/jpeg", name = "photo.jpg")))
        assertNull(Structure.findPreviewPart(PartNode(null, "application/pdf", disposition = "attachment")))
    }
}
