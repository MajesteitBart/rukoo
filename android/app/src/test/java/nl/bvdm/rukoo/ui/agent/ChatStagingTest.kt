package nl.bvdm.rukoo.ui.agent

import java.io.ByteArrayInputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import nl.bvdm.rukoo.agents.FileSource
import nl.bvdm.rukoo.agents.HubKit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Picked files on their way into the chat input, owned by the activity rather than the pane (ChatStaging). */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatStagingTest {
    @After
    fun tearDown() = Dispatchers.resetMain()

    private suspend fun TestScope.kit(): HubKit {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val k = HubKit(this)
        runCurrent()
        k.hub.ready()
        return k
    }

    private fun src(name: String, text: String = "x") = FileSource(name, text.length.toLong()) { ByteArrayInputStream(text.toByteArray()) }

    @Test
    fun filesPickedWhileNoInputIsThereWaitUntilOneTakesThem() = runTest {
        val k = kit()
        val staging = ChatStaging(hub = { k.hub }, io = StandardTestDispatcher(testScheduler))
        staging.stage(room = 10) { listOf(src("a.txt"), src("b.exe")) }
        // Holding from the tap on, so nothing is sent without the files.
        assertTrue(staging.holding())
        advanceUntilIdle()
        assertEquals(listOf(null, "blocked"), staging.results.value.map { it.error })
        // Still holding until the input has taken them, so a message sent in between can't leave them behind.
        assertTrue(staging.holding())
        val taken = staging.take()
        assertFalse(staging.holding())
        assertEquals(listOf("a.txt", "b.exe"), taken.map { it.name })
        assertTrue(staging.results.value.isEmpty())
        assertTrue(staging.take().isEmpty())
    }

    @Test
    fun theRoomCountsFilesStillOnTheirWay() = runTest {
        val k = kit()
        val staging = ChatStaging(hub = { k.hub }, io = StandardTestDispatcher(testScheduler))
        // Two picks before either is in: the second has room only for what the first leaves.
        staging.stage(room = 3) { listOf(src("a.txt"), src("b.txt")) }
        staging.stage(room = 3) { listOf(src("c.txt"), src("d.txt")) }
        advanceUntilIdle()
        assertEquals(
            listOf("a.txt" to null, "b.txt" to null, "c.txt" to null, "d.txt" to "too-many"),
            staging.take().map { it.name to it.error }.sortedBy { it.first },
        )
        assertTrue(staging.adding.value.isEmpty())
        assertFalse(staging.holding())
    }
}
