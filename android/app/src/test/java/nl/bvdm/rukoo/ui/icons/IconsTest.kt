package nl.bvdm.rukoo.ui.icons

import androidx.compose.ui.graphics.vector.PathNode
import androidx.compose.ui.graphics.vector.VectorPath
import androidx.compose.ui.graphics.vector.addPathNodes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class IconsTest {
    @Test
    fun everyDesktopIconIsPorted() {
        // icons.js has 81 icons and bui.js ICONS 40; a missing one would send a track to Material icons.
        assertEquals(81, RukooIcons.names.size)
        assertEquals(40, PanelIcons.names.size)
        for (name in listOf("sparkle", "bell", "vip", "mailOpen", "markUnread", "unsubscribe", "textFormat", "chevronUpDown")) {
            assertTrue(name, name in RukooIcons.names)
        }
        for (name in listOf("arrow-out", "list-check", "file-text", "chevron-up", "skill", "sliders", "stop")) {
            assertTrue(name, PanelIcons.has(name))
        }
    }

    @Test
    fun everyIconBuildsWithDrawablePaths() {
        for (name in RukooIcons.names) assertDrawable(name, RukooIcons.named(name))
        for (name in PanelIcons.names) assertDrawable(name, PanelIcons.named(name))
        for (id in listOf("google", "yahoo", "outlook", "exchange", "office365", "other", "demo")) {
            assertDrawable(id, ProviderLogos.forProvider(id))
        }
    }

    @Test
    fun unknownPanelIconFallsBackToTheWrench() {
        assertEquals("wrench", PanelIcons.named("no-such-icon").name)
        assertSame(PanelIcons.named("check", 3f), PanelIcons.named("check", 3f))
    }

    @Test
    fun strokeWidthsComeFromTheDesktop() {
        val send = paths(PanelIcons.Send)
        assertEquals(2.4f, send.single().strokeLineWidth)
        // bold sets its own width on the path, which a toolbar's 1.7 doesn't override.
        assertEquals(2.4f, paths(RukooIcons.named("bold", 1.7f)).single().strokeLineWidth)
        assertEquals(1.7f, paths(RukooIcons.named("search", 1.7f)).first().strokeLineWidth)
        // A filled panel icon has no stroke.
        assertEquals(null, paths(PanelIcons.Stop).single().stroke)
    }

    @Test
    fun implicitLineToAfterMoveToIsParsed() {
        // icons.js writes "M15.5 15.5 20 20"; the second pair must be a line, not a second move.
        val nodes = addPathNodes("M15.5 15.5 20 20")
        assertEquals(2, nodes.size)
        assertTrue(nodes[1] is PathNode.LineTo)
    }

    @Test
    fun shapesBecomeClosedPaths() {
        assertTrue(addPathNodes(circlePath(12f, 12f, 3f)).last() is PathNode.Close)
        assertTrue(addPathNodes(rectPath(3.5f, 4f, 17f, 16f, 3f)).count { it is PathNode.RelativeArcTo } == 4)
        assertEquals("M3.5 4h17v16h-17z", rectPath(3.5f, 4f, 17f, 16f))
    }

    @Test
    fun effortLevelsMatchTheDesktopMeter() {
        assertEquals(0f, EffortLevels.levelOf("minimal"))
        assertEquals(0.55f, EffortLevels.levelOf("HIGH"))
        assertEquals(1f, EffortLevels.levelOf("ultra"))
        assertEquals(null, EffortLevels.levelOf(null))
        assertEquals(null, EffortLevels.levelOf("auto"))
    }

    private fun paths(vector: androidx.compose.ui.graphics.vector.ImageVector): List<VectorPath> =
        (0 until vector.root.size).mapNotNull { vector.root[it] as? VectorPath }

    private fun assertDrawable(name: String, vector: androidx.compose.ui.graphics.vector.ImageVector) {
        val list = paths(vector)
        assertTrue("$name has no paths", list.isNotEmpty())
        for (p in list) {
            assertTrue("$name has an empty path", p.pathData.size >= 2)
            assertTrue("$name draws nothing", p.fill != null || p.stroke != null)
        }
    }
}
