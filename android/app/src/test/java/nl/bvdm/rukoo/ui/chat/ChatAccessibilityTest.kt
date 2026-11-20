package nl.bvdm.rukoo.ui.chat

import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsModifier
import nl.bvdm.rukoo.ui.theme.RukooColors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** What Chat's controls tell people who read them: the mode switch's labels and a message row's actions. */
class ChatAccessibilityTest {
    private fun contrast(a: Color, b: Color): Double {
        val (x, y) = a.luminance() to b.luminance()
        return (maxOf(x, y) + 0.05) / (minOf(x, y) + 0.05)
    }

    @Test
    fun `the unselected mode label reads at 4_5 to 1 on its track in both themes`() {
        for (c in listOf(RukooColors.Light, RukooColors.Dark)) {
            // The switch sits in Mail's drawer and sheet as well as Chat's, on any of these surfaces.
            for ((name, surface) in listOf("bg" to c.bg, "panel" to c.panel, "raised" to c.raised)) {
                val track = segmentTrack(c).compositeOver(surface)
                val r = contrast(segmentLabel(selected = false, c = c), track)
                assertTrue("unselected label on the track over $name (dark=${c.isDark}) is ${"%.2f".format(r)}:1", r >= 4.5)
            }
            assertEquals(c.text, segmentLabel(selected = true, c = c))
        }
    }

    @Test
    fun `a message row offers Message actions to screen readers and no click that does nothing`() {
        var opened = 0
        val config = SemanticsConfiguration().apply { messageActionsSemantics("Message actions") { opened += 1 } }
        assertFalse("a tap does nothing, so it isn't offered", SemanticsActions.OnClick in config)
        val longClick = config[SemanticsActions.OnLongClick]
        assertEquals("Message actions", longClick.label)
        val custom = config[SemanticsActions.CustomActions].single()
        assertEquals("Message actions", custom.label)
        assertTrue(custom.action())
        assertTrue(longClick.action!!.invoke())
        assertEquals(2, opened)
    }

    @Test
    fun `a message row reads as one stop with its name, time and text, carrying its actions`() {
        var opened = 0
        // The row's own semantics, as messageActions puts them on the Row.
        @Suppress("DEPRECATION")
        val configs = Modifier.messageRowSemantics("Message actions") { opened += 1 }
            .foldIn(emptyList<SemanticsConfiguration>()) { acc, e -> if (e is SemanticsModifier) acc + listOf(e.semanticsConfiguration) else acc }
        val config = configs.single()
        assertTrue("the row merges its name, time and text, so TalkBack doesn't stop on an empty node", config.isMergingSemanticsOfDescendants)
        assertEquals("Message actions", config[SemanticsActions.OnLongClick].label)
        assertTrue(config[SemanticsActions.CustomActions].single().action())
        assertEquals(1, opened)
    }
}
