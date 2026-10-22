package nl.bvdm.rukoo.ui.reader

import org.jsoup.Jsoup
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MailFrameTest {
    // The shape of the demo newsletter: a grey canvas on body and a full-width table, a white 600px card inside.
    private val newsletter = """<!doctype html><html><body style="margin:0;background:#f2f2f2">
<table role="presentation" width="100%" style="background:#f2f2f2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" style="background:#ffffff;max-width:600px"><tr><td>Hello</td></tr></table>
</td></tr></table></body></html>"""

    @Test
    fun darkThemeInvertsHtmlMailAndTurnsImagesBack() {
        val doc = MailFrame.document(newsletter, isHtml = true, light = false, darkEmails = true)
        assertTrue(doc.contains("[data-rukoo-mail]{filter:invert(1) hue-rotate(180deg);background:#e2e3e8}"))
        assertTrue(doc.contains("html,body{background:transparent}"))
        assertTrue(doc.contains("[style*=\"background-image\"]:not([data-rukoo-canvas])"))
        assertTrue(doc.contains("color:#15171c"))
        assertTrue(doc.contains("a{color:#1a5fd0}"))
    }

    @Test
    fun plainTextAndLightThemeAreNotInverted() {
        val plain = MailFrame.document("<div>Hi</div>", isHtml = false, light = false, darkEmails = true)
        assertFalse(plain.contains("invert(1)"))
        assertTrue(plain.contains("color:#e6e8ee"))
        assertTrue(plain.contains("color-scheme:dark"))
        val light = MailFrame.document(newsletter, isHtml = true, light = true, darkEmails = true)
        assertFalse(light.contains("invert(1)"))
        assertTrue(light.contains("a{color:#2f63c8}"))
        val off = MailFrame.document(newsletter, isHtml = true, light = false, darkEmails = false)
        assertFalse(off.contains("invert(1)"))
    }

    @Test
    fun theGreyCanvasBecomesTransparentAndTheCardStays() {
        val doc = Jsoup.parse(MailFrame.document(newsletter, isHtml = true, light = true, darkEmails = true))
        // The mail's body attributes moved to the wrapper, so the page canvas stays transparent.
        assertTrue(doc.body().attributes().isEmpty)
        val wrapper = doc.selectFirst("[data-rukoo-mail]")!!
        assertTrue(wrapper.attr("style").startsWith("margin:0;background:#f2f2f2;"))
        assertTrue(wrapper.attr("style").endsWith("background-color:transparent !important"))
        assertTrue(wrapper.hasAttr("data-rukoo-canvas"))
        val outer = wrapper.selectFirst("table")!!
        assertTrue(outer.attr("style").contains("transparent !important"))
        val card = doc.select("table[width=600]").first()!!
        assertEquals("background:#ffffff;max-width:600px", card.attr("style"))
    }

    @Test
    fun aBodyColourBecomesWrapperCss() {
        val doc = Jsoup.parse(MailFrame.document("<html><body bgcolor=\"#003366\" text=\"#ffffff\">x</body></html>", true, false, true))
        val wrapper = doc.selectFirst("[data-rukoo-mail]")!!
        assertEquals("background-color:#003366;color:#ffffff;", wrapper.attr("style"))
        assertTrue(doc.body().attributes().isEmpty)
    }

    @Test
    fun aColouredOrNarrowCanvasIsLeftAlone() {
        val blue = Jsoup.parse(MailFrame.document("<div style=\"background:#2f66d6\">x</div>", true, true, true))
        assertFalse(blue.selectFirst("div")!!.attr("style").contains("transparent"))
        val narrow = Jsoup.parse(MailFrame.document("<table bgcolor=\"#f2f2f2\"><tr><td>x</td></tr></table>", true, true, true))
        assertEquals("#f2f2f2", narrow.selectFirst("table")!!.attr("bgcolor"))
    }

    @Test
    fun scriptsFormsFramesAndHandlersGo() {
        val doc = MailFrame.document(
            "<script>alert(1)</script><form action=\"https://x\"><input name=q></form><iframe src=x></iframe>" +
                "<a href=\"javascript:alert(1)\" onclick=\"x()\">link</a><meta http-equiv=\"refresh\" content=\"0;url=x\">",
            isHtml = true, light = true, darkEmails = true,
        )
        assertFalse(doc.contains("<script"))
        assertFalse(doc.contains("<form"))
        assertFalse(doc.contains("<iframe"))
        assertFalse(doc.contains("onclick"))
        assertFalse(doc.contains("javascript:"))
        assertFalse(doc.contains("http-equiv"))
        assertTrue(doc.contains("<input name=\"q\">"))
    }

    @Test
    fun aMalformedColourIsNoColourAndNoCrash() {
        assertEquals(null, MailFrame.parseColor("rgb(999999999999999999999,242,242)"))
        assertEquals(null, MailFrame.parseColor("rgb(300,242,242)"))
        assertEquals(null, MailFrame.parseColor("rgba(242,242,242,1.2.3)"))
        val doc = MailFrame.document("<div style=\"background:rgb(999999999999999999999,242,242)\">x</div>", true, false, true)
        assertTrue(doc.contains(">x</div>"))
    }

    @Test
    fun theFallbackShowsTheSourceAsText() {
        val doc = MailFrame.unprocessed("<form action=\"x\"><meta http-equiv=\"refresh\" content=\"0;url=x\">A & B</form>", light = true)
        val body = Jsoup.parse(doc).body()
        assertTrue(body.select("form, meta").isEmpty())
        assertEquals("<form action=\"x\"><meta http-equiv=\"refresh\" content=\"0;url=x\">A & B</form>", body.wholeText())
    }

    @Test
    fun colors() {
        assertTrue(MailFrame.neutral(MailFrame.parseColor("#fff")!!))
        assertTrue(MailFrame.neutral(MailFrame.parseColor("rgb(242, 242, 242)")!!))
        assertFalse(MailFrame.neutral(MailFrame.parseColor("rgba(242,242,242,0)")!!))
        assertFalse(MailFrame.neutral(MailFrame.parseColor("#e0f0ff")!!))
        assertTrue(MailFrame.neutral(MailFrame.parseColor("white")!!))
        // From the engine's former reader document: more neutral names, alpha hex, and darker greys aren't a canvas.
        assertTrue(MailFrame.neutral(MailFrame.parseColor("WhiteSmoke")!!))
        assertTrue(MailFrame.neutral(MailFrame.parseColor("#f2f2f2ff")!!))
        assertFalse(MailFrame.neutral(MailFrame.parseColor("#f2f2f200")!!))
        assertEquals(listOf(255, 255, 255, 127), MailFrame.parseColor("rgba(255, 255, 255, .5)")!!.toList())
        assertEquals(null, MailFrame.parseColor("gainsboro"))
        assertEquals(null, MailFrame.parseColor("not a colour"))
    }

    @Test
    fun aCanvasWithABackgroundImageStaysUnderTheImageRule() {
        val doc = Jsoup.parse(MailFrame.document("<table width=\"100%\" bgcolor=\"#f2f2f2\" background=\"https://x/bg.png\"><tr><td>x</td></tr></table>", true, false, true))
        val table = doc.selectFirst("table")!!
        assertTrue(table.attr("style").contains("transparent !important"))
        assertFalse(table.hasAttr("data-rukoo-canvas"))
    }

    @Test
    fun attachmentKindsAndRiskyNames() {
        assertEquals(AttachmentKind("PDF", "pdf"), Attachments.kindOf("Proposal-v3.pdf"))
        assertEquals(AttachmentKind("FILE", "other"), Attachments.kindOf("README"))
        assertEquals("XLSX", Attachments.kindOf("a.xlsx").label)
        assertTrue(Attachments.isRisky("invoice.pdf.exe"))
        assertTrue(Attachments.isRisky("update.apk"))
        assertFalse(Attachments.isRisky("Proposal-v3.pdf"))
        assertEquals("application/pdf", Attachments.viewType("a.pdf", "application/octet-stream"))
        assertEquals("image/png", Attachments.viewType("a.bin", "image/png; name=a.png"))
    }
}
