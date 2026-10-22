package nl.bvdm.rukoo.mail

import nl.bvdm.rukoo.mail.html.MailHtml
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
