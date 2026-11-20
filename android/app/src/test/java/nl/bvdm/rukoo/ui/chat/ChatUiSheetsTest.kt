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

        /** The rooms the view holds. */
        var rooms: List<Room> = emptyList()

        /** The channels' members; null makes loading them fail. */
        var inside: List<RoomMember>? = listOf(RoomMember(ME, "manager"), RoomMember(MILA, "member"), RoomMember(OLGA, "member"))

        /** What leaving the workspace answers the first time; null leaves. */
        var leaveWsError: WorkspaceError? = null
        var wsLeaves = 0
        val roleCalls = ArrayList<String>()

        fun currentView(ws: String) = WorkspaceView(WorkspaceSummary(ws, "Acme", "owner"), people.first(), rooms, people, false, emptyList(), emptyList())

        override fun view(ws: String): Flow<WorkspaceView> = flowOf(currentView(ws))

        override suspend fun leaveWorkspace(ws: String) {
            wsLeaves++
            leaveWsError?.let {
                leaveWsError = null
                throw it
            }
        }

        override suspend fun startDm(ws: String, members: List<String>): String = throw WorkspaceError("blocked", status = 409, member = members.first())

        val unblocked = ArrayList<String>()

        override suspend fun unblock(ws: String, member: String) {
            unblocked += member
        }

        override suspend fun leaveChannel(ws: String, channel: String, successor: String?) {
            leaves += successor
            val sole = inside?.none { it.member != ME && it.role == "manager" } ?: true
            if (successor == null && sole) throw WorkspaceError("last_manager", status = 409, channels = listOf("c_" + "x".repeat(22)))
        }

        override suspend fun roomMembers(ws: String, room: String): List<RoomMember> = inside ?: throw WorkspaceError("network")

        val roles = ArrayList<String>()

        override suspend fun setRole(ws: String, member: String, role: String) {
            roles += role
        }

        val channelRoles = ArrayList<String>()

        override suspend fun setChannelRole(ws: String, channel: String, member: String, role: String) {
            channelRoles += role
            roleCalls += "$channel:$member:$role"
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
    fun `the only manager leaving picks a successor among the full members at once, and leaves with them`() = runTest {
        val w = FakeWorkspaces(members)
        val ui = ui(w)
        ui.askLeaveChannel("w1", channel, members.associateBy { it.id }, ME)
        advanceUntilIdle()
        // No confirmation first: the successor question is the one that matters.
        assertNull(ui.dialog)
        val prompt = ui.prompt as ChatPrompt.Successor
        // Not yourself, not the guest.
        assertEquals(listOf("Mila Bakker"), prompt.people!!.map { it.name })
        assertTrue(ui.wasExpected("c1").also { ui.expectGone("c1") })
        ui.handOver(MILA)
        advanceUntilIdle()
        assertEquals(listOf(MILA), w.leaves)
        assertNull(ui.prompt)
    }

    @Test
    fun `a manager with another manager beside them gets the plain confirmation`() = runTest {
        val w = FakeWorkspaces(members)
        w.inside = listOf(RoomMember(ME, "manager"), RoomMember(MILA, "manager"), RoomMember(OLGA, "member"))
        val ui = ui(w)
        ui.askLeaveChannel("w1", channel, members.associateBy { it.id }, ME)
        advanceUntilIdle()
        assertEquals(Strings.get(R.string.chat_channel_leave_title, "plans"), ui.dialog!!.title)
        ui.dialog!!.answer(DialogChoice.CONFIRM)
        advanceUntilIdle()
        assertEquals(listOf<String?>(null), w.leaves)
        assertNull(ui.prompt)
    }

    @Test
    fun `when the channel's members don't load, the server's last_manager still opens the successor question`() = runTest {
        val w = FakeWorkspaces(members)
        w.inside = null
        val ui = ui(w)
        ui.askLeaveChannel("w1", channel, members.associateBy { it.id }, ME)
        advanceUntilIdle()
        ui.dialog!!.answer(DialogChoice.CONFIRM)
        advanceUntilIdle()
        assertTrue(ui.prompt is ChatPrompt.Successor)
        assertEquals(listOf<String?>(null), w.leaves)
    }

    @Test
    fun `the only owner is told before any confirmation and nothing is sent`() = runTest {
        val w = FakeWorkspaces(members)
        val ui = ui(w)
        var membersOpened = false
        ui.askLeaveWorkspace("w1", w.currentView("w1")) { membersOpened = true }
        advanceUntilIdle()
        val asked = ui.dialog!!
        assertEquals(Strings.get(R.string.chat_leave_last_owner), asked.message)
        assertEquals(Strings.get(R.string.chat_workspace_members), asked.confirmLabel)
        asked.answer(DialogChoice.CONFIRM)
        advanceUntilIdle()
        assertTrue(membersOpened)
        assertEquals(0, w.wsLeaves)
    }

    @Test
    fun `the only manager of a shared channel picks its successor in the hand-over, whose button hands over and leaves`() = runTest {
        val w = FakeWorkspaces(members.map { if (it.id == MILA) it.copy(role = "owner") else it })
        w.rooms = listOf(channel, channel.copy(id = "c2", name = "solo", members = 1), channel.copy(id = "c3", name = "ads", role = "member"))
        val ui = ui(w)
        ui.askLeaveWorkspace("w1", w.currentView("w1")) {}
        advanceUntilIdle()
        assertNull(ui.dialog)
        val prompt = ui.prompt as ChatPrompt.HandOver
        // Only the channel with others in it; nobody preselected.
        assertEquals(listOf("c1"), prompt.channels.map { it.id })
        assertEquals(listOf("Mila Bakker"), prompt.channels.single().people!!.map { it.name })
        ui.handOverAndLeave(emptyMap())
        advanceUntilIdle()
        assertEquals(0, w.wsLeaves)
        ui.handOverAndLeave(mapOf("c1" to MILA))
        advanceUntilIdle()
        assertEquals(listOf("c1:$MILA:manager"), w.roleCalls)
        assertEquals(1, w.wsLeaves)
        assertNull(ui.prompt)
    }

    @Test
    fun `with nothing to hand over, leaving asks first, and the server's last_manager opens the hand-over`() = runTest {
        val w = FakeWorkspaces(members.map { if (it.id == MILA) it.copy(role = "owner") else it })
        val ui = ui(w)
        w.leaveWsError = WorkspaceError("last_manager", status = 409, channels = listOf("c1"))
        // The view doesn't hold the room yet, so the app can't tell; the hand-over names it from the server's answer.
        val view = w.currentView("w1").copy(channels = listOf(nl.bvdm.rukoo.workspaces.Channel("c1", "plans", "workspace")))
        ui.askLeaveWorkspace("w1", view) {}
        advanceUntilIdle()
        assertEquals(Strings.get(R.string.chat_leave_title, ""), ui.dialog!!.title)
        ui.dialog!!.answer(DialogChoice.CONFIRM)
        advanceUntilIdle()
        val prompt = ui.prompt as ChatPrompt.HandOver
        assertEquals(listOf("plans"), prompt.channels.map { it.name })
        assertEquals(listOf("Mila Bakker"), prompt.channels.single().people!!.map { it.name })
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
        ui.dismissPrompt()
        assertNull(ui.prompt)
        assertEquals(false, ui.wasExpected("c1"))
    }
}
