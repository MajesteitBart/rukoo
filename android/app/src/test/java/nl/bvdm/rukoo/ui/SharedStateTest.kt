package nl.bvdm.rukoo.ui

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import nl.bvdm.rukoo.mail.model.Address
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SharedStateTest {
    @Test
    fun idleCountsFromLeavingTheForeground() {
        var now = 1_000_000L
        val screen = ScreenState { now }
        assertEquals(ScreenState.NEVER_USED_IDLE, screen.idleSeconds())
        screen.setForeground(true)
        now += 600_000
        // On screen but untouched for ten minutes still counts as in use.
        assertEquals(0, screen.idleSeconds())
        screen.setForeground(false)
        assertEquals(0, screen.idleSeconds())
        now += 42_000
        assertEquals(42, screen.idleSeconds())
    }

    @Test
    fun anOpenDraftSurvivesTheProcess() = runTest {
        val file = File(Files.createTempDirectory("rukoo-composer").toFile(), ComposerController.FILE_NAME)
        val io = StandardTestDispatcher(testScheduler)
        val first = ComposerController(file, backgroundScope, io)
        val key = first.open(ComposerState(to = listOf(Address("Sanne", "sanne@example.com")), subject = "Re: Call"))
        first.update { it.copy(body = "Works for me", dirty = true) }
        // Not written on every change.
        runCurrent()
        assertFalse(file.exists())
        advanceTimeBy(1_000)
        runCurrent()
        assertTrue(file.exists())

        val restored = ComposerController(file, backgroundScope, io).current()!!
        assertEquals(key, restored.id)
        assertEquals("Works for me", restored.body)
        assertEquals("sanne@example.com", restored.to.single().address)

        first.close()
        runCurrent()
        assertFalse(file.exists())
        assertNull(ComposerController(file, null).current())
    }

    @Test
    fun closingWhileTheFirstWriteRunsStillDeletes() = runTest {
        val file = File(Files.createTempDirectory("rukoo-composer").toFile(), ComposerController.FILE_NAME)
        val io = StandardTestDispatcher(testScheduler)
        val composer = ComposerController(file, backgroundScope, io)
        composer.open(ComposerState(subject = "Draft"))
        // Past the save delay, the write is dispatched; close before it has run.
        advanceTimeBy(401)
        composer.close()
        advanceTimeBy(1_000)
        runCurrent()
        assertFalse(file.exists())
    }
}
