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

        val roles = ArrayList<String>()

        override suspend fun setRole(ws: String, member: String, role: String) {
            roles += role
        }

        val channelRoles = ArrayList<String>()

        override suspend fun setChannelRole(ws: String, channel: String, member: String, role: String) {
            channelRoles += role
        }
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
    fun `Owner asks first, Cancel keeps the role, and the confirmed change says nothing more`() = runTest {
        val w = FakeWorkspaces(members)
        val ui = ui(w)
        ui.changeRole("w1", MILA, "Mila Bakker", "member", "owner")
        advanceUntilIdle()
        val asked = ui.dialog!!
        assertEquals(Strings.get(R.string.chat_members_owner_title, "Mila Bakker"), asked.title)
        assertEquals(Strings.get(R.string.chat_members_owner_confirm), asked.confirmLabel)
        assertEquals(false, asked.danger)
        asked.answer(DialogChoice.CANCEL)
        advanceUntilIdle()
        assertEquals(emptyList<String>(), w.roles)

        ui.changeRole("w1", MILA, "Mila Bakker", "member", "owner")
        advanceUntilIdle()
        ui.dialog!!.answer(DialogChoice.CONFIRM)
        advanceUntilIdle()
        assertEquals(listOf("owner"), w.roles)
        assertNull(ui.toasts.current)
    }

    @Test
    fun `Guest asks first and says the direct messages close`() = runTest {
        val w = FakeWorkspaces(members)
        val ui = ui(w)
        ui.changeRole("w1", MILA, "Mila Bakker", "member", "guest")
        advanceUntilIdle()
        val asked = ui.dialog!!
        assertEquals(Strings.get(R.string.chat_members_guest_title, "Mila Bakker"), asked.title)
        assertEquals(Strings.get(R.string.chat_members_guest_body, "Mila Bakker"), asked.message)
        assertEquals(Strings.get(R.string.chat_members_guest_confirm), asked.confirmLabel)
        assertTrue(asked.danger)
        asked.answer(DialogChoice.CONFIRM)
        advanceUntilIdle()
        assertEquals(listOf("guest"), w.roles)
        assertNull(ui.toasts.current)
    }

    @Test
    fun `Admin applies at once, and its Undo sets the role from before back`() = runTest {
        val w = FakeWorkspaces(members)
        val ui = ui(w)
        // An owner made admin: Undo makes them owner again, not member.
        ui.changeRole("w1", MILA, "Mila Bakker", "owner", "admin")
        advanceUntilIdle()
        assertNull(ui.dialog)
        assertEquals(listOf("admin"), w.roles)
        val toast = ui.toasts.current!!
        assertEquals(Strings.get(R.string.chat_members_now_admin, "Mila Bakker"), toast.message)
        assertEquals(Strings.get(R.string.common_actions_undo), toast.actionLabel)
        toast.onAction!!()
        advanceUntilIdle()
        assertEquals(listOf("admin", "owner"), w.roles)
    }

    @Test
    fun `Member applies at once with Undo`() = runTest {
        val w = FakeWorkspaces(members)
        val ui = ui(w)
        ui.changeRole("w1", MILA, "Mila Bakker", "guest", "member")
        advanceUntilIdle()
        assertNull(ui.dialog)
        assertEquals(Strings.get(R.string.chat_members_now_member, "Mila Bakker"), ui.toasts.current?.message)
        ui.toasts.current!!.onAction!!()
        advanceUntilIdle()
        assertEquals(listOf("member", "guest"), w.roles)
    }

    @Test
    fun `Make manager and Make member say so with Undo, and the list loads again after each`() = runTest {
        val w = FakeWorkspaces(members)
        val ui = ui(w)
        var loads = 0
        ui.changeChannelRole("w1", "c1", MILA, "Mila Bakker", "manager") { loads++ }
        advanceUntilIdle()
        assertEquals(listOf("manager"), w.channelRoles)
        assertEquals(1, loads)
        assertEquals(Strings.get(R.string.chat_channel_now_manager, "Mila Bakker"), ui.toasts.current?.message)
        ui.toasts.current!!.onAction!!()
        advanceUntilIdle()
        assertEquals(listOf("manager", "member"), w.channelRoles)
        assertEquals(2, loads)

        ui.changeChannelRole("w1", "c1", MILA, "Mila Bakker", "member") { loads++ }
        advanceUntilIdle()
        assertEquals(Strings.get(R.string.chat_channel_now_member, "Mila Bakker"), ui.toasts.current?.message)
        ui.toasts.current!!.onAction!!()
        advanceUntilIdle()
        assertEquals(listOf("manager", "member", "member", "manager"), w.channelRoles)
        assertEquals(4, loads)
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
