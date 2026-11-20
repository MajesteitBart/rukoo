package nl.bvdm.rukoo.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.roundToInt

class TypeAndTokensTest {
    @Test
    fun featuresCombineWithoutDuplicates() {
        assertEquals("cv11, tnum", withFeature("cv11", "tnum"))
        assertEquals("cv11, tnum", withFeature("cv11, tnum", "tnum"))
        assertEquals("tnum", withFeature(null, "tnum"))
        assertEquals("cv11, ss01, tnum", RukooType.Default.text13.panel.tabular.fontFeatureSettings)
    }

    @Test
    fun desktopSizesGainOneSp() {
        val t = RukooType.Default
        assertEquals(14.sp, t.text13.fontSize)
        assertEquals(13.5.sp, t.text12_5.fontSize)
        assertEquals(12.sp, t.text11.fontSize)
        assertEquals(20.sp, t.text18.fontSize)
        assertEquals(1.4.em, t.body.lineHeight)
        assertEquals((-0.01).em, t.panelBody.letterSpacing)
        assertEquals(1.5.em, t.panelBody.lineHeight)
        assertEquals(650, t.pageTitle.fontWeight?.weight)
    }

    @Test
    fun panelAliasesPointAtAppTokens() {
        for (c in listOf(RukooColors.Dark, RukooColors.Light)) {
            assertEquals(c.raised, c.surface)
            assertEquals(c.panel2, c.inset)
            assertEquals(c.text3, c.ink3)
            assertEquals(c.chip, c.field)
            assertEquals(c.link, c.accentInk)
            assertEquals(c.accentSoft, c.accentTint)
        }
        assertTrue(RukooColors.Dark.isDark)
        assertFalse(RukooColors.Light.isDark)
        // The toast is dark in both themes on purpose.
        assertEquals(RukooColors.Dark.toastBackground, RukooColors.Light.toastBackground)
    }

    @Test
    fun generatedColorsFollowTheTheme() {
        // styles.css .avatar for hue 277, converted by the CSS hsl() formula in Node.
        assertRgb(intArrayOf(75, 43, 95), RukooColors.Dark.avatarBackground(277))
        assertRgb(intArrayOf(221, 186, 243), RukooColors.Dark.avatarText(277))
        assertRgb(intArrayOf(240, 226, 248), RukooColors.Light.avatarBackground(277))
        assertRgb(intArrayOf(90, 45, 118), RukooColors.Light.avatarText(277))
    }

    private fun assertRgb(expected: IntArray, actual: Color) {
        val rgb = intArrayOf((actual.red * 255).roundToInt(), (actual.green * 255).roundToInt(), (actual.blue * 255).roundToInt())
        for (i in 0..2) assertTrue("${expected.toList()} vs ${rgb.toList()}", kotlin.math.abs(expected[i] - rgb[i]) <= 1)
    }

    // WCAG contrast of two opaque colors, as desktop's test/chat-contrast.test.js measures the same pairs.
    private fun contrast(a: Color, b: Color): Double {
        val (x, y) = a.luminance() to b.luminance()
        return (maxOf(x, y) + 0.05) / (minOf(x, y) + 0.05)
    }

    private fun assertReadable(label: String, fg: Color, bg: Color, min: Double = 4.5) {
        val r = contrast(fg, bg)
        assertTrue("$label is ${"%.2f".format(r)}:1, under $min:1", r >= min)
    }

    @Test
    fun dangerButtonLabelsPassInBothThemes() {
        assertReadable("dark danger label", RukooColors.Dark.onDanger, RukooColors.Dark.danger)
        assertReadable("light danger label", RukooColors.Light.onDanger, RukooColors.Light.danger)
        // The dark ink on dark's lighter red, white on light's, as desktop's --on-primary.
        assertEquals(Color(0xFF15171C), RukooColors.Dark.onDanger)
        assertEquals(Color.White, RukooColors.Light.onDanger)
    }

    @Test
    fun countPillDigitsPassOnTheAccent() {
        for (c in listOf(RukooColors.Dark, RukooColors.Light)) {
            assertEquals(c.panel, c.onCountPill)
            assertReadable("count pill (dark=${c.isDark})", c.onCountPill, c.accent)
        }
    }

    @Test
    fun chatCaptionGreyPassesWhereChatDrawsIt() {
        for (c in listOf(RukooColors.Dark, RukooColors.Light)) {
            for ((name, surface) in listOf("panel" to c.panel, "bg" to c.bg, "raised" to c.raised)) {
                assertReadable("chat caption on $name (dark=${c.isDark})", c.chatText3, surface)
                assertReadable("text2 on $name (dark=${c.isDark})", c.text2, surface)
            }
            val chat = c.forChat()
            assertEquals(c.chatText3, chat.text3)
            assertEquals(c.chatText3, chat.ink3)
            assertEquals(c.text2, chat.text2)
        }
        // The same values as desktop's --ch-text-3; mail's text3 stays as it was.
        assertEquals(Color(0xFF8A909E), RukooColors.Dark.chatText3)
        assertEquals(Color(0xFF666B7A), RukooColors.Light.chatText3)
        assertEquals(Color(0xFF7A808E), RukooColors.Dark.text3)
        assertEquals(Color(0xFF868B98), RukooColors.Light.text3)
    }

    @Test
    fun materialPrimaryIsTheAccentNotTheInk() {
        val scheme = materialColors(RukooColors.Light)
        assertEquals(RukooColors.Light.accent, scheme.primary)
        assertEquals(Color.Transparent, scheme.surfaceTint)
        assertEquals(RukooColors.Light.raised, scheme.surfaceContainer)
    }

}
