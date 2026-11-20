package nl.bvdm.rukoo.ui.chat

import java.lang.reflect.Proxy
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import nl.bvdm.rukoo.ui.mail.UiStrings
import nl.bvdm.rukoo.workspaces.ChatState
import nl.bvdm.rukoo.workspaces.Draft
import nl.bvdm.rukoo.workspaces.Mention
import nl.bvdm.rukoo.workspaces.MentionSpan
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind
import nl.bvdm.rukoo.workspaces.RoomTimeline
import nl.bvdm.rukoo.workspaces.ThreadTimeline
import nl.bvdm.rukoo.workspaces.Workspaces
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Chat's actions outside composition: Undo of a discarded send (§3.8 "Resend modes") and Join (§7.4). */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatUiTest {
    private companion object {
        val ANN = "u_" + "ann".padEnd(22, 'x')

        /** Every call the tests don't expect fails. */
        val UNUSED = Proxy.newProxyInstance(Workspaces::class.java.classLoader, arrayOf(Workspaces::class.java)) { _, method, _ ->
            error("not expected: ${method.name}")
        } as Workspaces
    }

    /** The cache's drafts by `room/root`, and the calls made, in order. */
    private class FakeWorkspaces : Workspaces by UNUSED {
        override val state = MutableStateFlow(ChatState())
        val drafts = HashMap<String, Draft?>()
        val calls = ArrayList<String>()

        private fun room(id: String) = Room(
            id = id, kind = RoomKind.CHANNEL, name = "plans", visibility = "workspace", archived = false, closedReason = null,
            participants = null, startedBy = null, role = "member", members = 2, head = 5, floor = 1, lastAt = null, read = 5,
            unread = 0, mentions = 0, attention = 0, muted = false, hasCache = true,
        )

        override fun timeline(ws: String, room: String): Flow<RoomTimeline> = flowOf(
            RoomTimeline(room(room), emptyList(), emptyList(), emptyMap(), readAtOpen = 5, hasOlder = false, complete = true, loading = false, draft = drafts["$room/"]),
        )

        override fun thread(ws: String, room: String, root: String): Flow<ThreadTimeline> = flowOf(
            ThreadTimeline(root = null, replies = emptyList(), pending = emptyList(), complete = true, expired = false, draft = drafts["$room/$root"]),
        )

        override suspend fun saveDraft(ws: String, room: String, root: String?, draft: Draft?) {
            calls += "saveDraft $room/${root.orEmpty()}"
            drafts["$room/${root.orEmpty()}"] = draft
        }

        override suspend fun discard(localId: String) {
            calls += "discard $localId"
        }

        override suspend fun joinChannel(ws: String, channel: String) {
            calls += "join $channel"
        }

        override suspend fun open(ws: String, room: String, at: Long?) {
            calls += "open $room"
        }
    }

    private object Strings : UiStrings {
        override fun get(id: Int, vararg args: Any) = "s$id"
        override fun plural(id: Int, count: Int, vararg args: Any) = "p$id"
    }

    // The test's own scope: advanceUntilIdle runs it, and the test ends once its work did.
    private fun TestScope.ui(w: Workspaces): ChatUi = ChatUi(
        w,
        this,
        object : ChatUiHost {
            override fun openRoom(id: String, at: Long?) {}
            override fun selectWorkspace(id: String?) {}
        },
    ).also { it.strings = Strings }

    private fun TestScope.discardAndUndo(ui: ChatUi, row: PendingRow) {
        ui.pendingAction("w1", "c1", row, PendingAction.DISCARD) {}
        advanceUntilIdle()
        ui.toasts.runAction(ui.toasts.current!!)
        advanceUntilIdle()
    }

    @Test
    fun `Undo of a thread reply discarded after a restart keeps the draft that thread had`() = runTest {
        val w = FakeWorkspaces()
        w.drafts["c1/e1"] = Draft("Still writing")
        val ui = ui(w)
        // The thread's composer never came on screen in this process: only its cached draft is there.
        discardAndUndo(ui, PendingRow("l1", "e1", "@Ann can you check?", listOf(Mention(ANN, 0, 4))))
        assertEquals(listOf("discard l1", "saveDraft c1/e1"), w.calls)
        assertEquals(Draft("Still writing\n@Ann can you check?", listOf(Mention(ANN, 14, 18))), w.drafts["c1/e1"])
        // The room's own draft is left alone.
        assertNull(w.drafts["c1/"])
    }

    @Test
    fun `Undo with nothing kept puts the message back as the draft, and in a composer on screen after its text`() = runTest {
        val w = FakeWorkspaces()
        val ui = ui(w)
        discardAndUndo(ui, PendingRow("l1", null, "Lunch?", emptyList()))
        assertEquals(Draft("Lunch?"), w.drafts["c1/"])

        // With the room's composer in memory, the text goes after what it holds, and the draft follows 500 ms later.
        val composer = ui.composer("w1", "c1", null) { MentionEditing.fromDraft(Draft("Hello")) }
        discardAndUndo(ui, PendingRow("l2", null, "@Ann ok", listOf(Mention(ANN, 0, 4))))
        assertEquals("Hello\n@Ann ok", composer.value.text)
        assertEquals(listOf(MentionSpan(6, 10, ANN)), composer.value.spans)
        assertEquals(Draft("Hello\n@Ann ok", listOf(Mention(ANN, 6, 10))), w.drafts["c1/"])
    }

    @Test
    fun `Join opens the channel once joined, so its history loads and it catches up`() = runTest {
        val w = FakeWorkspaces()
        val ui = ui(w)
        ui.join("w1", "c2")
        advanceUntilIdle()
        assertEquals(listOf("join c2", "open c2"), w.calls)
    }
}
