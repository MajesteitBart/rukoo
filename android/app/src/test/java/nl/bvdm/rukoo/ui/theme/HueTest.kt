package nl.bvdm.rukoo.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Test

/** Expected values come from running the desktop's ui.js `hue`/`initials` and bui.js `monogram` in Node. */
class HueTest {
    @Test
    fun hueMatchesDesktop() {
        assertEquals(277, rukooHue("sanne@example.com"))
        assertEquals(202, rukooHue("Clark"))
        assertEquals(7, rukooHue(""))
        assertEquals(7, rukooHue(null))
        assertEquals(255, rukooHue("demo@example.com"))
        assertEquals(246, rukooHue("Ünïcode Øresund"))
        // Outside the BMP, JS takes the high surrogate of the code point.
        assertEquals(134, rukooHue("😀 smile"))
        // Lowercased first, so case doesn't change a sender's color.
        assertEquals(135, rukooHue("INFO@Bencompare.NL"))
    }

    @Test
    fun initialsMatchDesktop() {
        assertEquals("SV", rukooInitials("Sanne de Vries", "sanne@example.com"))
        assertEquals("JO", rukooInitials("", "joris.bakker@example.com"))
        assertEquals("FF", rukooInitials("Forward Future (Matthew Berman)"))
        assertEquals("VN", rukooInitials("\"Vandebron\" <noreply@vandebron.nl>"))
        assertEquals("SE", rukooInitials("serus"))
        assertEquals("Ö", rukooInitials("Ö"))
        assertEquals("X", rukooInitials(null, "x@y.z"))
        assertEquals("AD", rukooInitials("anne-marie_van.dijk"))
        assertEquals("?", rukooInitials(null, null))
    }

    @Test
    fun monogramTextMatchesDesktop() {
        assertEquals("CL", rukooMonogramText("Clark"))
        assertEquals("CB", rukooMonogramText("cb"))
        assertEquals("SV", rukooMonogramText("Sanne de Vries"))
        assertEquals("CL", rukooMonogramText("claude@anthropic.com"))
        assertEquals("X", rukooMonogramText("x"))
        assertEquals("HA", rukooMonogramText("Hermes Agent"))
        assertEquals("?", rukooMonogramText("(team)"))
    }

    @Test
    fun accountColorsRotateAndParse() {
        assertEquals(AccountColors.all[0].second, AccountColors.forIndex(0))
        assertEquals(AccountColors.all[1].second, AccountColors.forIndex(8))
        assertEquals(AccountColors.all[1].second, AccountColors.parse("#4a7dff"))
        assertEquals(AccountColors.all[0].second, AccountColors.parse("not a color"))
        assertEquals(AccountColors.all[0].second, AccountColors.parse(null))
    }
}
