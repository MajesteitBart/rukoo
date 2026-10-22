package nl.bvdm.rukoo.mail

import nl.bvdm.rukoo.mail.html.MailHtml
import nl.bvdm.rukoo.mail.html.ReaderHtml
import nl.bvdm.rukoo.mail.html.SignatureHtml
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.jsoup.Jsoup

class HtmlTest {
    @Test
    fun `the sanitizer removes scripts, frames, event handlers and refreshes`() {
        val out = MailHtml.sanitize(
            "<html><head><meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\"><script>alert(1)</script></head>" +
                "<body onload=\"steal()\"><p onclick=\"x()\" style=\"color:red\">Hi</p><iframe src=\"https://x\"></iframe>" +
                "<object data=\"x.swf\"></object><embed src=\"x\"><base href=\"https://evil.example/\"><SCRIPT src=x></SCRIPT></body></html>",
        )
        assertFalse(out.contains("script", ignoreCase = true))
        assertFalse(out.contains("onload") || out.contains("onclick"))
        assertFalse(out.contains("iframe") || out.contains("<object") || out.contains("<embed") || out.contains("<base"))
        assertFalse(out.contains("refresh"))
        assertTrue(out.contains("<p style=\"color:red\">Hi</p>"))
    }

    @Test
    fun `forms lose their tag but keep their text, and javascript links are neutralized`() {
        val out = MailHtml.sanitize(
            "<form action=\"https://x/submit\"><p>Name</p><input name=\"n\"></form>" +
                "<a href=\"java\tscript:alert(1)\">a</a><a href=\" JAVASCRIPT:alert(2)\">b</a><img src=\"vbscript:x\"><a href=\"https://ok.example\">ok</a>",
        )
        assertFalse(out.contains("<form"))
        assertTrue(out.contains("<p>Name</p>"))
        assertFalse(out.contains("script:", ignoreCase = true))
        assertTrue(out.contains("<a href=\"#\">a</a>"))
        assertTrue(out.contains("href=\"https://ok.example\""))
    }

    @Test
    fun `cid images become the inline parts and style sheets stay`() {
        val out = MailHtml.sanitize(
            "<style>.x{background:url(cid:bg@x)}</style><img src=\"cid:logo@Example\"><img src=\"https://remote.example/a.png\">",
            mapOf("logo@example" to "data:image/png;base64,AAAA", "bg@x" to "data:image/gif;base64,BBBB"),
        )
        assertTrue(out.contains("src=\"data:image/png;base64,AAAA\""))
        assertTrue(out.contains("url(data:image/gif;base64,BBBB)"))
        // Remote images load, like desktop.
        assertTrue(out.contains("https://remote.example/a.png"))
    }

    @Test
    fun `the reader inverts html mail in the dark theme and turns images back`() {
        val dark = ReaderHtml.document("<p>Hello</p>", isHtml = true, light = false, darkEmails = true)
        assertTrue(dark.contains("html{filter:invert(1) hue-rotate(180deg);background:#e2e3e8}"))
        assertTrue(dark.contains("img,picture,video,svg,[style*=\"background-image\"]:not([data-rukoo-canvas]),[background]{filter:invert(1) hue-rotate(180deg)}"))
        assertTrue(dark.contains("color-scheme:light;color:#15171c"))
        assertTrue(dark.contains("a{color:#1a5fd0}"))

        val plainDark = ReaderHtml.document("<p>Hello</p>", isHtml = false, light = false)
        assertFalse(plainDark.contains("invert"))
        assertTrue(plainDark.contains("color-scheme:dark;color:#e6e8ee"))
        assertTrue(plainDark.contains("a{color:#8ab0ff}"))

        val light = ReaderHtml.document("<p>Hello</p>", isHtml = true, light = true)
        assertFalse(light.contains("invert"))
        assertTrue(light.contains("a{color:#2f63c8}"))

        val ownColors = ReaderHtml.document("<p>Hello</p>", isHtml = true, light = false, darkEmails = false)
        assertFalse(ownColors.contains("invert"))
        assertTrue(ownColors.contains("<meta name=\"viewport\""))
        assertTrue(ownColors.endsWith("<p>Hello</p></body></html>"))
    }

    @Test
    fun `a newsletter's grey canvas becomes transparent but its white card stays`() {
        val html = "<html><body style=\"margin:0;background:#f2f2f2\"><table width=\"100%\" style=\"background:#f2f2f2\"><tr><td align=\"center\">" +
            "<table width=\"600\" style=\"background:#ffffff\"><tr><td>Card</td></tr></table></td></tr></table></body></html>"
        val doc = ReaderHtml.document(html, isHtml = true, light = false)
        val parsed = Jsoup.parse(doc)
        assertTrue(parsed.body().attr("style").contains("background-color:transparent !important"))
        assertTrue(parsed.body().hasAttr("data-rukoo-canvas"))
        val outer = parsed.selectFirst("table[width=100%]")!!
        assertTrue(outer.attr("style").endsWith("background-color:transparent !important"))
        val card = parsed.selectFirst("table[width=600]")!!
        assertEquals("background:#ffffff", card.attr("style"))
    }

    @Test
    fun `wide mail is zoomed to fit, down to four fifths`() {
        val wide = "<table width=\"600\"><tr><td>x</td></tr></table>"
        assertTrue(ReaderHtml.document(wide, isHtml = true, light = true, availableWidth = 560).contains("body{zoom:0.927}"))
        assertTrue(ReaderHtml.document(wide, isHtml = true, light = true, availableWidth = 300).contains("body{zoom:0.800}"))
        assertFalse(ReaderHtml.document(wide, isHtml = true, light = true, availableWidth = 700).contains("zoom"))
        assertNull(ReaderHtml.parseColor("not a colour"))
        assertEquals(listOf(242, 242, 242, 255), ReaderHtml.parseColor("#f2f2f2")!!.toList())
        assertEquals(listOf(255, 255, 255, 127), ReaderHtml.parseColor("rgba(255, 255, 255, .5)")!!.toList())
    }

    @Test
    fun `signatures keep static formatting only`() {
        val clean = SignatureHtml.clean(
            "<div style=\"color:#333;position:fixed;background:url(x)\" onclick=\"x()\"><b>Bart</b><br>" +
                "<a href=\"javascript:alert(1)\">bad</a> <a href=\"https://bvdm.ai\" class=\"x\">site</a>" +
                "<img src=\"https://bvdm.ai/logo.png\" width=\"80\"><img src=\"file:///etc/passwd\"><script>x</script><!-- c --></div>",
        )
        assertEquals(
            "<div style=\"color:#333\"><b>Bart</b><br>bad <a href=\"https://bvdm.ai\">site</a><img src=\"https://bvdm.ai/logo.png\" width=\"80\"></div>",
            clean,
        )
        assertEquals("", SignatureHtml.clean("<div> <span></span> </div>"))
        assertEquals("Bart\n\n06 123", SignatureHtml.text("<p>Bart</p><p></p><p></p>06 123"))
    }
}
