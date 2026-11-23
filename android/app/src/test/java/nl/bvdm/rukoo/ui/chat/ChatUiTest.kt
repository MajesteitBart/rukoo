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
import nl.bvdm.rukoo.workspaces.RoomMember
import nl.bvdm.rukoo.workspaces.RoomTimeline
import nl.bvdm.rukoo.workspaces.ThreadTimeline
import nl.bvdm.rukoo.workspaces.Workspaces
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
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

    // The test's own scope: advanceUntilIdle runs it, and the test ends once its work did. [threads] records the
    // threads opened, as "ws/room/root".
    private fun TestScope.ui(w: Workspaces, threads: MutableList<String> = ArrayList()): ChatUi = ChatUi(
        w,
        this,
        object : ChatUiHost {
            override fun openRoom(id: String, at: Long?) {}
            override fun selectWorkspace(id: String?) {}
            override fun openThread(ws: String, room: String, root: String) {
                threads += "$ws/$room/$root"
            }
        },
    ).also { it.strings = Strings }

    private fun TestScope.discardAndUndo(ui: ChatUi, row: PendingRow) {
        ui.pendingAction("w1", "c1", row, PendingAction.DISCARD) {}
        advanceUntilIdle()
        ui.toasts.runAction(ui.toasts.current!!)
        advanceUntilIdle()
    }

    @Test
    fun `Undo of a thread reply discarded after a restart keeps the draft that thread had, and opens the thread with it`() = runTest {
        val w = FakeWorkspaces()
        w.drafts["c1/e1"] = Draft("Still writing")
        val threads = ArrayList<String>()
        val ui = ui(w, threads)
        // The thread's composer never came on screen in this process: only its cached draft is there.
        discardAndUndo(ui, PendingRow("l1", "e1", "@Ann can you check?", listOf(Mention(ANN, 0, 4))))
        assertEquals(listOf("discard l1", "saveDraft c1/e1"), w.calls)
        assertEquals(Draft("Still writing\n@Ann can you check?", listOf(Mention(ANN, 14, 18))), w.drafts["c1/e1"])
        // The thread opens, its composer holding the text, so the Undo shows where the text went.
        assertEquals(listOf("w1/c1/e1"), threads)
        val composer = ui.composer("w1", "c1", "e1") { error("the composer should be there already") }
        assertEquals("Still writing\n@Ann can you check?", composer.value.text)
        assertEquals(listOf(MentionSpan(14, 18, ANN)), composer.value.spans)
        // The room's own draft is left alone.
        assertNull(w.drafts["c1/"])
    }

    @Test
    fun `Undo of a thread reply whose composer is in memory puts the text after it and opens the thread`() = runTest {
        val w = FakeWorkspaces()
        val threads = ArrayList<String>()
        val ui = ui(w, threads)
        val composer = ui.composer("w1", "c1", "e1") { MentionEditing.fromDraft(Draft("Hi")) }
        discardAndUndo(ui, PendingRow("l1", "e1", "ok", emptyList()))
        assertEquals("Hi\nok", composer.value.text)
        assertEquals(listOf("w1/c1/e1"), threads)
    }

    @Test
    fun `Undo of a room message opens no thread`() = runTest {
        val w = FakeWorkspaces()
        val threads = ArrayList<String>()
        val ui = ui(w, threads)
        discardAndUndo(ui, PendingRow("l1", null, "Lunch?", emptyList()))
        assertEquals(Draft("Lunch?"), w.drafts["c1/"])
        assertEquals(emptyList<String>(), threads)
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

    @Test
    fun `the mention picker loads a channel's people again when it opens, so someone replaced isn't offered`() = runTest {
        val roster = ArrayList(listOf("u_ann", "u_bob"))
        var loads = 0
        val w = object : Workspaces by UNUSED {
            override suspend fun roomMembers(ws: String, room: String): List<RoomMember> {
                loads += 1
                return roster.map { RoomMember(it, "member") }
            }
        }
        val ui = ui(w)
        val channel = Room(
            id = "c1", kind = RoomKind.CHANNEL, name = "plans", visibility = "workspace", archived = false, closedReason = null,
            participants = null, startedBy = null, role = "member", members = 2, head = 5, floor = 1, lastAt = null, read = 5,
            unread = 0, mentions = 0, attention = 0, muted = false, hasCache = true,
        )
        assertEquals(listOf("u_ann", "u_bob"), ui.mentionMembers("w1", channel))
        // The composer coming back with the same count keeps what it loaded.
        assertEquals(listOf("u_ann", "u_bob"), ui.mentionMembers("w1", channel))
        assertEquals(1, loads)
        // Bob was removed and Cas added: the count stays 2. The picker opening asks the server again.
        roster[1] = "u_cas"
        assertEquals(listOf("u_ann", "u_cas"), ui.mentionMembers("w1", channel, fresh = true))
        // A changed count loads again too, without the picker asking.
        roster += "u_dee"
        assertEquals(listOf("u_ann", "u_cas", "u_dee"), ui.mentionMembers("w1", channel.copy(members = 3)))
        assertEquals(3, loads)
        // Offline, the people it knew stand in.
        val offline = object : Workspaces by UNUSED {
            override suspend fun roomMembers(ws: String, room: String): List<RoomMember> = throw nl.bvdm.rukoo.workspaces.WorkspaceError("network")
        }
        val off = ui(offline)
        assertNull(off.mentionMembers("w1", channel, fresh = true))
    }

    @Test
    fun `the mention picker loads a channel's roster again when an agent comes or goes, though the people's count stays`() = runTest {
        val roster = ArrayList(listOf("u_ann", "u_bob"))
        var loads = 0
        val w = object : Workspaces by UNUSED {
            override suspend fun roomMembers(ws: String, room: String): List<RoomMember> {
                loads += 1
                return roster.map { RoomMember(it, "member") }
            }
        }
        val ui = ui(w)
        val channel = Room(
            id = "c1", kind = RoomKind.CHANNEL, name = "plans", visibility = "workspace", archived = false, closedReason = null,
            participants = null, startedBy = null, role = "member", members = 2, head = 5, floor = 1, lastAt = null, read = 5,
            unread = 0, mentions = 0, attention = 0, muted = false, hasCache = true,
        )
        assertEquals(listOf("u_ann", "u_bob"), ui.mentionMembers("w1", channel))
        // Clark is added: two people still, one agent now. The composer's key changes with it, so an open picker reloads.
        roster += "u_clark"
        val withClark = channel.copy(agents = 1)
        assertNotEquals(MentionRoster.of(channel), MentionRoster.of(withClark))
        assertEquals(listOf("u_ann", "u_bob", "u_clark"), ui.mentionMembers("w1", withClark))
        // Clark is removed again: he isn't offered, so a mention of him can't go out and fail on the server.
        roster -= "u_clark"
        assertEquals(listOf("u_ann", "u_bob"), ui.mentionMembers("w1", channel))
        assertEquals(3, loads)
    }

    @Test
    fun `the mention picker loads a channel's roster again when one agent replaces another, though both counts stay`() = runTest {
        val roster = ArrayList(listOf("u_ann", "u_bob", "u_clark"))
        var loads = 0
        val w = object : Workspaces by UNUSED {
            override suspend fun roomMembers(ws: String, room: String): List<RoomMember> {
                loads += 1
                return roster.map { RoomMember(it, "member") }
            }
        }
        val ui = ui(w)
        // Two people and Clark, who came in at seq 5.
        val channel = Room(
            id = "c1", kind = RoomKind.CHANNEL, name = "plans", visibility = "workspace", archived = false, closedReason = null,
            participants = null, startedBy = null, role = "member", members = 2, head = 5, floor = 1, lastAt = null, read = 5,
            unread = 0, mentions = 0, attention = 0, muted = false, hasCache = true, agents = 1, roster = 5,
        )
        assertEquals(listOf("u_ann", "u_bob", "u_clark"), ui.mentionMembers("w1", channel))
        // A message moves the head, not the roster: the composer keeps what it loaded.
        assertEquals(listOf("u_ann", "u_bob", "u_clark"), ui.mentionMembers("w1", channel.copy(head = 6)))
        assertEquals(1, loads)
        // Clark leaves at seq 7 and Dot comes in at seq 8: two people and one agent still, the roster moved. The
        // composer's key changes with it, so an open picker loads again and no longer offers Clark.
        roster[2] = "u_dot"
        val swapped = channel.copy(head = 8, roster = 8)
        assertEquals(channel.members to channel.agents, swapped.members to swapped.agents)
        assertNotEquals(MentionRoster.of(channel), MentionRoster.of(swapped))
        assertEquals(listOf("u_ann", "u_bob", "u_dot"), ui.mentionMembers("w1", swapped))
        assertEquals(2, loads)
        assertEquals(listOf("u_ann", "u_bob", "u_dot"), ui.mentionMembers("w1", swapped))
        assertEquals(2, loads)
    }

    @Test
    fun `a thread's collected value is only taken for that thread`() {
        val a = ThreadTimeline(root = null, replies = emptyList(), pending = emptyList(), complete = true, expired = false, draft = Draft("Reply for A"))
        val keyed = KeyedThread("w1", "c1", "e_a", a)
        assertEquals(a, keyed.of("w1", "c1", "e_a"))
        // Thread B opened while A's value is still the collected one: B shows loading, and its composer waits for B's
        // own draft instead of starting from A's.
        assertNull(keyed.of("w1", "c1", "e_b"))
        assertNull(keyed.of("w1", "c2", "e_a"))
        assertNull(keyed.of("w2", "c1", "e_a"))
    }
}
