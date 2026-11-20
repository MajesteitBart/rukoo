package nl.bvdm.rukoo.ui.chat

import nl.bvdm.rukoo.workspaces.Block
import nl.bvdm.rukoo.workspaces.Channel
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind
import nl.bvdm.rukoo.workspaces.RoomMember
import nl.bvdm.rukoo.workspaces.WorkspaceSummary
import nl.bvdm.rukoo.workspaces.WorkspaceView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The rules behind Chat's sheets (contract §3.3, §3.12, §3.16, §5.10, desktop-ui 6). */
class ChatSheetRulesTest {
    private val byName: Comparator<String> = String.CASE_INSENSITIVE_ORDER

    private fun id(prefix: String, s: String) = "${prefix}_" + s.padEnd(22, 'x')

    private val me = id("u", "me")
    private val ann = id("u", "ann")
    private val bo = id("u", "bo")
    private val cy = id("u", "cy")
    private val guestId = id("u", "guest")
    private val gone = id("u", "gone")

    private fun member(id: String, name: String, role: String = "member", state: String = "active") = Member(id, "human", name, role, state)

    private val people = listOf(
        member(me, "Me", role = "owner"),
        member(bo, "Bo"),
        member(ann, "Ann", role = "admin"),
        member(cy, "Cy"),
        member(guestId, "Gus", role = "guest"),
        member(gone, "Gone", state = "former"),
    )

    private fun channel(id: String, name: String, role: String? = "member", archived: Boolean = false, visibility: String = "workspace", members: Int = 3, muted: Boolean = false) = Room(
        id = id, kind = RoomKind.CHANNEL, name = name, visibility = visibility, archived = archived, closedReason = null,
        participants = null, startedBy = null, role = role, members = members, head = 5, floor = 1, lastAt = null, read = 5,
        unread = 0, mentions = 0, attention = 0, muted = muted, hasCache = true,
    )

    private fun dm(id: String, vararg others: String, closed: String? = null) = Room(
        id = id, kind = RoomKind.DM, name = null, visibility = "dm", archived = closed != null, closedReason = closed,
        participants = listOf(me, *others), startedBy = me, role = "member", members = others.size + 1, head = 3, floor = 1,
        lastAt = 1L, read = 3, unread = 0, mentions = 0, attention = 0, muted = false, hasCache = true,
    )

    private fun view(role: String = "owner", members: List<Member> = people, more: Boolean = false, rooms: List<Room> = emptyList(), channels: List<Channel> = emptyList()) =
        WorkspaceView(
            ws = WorkspaceSummary(id("w", "acme"), "Acme", role),
            me = members.firstOrNull { it.id == me }?.copy(role = role) ?: member(me, "Me", role),
            rooms = rooms,
            members = members,
            membersMore = more,
            channels = channels,
            blocks = emptyList<Block>(),
        )

    @Test
    fun `names are 1 to 80 characters on one line, counted in code points after trimming`() {
        assertTrue(SheetRules.nameOk("Plans"))
        assertTrue(SheetRules.nameOk("  Plans  "))
        assertTrue(SheetRules.nameOk("😀".repeat(80)))
        assertFalse(SheetRules.nameOk("😀".repeat(81)))
        assertFalse(SheetRules.nameOk("   "))
        assertFalse(SheetRules.nameOk("two\nlines"))
        assertFalse(SheetRules.nameOk("a".repeat(81)))
    }

    @Test
    fun `the name field starts as the address before the at`() {
        assertEquals("sanne", SheetRules.defaultName("sanne@example.com"))
        assertEquals("", SheetRules.defaultName(null))
    }

    @Test
    fun `search ignores case and accents`() {
        assertTrue(SheetRules.matches("Zoë de Vries", "zoe"))
        assertTrue(SheetRules.matches("Zoë de Vries", "VRIES"))
        assertTrue(SheetRules.matches("anything", " "))
        assertFalse(SheetRules.matches("Mila", "zoe"))
    }

    @Test
    fun `a new workspace opens its first channel by name, skipping archived ones and DMs`() {
        val rooms = listOf(channel("c2", "random"), channel("c1", "General"), channel("c0", "aaa", archived = true), dm("d1", ann))
        assertEquals("c1", SheetRules.firstChannel(rooms, byName)?.id)
        assertNull(SheetRules.firstChannel(listOf(dm("d1", ann)), byName))
    }

    @Test
    fun `the open DM of exactly that set is found, whoever started it, and a closed one isn't`() {
        val rooms = listOf(dm("one", ann), dm("group", ann, bo), dm("closed", cy, closed = "left"))
        assertEquals("one", SheetRules.openDmFor(rooms, me, listOf(ann))?.id)
        assertEquals("group", SheetRules.openDmFor(rooms, me, listOf(bo, ann))?.id)
        assertNull(SheetRules.openDmFor(rooms, me, listOf(ann, bo, cy)))
        assertNull(SheetRules.openDmFor(rooms, me, listOf(cy)))
        assertNull(SheetRules.openDmFor(rooms, me, emptyList()))
    }

    @Test
    fun `a DM can be started with active full members other than yourself and the people you blocked`() {
        val list = SheetRules.dmCandidates(people, me, setOf(cy), byName)
        assertEquals(listOf("Ann", "Bo"), list.map { it.name })
    }

    @Test
    fun `an invitation adds to open channels you manage, and a guest needs one`() {
        val rooms = listOf(channel("c1", "plans", role = "manager"), channel("c2", "ads", role = "manager"), channel("c3", "old", role = "manager", archived = true), channel("c4", "other"))
        assertEquals(listOf("ads", "plans"), SheetRules.managedChannels(rooms, byName).map { it.name })
        assertTrue(SheetRules.inviteReady("member", 0))
        assertFalse(SheetRules.inviteReady("guest", 0))
        assertTrue(SheetRules.inviteReady("guest", 1))
        assertFalse(SheetRules.inviteReady("member", 21))
        assertEquals(listOf(1, 3, 7), SheetRules.INVITE_DAYS)
        assertTrue(SheetRules.canInvite("owner"))
        assertTrue(SheetRules.canInvite("admin"))
        assertFalse(SheetRules.canInvite("member"))
    }

    @Test
    fun `only an owner who is the only active member can delete the workspace`() {
        val solo = listOf(member(me, "Me", role = "owner"), member(gone, "Gone", state = "former"))
        assertTrue(SheetRules.canDelete(view(members = solo)))
        assertFalse(SheetRules.canDelete(view(role = "admin", members = solo)))
        assertFalse(SheetRules.canDelete(view()))
        // A directory that isn't complete can't vouch that nobody else is in it.
        assertFalse(SheetRules.canDelete(view(members = solo, more = true)))
    }

    @Test
    fun `leaving says what it means there`() {
        assertEquals(LeaveBody.LAST, SheetRules.leaveBody(channel("c1", "solo", members = 1)))
        assertEquals(LeaveBody.PRIVATE, SheetRules.leaveBody(channel("c1", "secret", visibility = "private")))
        assertEquals(LeaveBody.PUBLIC, SheetRules.leaveBody(channel("c1", "plans")))
    }

    @Test
    fun `a successor is an active full member of the channel other than yourself`() {
        val byId = people.associateBy { it.id }
        val ids = listOf(me, cy, guestId, gone, ann, ann)
        assertEquals(listOf("Ann", "Cy"), SheetRules.successors(ids, byId, me, byName).map { it.name })
    }

    @Test
    fun `the only owner is an owner with no other active owner in a complete directory`() {
        assertTrue(SheetRules.onlyOwner(view()))
        assertFalse(SheetRules.onlyOwner(view(role = "admin")))
        assertFalse(SheetRules.onlyOwner(view(members = people.map { if (it.id == ann) it.copy(role = "owner") else it })))
        // A former owner doesn't count, and a directory that isn't complete can't vouch for it.
        assertTrue(SheetRules.onlyOwner(view(members = people + member(id("u", "old"), "Old", role = "owner", state = "former"))))
        assertFalse(SheetRules.onlyOwner(view(more = true)))
    }

    @Test
    fun `a successor may be needed in open channels you manage with others in them, and only when you are their only manager`() {
        val rooms = listOf(
            channel("c1", "plans", role = "manager"),
            channel("c2", "solo", role = "manager", members = 1),
            channel("c3", "old", role = "manager", archived = true),
            channel("c4", "ads"),
            dm("d1", ann),
        )
        assertEquals(listOf("c1"), SheetRules.sharedManaged(rooms).map { it.id })
        assertTrue(SheetRules.soleManager(listOf(RoomMember(me, "manager"), RoomMember(bo, "member")), me))
        assertFalse(SheetRules.soleManager(listOf(RoomMember(me, "manager"), RoomMember(bo, "manager")), me))
        assertFalse(SheetRules.soleManager(listOf(RoomMember(me, "manager")), me))
    }

    @Test
    fun `the hand-over leaves once every channel has a successor picked from its own people`() {
        val a = HandOverChannel("c1", "plans", false, listOf(member(bo, "Bo")))
        val b = HandOverChannel("c2", "ads", false, listOf(member(cy, "Cy")))
        assertFalse(SheetRules.handOverReady(listOf(a, b), emptyMap()))
        assertFalse(SheetRules.handOverReady(listOf(a, b), mapOf("c1" to bo)))
        assertFalse(SheetRules.handOverReady(listOf(a, b), mapOf("c1" to bo, "c2" to bo)))
        assertTrue(SheetRules.handOverReady(listOf(a, b), mapOf("c1" to bo, "c2" to cy)))
        assertFalse(SheetRules.handOverReady(listOf(a.copy(people = null)), mapOf("c1" to bo)))
        assertFalse(SheetRules.handOverReady(emptyList(), emptyMap()))
    }

    @Test
    fun `a successor list gets a search field above six people`() {
        assertFalse(SheetRules.successorSearch(6))
        assertTrue(SheetRules.successorSearch(7))
    }

    @Test
    fun `the channels to hand over get their names from the rooms or the directory`() {
        val v = view(rooms = listOf(channel("c1", "plans", visibility = "private")), channels = listOf(Channel("c2", "ads", "workspace")))
        assertEquals(
            listOf(HandOverChannel("c1", "plans", true), HandOverChannel("c2", "ads", false)),
            SheetRules.handOver(listOf("c1", "c2", "c-unknown", "c1"), v),
        )
    }

    @Test
    fun `people can be added who aren't in the channel, and only owners and admins add guests`() {
        val list = SheetRules.addCandidates(people, setOf(me, bo), byName)
        assertEquals(listOf("Ann", "Cy", "Gus"), list.map { it.name })
        val gus = people.first { it.id == guestId }
        assertTrue(SheetRules.guestLocked(gus, "member"))
        assertFalse(SheetRules.guestLocked(gus, "admin"))
        assertFalse(SheetRules.guestLocked(people.first { it.id == cy }, "member"))
    }

    @Test
    fun `browse lists the open channels by name and the archived ones you were in`() {
        val channels = listOf(
            Channel("c1", "random", "workspace", members = 4),
            Channel("c2", "General", "workspace", joined = true),
            Channel("c3", "old", "workspace", archived = true, joined = true),
            Channel("c4", "older", "workspace", archived = true),
            Channel("c5", "oldest", "workspace", archived = true),
        )
        val (open, archived) = SheetRules.browse(channels, roomIds = setOf("c5"), query = "", compare = byName)
        assertEquals(listOf("General", "random"), open.map { it.name })
        assertEquals(listOf("old", "oldest"), archived.map { it.name })
        assertEquals(listOf("random"), SheetRules.browse(channels, emptySet(), "RAND", byName).first.map { it.name })
    }

    @Test
    fun `a channel's details offer what your role allows`() {
        val member = SheetRules.detailActions(channel("c1", "plans"), "member", me, emptySet())
        assertEquals(listOf(DetailAction.MUTE, DetailAction.MARK_READ, DetailAction.MEMBERS, DetailAction.LEAVE_CHANNEL), member)
        val manager = SheetRules.detailActions(channel("c1", "plans", role = "manager", muted = true), "member", me, emptySet())
        assertEquals(
            listOf(DetailAction.UNMUTE, DetailAction.MARK_READ, DetailAction.MEMBERS, DetailAction.ADD_PEOPLE, DetailAction.RENAME, DetailAction.ARCHIVE, DetailAction.LEAVE_CHANNEL),
            manager,
        )
        // A workspace admin archives a channel they don't manage, but doesn't rename it.
        val admin = SheetRules.detailActions(channel("c1", "plans"), "admin", me, emptySet())
        assertTrue(DetailAction.ARCHIVE in admin)
        assertFalse(DetailAction.RENAME in admin)
        // An archived channel can't be added to, renamed or archived again.
        val archived = SheetRules.detailActions(channel("c1", "plans", role = "manager", archived = true), "owner", me, emptySet())
        assertEquals(listOf(DetailAction.MUTE, DetailAction.MARK_READ, DetailAction.MEMBERS, DetailAction.LEAVE_CHANNEL), archived)
    }

    @Test
    fun `a DM's details offer leaving, and Block or Unblock only one to one for full members`() {
        assertEquals(
            listOf(DetailAction.MUTE, DetailAction.MARK_READ, DetailAction.LEAVE_DM, DetailAction.BLOCK),
            SheetRules.detailActions(dm("d1", ann), "member", me, emptySet()),
        )
        assertEquals(DetailAction.UNBLOCK, SheetRules.detailActions(dm("d1", ann), "member", me, setOf(ann)).last())
        assertEquals(
            listOf(DetailAction.MUTE, DetailAction.MARK_READ, DetailAction.LEAVE_DM),
            SheetRules.detailActions(dm("d2", ann, bo), "member", me, emptySet()),
        )
        assertEquals(
            listOf(DetailAction.MUTE, DetailAction.MARK_READ, DetailAction.REMOVE_FROM_LIST, DetailAction.BLOCK),
            SheetRules.detailActions(dm("d3", ann, closed = "closed"), "member", me, emptySet()),
        )
        // A guest who had DMs before becoming one sees them closed, and blocks nobody from there.
        assertEquals(
            listOf(DetailAction.MUTE, DetailAction.MARK_READ, DetailAction.REMOVE_FROM_LIST),
            SheetRules.detailActions(dm("d4", ann, closed = "ineligible"), "guest", me, emptySet()),
        )
    }

    @Test
    fun `the member menu follows desktop-ui 6_15`() {
        val annM = people.first { it.id == ann }
        val boM = people.first { it.id == bo }
        val gus = people.first { it.id == guestId }
        // An owner: everything, every role.
        assertEquals(
            listOf(MemberAction.MESSAGE, MemberAction.ROLE_OWNER, MemberAction.ROLE_ADMIN, MemberAction.ROLE_MEMBER, MemberAction.ROLE_GUEST, MemberAction.BLOCK, MemberAction.REMOVE),
            SheetRules.memberActions("owner", me, annM, emptySet()),
        )
        // An admin changes and removes members and guests, not other admins.
        assertEquals(
            listOf(MemberAction.MESSAGE, MemberAction.ROLE_MEMBER, MemberAction.ROLE_GUEST, MemberAction.BLOCK, MemberAction.REMOVE),
            SheetRules.memberActions("admin", me, boM, emptySet()),
        )
        assertEquals(listOf(MemberAction.MESSAGE, MemberAction.BLOCK), SheetRules.memberActions("admin", me, annM, emptySet()))
        // A member messages and blocks; nobody messages a guest or someone they blocked.
        assertEquals(listOf(MemberAction.BLOCK), SheetRules.memberActions("member", me, gus, emptySet()))
        assertEquals(listOf(MemberAction.UNBLOCK), SheetRules.memberActions("member", me, boM, setOf(bo)))
        // A guest gets no DM or block items.
        assertEquals(emptyList<MemberAction>(), SheetRules.memberActions("guest", me, boM, emptySet()))
        // Nothing for yourself or a former member.
        assertEquals(emptyList<MemberAction>(), SheetRules.memberActions("owner", me, people.first { it.id == me }, emptySet()))
        assertEquals(emptyList<MemberAction>(), SheetRules.memberActions("owner", me, people.first { it.id == gone }, emptySet()))
        assertEquals("guest", SheetRules.roleOf(MemberAction.ROLE_GUEST))
        assertNull(SheetRules.roleOf(MemberAction.BLOCK))
    }

    @Test
    fun `Owner and Guest ask first, Admin and Member apply at once`() {
        assertTrue(SheetRules.roleAsks("owner"))
        assertTrue(SheetRules.roleAsks("guest"))
        assertFalse(SheetRules.roleAsks("admin"))
        assertFalse(SheetRules.roleAsks("member"))
    }

    @Test
    fun `a channel's managers change roles and remove others, in an open channel`() {
        val managed = channel("c1", "plans", role = "manager")
        assertEquals(
            listOf(ChannelMemberAction.MAKE_MANAGER, ChannelMemberAction.REMOVE),
            SheetRules.channelMemberActions(managed, me, RoomMember(bo, "member")),
        )
        assertEquals(
            listOf(ChannelMemberAction.MAKE_MEMBER, ChannelMemberAction.REMOVE),
            SheetRules.channelMemberActions(managed, me, RoomMember(ann, "manager")),
        )
        assertEquals(emptyList<ChannelMemberAction>(), SheetRules.channelMemberActions(managed, me, RoomMember(me, "manager")))
        assertEquals(emptyList<ChannelMemberAction>(), SheetRules.channelMemberActions(channel("c1", "plans"), me, RoomMember(bo, "member")))
        assertEquals(emptyList<ChannelMemberAction>(), SheetRules.channelMemberActions(channel("c1", "plans", role = "manager", archived = true), me, RoomMember(bo, "member")))
    }
}
