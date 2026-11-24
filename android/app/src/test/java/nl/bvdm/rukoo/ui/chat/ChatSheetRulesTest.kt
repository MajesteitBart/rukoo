package nl.bvdm.rukoo.ui.chat

import nl.bvdm.rukoo.ui.root.ChatSheet
import nl.bvdm.rukoo.workspaces.AgentSettings
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
    fun `New message shows who you blocked with Unblock and the guests with why, and says why it is empty`() {
        fun names(p: DmPicker) = listOf(p.pick, p.blocked, p.guests).map { list -> list.map { it.name } }

        // Active full members; the guest waits for a search, and nobody who left shows.
        val all = SheetRules.dmPicker(people, me, emptySet(), "", byName)
        assertEquals(listOf(listOf("Ann", "Bo", "Cy"), emptyList(), emptyList()), names(all))
        assertNull(all.empty)
        // Someone you blocked moves to the off rows.
        assertEquals(listOf(listOf("Ann", "Bo"), listOf("Cy"), emptyList()), names(SheetRules.dmPicker(people, me, setOf(cy), "", byName)))
        // A search shows the guest too, switched off; the blocked person only when they fit it.
        assertEquals(listOf(emptyList(), emptyList(), listOf("Gus")), names(SheetRules.dmPicker(people, me, setOf(cy), "gu", byName)))
        assertEquals(listOf(emptyList(), listOf("Cy"), emptyList()), names(SheetRules.dmPicker(people, me, setOf(cy), "cy", byName)))
        // A search that finds nobody, the person who left included.
        val none = SheetRules.dmPicker(people, me, emptySet(), "gone", byName)
        assertEquals(PickerEmpty.NONE, none.empty)
        // The rank the sheet passes decides the order of the picks while searching.
        val ranked = SheetRules.dmPicker(people, me, emptySet(), "x", byName) { _, list -> list.reversed() }
        assertEquals(listOf("Cy", "Bo", "Ann"), ranked.pick.map { it.name })

        // Only a guest besides you: it shows, switched off.
        val withGuest = listOf(member(me, "Me"), member(guestId, "Gus", role = "guest"))
        assertEquals(listOf("Gus"), SheetRules.dmPicker(withGuest, me, emptySet(), "", byName).guests.map { it.name })
        // Nobody else: Nobody else is in the workspace, unless the directory isn't complete.
        val alone = listOf(member(me, "Me"), member(gone, "Gone", state = "former"))
        assertEquals(PickerEmpty.NOBODY, SheetRules.dmPicker(alone, me, emptySet(), "", byName).empty)
        assertEquals(PickerEmpty.NONE, SheetRules.dmPicker(alone, me, emptySet(), "", byName, membersMore = true).empty)
    }

    @Test
    fun `Add people says whether nobody else is in the workspace or everyone is in the channel already`() {
        assertNull(SheetRules.addPeopleEmpty(rows = 2, candidates = 2, others = 4, query = ""))
        assertEquals(PickerEmpty.NONE, SheetRules.addPeopleEmpty(rows = 0, candidates = 2, others = 4, query = "zz"))
        assertEquals(PickerEmpty.EVERYONE, SheetRules.addPeopleEmpty(rows = 0, candidates = 0, others = 4, query = ""))
        assertEquals(PickerEmpty.EVERYONE, SheetRules.addPeopleEmpty(rows = 0, candidates = 0, others = 4, query = "zz"))
        assertEquals(PickerEmpty.NOBODY, SheetRules.addPeopleEmpty(rows = 0, candidates = 0, others = 0, query = ""))
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
    fun `the drawer offers the workspace's actions by role, and only Members while the server asks for an update`() {
        val all = listOf(WorkspaceAction.RENAME_ME, WorkspaceAction.MEMBERS, WorkspaceAction.INVITE, WorkspaceAction.BLOCKED, WorkspaceAction.LEAVE, WorkspaceAction.DELETE)
        assertEquals(all, SheetRules.workspaceActions(view()))
        assertEquals(
            listOf(WorkspaceAction.RENAME_ME, WorkspaceAction.MEMBERS, WorkspaceAction.BLOCKED, WorkspaceAction.LEAVE),
            SheetRules.workspaceActions(view(role = "member")),
        )
        assertEquals(listOf(WorkspaceAction.RENAME_ME, WorkspaceAction.MEMBERS, WorkspaceAction.LEAVE), SheetRules.workspaceActions(view(role = "guest")))
        for (role in listOf("owner", "admin", "member", "guest")) {
            assertEquals("a parked workspace is read-only for $role", listOf(WorkspaceAction.MEMBERS), SheetRules.workspaceActions(view(role = role), writable = false))
        }
    }

    @Test
    fun `while the server asks for an update only the sheets without writes in the workspace stay open`() {
        val stay = ChatSheet.entries.filter { SheetRules.opensWhileReadOnly(it) }.toSet()
        assertEquals(setOf(ChatSheet.JOIN, ChatSheet.CREATE_WORKSPACE, ChatSheet.DETAILS, ChatSheet.MEMBERS), stay)
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
    fun `a search keeps the picked person in the successor list`() {
        val list = listOf(member(ann, "Ann"), member(bo, "Bo"), member(cy, "Cy"))
        assertEquals(listOf("Bo"), SheetRules.pickerShown(list, "bo", null) { it.name }.map { it.name })
        assertEquals(listOf("Ann", "Bo"), SheetRules.pickerShown(list, "bo", ann) { it.name }.map { it.name })
        assertEquals(listOf("Ann", "Bo", "Cy"), SheetRules.pickerShown(list, "", ann) { it.name }.map { it.name })
    }

    @Test
    fun `the Leave row says to make someone else owner only when there is someone to make owner`() {
        assertTrue(SheetRules.ownerFirstHint(view()))
        val solo = listOf(member(me, "Me", role = "owner"), member(gone, "Gone", state = "former"))
        assertFalse(SheetRules.ownerFirstHint(view(members = solo)))
        assertFalse(SheetRules.ownerFirstHint(view(members = people.map { if (it.id == ann) it.copy(role = "owner") else it })))
        assertFalse(SheetRules.ownerFirstHint(view(role = "member")))
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
    fun `while the server asks for an update, details and member menus offer only what stays on the phone`() {
        val manager = channel("c1", "plans", role = "manager")
        assertEquals(
            listOf(DetailAction.MUTE, DetailAction.MARK_READ, DetailAction.MEMBERS),
            SheetRules.detailActions(manager, "owner", me, emptySet(), writable = false),
        )
        assertEquals(listOf(DetailAction.MUTE, DetailAction.MARK_READ), SheetRules.detailActions(dm("d1", ann), "member", me, emptySet(), writable = false))
        assertEquals(listOf(DetailAction.MUTE, DetailAction.MARK_READ), SheetRules.detailActions(dm("d3", ann, closed = "closed"), "member", me, setOf(ann), writable = false))
        // Message only opens the DM; roles, Block and Remove are writes.
        assertEquals(listOf(MemberAction.MESSAGE), SheetRules.memberActions("owner", me, people.first { it.id == ann }, emptySet(), writable = false))
        assertEquals(emptyList<ChannelMemberAction>(), SheetRules.channelMemberActions(manager, me, RoomMember(bo, "member"), writable = false))
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
    @Test
    fun aNewLinkSaysWhatItGrantsAndAnOpenOneNamesItsChannels() {
        val and = { list: String, last: String -> "$list and $last" }
        val more = { list: String, n: Int -> "$list and $n more" }
        // Up to three names, then how many more (desktop chat-model.js inviteChannelList).
        assertEquals("", SheetRules.inviteChannelList(emptyList(), and, more))
        assertEquals("#general", SheetRules.inviteChannelList(listOf("general"), and, more))
        assertEquals("#design and #general", SheetRules.inviteChannelList(listOf("design", "general"), and, more))
        assertEquals("#a, #b and #c", SheetRules.inviteChannelList(listOf("a", "b", "c"), and, more))
        assertEquals("#a, #b, #c and 2 more", SheetRules.inviteChannelList(listOf("a", "b", "c", "d", "e"), and, more))
        // A guest only in the channels, a member with them, a member with none picked.
        val guest = { c: String -> "guest only in $c" }
        val memberIn = { c: String -> "member with $c" }
        val member = { "member" }
        assertEquals("guest only in #design", SheetRules.inviteGrant("guest", "#design", guest, memberIn, member))
        assertEquals("member with #general", SheetRules.inviteGrant("member", "#general", guest, memberIn, member))
        assertEquals("member", SheetRules.inviteGrant("member", "", guest, memberIn, member))
        // A row: two names, then +n; private channels the person can't name count in the +n; no name gives null.
        val plus = { shown: String, n: Int -> "$shown +$n" }
        assertEquals("#general", SheetRules.inviteRowChannels(listOf("general"), 1, plus))
        assertEquals("#design, #general", SheetRules.inviteRowChannels(listOf("design", "general"), 2, plus))
        assertEquals("#a, #b +2", SheetRules.inviteRowChannels(listOf("a", "b", "c", "d"), 4, plus))
        assertEquals("#design +2", SheetRules.inviteRowChannels(listOf("design"), 3, plus))
        assertEquals("#design +1", SheetRules.inviteRowChannels(listOf("", "design"), 2, plus))
        assertNull(SheetRules.inviteRowChannels(emptyList(), 2, plus))
    }

    @Test
    fun closingAsksOnlyWhileANewLinkWasNeitherKeptNorWithdrawn() {
        assertFalse(SheetRules.inviteCloseAsks(made = false, kept = false, withdrawn = false))
        assertTrue(SheetRules.inviteCloseAsks(made = true, kept = false, withdrawn = false))
        assertFalse(SheetRules.inviteCloseAsks(made = true, kept = true, withdrawn = false))
        assertFalse(SheetRules.inviteCloseAsks(made = true, kept = false, withdrawn = true))
    }

    @Test
    fun theSheetStaysWhileItsLinkIsBeingMade() {
        // Dismissing while the request runs would leave an open invitation whose one-time link nobody saw.
        assertTrue(SheetRules.inviteCloseHeld(making = true, made = false, kept = false, withdrawn = false))
        assertFalse(SheetRules.inviteCloseHeld(making = false, made = false, kept = false, withdrawn = false))
        // Once made, the question about an unshared link holds it, as before.
        assertTrue(SheetRules.inviteCloseHeld(making = false, made = true, kept = false, withdrawn = false))
        assertFalse(SheetRules.inviteCloseHeld(making = false, made = true, kept = true, withdrawn = false))
    }

    // ---- agents in channels ----

    private val clark = id("u", "clark")
    private val revy = id("u", "revy")

    private fun agent(id: String, name: String, sponsor: String, answers: String = AgentRules.EVERYONE, chosen: List<String> = emptyList(), state: String = "active") =
        Member(id, Member.KIND_AGENT, name, "member", state, agent = AgentSettings(sponsor, answers, chosen))

    private val withAgents = people + agent(clark, "Clark", sponsor = me, answers = AgentRules.SPONSOR) + agent(revy, "Revy", sponsor = bo)

    @Test
    fun `agents are never in a DM, never successors, and don't make a workspace less empty`() {
        assertEquals(listOf("Ann", "Bo"), SheetRules.dmCandidates(withAgents, me, setOf(cy), byName).map { it.name })
        val picker = SheetRules.dmPicker(withAgents, me, emptySet(), "", byName)
        assertTrue((picker.pick + picker.blocked + picker.guests).none { it.isAgent })
        assertTrue(SheetRules.dmPicker(withAgents, me, emptySet(), "cl", byName).let { it.pick.isEmpty() && it.guests.isEmpty() && it.empty == PickerEmpty.NONE })
        val byId = withAgents.associateBy { it.id }
        assertEquals(listOf("Ann", "Bo"), SheetRules.successors(listOf(ann, bo, clark, revy), byId, me, byName).map { it.name })
        // Alone with only your agents, you can still delete the workspace.
        val mine = listOf(member(me, "Me", role = "owner"), agent(clark, "Clark", sponsor = me))
        assertTrue(SheetRules.alone(view(members = mine)))
        assertTrue(SheetRules.canDelete(view(members = mine)))
    }

    @Test
    fun `a channel's last manager with only agents beside them has nobody to hand it to`() {
        val agents = setOf(clark, revy)
        val withClark = listOf(RoomMember(me, "manager"), RoomMember(clark, "member"))
        assertTrue("without the agents' IDs it looks shared", SheetRules.soleManager(withClark, me))
        assertFalse(SheetRules.soleManager(withClark, me, agents))
        assertTrue(SheetRules.soleManager(withClark + RoomMember(bo, "member"), me, agents))
        assertEquals(setOf(clark, revy), agentIds(withAgents.associateBy { it.id }))
    }

    @Test
    fun `Add people lists people without agents, and the agents someone may add apart`() {
        assertEquals(listOf("Ann", "Bo", "Cy", "Gus"), SheetRules.addCandidates(withAgents, setOf(me), byName).map { it.name })
        val removed = agent(id("u", "old"), "Old", sponsor = me, state = "former")
        val all = withAgents + removed
        // A manager may add any agent that isn't in yet.
        assertEquals(listOf("Clark", "Revy"), AgentRules.addable(all, setOf(me), channel("c1", "plans", role = "manager"), me, byName, on = true).map { it.name })
        assertEquals(listOf("Revy"), AgentRules.addable(all, setOf(me, bo, clark), channel("c1", "plans", role = "manager", visibility = "private"), me, byName, on = true).map { it.name })
        // Anyone else only their own agents, in a channel the workspace sees.
        assertEquals(listOf("Clark"), AgentRules.addable(all, setOf(me), channel("c1", "plans"), me, byName, on = true).map { it.name })
        assertEquals(emptyList<Member>(), AgentRules.addable(all, setOf(me), channel("c1", "plans", visibility = "private"), me, byName, on = true))
        assertEquals(emptyList<Member>(), AgentRules.addable(all, setOf(me), channel("c1", "plans", role = "manager", archived = true), me, byName, on = true))
        assertEquals(emptyList<Member>(), AgentRules.addable(all, emptySet(), dm("d1", ann), me, byName, on = true))
    }

    @Test
    fun `a private channel is offered only the agents whose sponsor is in it, as the server refuses the others`() {
        val private = channel("c1", "plans", role = "manager", visibility = "private")
        // Bo isn't in the channel: his Revy would get 409 sponsor_not_in_channel, so the manager isn't offered it.
        assertEquals(listOf("Clark"), AgentRules.addable(withAgents, setOf(me, ann), private, me, byName, on = true).map { it.name })
        assertEquals(listOf("Clark", "Revy"), AgentRules.addable(withAgents, setOf(me, bo), private, me, byName, on = true).map { it.name })
        // Settings this phone can't read don't name a sponsor, so such an agent isn't offered for a private channel.
        val unread = Member(id("u", "odd"), Member.KIND_AGENT, "Odd", "member", "active")
        assertEquals(emptyList<Member>(), AgentRules.addable(people + unread, setOf(me), private, me, byName, on = true))
        assertEquals(listOf("Odd"), AgentRules.addable(people + unread, setOf(me), channel("c1", "plans", role = "manager"), me, byName, on = true).map { it.name })
    }

    @Test
    fun `nothing offers to add an agent while the server has agents off`() {
        val manages = channel("c1", "plans", role = "manager")
        assertEquals(emptyList<Member>(), AgentRules.addable(withAgents, setOf(me), manages, me, byName, on = false))
        assertTrue(AgentRules.ownAgents(withAgents, me, on = true))
        assertFalse(AgentRules.ownAgents(withAgents, me, on = false))
        assertFalse(AgentRules.ownAgents(withAgents, cy, on = true))
        val plain = channel("c1", "plans")
        assertFalse(DetailAction.ADD_AGENTS in SheetRules.detailActions(plain, "member", me, emptySet(), ownAgents = AgentRules.ownAgents(withAgents, me, on = false)))
        assertFalse(AgentRules.sponsorAdds(plain, AgentRules.ownAgents(withAgents, me, on = false)))
        // Workspace members offers nothing for an agent either; its people keep their menu.
        val revyM = withAgents.first { it.id == revy }
        assertEquals(emptyList<MemberAction>(), SheetRules.memberActions("owner", me, revyM, emptySet(), agents = false))
        assertTrue(MemberAction.REMOVE in SheetRules.memberActions("owner", me, withAgents.first { it.id == bo }, emptySet(), agents = false))
    }

    @Test
    fun `a sponsor who doesn't manage a channel the workspace sees gets Add agents in its details`() {
        assertTrue(AgentRules.sponsors(withAgents, me))
        assertFalse(AgentRules.sponsors(withAgents, cy))
        assertFalse("a removed agent doesn't count", AgentRules.sponsors(people + agent(clark, "Clark", sponsor = cy, state = "former"), cy))
        val plain = SheetRules.detailActions(channel("c1", "plans"), "member", me, emptySet(), ownAgents = true)
        assertEquals(
            listOf(DetailAction.MUTE, DetailAction.MARK_READ, DetailAction.MEMBERS, DetailAction.ADD_AGENTS, DetailAction.LEAVE_CHANNEL),
            plain,
        )
        assertFalse(DetailAction.ADD_AGENTS in SheetRules.detailActions(channel("c1", "plans", visibility = "private"), "member", me, emptySet(), ownAgents = true))
        assertFalse(DetailAction.ADD_AGENTS in SheetRules.detailActions(channel("c1", "plans"), "member", me, emptySet(), ownAgents = false))
        assertFalse(DetailAction.ADD_AGENTS in SheetRules.detailActions(channel("c1", "plans"), "member", me, emptySet(), writable = false, ownAgents = true))
        // A manager has Add people, which lists the agents too.
        val manager = SheetRules.detailActions(channel("c1", "plans", role = "manager"), "member", me, emptySet(), ownAgents = true)
        assertTrue(DetailAction.ADD_PEOPLE in manager)
        assertFalse(DetailAction.ADD_AGENTS in manager)
    }

    @Test
    fun `in members lists an agent is edited and removed by its sponsor, an owner or an admin, re-keyed by its sponsor, and a channel's managers remove it`() {
        val clarkM = withAgents.first { it.id == clark }
        val revyM = withAgents.first { it.id == revy }
        // Workspace members, as on the desktop: Edit agent, New key for its sponsor only, Remove agent.
        assertEquals(
            listOf(MemberAction.EDIT_AGENT, MemberAction.AGENT_KEY, MemberAction.REMOVE),
            SheetRules.memberActions("member", me, clarkM, emptySet(), agents = true),
        )
        assertEquals(emptyList<MemberAction>(), SheetRules.memberActions("member", me, revyM, emptySet(), agents = true))
        assertEquals(listOf(MemberAction.EDIT_AGENT, MemberAction.REMOVE), SheetRules.memberActions("admin", me, revyM, emptySet(), agents = true))
        assertEquals(listOf(MemberAction.EDIT_AGENT, MemberAction.REMOVE), SheetRules.memberActions("owner", me, revyM, emptySet(), agents = true))
        assertEquals(emptyList<MemberAction>(), SheetRules.memberActions("owner", me, revyM, emptySet(), writable = false, agents = true))
        assertEquals(emptyList<MemberAction>(), SheetRules.memberActions("guest", me, revyM, emptySet(), agents = true))
        // Settings this phone can't read leave Edit out: the form would have nothing to start from.
        val unread = Member(revy, Member.KIND_AGENT, "Revy", "member", "active")
        assertEquals(listOf(MemberAction.REMOVE), SheetRules.memberActions("owner", me, unread, emptySet(), agents = true))
        // In a channel: never Make manager; Remove for its managers and the agent's sponsor.
        val manages = channel("c1", "plans", role = "manager")
        assertEquals(listOf(ChannelMemberAction.REMOVE), SheetRules.channelMemberActions(manages, me, RoomMember(revy, "member"), member = revyM))
        assertEquals(listOf(ChannelMemberAction.REMOVE), SheetRules.channelMemberActions(channel("c1", "plans"), me, RoomMember(clark, "member"), member = clarkM))
        assertEquals(emptyList<ChannelMemberAction>(), SheetRules.channelMemberActions(channel("c1", "plans"), me, RoomMember(revy, "member"), member = revyM))
        // Archived, the agent still reads the channel and the server still takes it out: Remove stays, and only Remove.
        val archived = channel("c1", "plans", archived = true)
        val archivedManaged = channel("c1", "plans", role = "manager", archived = true)
        assertEquals(listOf(ChannelMemberAction.REMOVE), SheetRules.channelMemberActions(archived, me, RoomMember(clark, "member"), member = clarkM))
        assertEquals(listOf(ChannelMemberAction.REMOVE), SheetRules.channelMemberActions(archivedManaged, me, RoomMember(revy, "member"), member = revyM))
        assertEquals(emptyList<ChannelMemberAction>(), SheetRules.channelMemberActions(archived, me, RoomMember(revy, "member"), member = revyM))
        assertEquals(emptyList<ChannelMemberAction>(), SheetRules.channelMemberActions(archived, me, RoomMember(clark, "member"), writable = false, member = clarkM))
        assertEquals(
            emptyList<ChannelMemberAction>(),
            SheetRules.channelMemberActions(archivedManaged, me, RoomMember(bo, "member"), member = withAgents.first { it.id == bo }),
        )
        // A person in the same channel still gets the manager's menu.
        assertEquals(
            listOf(ChannelMemberAction.MAKE_MANAGER, ChannelMemberAction.REMOVE),
            SheetRules.channelMemberActions(manages, me, RoomMember(bo, "member"), member = withAgents.first { it.id == bo }),
        )
    }

    @Test
    fun `the drawer has Agents for full members while the server has agents on`() {
        assertTrue(WorkspaceAction.AGENTS in SheetRules.workspaceActions(view(role = "member"), agents = true))
        assertFalse(WorkspaceAction.AGENTS in SheetRules.workspaceActions(view(role = "member"), agents = false))
        assertFalse(WorkspaceAction.AGENTS in SheetRules.workspaceActions(view(role = "guest"), agents = true))
        assertEquals(listOf(WorkspaceAction.MEMBERS), SheetRules.workspaceActions(view(), writable = false, agents = true))
        assertEquals(
            listOf(WorkspaceAction.RENAME_ME, WorkspaceAction.MEMBERS, WorkspaceAction.INVITE, WorkspaceAction.AGENTS, WorkspaceAction.BLOCKED, WorkspaceAction.LEAVE, WorkspaceAction.DELETE),
            SheetRules.workspaceActions(view(), agents = true),
        )
        assertFalse(SheetRules.opensWhileReadOnly(ChatSheet.AGENTS))
    }

    @Test
    fun `whom an agent answers, and whether it answers you`() {
        val everyone = AgentSettings(bo, AgentRules.EVERYONE)
        val sponsorOnly = AgentSettings(bo, AgentRules.SPONSOR)
        val chosen = AgentSettings(bo, AgentRules.MEMBERS, listOf(ann, cy))
        assertTrue(AgentRules.answers(everyone, me))
        assertFalse(AgentRules.answers(sponsorOnly, me))
        assertTrue("its sponsor always", AgentRules.answers(sponsorOnly, bo))
        assertTrue(AgentRules.answers(chosen, ann))
        assertFalse(AgentRules.answers(chosen, me))
        assertTrue("its sponsor is answered without being listed", AgentRules.answers(chosen, bo))
        assertTrue("settings not loaded yet claim nothing", AgentRules.answers(null, me))
        assertFalse("an unknown choice answers only its sponsor", AgentRules.answers(AgentSettings(bo, "later"), me))
        assertNull(AgentRules.answered(everyone))
        assertEquals(listOf(bo), AgentRules.answered(sponsorOnly))
        assertEquals(listOf(bo, ann, cy), AgentRules.answered(chosen))
        assertEquals(listOf(bo, ann), AgentRules.answered(AgentSettings(bo, AgentRules.MEMBERS, listOf(bo, ann))))
        // Up to three are named, past that the first two and how many more.
        assertEquals(listOf(bo) to 0, AgentRules.named(listOf(bo)))
        assertEquals(listOf(bo, ann, cy) to 0, AgentRules.named(listOf(bo, ann, cy)))
        assertEquals(listOf(bo, ann) to 3, AgentRules.named(listOf(bo, ann, cy, me, gone)))
        assertTrue(AgentRules.canManage(me, me, "member"))
        assertFalse(AgentRules.canManage(bo, me, "member"))
        assertTrue(AgentRules.canManage(bo, me, "admin"))
        assertTrue(AgentRules.canManage(bo, me, "owner"))
        assertFalse(AgentRules.canManage(bo, me, "guest"))
    }

    @Test
    fun `only its sponsor makes a new key for an agent, owners and admins included`() {
        assertTrue(AgentRules.canNewKey(me, me))
        assertFalse(AgentRules.canNewKey(bo, me))
        assertFalse(AgentRules.canNewKey(null, me))
        assertFalse(AgentRules.canNewKey(bo, null))
    }

    @Test
    fun `whom an agent answers names only people the directory lists, never Former member`() {
        val known = setOf(me, ann)
        // A guest's directory may not hold the sponsor: the line then names whom it does know.
        assertEquals(emptyList<String>(), AgentRules.answeredKnown(AgentSettings(bo, AgentRules.SPONSOR)) { it in known })
        assertEquals(listOf(ann), AgentRules.answeredKnown(AgentSettings(bo, AgentRules.MEMBERS, listOf(ann, cy))) { it in known })
        assertEquals(listOf(me, ann), AgentRules.answeredKnown(AgentSettings(me, AgentRules.MEMBERS, listOf(ann))) { it in known })
        assertNull(AgentRules.answeredKnown(AgentSettings(bo, AgentRules.EVERYONE)) { it in known })
        assertEquals("an unknown choice reads as its sponsor only", emptyList<String>(), AgentRules.answeredKnown(AgentSettings(bo, "later")) { it in known })
    }

    @Test
    fun `a sponsor the server leaves out of a guest's directory names nobody and manages nothing`() {
        val hidden = AgentSettings(null, AgentRules.MEMBERS, listOf(me))
        assertEquals(listOf(me), AgentRules.answered(hidden))
        assertEquals(emptyList<String>(), AgentRules.answered(AgentSettings(null, AgentRules.SPONSOR)))
        assertTrue(AgentRules.answers(hidden, me))
        assertFalse(AgentRules.answers(AgentSettings(null, AgentRules.SPONSOR), me))
        assertNull("no form for an agent without a sponsor", AgentRules.agentOf(Member(clark, Member.KIND_AGENT, "Clark", "member", "active", agent = hidden)))
        assertFalse(AgentRules.sponsors(listOf(Member(clark, Member.KIND_AGENT, "Clark", "member", "active", agent = hidden)), me))
    }

    @Test
    fun `Workspace members opens the Agents sheet on an agent's form or its new key`() {
        assertEquals(AgentRules.Opened(clark, key = false), AgentRules.opened(AgentRules.editTarget(clark)))
        assertEquals(AgentRules.Opened(clark, key = true), AgentRules.opened(AgentRules.keyTarget(clark)))
        assertNull(AgentRules.opened(null))
        assertNull(AgentRules.opened(clark))
        // The form starts from the directory's settings.
        assertEquals(
            nl.bvdm.rukoo.workspaces.Agent(clark, "Clark", me, AgentRules.SPONSOR),
            AgentRules.agentOf(withAgents.first { it.id == clark }),
        )
        assertNull(AgentRules.agentOf(withAgents.first { it.id == bo }))
        assertNull(AgentRules.agentOf(Member(clark, Member.KIND_AGENT, "Clark", "member", "active")))
    }

    @Test
    fun `the agent form takes a name, a known choice and chosen people for Chosen people`() {
        assertTrue(AgentRules.formReady("Clark", AgentRules.SPONSOR, emptySet()))
        assertTrue(AgentRules.formReady("Clark", AgentRules.EVERYONE, emptySet()))
        assertFalse(AgentRules.formReady(" ", AgentRules.EVERYONE, emptySet()))
        assertFalse(AgentRules.formReady("Clark", AgentRules.MEMBERS, emptySet()))
        assertTrue(AgentRules.formReady("Clark", AgentRules.MEMBERS, setOf(ann)))
        assertFalse(AgentRules.formReady("Clark", "later", emptySet()))
        assertFalse(AgentRules.formReady("Clark", AgentRules.MEMBERS, (1..51).map { "u_$it" }))
        // The people to choose: active people, guests too, never an agent, nor its sponsor.
        assertEquals(listOf("Ann", "Bo", "Cy", "Gus"), AgentRules.choosable(withAgents, me, byName).map { it.name })
        assertEquals(listOf("Ann", "Cy", "Gus", "Me"), AgentRules.choosable(withAgents, bo, byName).map { it.name })
    }

    @Test
    fun `the runner config is the desktop's, with the server, the workspace, the key and a command to replace`() {
        val key = "rka_" + "a".repeat(22) + "." + "b".repeat(43)
        val w = id("w", "acme")
        // Byte for byte what desktop's chat-agents.js runnerText writes for a config without one of the person's agents.
        val expected = """
            |{
            |  "server": "https://rukoo.io",
            |  "workspace": "$w",
            |  "key": "$key",
            |  "backend": {
            |    "type": "command",
            |    "command": "my-agent"
            |  },
            |  "context": {
            |    "threadMessages": 50,
            |    "channelMessages": 20,
            |    "maxChars": 30000
            |  },
            |  "instructions": ""
            |}
            |""".trimMargin()
        assertEquals(expected, AgentRules.runnerConfig("https://rukoo.io/", w, key))
        assertEquals("node integrations/agent-runner/runner.js --config agent.json", AgentRules.RUNNER_COMMAND)
    }
}
