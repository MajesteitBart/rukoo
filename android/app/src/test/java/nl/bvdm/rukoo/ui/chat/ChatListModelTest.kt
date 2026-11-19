package nl.bvdm.rukoo.ui.chat

import nl.bvdm.rukoo.workspaces.ChatState
import nl.bvdm.rukoo.workspaces.Connection
import nl.bvdm.rukoo.workspaces.Event
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind
import nl.bvdm.rukoo.workspaces.WorkspaceStatus
import nl.bvdm.rukoo.workspaces.WorkspaceSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The conversation list (contract §3.10, §3.12, §7.4): sections, filters, badges, closed and muted rows, titles. */
class ChatListModelTest {
    private val me = Member(u("me"), name = "Me", role = "member", state = "active")
    private val guest = me.copy(role = "guest")
    private val people = listOf(
        me,
        Member(u("sanne"), name = "Sanne", role = "member", state = "active"),
        Member(u("mila"), name = "Mila", role = "member", state = "active"),
        Member(u("olga"), name = "Olga", role = "member", state = "active"),
        Member(u("piet"), name = "Piet", role = "member", state = "active"),
        Member(u("gone"), name = "Gone", role = "member", state = "deleted"),
    ).associateBy { it.id }
    private val names = ChatNames(
        former = "Former member",
        deleted = "Deleted member",
        others = { n -> " and $n others" },
        list = { list -> list.dropLast(1).joinToString(", ") + " and " + list.last() },
    )

    @Test
    fun `channels go by name, DMs by their last message with closed ones last, archived channels apart`() {
        val rooms = listOf(
            channel("c_b", "beta"),
            channel("c_a", "Alpha"),
            channel("c_old", "old", archived = true),
            dm("d_1", lastAt = 100, with = listOf("sanne")),
            dm("d_2", lastAt = 300, with = listOf("mila")),
            dm("d_closed", lastAt = 900, with = listOf("olga"), closedReason = "left"),
        )
        val s = ChatListModel.sections(rooms, ChatFilter.ALL, me, people, names)
        assertEquals(listOf("Alpha", "beta"), s.channels.map { it.title })
        assertEquals(listOf("old"), s.archived.map { it.title })
        assertEquals(listOf("d_2", "d_1", "d_closed"), s.dms.map { it.room.id })
        assertTrue(s.dms.last().closed)
        // An archived channel that is open stays among Channels.
        val open = ChatListModel.sections(rooms, ChatFilter.ALL, me, people, names, open = "c_old")
        assertEquals(listOf("Alpha", "beta", "old"), open.channels.map { it.title })
        assertTrue(open.archived.isEmpty())
        assertTrue(open.channels.last().open)
    }

    @Test
    fun `the Unread filter keeps unread rooms that aren't muted, and the open room`() {
        val rooms = listOf(
            channel("c_quiet", "quiet"),
            channel("c_news", "news", unread = 3),
            channel("c_muted", "muted", unread = 5, muted = true),
            dm("d_1", with = listOf("sanne"), unread = 1),
        )
        val s = ChatListModel.sections(rooms, ChatFilter.UNREAD, me, people, names)
        assertEquals(listOf("c_news"), s.channels.map { it.room.id })
        assertEquals(listOf("d_1"), s.dms.map { it.room.id })
        assertEquals(2, s.unreadCount)
        val kept = ChatListModel.sections(rooms, ChatFilter.UNREAD, me, people, names, open = "c_quiet")
        assertEquals(listOf("c_news", "c_quiet"), kept.channels.map { it.room.id })
        assertTrue(ChatListModel.sections(listOf(channel("c_quiet", "quiet")), ChatFilter.UNREAD, me, people, names).isEmpty)
    }

    @Test
    fun `badges follow section 3_10`() {
        // A DM with unread messages: the accent pill with the count.
        RowBadge.of(dm("d", with = listOf("sanne"), unread = 4)).let {
            assertEquals(4, it.pill)
            assertFalse(it.dot)
            assertTrue(it.bold)
            assertEquals(4, it.attention)
        }
        // A channel with mentions: the pill with the mention count.
        RowBadge.of(channel("c", "x", unread = 9, mentions = 2)).let {
            assertEquals(2, it.pill)
            assertFalse(it.dot)
            assertTrue(it.bold)
            assertEquals(2, it.attention)
        }
        // A channel with unread messages and no mentions: bold with a news dot, and no attention.
        RowBadge.of(channel("c", "x", unread = 9)).let {
            assertNull(it.pill)
            assertTrue(it.dot)
            assertTrue(it.bold)
            assertEquals(0, it.attention)
        }
        // Muted: never bold, no pill, dimmed, no attention.
        RowBadge.of(channel("c", "x", unread = 9, mentions = 2, muted = true)).let {
            assertNull(it.pill)
            assertFalse(it.dot)
            assertFalse(it.bold)
            assertTrue(it.dim)
            assertEquals(0, it.attention)
        }
        RowBadge.of(dm("d", with = listOf("sanne"), unread = 4, muted = true)).let {
            assertNull(it.pill)
            assertEquals(0, it.attention)
            assertTrue(it.dim)
        }
        // A closed DM is dimmed and still counts what is unread.
        RowBadge.of(dm("d", with = listOf("sanne"), unread = 1, closedReason = "closed")).let {
            assertTrue(it.dim)
            assertEquals(1, it.pill)
        }
        RowBadge.of(channel("c", "x")).let {
            assertNull(it.pill)
            assertFalse(it.dot)
            assertFalse(it.bold)
            assertFalse(it.dim)
        }
    }

    @Test
    fun `the mode badge is a count, 99+ above 99, or a dot`() {
        assertNull(ChatBadge.of(0, unread = false))
        assertEquals(ChatBadge(0, dot = true), ChatBadge.of(0, unread = true))
        assertEquals("7", ChatBadge.of(7, unread = true)!!.text)
        assertFalse(ChatBadge.of(7, unread = false)!!.dot)
        assertEquals("99", ChatBadge.of(99, unread = false)!!.text)
        assertEquals("99+", ChatBadge.of(100, unread = false)!!.text)
    }

    @Test
    fun `full members get the plus buttons, guests see Direct messages only with DMs`() {
        val rooms = listOf(channel("c_a", "a"))
        val member = ChatListModel.sections(rooms, ChatFilter.ALL, me, people, names)
        assertTrue(member.canCreate)
        assertTrue(member.showDms)
        val asGuest = ChatListModel.sections(rooms, ChatFilter.ALL, guest, people, names)
        assertFalse(asGuest.canCreate)
        assertFalse(asGuest.showDms)
        val guestWithClosed = ChatListModel.sections(rooms + dm("d", with = listOf("sanne"), closedReason = "ineligible"), ChatFilter.ALL, guest, people, names)
        assertTrue(guestWithClosed.showDms)
        assertTrue(guestWithClosed.dms.single().badge.dim)
        for (role in listOf("owner", "admin", "member")) assertTrue(role, ChatListModel.isFullMember(role))
        assertFalse(ChatListModel.isFullMember("guest"))
        assertFalse(ChatListModel.isFullMember(null))
    }

    @Test
    fun `DM rows preview the newest cached message`() {
        val one = dm("d_1", with = listOf("sanne"), preview = event(u("sanne"), "Lunch\n at  12?"))
        assertEquals(RoomPreview(null, "Lunch at 12?", removed = false), ChatListModel.preview(one, people, me.id, names))
        val group = dm("d_2", with = listOf("sanne", "mila"), preview = event(u("mila"), "Done"))
        assertEquals(RoomPreview("Mila", "Done", removed = false), ChatListModel.preview(group, people, me.id, names))
        // Your own message in a group carries no name; a removed one says so.
        val mine = dm("d_3", with = listOf("sanne", "mila"), preview = event(me.id, "Mine"))
        assertNull(ChatListModel.preview(mine, people, me.id, names)!!.author)
        val removed = dm("d_4", with = listOf("sanne"), preview = event(u("sanne"), null, redacted = true))
        assertTrue(ChatListModel.preview(removed, people, me.id, names)!!.removed)
        assertNull(ChatListModel.preview(dm("d_5", with = listOf("sanne")), people, me.id, names))
        assertNull(ChatListModel.preview(channel("c", "x"), people, me.id, names))
    }

    @Test
    fun `DM titles name the others, with Former and Deleted members`() {
        val m = people
        assertEquals("Sanne", names.dmTitle(listOf(me.id, u("sanne")), m, me.id))
        assertEquals("Sanne and Mila", names.dmTitle(listOf(me.id, u("sanne"), u("mila")), m, me.id))
        assertEquals("Sanne, Mila and Olga", names.dmTitle(listOf(u("sanne"), me.id, u("mila"), u("olga")), m, me.id))
        assertEquals("Sanne, Mila and 2 others", names.dmTitle(listOf(u("sanne"), u("mila"), u("olga"), u("piet"), me.id), m, me.id))
        assertEquals("Deleted member", names.dmTitle(listOf(me.id, u("gone")), m, me.id))
        assertEquals("Former member", names.dmTitle(listOf(me.id, u("stranger")), m, me.id))
        // Nobody else left in it: your own name.
        assertEquals("Me", names.dmTitle(listOf(me.id), m, me.id))
        assertEquals("general", names.title(channel("c", "general"), m, me.id))
    }

    @Test
    fun `the gate and the status line`() {
        val ready = ChatState(available = true, signedIn = true, workspaces = listOf(WorkspaceSummary("w1", "A", "member", WorkspaceStatus.OK)))
        assertNull(ChatListModel.gate(ready))
        assertEquals(ChatGate.STORAGE, ChatListModel.gate(ready.copy(storage = false)))
        assertEquals(ChatGate.SIGNED_OUT, ChatListModel.gate(ready.copy(signedIn = false)))
        assertEquals(ChatGate.LOADING, ChatListModel.gate(ready.copy(workspaces = emptyList(), connection = Connection.CONNECTING)))
        assertEquals(ChatGate.NO_WORKSPACE, ChatListModel.gate(ready.copy(workspaces = emptyList())))

        val ws = ready.workspaces.single()
        assertEquals(ChatStatus.SIGNED_OUT, ChatListModel.status(ready.copy(signedIn = false), ws))
        assertEquals(ChatStatus.CATCHING_UP, ChatListModel.status(ready, ws.copy(status = WorkspaceStatus.LOADING)))
        assertEquals(ChatStatus.CONNECTED, ChatListModel.status(ready.copy(connection = Connection.ONLINE), ws))
        assertEquals(ChatStatus.CONNECTING, ChatListModel.status(ready.copy(connection = Connection.CONNECTING), ws))
        assertEquals(ChatStatus.OFFLINE, ChatListModel.status(ready.copy(connection = Connection.OFFLINE), ws))
        assertEquals(ChatStatus.IDLE, ChatListModel.status(ready, ws))
    }

    // ---- helpers ----

    private fun u(name: String) = "u_" + name.padEnd(22, 'x')

    private fun channel(id: String, name: String, unread: Int = 0, mentions: Int = 0, muted: Boolean = false, archived: Boolean = false) =
        room(id, RoomKind.CHANNEL, name, "workspace", null, unread = unread, mentions = mentions, muted = muted, archived = archived)

    private fun dm(
        id: String,
        with: List<String>,
        lastAt: Long? = null,
        unread: Int = 0,
        muted: Boolean = false,
        closedReason: String? = null,
        preview: Event? = null,
    ) = room(id, RoomKind.DM, null, "dm", listOf(me.id) + with.map(::u), lastAt, unread, 0, muted, closedReason != null, closedReason, preview)

    private fun room(
        id: String,
        kind: RoomKind,
        name: String?,
        visibility: String,
        participants: List<String>?,
        lastAt: Long? = null,
        unread: Int = 0,
        mentions: Int = 0,
        muted: Boolean = false,
        archived: Boolean = false,
        closedReason: String? = null,
        preview: Event? = null,
    ) = Room(
        id = id, kind = kind, name = name, visibility = visibility, archived = archived, closedReason = closedReason,
        participants = participants, startedBy = null, role = "member", members = 3, head = 10, floor = 1, lastAt = lastAt,
        read = 0, unread = unread, mentions = mentions, attention = 0, muted = muted, hasCache = true, preview = preview,
    )

    private fun event(actor: String, text: String?, redacted: Boolean = false) =
        Event(seq = 9, id = "e_1", kind = "message.posted", actor = actor, at = 1000, root = null, text = text, mentions = emptyList(), redacted = redacted)
}
