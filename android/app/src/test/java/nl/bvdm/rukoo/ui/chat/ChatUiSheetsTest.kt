package nl.bvdm.rukoo.ui.chat

import java.lang.reflect.Proxy
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.mail.DialogChoice
import nl.bvdm.rukoo.ui.mail.UiStrings
import nl.bvdm.rukoo.workspaces.ChatState
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind
import nl.bvdm.rukoo.workspaces.RoomMember
import nl.bvdm.rukoo.workspaces.WorkspaceError
import nl.bvdm.rukoo.workspaces.WorkspaceSummary
import nl.bvdm.rukoo.workspaces.WorkspaceView
import nl.bvdm.rukoo.workspaces.Workspaces
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The sheets' work in the view model (contract §3.12, §5.10): errors that name a person, and leaving a channel. */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatUiSheetsTest {
    private companion object {
        val ME = "u_" + "me".padEnd(22, 'x')
        val MILA = "u_" + "mila".padEnd(22, 'x')
        val OLGA = "u_" + "olga".padEnd(22, 'x')

        val UNUSED = Proxy.newProxyInstance(Workspaces::class.java.classLoader, arrayOf(Workspaces::class.java)) { _, method, _ ->
            error("not expected: ${method.name}")
        } as Workspaces
    }

    private val members = listOf(
        Member(ME, "human", "Sam Jansen", "owner", "active"),
        Member(MILA, "human", "Mila Bakker", "member", "active"),
        Member(OLGA, "human", "Olga Smit", "guest", "active"),
    )

    private val channel = Room(
        id = "c1", kind = RoomKind.CHANNEL, name = "plans", visibility = "workspace", archived = false, closedReason = null,
        participants = null, startedBy = null, role = "manager", members = 3, head = 5, floor = 1, lastAt = null, read = 5,
        unread = 0, mentions = 0, attention = 0, muted = false, hasCache = true,
    )

    private class FakeWorkspaces(private val people: List<Member>) : Workspaces by UNUSED {
        override val state = MutableStateFlow(ChatState(selected = "w1"))
        val leaves = ArrayList<String?>()

        override fun view(ws: String): Flow<WorkspaceView> = flowOf(
            WorkspaceView(WorkspaceSummary(ws, "Acme", "owner"), people.first(), emptyList(), people, false, emptyList(), emptyList()),
        )

        override suspend fun startDm(ws: String, members: List<String>): String = throw WorkspaceError("blocked", status = 409, member = members.first())

        val unblocked = ArrayList<String>()

        override suspend fun unblock(ws: String, member: String) {
            unblocked += member
        }

        override suspend fun leaveChannel(ws: String, channel: String, successor: String?) {
            leaves += successor
            if (successor == null) throw WorkspaceError("last_manager", status = 409, channels = listOf("c_" + "x".repeat(22)))
        }

        override suspend fun roomMembers(ws: String, room: String): List<RoomMember> =
            listOf(RoomMember(ME, "manager"), RoomMember(MILA, "member"), RoomMember(OLGA, "member"))
    }

    private object Strings : UiStrings {
        override fun get(id: Int, vararg args: Any) = "s$id" + if (args.isEmpty()) "" else args.joinToString(",", "(", ")")
        override fun plural(id: Int, count: Int, vararg args: Any) = "p$id"
    }

    private fun TestScope.ui(w: FakeWorkspaces): ChatUi = ChatUi(
        w,
        this,
        object : ChatUiHost {
            override fun openRoom(id: String, at: Long?) {}
            override fun selectWorkspace(id: String?) {}
        },
        state = { w.state.value },
    ).also { it.strings = Strings }

    @Test
    fun `a refusal for someone you blocked names them, even when the caller didn't know whom`() = runTest {
        val w = FakeWorkspaces(members)
        val ui = ui(w)
        // The closed DM's Start a new conversation launches without a name: the directory supplies it.
        ui.launch("startDm", ui.context("w1")) { startDm("w1", listOf(MILA)) }
        advanceUntilIdle()
        assertEquals(Strings.get(R.string.chat_errors_blocked, "Mila Bakker"), ui.toasts.current?.message)
    }

    @Test
    fun `a refusal for someone you blocked offers Unblock, which unblocks them`() = runTest {
        val w = FakeWorkspaces(members)
        val ui = ui(w)
        ui.launch("startDm", ui.context("w1")) { startDm("w1", listOf(MILA)) }
        advanceUntilIdle()
        val toast = ui.toasts.current!!
        assertEquals(Strings.get(R.string.chat_block_unblock), toast.actionLabel)
        toast.onAction!!()
        advanceUntilIdle()
        assertEquals(listOf(MILA), w.unblocked)
        assertEquals(Strings.get(R.string.chat_block_unblocked, "Mila Bakker"), ui.toasts.current?.message)
    }

    @Test
    fun `the only manager leaving picks a successor among the full members, and leaves with them`() = runTest {
        val w = FakeWorkspaces(members)
        val ui = ui(w)
        ui.askLeaveChannel("w1", channel, members.associateBy { it.id }, ME)
        advanceUntilIdle()
        // The question first.
        ui.dialog!!.answer(DialogChoice.CONFIRM)
        advanceUntilIdle()
        val prompt = ui.prompt as ChatPrompt.Successor
        // Not yourself, not the guest.
        assertEquals(listOf("Mila Bakker"), prompt.people!!.map { it.name })
        assertTrue(ui.wasExpected("c1").also { ui.expectGone("c1") })
        ui.handOver(MILA)
        advanceUntilIdle()
        assertEquals(listOf(null, MILA), w.leaves)
        assertNull(ui.prompt)
    }

    @Test
    fun `closing the successor question keeps the channel, so its going is news again`() = runTest {
        val w = FakeWorkspaces(members)
        val ui = ui(w)
        ui.askLeaveChannel("w1", channel, members.associateBy { it.id }, ME)
        advanceUntilIdle()
        ui.dialog!!.answer(DialogChoice.CONFIRM)
        advanceUntilIdle()
        ui.dismissPrompt()
        assertNull(ui.prompt)
        assertEquals(false, ui.wasExpected("c1"))
    }
}
