package nl.bvdm.rukoo.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ComponentsLogicTest {
    @Test
    fun toastDurationsFollowTheDesktop() {
        val state = RkToastState()
        state.showToast("Marked 3 emails as read")
        assertEquals(2600L, state.current?.durationMs)
        state.showToast("Moved to Trash", "Undo") {}
        assertEquals(8000L, state.current?.durationMs)
        assertEquals("Undo", state.current?.actionLabel)
        state.showError("Sync failed")
        assertEquals(5000L, state.current?.durationMs)
    }

    @Test
    fun anActionNeedsACallback() {
        val state = RkToastState()
        state.showToast("Moved to Trash", actionLabel = "Undo", onAction = null)
        assertNull(state.current?.actionLabel)
        assertEquals(2600L, state.current?.durationMs)
    }

    @Test
    fun runningTheActionClosesTheToastFirst() {
        val state = RkToastState()
        var undone = 0
        state.showToast("Moved to Trash", "Undo") { undone++ }
        state.runAction(state.current!!)
        assertEquals(1, undone)
        assertNull(state.current)
    }

    @Test
    fun anActionRunsOnceAndNotAfterTheToastIsReplaced() {
        val state = RkToastState()
        var undone = 0
        state.showToast("Moved to Trash", "Undo") { undone++ }
        val first = state.current!!
        // A second tap while the toast fades out.
        state.runAction(first)
        state.runAction(first)
        assertEquals(1, undone)
        // An old toast's action does nothing once another toast is showing.
        state.showToast("Moved to Archive", "Undo") { undone += 10 }
        state.runAction(first)
        assertEquals(1, undone)
        assertEquals("Moved to Archive", state.current?.message)
    }

    @Test
    fun dismissingAnOldToastLeavesTheNewOne() {
        val state = RkToastState()
        state.showToast("First")
        val first = state.current!!.id
        state.showToast("Second")
        state.dismiss(first)
        assertEquals("Second", state.current?.message)
        state.dismiss()
        assertNull(state.current)
    }

    @Test
    fun pixelLoaderBlinksLikeTheKeyframes() {
        assertEquals(0.15f, pixelOpacity(0f), 0.001f)
        assertEquals(1f, pixelOpacity(0.18f), 0.001f)
        assertEquals(1f, pixelOpacity(0.3f), 0.001f)
        assertEquals(0.15f, pixelOpacity(0.62f), 0.001f)
        assertEquals(0.15f, pixelOpacity(0.9f), 0.001f)
    }
}
