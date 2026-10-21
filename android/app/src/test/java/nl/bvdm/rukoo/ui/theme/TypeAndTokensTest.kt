package nl.bvdm.rukoo.ui.theme

import androidx.compose.ui.graphics.Color
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

    @Test
    fun materialPrimaryIsTheAccentNotTheInk() {
        val scheme = materialColors(RukooColors.Light)
        assertEquals(RukooColors.Light.accent, scheme.primary)
        assertEquals(Color.Transparent, scheme.surfaceTint)
        assertEquals(RukooColors.Light.raised, scheme.surfaceContainer)
    }

}
