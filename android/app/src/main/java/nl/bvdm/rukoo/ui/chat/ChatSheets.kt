package nl.bvdm.rukoo.ui.chat

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.text.Collator
import nl.bvdm.rukoo.BuildConfig
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.Avatar
import nl.bvdm.rukoo.ui.components.ExpandChevron
import nl.bvdm.rukoo.ui.components.LocalRkToast
import nl.bvdm.rukoo.ui.components.Monogram
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkButtonSize
import nl.bvdm.rukoo.ui.components.RkDropdownMenu
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkIconButtonSize
import nl.bvdm.rukoo.ui.components.RkLinkButton
import nl.bvdm.rukoo.ui.components.RkMenuItem
import nl.bvdm.rukoo.ui.components.RkSearchField
import nl.bvdm.rukoo.ui.components.RkTextField
import nl.bvdm.rukoo.ui.components.RkToastHost
import nl.bvdm.rukoo.ui.components.SheetDivider
import nl.bvdm.rukoo.ui.components.SheetHeading
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.components.Spinner
import nl.bvdm.rukoo.ui.components.popIn
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.mail.MailCheckbox
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.ChatSheet
import nl.bvdm.rukoo.ui.settings.ErrorLine
import nl.bvdm.rukoo.ui.settings.NoteBox
import nl.bvdm.rukoo.ui.settings.NoteTone
import nl.bvdm.rukoo.ui.settings.RkDialog
import nl.bvdm.rukoo.ui.settings.formatDate
import nl.bvdm.rukoo.ui.settings.formatTime
import nl.bvdm.rukoo.ui.settings.hostOf
import nl.bvdm.rukoo.ui.theme.ChatInk
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooDurations
import nl.bvdm.rukoo.ui.theme.lineHeight
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.rkShadow
import nl.bvdm.rukoo.ui.theme.rkSurface
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.title
import nl.bvdm.rukoo.workspaces.Channel
import nl.bvdm.rukoo.workspaces.ChatState
import nl.bvdm.rukoo.workspaces.Invite
import nl.bvdm.rukoo.workspaces.InviteLink
import nl.bvdm.rukoo.workspaces.InvitePreview
import nl.bvdm.rukoo.workspaces.MadeInvite
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind
import nl.bvdm.rukoo.workspaces.RoomMember
import nl.bvdm.rukoo.workspaces.WorkspaceError
import nl.bvdm.rukoo.workspaces.WorkspaceStatus
import nl.bvdm.rukoo.workspaces.WorkspaceView

// ---- the rules behind the sheets, pure so ChatSheetRulesTest covers them ----

/** What leaving a channel means there (desktop-ui 6.9): the last one archives it; private needs adding again. */
enum class LeaveBody { LAST, PRIVATE, PUBLIC }

/**
 * What a room's details offer (contract §7.4 DetailsSheet). ADD_AGENTS is Add people for someone who isn't a manager
 * but may bring their own agents into a channel the whole workspace sees.
 */
enum class DetailAction { MUTE, UNMUTE, MARK_READ, MEMBERS, ADD_PEOPLE, ADD_AGENTS, RENAME, ARCHIVE, LEAVE_CHANNEL, LEAVE_DM, REMOVE_FROM_LIST, BLOCK, UNBLOCK }

/**
 * What a member row's menu in the workspace's members offers (desktop-ui 6.15). EDIT_AGENT and AGENT_KEY are an
 * agent's Edit agent and New key; REMOVE is Remove agent there.
 */
enum class MemberAction { MESSAGE, ROLE_OWNER, ROLE_ADMIN, ROLE_MEMBER, ROLE_GUEST, BLOCK, UNBLOCK, REMOVE, EDIT_AGENT, AGENT_KEY }

/** What a member row's menu in a channel's members offers to its managers (desktop-ui 6.6). */
enum class ChannelMemberAction { MAKE_MANAGER, MAKE_MEMBER, REMOVE }

/** The workspace drawer's rows for the workspace on screen (contract §5.10, §7.4). */
enum class WorkspaceAction { RENAME_ME, MEMBERS, INVITE, AGENTS, BLOCKED, LEAVE, DELETE }

/** The sheets' rules (contract §3.3, §3.12, §3.16, §5.10, desktop-ui 6). */
/** Why a people list is empty: a search found nobody, nobody else is in the workspace, or everyone is in already. */
enum class PickerEmpty { NONE, NOBODY, EVERYONE }

/** New message's rows: who can be picked, who you blocked, the guests, and why the list is empty. */
data class DmPicker(val pick: List<Member>, val blocked: List<Member>, val guests: List<Member>, val empty: PickerEmpty?)

object SheetRules {
    /** §3.16: workspace, channel and display names, trimmed. */
    const val NAME_MAX = 80

    /** §3.12, §2.7: a DM has 2 to 8 people, so 1 to 7 others. */
    const val DM_OTHERS_MAX = 7

    /** §3.16: an invitation adds to at most 20 channels the person manages. */
    const val INVITE_CHANNELS_MAX = 20

    /** §3.16, §1.2: how long an invitation link works, in days; 1 by default. */
    val INVITE_DAYS = listOf(1, 3, 7)

    private val ROLES = listOf("owner", "admin", "member", "guest")

    private val LINE_BREAKS = charArrayOf('\n', '\r', '\u0085', ' ', ' ')

    /** A name the server takes as to length and lines (§3.16): 1 to 80 code points after trimming, on one line. */
    fun nameOk(name: String): Boolean {
        val t = name.trim()
        return t.codePointCount(0, t.length) in 1..NAME_MAX && t.indexOfAny(LINE_BREAKS) < 0
    }

    /** The name field's default in Make and Join (§3.3): the account address before the @. */
    fun defaultName(email: String?): String = email?.substringBefore('@')?.trim().orEmpty()

    /** Whether [name] fits what was typed in a sheet's search field: accents, case and spacing don't count. */
    fun matches(name: String, query: String): Boolean {
        val q = MentionMatch.fold(query)
        return q.isEmpty() || MentionMatch.fold(name).contains(q)
    }

    /** The first channel in sidebar order (§3.3 "Joining"): joined, not archived, by name. */
    fun firstChannel(rooms: List<Room>, compare: Comparator<String>): Room? =
        rooms.filter { it.kind == RoomKind.CHANNEL && !it.archived }.sortedWith { a, b -> compare.compare(a.name.orEmpty(), b.name.orEmpty()) }.firstOrNull()

    /** The open DM whose people are exactly [me] and [others], whoever started it (§3.12 "Open conversation"). */
    fun openDmFor(rooms: List<Room>, me: String?, others: Collection<String>): Room? {
        if (me == null || others.isEmpty()) return null
        val set = (others + me).toSet()
        return rooms.firstOrNull { it.kind == RoomKind.DM && it.closedReason == null && !it.archived && it.participants.orEmpty().toSet() == set }
    }

    /**
     * Who a DM can be started with (§3.12): active full members, without the person and the people they blocked.
     * Agents are never in a DM.
     */
    fun dmCandidates(members: List<Member>, me: String?, blocked: Set<String>, compare: Comparator<String>): List<Member> =
        members.filter { it.state == "active" && it.id != me && it.id !in blocked && !it.isAgent && ChatListModel.isFullMember(it.role) }
            .sortedWith { a, b -> compare.compare(a.name, b.name) }

    /**
     * New message's list for [query] (desktop chat-model.js dmPicker). [DmPicker.pick]: active full members who aren't
     * blocked, ranked by [rank] while searching. [DmPicker.blocked]: people [me] blocked, shown off with Unblock.
     * [DmPicker.guests]: shown off with the reason, while searching or when nobody else would show. [DmPicker.empty]:
     * NONE for a search that finds nobody, NOBODY when nobody else is in the workspace (a complete directory only).
     * Agents don't show at all: they are never in a DM.
     */
    fun dmPicker(
        members: List<Member>,
        me: String?,
        blocked: Set<String>,
        query: String,
        compare: Comparator<String>,
        membersMore: Boolean = false,
        rank: (String, List<Member>) -> List<Member> = { q, list -> list.filter { matches(it.name, q) } },
    ): DmPicker {
        val others = members.filter { it.state == "active" && it.id != me && !it.isAgent }.sortedWith { a, b -> compare.compare(a.name, b.name) }
        val searching = query.isNotBlank()
        val full = others.filter { ChatListModel.isFullMember(it.role) }
        val open = full.filter { it.id !in blocked }
        val pick = if (searching) rank(query, open) else open
        val off = full.filter { it.id in blocked && matches(it.name, query) }
        val guests = if (searching || full.isEmpty()) others.filter { !ChatListModel.isFullMember(it.role) && matches(it.name, query) } else emptyList()
        val empty = when {
            pick.isNotEmpty() || off.isNotEmpty() || guests.isNotEmpty() -> null
            searching -> PickerEmpty.NONE
            others.isEmpty() -> if (membersMore) PickerEmpty.NONE else PickerEmpty.NOBODY
            else -> null
        }
        return DmPicker(pick, off, guests, empty)
    }

    /**
     * What Add people says when its list is empty, or null while it has rows: NONE after a search, NOBODY when the
     * workspace has nobody else, EVERYONE when everyone else is in the channel already.
     */
    fun addPeopleEmpty(rows: Int, candidates: Int, others: Int, query: String): PickerEmpty? = when {
        rows > 0 -> null
        query.isNotBlank() && candidates > 0 -> PickerEmpty.NONE
        others > 0 -> PickerEmpty.EVERYONE
        else -> PickerEmpty.NOBODY
    }

    /** The channels an invitation can add someone to (desktop-ui 6.3): open channels the person manages, by name. */
    fun managedChannels(rooms: List<Room>, compare: Comparator<String>): List<Room> =
        rooms.filter { it.kind == RoomKind.CHANNEL && !it.archived && it.role == "manager" }.sortedWith { a, b -> compare.compare(a.name.orEmpty(), b.name.orEmpty()) }

    /** Whether an invitation can be made (§3.16): a guest needs a channel, and 20 at most. */
    fun inviteReady(role: String, channels: Int): Boolean = channels <= INVITE_CHANNELS_MAX && (role != "guest" || channels > 0)

    /**
     * The channels a new invitation grants, for the line under its link (desktop chat-model.js `inviteChannelList`):
     * up to three names, then how many more. [and] joins the last name on, [more] adds the count.
     */
    fun inviteChannelList(names: List<String>, and: (String, String) -> String, more: (String, Int) -> String): String {
        val tags = names.map { "#$it" }
        return when {
            tags.size <= 1 -> tags.firstOrNull().orEmpty()
            tags.size <= 3 -> and(tags.dropLast(1).joinToString(", "), tags.last())
            else -> more(tags.take(3).joinToString(", "), tags.size - 3)
        }
    }

    /**
     * The line under a new link (desktop `inviteGrant`): a guest only in [channels], a member with them, or a member
     * with none picked.
     */
    fun inviteGrant(role: String, channels: String, guest: (String) -> String, memberIn: (String) -> String, member: () -> String): String = when {
        role == "guest" -> guest(channels)
        channels.isNotEmpty() -> memberIn(channels)
        else -> member()
    }

    /**
     * An open invitation's channels (desktop `inviteRowChannels`): up to two names, then "+n" through [more]. [total]
     * also counts the private channels the person can't name. Null without a name, for the count instead.
     */
    fun inviteRowChannels(names: List<String>, total: Int, more: (String, Int) -> String): String? {
        val tags = names.filter { it.isNotEmpty() }.map { "#$it" }
        if (tags.isEmpty()) return null
        val rest = maxOf(total, tags.size) - minOf(tags.size, 2)
        val shown = tags.take(2).joinToString(", ")
        return if (rest > 0) more(shown, rest) else shown
    }

    /** Whether closing the Invite sheet asks first: a link is on screen that nobody shared, copied or withdrew. */
    fun inviteCloseAsks(made: Boolean, kept: Boolean, withdrawn: Boolean): Boolean = made && !kept && !withdrawn

    /**
     * Whether the Invite sheet stays when the person tries to close it: while its link is being made ([making]), as the
     * server may already hold an invitation whose one-time link only this sheet can show, and when [inviteCloseAsks].
     */
    fun inviteCloseHeld(making: Boolean, made: Boolean, kept: Boolean, withdrawn: Boolean): Boolean =
        making || inviteCloseAsks(made, kept, withdrawn)

    /** Whether [view]'s person is its only active member, as far as the directory knows. Agents don't count (§2.14). */
    fun alone(view: WorkspaceView): Boolean =
        !view.membersMore && view.members.count { it.state == "active" && it.id != view.me.id && !it.isAgent } == 0

    /** Whether Delete workspace works (§2.14): an owner who is its only member. */
    fun canDelete(view: WorkspaceView): Boolean = view.me.role == "owner" && alone(view)

    /** Whether the person invites (desktop-ui 6.3): owners and admins. */
    fun canInvite(role: String?): Boolean = role == "owner" || role == "admin"

    /**
     * The workspace drawer's rows for the workspace on screen (contract §5.10, §7.4), in order. While it can't take
     * writes (not [writable]: the server asks for an update, 426) only Members stays, whose sheet then offers Message
     * and no write: the list is read-only (android.md "Upgrade required"). Agents is for full members while the server
     * has [agents] on.
     */
    fun workspaceActions(view: WorkspaceView, writable: Boolean = true, agents: Boolean = false): List<WorkspaceAction> {
        if (!writable) return listOf(WorkspaceAction.MEMBERS)
        val role = view.me.role
        return buildList {
            add(WorkspaceAction.RENAME_ME)
            add(WorkspaceAction.MEMBERS)
            if (canInvite(role)) add(WorkspaceAction.INVITE)
            if (agents && ChatListModel.isFullMember(role)) add(WorkspaceAction.AGENTS)
            if (ChatListModel.isFullMember(role) || view.blocks.isNotEmpty()) add(WorkspaceAction.BLOCKED)
            add(WorkspaceAction.LEAVE)
            if (role == "owner") add(WorkspaceAction.DELETE)
        }
    }

    /**
     * Whether [sheet] stays open while the selected workspace can't take writes (426): Join and Make aren't about it,
     * and Details and Members hide their writes then. Every other sheet exists to write in it, and closes.
     */
    fun opensWhileReadOnly(sheet: ChatSheet): Boolean =
        sheet == ChatSheet.JOIN || sheet == ChatSheet.CREATE_WORKSPACE || sheet == ChatSheet.DETAILS || sheet == ChatSheet.MEMBERS

    /** Leaving [room]'s body (desktop-ui 6.9). */
    fun leaveBody(room: Room): LeaveBody = when {
        room.members <= 1 -> LeaveBody.LAST
        room.visibility == "private" -> LeaveBody.PRIVATE
        else -> LeaveBody.PUBLIC
    }

    /**
     * Whether leaving [room] may take agents [me] made with it, so the confirmation needs the channel's members to say
     * so (desktop's chat-model.js `mayTakeAgents`): the directory holds an active agent of theirs, the channel holds
     * agents, and it is private or they are its last person. This follows the server's `#endGrant`: a private channel
     * keeps someone's agents only while they are in it, archived or not, and the last person's leaving archives a
     * channel of either kind and takes every agent out.
     */
    fun mayTakeAgents(room: Room, members: Map<String, Member>, me: String?): Boolean =
        me != null && room.kind == RoomKind.CHANNEL && (room.visibility == "private" || room.members <= 1) &&
            room.agents > 0 && members.values.any { it.isAgent && it.state == "active" && it.agent?.sponsor == me }

    /**
     * The agents that leave [room] with [me]: the active agents of theirs among the channel's members ([inside]), by
     * name. Empty for a channel leaving doesn't take agents out of; null when it may and the members didn't load.
     * A channel everyone can see keeps its agents while another person is in it, and the room's own count can be older
     * than that: the members just loaded decide, and so does [others], for a caller that knows someone else is in it
     * (the server asked for a successor).
     */
    fun leavingAgents(
        room: Room,
        inside: List<RoomMember>?,
        members: Map<String, Member>,
        me: String?,
        compare: Comparator<String>,
        others: Boolean = false,
    ): List<Member>? {
        if (!mayTakeAgents(room, members, me)) return emptyList()
        val open = room.visibility != "private"
        if (open && others) return emptyList()
        if (inside == null) return null
        if (open && inside.any { it.member != me && members[it.member]?.isAgent != true }) return emptyList()
        return inside.map { it.member }.distinct().mapNotNull { members[it] }
            .filter { it.isAgent && it.state == "active" && it.agent?.sponsor == me }
            .sortedWith { a, b -> compare.compare(a.name, b.name) }
    }

    /** "Your agent Clark leaves with you." names up to this many agents; past it the line counts them. */
    const val LEAVING_AGENTS_NAMED = 3

    /** Who can take over a channel (desktop-ui 6.9): its active full members other than [me], by name. Never an agent. */
    fun successors(ids: List<String>, members: Map<String, Member>, me: String?, compare: Comparator<String>): List<Member> =
        ids.distinct().mapNotNull { members[it] }.filter { it.id != me && it.state == "active" && !it.isAgent && ChatListModel.isFullMember(it.role) }
            .sortedWith { a, b -> compare.compare(a.name, b.name) }

    /** A successor list gets a search field once it holds more people than this. */
    const val SUCCESSOR_SEARCH_FROM = 6

    /** Whether a successor list of [count] people shows a search field. */
    fun successorSearch(count: Int): Boolean = count > SUCCESSOR_SEARCH_FROM

    /**
     * Whether [view]'s person is its only owner, as far as the directory knows: an owner with no other active owner in
     * a complete directory. Leaving then can't work (`409 last_owner`), so the app says so before asking.
     */
    fun onlyOwner(view: WorkspaceView): Boolean =
        view.me.role == "owner" && !view.membersMore && view.members.none { it.id != view.me.id && it.state == "active" && it.role == "owner" }

    /**
     * Whether the drawer's Leave row says to make someone else an owner first: the only owner with someone in the
     * workspace to make owner. Alone, Delete workspace is the way out and the line would point at nobody.
     */
    fun ownerFirstHint(view: WorkspaceView): Boolean = onlyOwner(view) && !alone(view)

    /**
     * The rows of a successor list for [query]: the people whose name ([display]) matches, and always the one picked
     * ([pick]), so a search never hides who the button acts for.
     */
    fun pickerShown(people: List<Member>, query: String, pick: String?, display: (Member) -> String): List<Member> =
        people.filter { it.id == pick || matches(display(it), query) }

    /**
     * The channels in [rooms] that may need a successor before the person leaves: open channels they manage with
     * other people in them. Whether they are the only manager there takes the channel's members ([soleManager]).
     */
    fun sharedManaged(rooms: List<Room>): List<Room> = rooms.filter { it.kind == RoomKind.CHANNEL && !it.archived && it.role == "manager" && it.members > 1 }

    /**
     * Whether [me] is the only manager among a channel's [members] while other people are in it (`409 last_manager`).
     * The [agents] among them don't count: a channel whose last person leaves is archived, agents or not.
     */
    fun soleManager(members: List<RoomMember>, me: String?, agents: Set<String> = emptySet()): Boolean {
        val people = members.filter { it.member !in agents }
        return people.any { it.member != me } && people.none { it.member != me && it.role == "manager" }
    }

    /** Whether every channel of a hand-over has a successor picked from its own people. */
    fun handOverReady(channels: List<HandOverChannel>, picks: Map<String, String>): Boolean =
        channels.isNotEmpty() && channels.all { ch -> ch.people?.any { it.id == picks[ch.id] } == true }

    /** The channels a `409 last_manager` named, with the names [view] knows; unknown ones are left out. */
    fun handOver(ids: List<String>, view: WorkspaceView?): List<HandOverChannel> = ids.distinct().mapNotNull { id ->
        val room = view?.rooms?.firstOrNull { it.id == id }
        val channel = view?.channels?.firstOrNull { it.id == id }
        when {
            room != null -> HandOverChannel(id, room.name.orEmpty(), room.visibility == "private")
            channel != null -> HandOverChannel(id, channel.name, channel.visibility == "private")
            else -> null
        }
    }

    /**
     * The people who can be added to a channel (desktop-ui 6.6): active members who aren't in it, by name. A guest needs
     * an owner or admin ([guestLocked] true for anyone else), so their rows are off. Agents have a list of their own
     * ([AgentRules.addable]).
     */
    fun addCandidates(members: List<Member>, inside: Set<String>, compare: Comparator<String>): List<Member> =
        members.filter { it.state == "active" && it.id !in inside && !it.isAgent }.sortedWith { a, b -> compare.compare(a.name, b.name) }

    fun guestLocked(member: Member, myRole: String?): Boolean = member.role == "guest" && !canInvite(myRole)

    /**
     * Browse channels (desktop-ui 6.5): the open channels the workspace can see that fit [query], and the archived ones
     * the person was in, each by name.
     */
    fun browse(channels: List<Channel>, roomIds: Set<String>, query: String, compare: Comparator<String>): Pair<List<Channel>, List<Channel>> {
        val list = channels.filter { matches(it.name, query) }.sortedWith { a, b -> compare.compare(a.name, b.name) }
        return list.filter { !it.archived } to list.filter { it.archived && (it.joined || it.id in roomIds) }
    }

    /**
     * A room's details (contract §7.4): for a channel Mute, Mark as read, Members, Add people and Rename for managers,
     * Archive for managers, owners and admins, and Leave; for a DM Mute, Mark as read, Leave conversation (Remove from
     * list once closed), and Block or Unblock in a one-to-one DM for full members. An archived channel can't be added
     * to, renamed or archived. While the workspace can't take writes (not [writable]: the server asks for an update),
     * only what stays on the phone is offered: Mute, Mark as read and Members. [ownAgents] says the person sponsors
     * an agent, which they may add to a channel the workspace sees without managing it: Add agents.
     */
    fun detailActions(room: Room, myRole: String?, me: String?, blocked: Set<String>, writable: Boolean = true, ownAgents: Boolean = false): List<DetailAction> =
        detailActionsFor(room, myRole, me, blocked, ownAgents).filter { writable || it in LOCAL_DETAILS }

    private val LOCAL_DETAILS = setOf(DetailAction.MUTE, DetailAction.UNMUTE, DetailAction.MARK_READ, DetailAction.MEMBERS)

    private fun detailActionsFor(room: Room, myRole: String?, me: String?, blocked: Set<String>, ownAgents: Boolean): List<DetailAction> {
        val out = ArrayList<DetailAction>()
        out += if (room.muted) DetailAction.UNMUTE else DetailAction.MUTE
        out += DetailAction.MARK_READ
        if (room.kind == RoomKind.CHANNEL) {
            val manager = room.role == "manager" && !room.archived
            out += DetailAction.MEMBERS
            if (manager) out += DetailAction.ADD_PEOPLE
            if (!manager && AgentRules.sponsorAdds(room, ownAgents)) out += DetailAction.ADD_AGENTS
            if (manager) out += DetailAction.RENAME
            if (!room.archived && (manager || myRole == "owner" || myRole == "admin")) out += DetailAction.ARCHIVE
            out += DetailAction.LEAVE_CHANNEL
        } else {
            val closed = room.closedReason != null || room.archived
            out += if (closed) DetailAction.REMOVE_FROM_LIST else DetailAction.LEAVE_DM
            val others = room.participants.orEmpty().distinct().filter { it != me }
            if (others.size == 1 && ChatListModel.isFullMember(myRole)) out += if (others[0] in blocked) DetailAction.UNBLOCK else DetailAction.BLOCK
        }
        return out
    }

    /**
     * A member row's menu (desktop-ui 6.15): Message for full members to another full member they haven't blocked;
     * the roles an owner (any) or an admin (member and guest, for members and guests) may give; Block or Unblock for
     * full members; Remove for owners, and for admins over members and guests. Nothing for the person themself. While
     * the workspace can't take writes (not [writable]), only Message, which opens the DM. An agent gets no Message,
     * Block or role: while the server has [agents] on, its sponsor, an owner or an admin who is a full member gets Edit
     * agent and Remove agent, and its sponsor also New key, as on the desktop.
     */
    fun memberActions(myRole: String?, me: String?, target: Member, blocked: Set<String>, writable: Boolean = true, agents: Boolean = false): List<MemberAction> =
        memberActionsFor(myRole, me, target, blocked, agents).filter { writable || it == MemberAction.MESSAGE }

    private fun memberActionsFor(myRole: String?, me: String?, target: Member, blocked: Set<String>, agents: Boolean): List<MemberAction> {
        if (target.id == me || target.state != "active") return emptyList()
        if (target.isAgent) {
            val sponsor = target.agent?.sponsor
            if (!agents || !ChatListModel.isFullMember(myRole) || !AgentRules.canManage(sponsor, me, myRole)) return emptyList()
            return buildList {
                if (target.agent != null) add(MemberAction.EDIT_AGENT)
                if (AgentRules.canNewKey(sponsor, me)) add(MemberAction.AGENT_KEY)
                add(MemberAction.REMOVE)
            }
        }
        val out = ArrayList<MemberAction>()
        val full = ChatListModel.isFullMember(myRole)
        val isBlocked = target.id in blocked
        if (full && ChatListModel.isFullMember(target.role) && !isBlocked) out += MemberAction.MESSAGE
        val choices = when {
            myRole == "owner" -> ROLES
            myRole == "admin" && target.role in setOf("member", "guest") -> listOf("member", "guest")
            else -> emptyList()
        }
        for (role in choices) {
            out += when (role) {
                "owner" -> MemberAction.ROLE_OWNER
                "admin" -> MemberAction.ROLE_ADMIN
                "member" -> MemberAction.ROLE_MEMBER
                else -> MemberAction.ROLE_GUEST
            }
        }
        if (full) out += if (isBlocked) MemberAction.UNBLOCK else MemberAction.BLOCK
        if (myRole == "owner" || (myRole == "admin" && target.role in setOf("member", "guest"))) out += MemberAction.REMOVE
        return out
    }

    /** The role a [MemberAction] gives, or null for the others. */
    fun roleOf(action: MemberAction): String? = when (action) {
        MemberAction.ROLE_OWNER -> "owner"
        MemberAction.ROLE_ADMIN -> "admin"
        MemberAction.ROLE_MEMBER -> "member"
        MemberAction.ROLE_GUEST -> "guest"
        else -> null
    }

    /**
     * Whether setting [role] asks first. Owner and Guest reach past the person: an owner can remove you, and a guest's
     * DMs close for everyone in them. Admin and Member apply at once with Undo.
     */
    fun roleAsks(role: String): Boolean = role == "owner" || role == "guest"

    /**
     * A channel member row's menu for a manager of an open channel; nothing for the person themself, nor while the
     * workspace can't take writes (not [writable]). An agent ([member] from the directory) never manages a channel, so
     * it gets only Remove, from the channel's managers and its sponsor. That Remove stays once the channel is archived:
     * the agent keeps reading it, and the server still takes it out, as on the desktop.
     */
    fun channelMemberActions(room: Room, me: String?, target: RoomMember, writable: Boolean = true, member: Member? = null): List<ChannelMemberAction> {
        if (!writable || room.kind != RoomKind.CHANNEL || target.member == me) return emptyList()
        if (member?.isAgent == true) {
            return if (room.role == "manager" || (me != null && member.agent?.sponsor == me)) listOf(ChannelMemberAction.REMOVE) else emptyList()
        }
        if (room.role != "manager" || room.archived) return emptyList()
        return listOf(if (target.role == "manager") ChannelMemberAction.MAKE_MEMBER else ChannelMemberAction.MAKE_MANAGER, ChannelMemberAction.REMOVE)
    }
}

// ---- the host ----

/**
 * The host of Chat's sheets and dialogs (android.md "Sheets and dialogs", contract §5.10, §7.4): RukooRoot calls it
 * while `NavState.chat.sheet` is set, with the room it is about as [target]. Each is an RkBottomSheet on one pane and
 * the same content in a centered dialog capped at 480dp on [twoPane]. A server error shows in the sheet, under the
 * field it concerns, and never closes it; work started in a sheet runs in the view model, so it finishes after the
 * sheet closed.
 */
@Composable
fun ChatSheetHost(app: AppViewModel, sheet: ChatSheet, target: String?, twoPane: Boolean) {
    val close: () -> Unit = app::closeChatSheet
    ChatInk { SheetFor(app, sheet, target, twoPane, close) }
}

@Composable
private fun SheetFor(app: AppViewModel, sheet: ChatSheet, target: String?, twoPane: Boolean, close: () -> Unit) {
    // A sheet that writes in the selected workspace closes once the server asks for an update, also one already open.
    val nav by app.state.collectAsStateWithLifecycle()
    if (!SheetRules.opensWhileReadOnly(sheet) && !takesWrites(app, nav.chat.workspaceId.orEmpty())) {
        LaunchedEffect(sheet, target) { close() }
        return
    }
    key(sheet, target) {
        when (sheet) {
            ChatSheet.NEW -> NewSheet(app, twoPane, close)
            ChatSheet.JOIN -> JoinSheet(app, twoPane, close)
            ChatSheet.CREATE_WORKSPACE -> CreateWorkspaceSheet(app, twoPane, close)
            ChatSheet.NEW_CHANNEL -> NewChannelSheet(app, twoPane, close)
            ChatSheet.NEW_DM -> NewDmSheet(app, twoPane, close)
            ChatSheet.BROWSE -> BrowseSheet(app, twoPane, close)
            ChatSheet.DETAILS -> if (target != null) DetailsSheet(app, target, twoPane, close) else LaunchedEffect(Unit) { close() }
            ChatSheet.MEMBERS -> MembersSheet(app, target, twoPane, close)
            ChatSheet.ADD_PEOPLE -> if (target != null) AddPeopleSheet(app, target, twoPane, close) else LaunchedEffect(Unit) { close() }
            ChatSheet.INVITE -> InviteSheet(app, twoPane, close)
            ChatSheet.BLOCKED -> BlockedSheet(app, twoPane, close)
            ChatSheet.AGENTS -> AgentsSheet(app, target, twoPane, close)
        }
    }
}

/**
 * What every Chat layout carries over its panes (contract §3.3, §5.10): the Join sheet with the link of a sign-up the
 * next time Chat shows, and the questions of [ChatUi.prompt]. Each layout composes it; one draws.
 */
@Composable
fun ChatOverlays(app: AppViewModel) {
    val ui = app.chatUi
    val owner = remember { Any() }
    DisposableEffect(ui, owner) {
        ui.claimOverlay(owner)
        onDispose { ui.releaseOverlay(owner) }
    }
    if (!ui.drawsOverlay(owner)) return
    val chat by app.chatState.collectAsStateWithLifecycle()
    val nav by app.state.collectAsStateWithLifecycle()
    // A sign-up with an invitation link left it here (§3.3): Join opens with it, and takes it.
    LaunchedEffect(chat.pendingJoin, chat.signedIn, nav.chat.sheet, nav.overlay) {
        if (chat.pendingJoin && chat.signedIn && nav.chat.sheet == null && nav.overlay == null) app.openChatSheet(ChatSheet.JOIN)
    }
    when (val p = ui.prompt) {
        is ChatPrompt.Successor -> SuccessorPrompt(app, p)
        is ChatPrompt.HandOver -> HandOverPrompt(app, p)
        null -> Unit
    }
}

// ---- the frame and the parts the sheets share ----

/**
 * A sheet: an RkBottomSheet on one pane, a dialog capped at 480dp on two (android.md "Sheets and dialogs"). [title] on
 * top, [content] scrolling, [buttons] right-aligned at the bottom, wrapping when Dutch labels don't fit. Both get the
 * close that slides the sheet away first. [holdClose] is asked before a swipe, a tap outside or Back closes it: true
 * keeps it open, for a sheet that asks first; the close [buttons] and [content] get doesn't ask.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SheetFrame(
    twoPane: Boolean,
    title: String,
    onDismiss: () -> Unit,
    subtitle: String? = null,
    holdClose: (() -> Boolean)? = null,
    buttons: (@Composable (close: () -> Unit) -> Unit)? = null,
    content: @Composable ColumnScope.(close: () -> Unit) -> Unit,
) {
    val c = Rk.colors
    @Composable
    fun ColumnScope.Body(close: () -> Unit) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 10.dp)) {
            Text(title, style = Rk.type.dialogTitle, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            // The subtitle can be the host disclosure ("Direct message · hosted by …"), so it is read: text2.
            if (subtitle != null) Text(subtitle, style = Rk.type.text12_5, color = c.text2, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Column(
            Modifier.weight(1f, fill = false).fillMaxWidth().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) { content(close) }
        if (buttons != null) {
            FlowRow(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 14.dp, bottom = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) { buttons(close) }
        }
    }
    // The sheet is a window of its own, over the root's toast host, so it shows the toasts itself: a role change's Undo
    // has to be in reach while Members is open. RukooRoot leaves its host out while a chat sheet shows.
    val toasts = LocalRkToast.current
    // Above the button row, so Close stays visible.
    val toastAt = Modifier.padding(bottom = if (buttons != null) 44.dp else 0.dp)
    if (twoPane) {
        Dialog(onDismissRequest = { if (holdClose?.invoke() != true) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            val shape = Rk.shapes.window
            Box(Modifier.padding(24.dp).widthIn(max = 480.dp)) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .popIn(RukooDurations.DIALOG, fromScale = 0.97f)
                        .rkSurface(Rk.elevation.overlay, shape, c.raised)
                        .border(1.dp, c.border, shape)
                        .padding(top = 20.dp, bottom = 14.dp),
                ) { Body(onDismiss) }
                RkToastHost(toasts, Modifier.align(Alignment.BottomCenter).then(toastAt))
            }
        }
    } else {
        RkBottomSheet(onDismissRequest = onDismiss, holdClose = holdClose) {
            val close: () -> Unit = { dismiss() }
            Box(Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 8.dp)) { Body(close) }
                RkToastHost(toasts, Modifier.align(Alignment.BottomCenter).then(toastAt))
            }
        }
    }
}

/** A sheet's form: fields and notes at the sheet's side padding. */
@Composable
internal fun Form(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
}

@Composable
internal fun SheetText(text: String, modifier: Modifier = Modifier, color: Color = Rk.colors.text2) {
    Text(text, modifier, style = Rk.type.text13.lineHeight(1.5f), color = color)
}

/** A line that says what a choice does ("You can't change this later.", what an invitation link gives): read, so text2. */
@Composable
internal fun Help(text: String, warn: Boolean = false) {
    Text(text, style = Rk.type.text12, color = if (warn) Rk.colors.warn else Rk.colors.text2)
}

/** The primary button with a spinner beside it while the work runs. */
@Composable
internal fun Primary(label: String, busy: Boolean, enabled: Boolean = true, danger: Boolean = false, onClick: () -> Unit) {
    if (busy) Spinner(size = 14.dp)
    RkButton(label, onClick, kind = if (danger) RkButtonKind.DANGER else RkButtonKind.PRIMARY, enabled = enabled && !busy)
}

@Composable
internal fun Secondary(label: String, enabled: Boolean = true, onClick: () -> Unit) = RkButton(label, onClick, kind = RkButtonKind.SECONDARY, enabled = enabled)

/**
 * The host disclosure (desktop-ui 6, desktop chat.js `hostNote`): who hosts the workspace and where, how long messages
 * are kept, and that the host can read them.
 */
@Composable
private fun HostNote(chat: ChatState) {
    val operator = chat.operator?.name ?: chat.host
    val where = when (chat.jurisdiction) {
        "eu" -> stringResource(R.string.settings_rukoo_where_eu)
        "us" -> stringResource(R.string.settings_rukoo_where_us)
        "fedramp" -> stringResource(R.string.settings_rukoo_where_fedramp)
        else -> null
    }
    val lines = buildList {
        add(stringResource(R.string.chat_host_line_no_location, operator, chat.host) + if (where != null) " $where." else "")
        chat.retention?.contentDays?.takeIf { it > 0 }?.let { add(pluralStringResource(R.plurals.chat_host_retention, it, it)) }
        add(stringResource(R.string.chat_host_reads))
        // An agent passes on what it reads, to a runtime the host can't see.
        if (chat.agents) add(stringResource(R.string.chat_host_agents))
    }
    NoteBox(lines.joinToString(" "))
}

/** A radio indicator: 18dp ring, a dot when chosen. */
@Composable
private fun RadioDot(selected: Boolean) {
    val c = Rk.colors
    Box(Modifier.size(18.dp).border(1.5.dp, if (selected) c.accent else c.borderStrong, CircleShape), contentAlignment = Alignment.Center) {
        if (selected) Box(Modifier.size(8.dp).background(c.accent, CircleShape))
    }
}

/** A choice of several, the whole row choosing it: the dot, an optional icon, the label and its hint. */
@Composable
internal fun RadioRow(label: String, selected: Boolean, onClick: () -> Unit, hint: String? = null, icon: ImageVector? = null, leading: (@Composable () -> Unit)? = null) {
    val c = Rk.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .selectable(selected, role = Role.RadioButton, interactionSource = null, indication = Rk.indication(Rk.shapes.control), onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioDot(selected)
        leading?.invoke()
        if (icon != null) RkIcon(icon, null, size = 16.dp, tint = c.text2)
        Column(Modifier.weight(1f)) {
            Text(label, style = Rk.type.text13, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (hint != null) Text(hint, style = Rk.type.text12, color = c.text2)
        }
    }
}

/** A check box row, the whole row toggling it; off rows say why in [note]. */
@Composable
internal fun CheckRow(
    label: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    enabled: Boolean = true,
    note: String? = null,
    tag: String? = null,
    leading: (@Composable () -> Unit)? = null,
) {
    val c = Rk.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .toggleable(checked, enabled = enabled, role = Role.Checkbox, interactionSource = null, indication = Rk.indication(Rk.shapes.control), onValueChange = onChange)
            .alpha(if (enabled) 1f else 0.5f)
            .padding(horizontal = 20.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MailCheckbox(checked)
        leading?.invoke()
        Column(Modifier.weight(1f)) {
            Text(label, style = Rk.type.text13, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (note != null) Text(note, style = Rk.type.text12, color = c.text3)
        }
        if (tag != null) Tag(tag)
    }
}

/** A small tag after a name: Guest, Agent, Former member, Blocked. */
@Composable
private fun Tag(text: String, accent: Boolean = false) {
    val c = Rk.colors
    Text(
        text,
        style = Rk.type.text11.medium,
        color = if (accent) c.accent else c.text2,
        maxLines = 1,
        modifier = Modifier.background(if (accent) c.accentSoft else c.chip, Rk.shapes.chip).padding(horizontal = 6.dp, vertical = 1.dp),
    )
}

/**
 * Two or three choices side by side (desktop's `segmented`): the chosen one raised. [label] names the group for a
 * screen reader.
 */
@Composable
private fun <T> Segmented(options: List<Pair<T, String>>, selected: T, label: String, onSelect: (T) -> Unit) {
    val c = Rk.colors
    val shape = Rk.shapes.pill
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .background(c.chip, shape)
            .padding(2.dp)
            .selectableGroup()
            .semantics { contentDescription = label },
    ) {
        for ((value, text) in options) {
            val on = value == selected
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 36.dp)
                    .then(if (on && !c.isDark) Modifier.rkShadow(Rk.elevation.shadowSm, shape) else Modifier)
                    .background(if (on) (if (c.isDark) c.active else c.raised) else Color.Transparent, shape)
                    // In dark the chosen fill sits close to the track, so a ring marks it too.
                    .then(if (on && c.isDark) Modifier.border(1.dp, c.borderStrong, shape) else Modifier)
                    .clip(shape)
                    .selectable(on, role = Role.Tab, onClick = { onSelect(value) }),
                contentAlignment = Alignment.Center,
            ) {
                Text(text, style = Rk.type.text12_5.medium, color = if (on) c.text else c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/**
 * A person or an agent: avatar, name and tags, a quiet [note] under them (whom an agent answers), with [trailing] at
 * the end (a menu or a button).
 */
@Composable
internal fun PersonRow(
    id: String,
    member: Member?,
    label: String,
    tags: List<String> = emptyList(),
    pill: String? = null,
    note: String? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = Rk.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 20.dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(if (member?.state == "deleted") "?" else member?.name, id, size = 28.dp, agent = member?.isAgent == true)
        Column(Modifier.weight(1f)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, style = Rk.type.text13, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                for (t in tags) Tag(t)
                if (pill != null) Tag(pill, accent = true)
            }
            if (note != null) Text(note, style = Rk.type.text12, color = c.text3, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        trailing?.invoke()
    }
}

/**
 * The tags after a member's name: Former member, Guest, Agent. The server says `left` or `removed` for a former
 * member, as RoomPane's tag reads it; a deleted member's name is the tag.
 */
@Composable
internal fun memberTags(member: Member?): List<String> = buildList {
    if (member != null && member.state != "active" && member.state != "deleted") add(stringResource(R.string.chat_log_former_member))
    if (member?.role == "guest" && member.state == "active" && !member.isAgent) add(stringResource(R.string.chat_roles_guest))
    if (member?.isAgent == true && member.state == "active") add(stringResource(R.string.chat_roles_agent))
}

/** # or a lock, for a channel's visibility. */
private fun channelIcon(visibility: String): ImageVector = if (visibility == "private") ChatIcons.Lock else ChatIcons.Hash

/** The collator of the interface language, for names. */
@Composable
internal fun rememberCompare(): Comparator<String> {
    val locale = LocalConfiguration.current.locales[0]
    return remember(locale) {
        val collator = Collator.getInstance(locale).apply { strength = Collator.PRIMARY }
        Comparator { a, b -> collator.compare(a, b) }
    }
}

/** The selected workspace's view while Chat shows it. */
@Composable
internal fun selectedView(app: AppViewModel): WorkspaceView? {
    val nav by app.state.collectAsStateWithLifecycle()
    val view by app.chatView.collectAsStateWithLifecycle()
    return view?.takeIf { it.ws.id == nav.chat.workspaceId }
}

/** Whether workspace [ws] takes writes: not while the server asks for an update (426, contract §3.15). */
@Composable
internal fun takesWrites(app: AppViewModel, ws: String): Boolean {
    val chat by app.chatState.collectAsStateWithLifecycle()
    return chat.workspaces.firstOrNull { it.id == ws }?.status != WorkspaceStatus.UPGRADE
}

/** A date and time as the settings pages write them. */
@Composable
internal fun dateTime(ms: Long): String {
    val locale = LocalConfiguration.current.locales[0]
    return "${formatDate(ms, locale)} ${formatTime(ms, locale)}"
}

/** An error's code, for the sheets that tell some apart. */
private fun codeOf(e: Exception): String? = (e as? WorkspaceError)?.code

/** A 410 and a 404 on an invitation mean the same to the person (desktop-ui 6.2). */
private fun inviteGone(e: Exception): Boolean {
    val w = e as? WorkspaceError ?: return false
    return w.code == "invite_gone" || (w.code == "not_found" && w.scope != "conversation")
}

// ---- New (the New message button) ----

/** New message's choices (android.md "Conversation list"): message someone, make a channel, browse channels. */
@Composable
private fun NewSheet(app: AppViewModel, twoPane: Boolean, onDismiss: () -> Unit) {
    val view = selectedView(app)
    val full = ChatListModel.isFullMember(view?.me?.role)
    SheetFrame(twoPane, stringResource(R.string.chat_sidebar_new_message), onDismiss) {
        if (full) SheetRow(stringResource(R.string.chat_dm_new), icon = RukooIcons.Person, onClick = { app.openChatSheet(ChatSheet.NEW_DM) })
        if (full) SheetRow(stringResource(R.string.chat_sidebar_make_channel), icon = ChatIcons.Hash, onClick = { app.openChatSheet(ChatSheet.NEW_CHANNEL) })
        if (full) SheetRow(stringResource(R.string.chat_sidebar_browse), icon = RukooIcons.Search, onClick = { app.openChatSheet(ChatSheet.BROWSE) })
    }
}

// ---- Join (desktop-ui 6.2, contract §3.2, §3.3) ----

private const val KEY_PREVIEW = "sheet:preview"
private const val KEY_JOIN = "sheet:join"

/**
 * Join with an invitation link: the link (with Paste, which reads the clipboard only when tapped), its card, the
 * person's name, Join. A link for another server only explains, with Close; one the person's workspace already has
 * offers Open. A sign-up's link fills it and loads its card at once.
 */
@Composable
private fun JoinSheet(app: AppViewModel, twoPane: Boolean, onDismiss: () -> Unit) {
    val ui = app.chatUi
    val workspaces = app.services.workspaces ?: return
    val chat by app.chatState.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val badLink = stringResource(R.string.chat_join_bad_link)
    val goneText = stringResource(R.string.chat_errors_invite_gone)
    val invalidName = stringResource(R.string.chat_errors_invalid_name)
    var text by remember { mutableStateOf("") }
    var checkedText by remember { mutableStateOf<String?>(null) }
    var link by remember { mutableStateOf<InviteLink?>(null) }
    var preview by remember { mutableStateOf<InvitePreview?>(null) }
    var elsewhere by remember { mutableStateOf<String?>(null) }
    var linkError by remember { mutableStateOf<String?>(null) }
    var nameError by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf(SheetRules.defaultName(app.services.account?.status?.value?.email)) }
    val checking = ui.isBusy(KEY_PREVIEW)
    val joining = ui.isBusy(KEY_JOIN)
    // The sheet shows the pending link of a sign-up or sign-in (RUK-234): closing it without joining lets the link go,
    // which otherwise waits on disk for the next start.
    var fromPending by remember { mutableStateOf(false) }
    // The pending link as it came: only that text, refused, lets it go; another one typed over it doesn't.
    var pendingText by remember { mutableStateOf<String?>(null) }
    var joined by remember { mutableStateOf(false) }
    val dismiss = {
        if (fromPending && !joined) workspaces.dropPendingJoin()
        onDismiss()
    }

    fun reset() {
        checkedText = null
        link = null
        preview = null
        elsewhere = null
        linkError = null
        error = null
    }

    fun check(value: String = text) {
        val t = value.trim()
        reset()
        val parsed = InviteLink.parse(t, BuildConfig.DEBUG)
        // rukoo.io and its former address are one server (InviteLink.sameServers).
        val ours = parsed != null && parsed.server in chat.linkServers.ifEmpty { listOf(chat.server) }
        // The pending link of a sign-up that this sheet can't use goes now, not after the next restart.
        if (fromPending && !ours && t == pendingText) workspaces.dropPendingJoin()
        when {
            parsed == null -> linkError = badLink
            !ours -> elsewhere = hostOf(parsed.server)
            else -> ui.attempt(KEY_PREVIEW, failed = { e ->
                when {
                    codeOf(e) == "other_server" -> elsewhere = hostOf(parsed.server)
                    codeOf(e) == "bad_link" || (codeOf(e) == "invalid" && (e as WorkspaceError).field in setOf("link", "invite")) -> linkError = badLink
                    inviteGone(e) -> linkError = goneText
                    else -> error = ui.errorText(e)
                }
            }) {
                val card = previewInvite(parsed)
                if (text.trim() == t) {
                    // The field shows the link that was read (§3.2), in place of a sentence around it or a full stop
                    // after it.
                    if (parsed.text != t) text = parsed.text
                    checkedText = parsed.text
                    link = parsed
                    preview = card
                }
            }
        }
    }

    // The link of a sign-up with an invitation (§3.3), taken once.
    LaunchedEffect(Unit) {
        workspaces.takePendingJoin()?.let {
            fromPending = true
            pendingText = it.text
            text = it.text
            check(it.text)
        }
    }

    fun submit(close: () -> Unit) {
        if (elsewhere != null) return close()
        val l = link
        val card = preview
        if (l == null || card == null || text.trim() != checkedText) return check()
        if (card.already) {
            ui.select(card.workspace.id)
            ui.toasts.showToast(ui.strings.get(R.string.chat_join_already, card.workspace.name))
            return close()
        }
        if (!SheetRules.nameOk(name)) {
            nameError = invalidName
            return
        }
        nameError = null
        error = null
        ui.attempt(KEY_JOIN, failed = { e ->
            when {
                inviteGone(e) -> error = goneText
                codeOf(e) == "invalid" && (e as WorkspaceError).field in setOf("name", "displayName") -> nameError = ui.errorText(e)
                else -> error = ui.errorText(e)
            }
        }) {
            val ws = join(l, name.trim())
            joined = true
            app.firstWorkspace()
            ui.arrive(ws)
        }
    }

    SheetFrame(
        twoPane,
        stringResource(R.string.chat_join_title),
        dismiss,
        buttons = { close ->
            if (elsewhere != null) {
                Primary(stringResource(R.string.common_actions_close), busy = false) { close() }
            } else {
                Secondary(stringResource(R.string.common_actions_cancel)) { close() }
                val card = preview
                val label = when {
                    card == null || text.trim() != checkedText -> stringResource(R.string.chat_join_check)
                    card.already -> stringResource(R.string.chat_join_open)
                    else -> stringResource(R.string.chat_join_submit, card.workspace.name)
                }
                Primary(label, busy = checking || joining, enabled = text.isNotBlank()) { submit(close) }
            }
        },
    ) { close ->
        Form {
            RkTextField(
                value = text,
                onValueChange = {
                    text = it
                    if (checkedText != null || elsewhere != null || linkError != null || error != null) reset()
                },
                label = stringResource(R.string.chat_join_link),
                placeholder = "https://…/join#w=…",
                error = linkError,
                enabled = !joining,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                keyboardActions = KeyboardActions(onGo = { submit(close) }),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                // A small secondary button, like Copy link, so it gets Android's 48dp touch target.
                RkButton(stringResource(R.string.chat_join_paste), {
                    val pasted = readClipboard(context)
                    if (!pasted.isNullOrBlank()) {
                        text = pasted.trim()
                        check(text)
                    }
                }, kind = RkButtonKind.SECONDARY, size = RkButtonSize.SMALL, icon = ChatIcons.Clipboard, enabled = !joining)
                if (checking) {
                    Spinner(size = 14.dp)
                    Text(stringResource(R.string.chat_join_checking), style = Rk.type.text12_5, color = Rk.colors.text3)
                }
            }
            elsewhere?.let { NoteBox(stringResource(R.string.chat_join_other_host, it, chat.host), tone = NoteTone.WARN) }
            val card = preview
            if (card != null && text.trim() == checkedText) {
                InviteCard(card)
                if (!card.already) {
                    RkTextField(
                        value = name,
                        onValueChange = {
                            name = it
                            nameError = null
                        },
                        label = stringResource(R.string.chat_make_your_name),
                        error = nameError,
                        enabled = !joining,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { submit(close) }),
                    )
                    HostNote(chat)
                }
            }
            error?.let { ErrorLine(it) }
        }
    }
}

/** An invitation's card: the workspace, who invited and as what, how many channels, until when, and history. */
@Composable
private fun InviteCard(card: InvitePreview) {
    val c = Rk.colors
    Column(
        Modifier.fillMaxWidth().background(c.panel, Rk.shapes.card).border(1.dp, c.border, Rk.shapes.card).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Monogram(card.workspace.name, size = 32.dp, hueKey = card.workspace.id)
            Text(card.workspace.name, style = Rk.type.text16.title, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (card.already) {
            SheetText(stringResource(R.string.chat_join_already, card.workspace.name))
        } else {
            if (card.issuer.name.isNotBlank()) {
                SheetText(stringResource(if (card.role == "guest") R.string.chat_join_invited_by_guest else R.string.chat_join_invited_by, card.issuer.name))
            }
            SheetText(pluralStringResource(R.plurals.chat_join_channels, card.channels, card.channels))
            if (card.expiresAt > 0) SheetText(stringResource(R.string.chat_join_expires, dateTime(card.expiresAt)))
            SheetText(stringResource(R.string.chat_join_history), color = c.text3)
        }
    }
}

private fun readClipboard(context: Context): String? = runCatching {
    val clip = context.getSystemService(ClipboardManager::class.java)?.primaryClip ?: return null
    if (clip.itemCount == 0) null else clip.getItemAt(0).coerceToText(context)?.toString()
}.getOrNull()

// ---- Make a workspace (desktop-ui 6.1) ----

private const val KEY_CREATE = "sheet:createWorkspace"

@Composable
private fun CreateWorkspaceSheet(app: AppViewModel, twoPane: Boolean, onDismiss: () -> Unit) {
    val ui = app.chatUi
    val chat by app.chatState.collectAsStateWithLifecycle()
    val invalidName = stringResource(R.string.chat_errors_invalid_name)
    var name by remember { mutableStateOf("") }
    var yourName by remember { mutableStateOf(SheetRules.defaultName(app.services.account?.status?.value?.email)) }
    var nameError by remember { mutableStateOf<String?>(null) }
    var yourError by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val busy = ui.isBusy(KEY_CREATE)

    fun submit() {
        nameError = if (SheetRules.nameOk(name)) null else invalidName
        yourError = if (SheetRules.nameOk(yourName)) null else invalidName
        if (nameError != null || yourError != null) return
        error = null
        ui.attempt(KEY_CREATE, failed = { e ->
            val field = (e as? WorkspaceError)?.field
            when {
                codeOf(e) == "invalid" && field == "name" -> nameError = ui.errorText(e)
                codeOf(e) == "invalid" && field == "displayName" -> yourError = ui.errorText(e)
                else -> error = ui.errorText(e)
            }
        }) {
            val ws = createWorkspace(name.trim(), yourName.trim())
            app.firstWorkspace()
            ui.arrive(ws)
        }
    }

    SheetFrame(
        twoPane,
        stringResource(R.string.chat_make_title),
        onDismiss,
        buttons = { close ->
            Secondary(stringResource(R.string.common_actions_cancel)) { close() }
            Primary(stringResource(R.string.chat_make_submit), busy = busy, enabled = name.isNotBlank() && yourName.isNotBlank(), onClick = ::submit)
        },
    ) {
        Form {
            RkTextField(
                value = name,
                onValueChange = {
                    name = it
                    nameError = null
                },
                label = stringResource(R.string.chat_make_name),
                placeholder = stringResource(R.string.chat_make_name_placeholder),
                error = nameError,
                enabled = !busy,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
            )
            RkTextField(
                value = yourName,
                onValueChange = {
                    yourName = it
                    yourError = null
                },
                label = stringResource(R.string.chat_make_your_name),
                error = yourError,
                enabled = !busy,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
            )
            HostNote(chat)
            error?.let { ErrorLine(it) }
        }
    }
}

// ---- Make a channel (desktop-ui 6.4) ----

private const val KEY_CHANNEL = "sheet:createChannel"

/** A name (saved as typed, §3.16) and who can see it, which can't change later. A private one asks for people next. */
@Composable
private fun NewChannelSheet(app: AppViewModel, twoPane: Boolean, onDismiss: () -> Unit) {
    val ui = app.chatUi
    val view = selectedView(app) ?: return
    val ws = view.ws.id
    val invalidName = stringResource(R.string.chat_errors_invalid_name)
    var name by remember { mutableStateOf("") }
    var private by remember { mutableStateOf(false) }
    var nameError by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val busy = ui.isBusy(KEY_CHANNEL)

    fun submit() {
        if (!SheetRules.nameOk(name)) {
            nameError = invalidName
            return
        }
        nameError = null
        error = null
        val visibility = if (private) "private" else "workspace"
        ui.attempt(KEY_CHANNEL, failed = { e ->
            when (codeOf(e)) {
                "name_taken", "invalid" -> nameError = ui.errorText(e)
                else -> error = ui.errorText(e)
            }
        }) {
            val id = createChannel(ws, name.trim(), visibility)
            app.openRoom(id)
            // A private channel has nobody in it yet: Add people comes right after (desktop-ui 6.4).
            if (visibility == "private") app.openChatSheet(ChatSheet.ADD_PEOPLE, id)
        }
    }

    SheetFrame(
        twoPane,
        stringResource(R.string.chat_channel_make_title),
        onDismiss,
        buttons = { close ->
            Secondary(stringResource(R.string.common_actions_cancel)) { close() }
            Primary(stringResource(R.string.chat_channel_make), busy = busy, enabled = name.isNotBlank(), onClick = ::submit)
        },
    ) {
        Form {
            RkTextField(
                value = name,
                onValueChange = {
                    name = it
                    nameError = null
                },
                label = stringResource(R.string.chat_channel_name),
                placeholder = "#",
                error = nameError,
                enabled = !busy,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
            )
            Text(stringResource(R.string.chat_channel_who), style = Rk.type.text12_5, color = Rk.colors.text2)
        }
        Column(Modifier.selectableGroup()) {
            RadioRow(
                stringResource(R.string.chat_channel_public, view.ws.name),
                selected = !private,
                onClick = { private = false },
                hint = stringResource(R.string.chat_channel_public_hint),
                icon = ChatIcons.Hash,
            )
            RadioRow(
                stringResource(R.string.chat_channel_private),
                selected = private,
                onClick = { private = true },
                hint = stringResource(R.string.chat_channel_private_hint),
                icon = ChatIcons.Lock,
            )
        }
        Form {
            Help(stringResource(R.string.chat_channel_fixed))
            error?.let { ErrorLine(it) }
        }
    }
}

// ---- New message: a DM or group DM (desktop-ui 6.11, contract §3.12) ----

private const val KEY_DM = "sheet:startDm"

/**
 * Pick 1 to 7 active full members (guests, blocked people and yourself are left out). When the picked set is an open
 * DM's, the button says Open conversation and opens it without a request; else Start conversation, which opens the
 * room the server answers with, new or existing. A refusal shows here, and `blocked` offers Unblock.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NewDmSheet(app: AppViewModel, twoPane: Boolean, onDismiss: () -> Unit) {
    val ui = app.chatUi
    val view = selectedView(app) ?: return
    val chat by app.chatState.collectAsStateWithLifecycle()
    val ws = view.ws.id
    val names = rememberChatNames()
    val compare = rememberCompare()
    val membersById = remember(view) { view.members.associateBy { it.id } }
    val blocked = remember(view) { view.blocks.mapTo(HashSet()) { it.member } }
    var query by remember { mutableStateOf("") }
    var picked by remember { mutableStateOf(listOf<String>()) }
    var error by remember { mutableStateOf<String?>(null) }
    var blockedMember by remember { mutableStateOf<String?>(null) }
    val busy = ui.isBusy(KEY_DM)
    val existing = SheetRules.openDmFor(view.rooms, view.me.id, picked)
    val full = picked.size >= SheetRules.DM_OTHERS_MAX
    // Everyone in the directory, so the list can say why a blocked person or a guest can't be picked (§3.12).
    val list = remember(view, compare, query) {
        SheetRules.dmPicker(view.members, view.me.id, blocked, query, compare, view.membersMore) { q, people ->
            MentionMatch.rank(q, people, view.me.id, limit = people.size.coerceAtLeast(1))
        }
    }
    val shown = list.pick

    fun submit() {
        if (picked.isEmpty()) return
        existing?.let { return app.openRoom(it.id) }
        error = null
        blockedMember = null
        val set = picked.toList()
        ui.attempt(KEY_DM, failed = { e ->
            val member = (e as? WorkspaceError)?.member
            error = ui.errorText(e, ui.context(ws, member = member?.let { names.display(membersById[it]) }))
            blockedMember = member?.takeIf { codeOf(e) == "blocked" }
        }) {
            val id = startDm(ws, set)
            app.openRoom(id)
        }
    }

    SheetFrame(
        twoPane,
        stringResource(R.string.chat_new_title),
        onDismiss,
        buttons = { close ->
            Secondary(stringResource(R.string.common_actions_cancel)) { close() }
            Primary(stringResource(if (existing != null) R.string.chat_new_open else R.string.chat_new_start), busy = busy, enabled = picked.isNotEmpty(), onClick = ::submit)
        },
    ) {
        Form {
            Text(stringResource(R.string.chat_new_to), style = Rk.type.text12_5, color = Rk.colors.text2)
            if (picked.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (id in picked) {
                        val person = names.display(membersById[id])
                        PickedChip(id, membersById[id], person, stringResource(R.string.chat_new_remove_person, person)) {
                            picked = picked - id
                            error = null
                        }
                    }
                }
            }
            RkSearchField(query, { query = it }, placeholder = stringResource(R.string.chat_new_search, view.ws.name))
        }
        Column {
            when (list.empty) {
                PickerEmpty.NONE -> Form { Help(stringResource(R.string.chat_new_none)) }
                PickerEmpty.NOBODY, PickerEmpty.EVERYONE -> NobodyElse(
                    stringResource(R.string.chat_new_nobody, view.ws.name),
                    invite = SheetRules.canInvite(view.me.role),
                ) { app.openChatSheet(ChatSheet.INVITE) }
                null -> Unit
            }
            for (m in shown) {
                val on = m.id in picked
                CheckRow(
                    names.display(m),
                    checked = on,
                    enabled = on || !full,
                    onChange = { now ->
                        picked = if (now) (picked + m.id).distinct().take(SheetRules.DM_OTHERS_MAX) else picked - m.id
                        error = null
                    },
                    leading = { Avatar(m.name, m.id, size = 24.dp) },
                )
            }
            // Who can't be picked, and why: someone you blocked (with Unblock) and guests.
            for (m in list.blocked) {
                OffRow(m, stringResource(R.string.chat_new_blocked_row, names.display(m)), note = null) {
                    RkLinkButton(stringResource(R.string.chat_block_unblock), enabled = !ui.isBusy("block:${m.id}"), onClick = {
                        ui.unblockMember(ws, m.id, names.display(m))
                    })
                }
            }
            for (m in list.guests) OffRow(m, names.display(m), note = stringResource(R.string.chat_new_guest_row))
        }
        Form {
            if (full) Help(stringResource(R.string.chat_new_limit), warn = true)
            NoteBox(stringResource(R.string.chat_new_host_note, chat.host))
            error?.let { text ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ErrorLine(text, Modifier.weight(1f, fill = false))
                    val member = blockedMember
                    if (member != null) {
                        RkLinkButton(stringResource(R.string.chat_block_unblock), onClick = {
                            ui.unblockMember(ws, member, names.display(membersById[member]))?.invokeOnCompletion {
                                error = null
                                blockedMember = null
                            }
                        })
                    }
                }
            }
        }
    }
}

/** A person New message can't pick, lined up with the check rows: the avatar faded, the text in text2, and [trailing]. */
@Composable
private fun OffRow(member: Member, label: String, note: String?, trailing: (@Composable () -> Unit)? = null) {
    val c = Rk.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 20.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The check box's room, so the names line up with the rows above.
        Box(Modifier.size(18.dp))
        Box(Modifier.alpha(0.55f)) { Avatar(member.name, member.id, size = 24.dp) }
        Column(Modifier.weight(1f)) {
            Text(label, style = Rk.type.text13, color = c.text2, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (note != null) Text(note, style = Rk.type.text12, color = c.text2)
        }
        trailing?.invoke()
    }
}

/** Nobody to pick: the line, and Invite people for those who may invite. */
@Composable
private fun NobodyElse(text: String, invite: Boolean, onInvite: () -> Unit) {
    Form {
        Help(text)
        if (invite) RkButton(stringResource(R.string.chat_workspace_invite), onInvite, kind = RkButtonKind.SECONDARY, size = RkButtonSize.SMALL)
    }
}

/** A picked person in New message: avatar, name and × to take them out. */
@Composable
private fun PickedChip(id: String, member: Member?, name: String, removeLabel: String, onRemove: () -> Unit) {
    val c = Rk.colors
    Row(
        Modifier.heightIn(min = 32.dp).background(c.chip, Rk.shapes.pill).padding(start = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(member?.name, id, size = 22.dp)
        Text(name, style = Rk.type.text12_5.medium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp))
        RkIconButton(RukooIcons.Close, removeLabel, onClick = onRemove, size = RkIconButtonSize.SMALL)
    }
}

// ---- Browse channels (desktop-ui 6.5) ----

/**
 * The workspace's channels, found by name: a joined one opens; one not joined yet opens before joining, with Join where
 * the composer goes; Join joins and opens. The archived ones the person was in fold away at the end, read-only. Make a
 * channel sits on top.
 */
@Composable
private fun BrowseSheet(app: AppViewModel, twoPane: Boolean, onDismiss: () -> Unit) {
    val ui = app.chatUi
    val view = selectedView(app) ?: return
    val ws = view.ws.id
    val compare = rememberCompare()
    val roomIds = remember(view) { view.rooms.mapTo(HashSet()) { it.id } }
    var query by remember { mutableStateOf("") }
    var archivedOpen by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val (open, archived) = remember(view, query, compare) { SheetRules.browse(view.channels, roomIds, query, compare) }
    // The directory loads again when the feed says it changed.
    LaunchedEffect(ws) { ui.refresh(ws) }

    fun join(c: Channel) {
        error = null
        ui.attempt(ui.joinKey(c.id), failed = { e -> error = ui.errorText(e) }) {
            joinChannel(ws, c.id)
            app.openRoom(c.id)
        }
    }

    SheetFrame(
        twoPane,
        stringResource(R.string.chat_channel_browse_title, view.ws.name),
        onDismiss,
        buttons = { close -> Secondary(stringResource(R.string.common_actions_close)) { close() } },
    ) {
        Form {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) { RkSearchField(query, { query = it }, placeholder = stringResource(R.string.chat_channel_search)) }
                if (ChatListModel.isFullMember(view.me.role)) {
                    RkButton(
                        stringResource(R.string.chat_channel_make_title),
                        { app.openChatSheet(ChatSheet.NEW_CHANNEL) },
                        kind = RkButtonKind.PRIMARY,
                        size = RkButtonSize.FIELD,
                        icon = RukooIcons.Plus,
                    )
                }
            }
        }
        Column {
            if (open.isEmpty()) Form { Help(stringResource(R.string.chat_channel_none_found)) }
            for (c in open) {
                val joined = c.id in roomIds
                BrowseRow(c, joined = joined, busy = ui.isBusy(ui.joinKey(c.id)), onOpen = { app.openRoom(c.id) }, onJoin = { join(c) })
            }
            if (archived.isNotEmpty()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 44.dp)
                        .rkClickable(Rk.shapes.control, onClick = { archivedOpen = !archivedOpen })
                        .padding(horizontal = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        pluralStringResource(R.plurals.chat_channel_archived_section, archived.size, archived.size),
                        style = Rk.type.text11_5.semibold,
                        color = Rk.colors.text3,
                        modifier = Modifier.weight(1f),
                    )
                    ExpandChevron(archivedOpen, tint = Rk.colors.text3)
                }
                if (archivedOpen) {
                    for (c in archived) BrowseRow(c, joined = true, archived = true, busy = false, onOpen = { if (c.id in roomIds) app.openRoom(c.id) }, onJoin = {})
                }
            }
        }
        error?.let { Form { ErrorLine(it) } }
    }
}

/** A channel in Browse: its icon, name and members, and Joined or Join at the end. */
@Composable
private fun BrowseRow(c: Channel, joined: Boolean, busy: Boolean, onOpen: () -> Unit, onJoin: () -> Unit, archived: Boolean = false) {
    val colors = Rk.colors
    val members = pluralStringResource(R.plurals.chat_head_members, c.members, c.members)
    val meta = if (c.visibility == "private") "$members · ${stringResource(R.string.chat_head_private)}" else members
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).rkClickable(Rk.shapes.control, onClick = onOpen).padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RkIcon(channelIcon(c.visibility), null, size = 16.dp, tint = colors.text3)
        Column(Modifier.weight(1f)) {
            Text(c.name, style = Rk.type.text13.medium, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(meta, style = Rk.type.text12, color = colors.text3, maxLines = 1)
        }
        when {
            archived -> Unit
            joined -> Tag(stringResource(R.string.chat_channel_joined))
            else -> {
                if (busy) Spinner(size = 14.dp)
                RkButton(stringResource(R.string.chat_channel_join), onJoin, kind = RkButtonKind.SECONDARY, size = RkButtonSize.SMALL, enabled = !busy)
            }
        }
    }
}

// ---- Details (contract §7.4) ----

/**
 * A room's details. A channel: its visibility and members, then Mute, Mark as read, Members, Add people, Rename,
 * Archive and Leave as [SheetRules.detailActions] allows. A DM: its people, then Mute, Mark as read, Leave conversation
 * (Remove from list once closed) and Block or Unblock in a one-to-one DM.
 */
@Composable
private fun DetailsSheet(app: AppViewModel, target: String, twoPane: Boolean, onDismiss: () -> Unit) {
    val ui = app.chatUi
    val view = selectedView(app) ?: return
    val room = view.rooms.firstOrNull { it.id == target } ?: return LaunchedEffect(Unit) { onDismiss() }
    val ws = view.ws.id
    val names = rememberChatNames()
    val members = remember(view) { view.members.associateBy { it.id } }
    val blocked = remember(view) { view.blocks.mapTo(HashSet()) { it.member } }
    val me = view.me.id
    val title = if (room.kind == RoomKind.DM) names.title(room, members, me) else "#${room.name.orEmpty()}"
    val subtitle = if (room.kind == RoomKind.DM) {
        stringResource(R.string.chat_head_direct, app.chatState.value.host)
    } else {
        val people = pluralStringResource(R.plurals.chat_head_members, room.members, room.members)
        val count = if (room.agents > 0) "$people · ${pluralStringResource(R.plurals.chat_head_agents, room.agents, room.agents)}" else people
        if (room.visibility == "private") "$count · ${stringResource(R.string.chat_head_private)}" else "$count · ${stringResource(R.string.chat_channel_public, view.ws.name)}"
    }
    val other = room.participants.orEmpty().distinct().filter { it != me }.singleOrNull()
    val otherName = other?.let { names.display(members[it]) }.orEmpty()
    val chat by app.chatState.collectAsStateWithLifecycle()

    SheetFrame(twoPane, title, onDismiss, subtitle = subtitle) { close ->
        if (room.kind == RoomKind.DM) {
            val count = room.participants.orEmpty().distinct().size
            SheetHeading(pluralStringResource(R.plurals.chat_head_members, count, count), Modifier.padding(start = 4.dp))
            for (id in room.participants.orEmpty().distinct()) {
                val m = members[id]
                val label = if (id == me) stringResource(R.string.chat_members_you, names.display(m)) else names.display(m)
                PersonRow(id, m, label, tags = memberTags(m) + if (id in blocked) listOf(stringResource(R.string.chat_members_blocked)) else emptyList())
            }
            SheetDivider()
        }
        val ownAgents = remember(view, chat.agents) { AgentRules.ownAgents(view.members, me, chat.agents) }
        for (action in SheetRules.detailActions(room, view.me.role, me, blocked, takesWrites(app, ws), ownAgents)) {
            when (action) {
                // Mute silences mentions too, so the row says so before it's chosen.
                DetailAction.MUTE -> SheetRow(stringResource(R.string.chat_head_mute), icon = RukooIcons.BellOff, hint = stringResource(R.string.chat_head_mute_hint), onClick = {
                    close()
                    ui.mute(ws, room.id, title, true)
                })
                DetailAction.UNMUTE -> SheetRow(stringResource(R.string.chat_head_unmute), icon = RukooIcons.Bell, onClick = {
                    close()
                    ui.mute(ws, room.id, title, false)
                })
                DetailAction.MARK_READ -> SheetRow(stringResource(R.string.chat_head_mark_read), icon = RukooIcons.Check, enabled = room.unread > 0 || room.mentions > 0, onClick = {
                    close()
                    ui.markRead(ws, room.id)
                })
                DetailAction.MEMBERS -> SheetRow(stringResource(R.string.chat_head_members_button), icon = RukooIcons.People, onClick = { app.openChatSheet(ChatSheet.MEMBERS, room.id) })
                DetailAction.ADD_PEOPLE -> SheetRow(stringResource(R.string.chat_head_add_people), icon = RukooIcons.Plus, onClick = { app.openChatSheet(ChatSheet.ADD_PEOPLE, room.id) })
                DetailAction.ADD_AGENTS -> SheetRow(stringResource(R.string.chat_channel_add_agents), icon = RukooIcons.Sparkle, onClick = { app.openChatSheet(ChatSheet.ADD_PEOPLE, room.id) })
                DetailAction.RENAME -> SheetRow(stringResource(R.string.chat_head_rename), icon = RukooIcons.Edit, onClick = {
                    close()
                    ui.askRenameChannel(ws, room)
                })
                DetailAction.ARCHIVE -> SheetRow(stringResource(R.string.chat_head_archive), icon = RukooIcons.Archive, onClick = {
                    close()
                    ui.askArchive(ws, room)
                })
                DetailAction.LEAVE_CHANNEL -> SheetRow(stringResource(R.string.chat_head_leave), icon = RukooIcons.Back, danger = true, onClick = {
                    close()
                    ui.askLeaveChannel(ws, room, members, me)
                })
                DetailAction.LEAVE_DM -> SheetRow(stringResource(R.string.chat_head_leave_dm), icon = RukooIcons.Back, danger = true, onClick = {
                    close()
                    ui.askLeaveDm(ws, room, names.everyoneElse(room.participants, members, me))
                })
                DetailAction.REMOVE_FROM_LIST -> SheetRow(stringResource(R.string.chat_input_remove_from_list), icon = RukooIcons.Trash, onClick = {
                    close()
                    ui.askLeaveDm(ws, room, names.everyoneElse(room.participants, members, me))
                })
                DetailAction.BLOCK -> SheetRow(stringResource(R.string.chat_head_block, otherName), icon = RukooIcons.Ban, danger = true, onClick = {
                    close()
                    other?.let { ui.askBlock(ws, it, otherName) }
                })
                DetailAction.UNBLOCK -> SheetRow(stringResource(R.string.chat_block_unblock), icon = RukooIcons.Ban, onClick = {
                    other?.let { ui.unblockMember(ws, it, otherName) }
                })
            }
        }
    }
}

// ---- Members (desktop-ui 6.6, 6.15) ----

/** The workspace's members ([target] null) or a channel's ([target] its ID). */
@Composable
private fun MembersSheet(app: AppViewModel, target: String?, twoPane: Boolean, onDismiss: () -> Unit) {
    val view = selectedView(app) ?: return
    if (target == null) {
        WorkspaceMembers(app, view, twoPane, onDismiss)
    } else {
        val room = view.rooms.firstOrNull { it.id == target } ?: return LaunchedEffect(Unit) { onDismiss() }
        RoomMembers(app, view, room, twoPane, onDismiss)
    }
}

/**
 * The workspace's active members grouped by role, found by name, each with a menu of what the person may do to them
 * ([SheetRules.memberActions]): Message, Change role, Block or Unblock, Remove from workspace. Agents come last in a
 * group of their own, each with who made it and whom it answers, and Edit agent and Remove agent for its sponsor,
 * owners and admins, with New key between them for its sponsor. Edit agent and a new key open the Agents sheet, which
 * comes back here.
 */
@Composable
private fun WorkspaceMembers(app: AppViewModel, view: WorkspaceView, twoPane: Boolean, onDismiss: () -> Unit) {
    val ui = app.chatUi
    val ws = view.ws.id
    val chat by app.chatState.collectAsStateWithLifecycle()
    val names = rememberChatNames()
    val compare = rememberCompare()
    val blocked = remember(view) { view.blocks.mapTo(HashSet()) { it.member } }
    val byId = remember(view) { view.members.associateBy { it.id } }
    val writable = takesWrites(app, ws)
    var query by remember { mutableStateOf("") }
    val groups = remember(view, query, compare) {
        val list = view.members.filter { it.state == "active" && SheetRules.matches(it.name, query) }.sortedWith { a, b -> compare.compare(a.name, b.name) }
        val people = listOf("owner", "admin", "member", "guest").map { role -> role to list.filter { !it.isAgent && it.role == role } }
        (people + (Member.KIND_AGENT to list.filter { it.isAgent })).filter { it.second.isNotEmpty() }
    }
    SheetFrame(
        twoPane,
        stringResource(R.string.chat_members_title, view.ws.name),
        onDismiss,
        buttons = { close -> Secondary(stringResource(R.string.common_actions_close)) { close() } },
    ) { close ->
        Form { RkSearchField(query, { query = it }, placeholder = stringResource(R.string.chat_members_search)) }
        Column {
            if (groups.isEmpty()) Form { Help(stringResource(R.string.chat_new_none)) }
            for ((role, people) in groups) {
                SheetHeading(
                    stringResource(
                        when (role) {
                            "owner" -> R.string.chat_roles_owners
                            "admin" -> R.string.chat_roles_admins
                            "member" -> R.string.chat_roles_members
                            Member.KIND_AGENT -> R.string.chat_roles_agents
                            else -> R.string.chat_roles_guests
                        },
                    ),
                    Modifier.padding(start = 4.dp),
                    // The only place this sheet shows anyone's role, so in text2 like desktop's .ch-group.
                    color = Rk.colors.text2,
                )
                for (m in people) {
                    val name = names.display(m)
                    val label = if (m.id == view.me.id) stringResource(R.string.chat_members_you, name) else name
                    val actions = SheetRules.memberActions(view.me.role, view.me.id, m, blocked, writable, agents = chat.agents)
                    PersonRow(
                        m.id,
                        m,
                        label,
                        tags = if (m.id in blocked) listOf(stringResource(R.string.chat_members_blocked)) else emptyList(),
                        note = if (m.isAgent) agentNote(m.agent, byId) else null,
                        trailing = if (actions.isEmpty()) null else {
                            {
                                MemberMenu(stringResource(R.string.chat_members_more, name)) { dismissMenu ->
                                    // Message, then the roles under their heading, then Block, then Remove, each group apart.
                                    // An agent's: Edit agent and New key, then Remove agent.
                                    val roles = actions.mapNotNull { SheetRules.roleOf(it) }
                                    var first = true
                                    fun gap() = !first
                                    if (MemberAction.EDIT_AGENT in actions) {
                                        RkMenuItem(stringResource(R.string.chat_agents_edit), icon = RukooIcons.Edit, onClick = {
                                            dismissMenu()
                                            app.openChatSheet(ChatSheet.AGENTS, AgentRules.editTarget(m.id))
                                        })
                                        first = false
                                    }
                                    if (MemberAction.AGENT_KEY in actions) {
                                        RkMenuItem(stringResource(R.string.chat_agents_new_key), icon = KeyIcon, enabled = !ui.isBusy(ui.agentKeyKey(m.id)), onClick = {
                                            dismissMenu()
                                            ui.askNewAgentKey(ws, m.id, name) { made ->
                                                ui.holdAgentKey(ws, made)
                                                app.openChatSheet(ChatSheet.AGENTS, AgentRules.keyTarget(m.id))
                                            }
                                        })
                                        first = false
                                    }
                                    if (MemberAction.MESSAGE in actions) {
                                        RkMenuItem(stringResource(R.string.chat_members_message), icon = ChatIcons.Bubble, onClick = {
                                            dismissMenu()
                                            close()
                                            ui.message(ws, m.id, view.rooms, view.me.id)
                                        })
                                        first = false
                                    }
                                    if (roles.isNotEmpty()) {
                                        if (gap()) MenuSeparator()
                                        MenuHeading(stringResource(R.string.chat_members_change_role))
                                        for (role in roles) {
                                            RkMenuItem(roleName(role), checked = m.role == role, onClick = {
                                                dismissMenu()
                                                if (m.role != role) ui.changeRole(ws, m.id, name, m.role, role)
                                            })
                                        }
                                        first = false
                                    }
                                    if (MemberAction.BLOCK in actions || MemberAction.UNBLOCK in actions) {
                                        if (gap()) MenuSeparator()
                                        if (MemberAction.UNBLOCK in actions) {
                                            RkMenuItem(stringResource(R.string.chat_block_unblock), icon = RukooIcons.Ban, onClick = {
                                                dismissMenu()
                                                ui.unblockMember(ws, m.id, name)
                                            })
                                        } else {
                                            RkMenuItem(stringResource(R.string.chat_head_block, name), icon = RukooIcons.Ban, onClick = {
                                                dismissMenu()
                                                ui.askBlock(ws, m.id, name)
                                            })
                                        }
                                        first = false
                                    }
                                    if (MemberAction.REMOVE in actions) {
                                        if (gap()) MenuSeparator()
                                        if (m.isAgent) {
                                            RkMenuItem(stringResource(R.string.chat_agents_remove), icon = RukooIcons.Trash, danger = true, onClick = {
                                                dismissMenu()
                                                ui.askRemoveAgent(ws, m.id, name)
                                            })
                                        } else {
                                            RkMenuItem(stringResource(R.string.chat_members_remove), icon = RukooIcons.Trash, danger = true, onClick = {
                                                dismissMenu()
                                                ui.askRemoveMember(ws, m.id, name)
                                            })
                                        }
                                    }
                                }
                            }
                        },
                    )
                }
            }
        }
    }
}

/** A More button that opens a menu next to it. */
@Composable
internal fun MemberMenu(label: String, items: @Composable ColumnScope.(dismiss: () -> Unit) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        RkIconButton(RukooIcons.More, label, onClick = { open = true }, size = RkIconButtonSize.SMALL)
        RkDropdownMenu(expanded = open, onDismissRequest = { open = false }) { items { open = false } }
    }
}

@Composable
internal fun MenuSeparator() {
    Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).heightIn(min = 1.dp).background(Rk.colors.border))
}

@Composable
private fun MenuHeading(text: String) {
    Text(text, style = Rk.type.text11_5.semibold, color = Rk.colors.text3, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
}

/**
 * A channel's members from the server, found by name, with Guest, Agent and Manager tags. Its managers get Add people
 * and a menu per person: Make manager or Make member, and Remove from the channel. An agent's row says who made it
 * and whom it answers, and offers only Remove, to the managers and its sponsor; a sponsor who doesn't manage a
 * channel the workspace sees gets Add agents while the server has agents on. Leave channel sits at the end; a DM
 * shows its people.
 */
@Composable
private fun RoomMembers(app: AppViewModel, view: WorkspaceView, room: Room, twoPane: Boolean, onDismiss: () -> Unit) {
    val ui = app.chatUi
    val workspaces = app.services.workspaces ?: return
    val ws = view.ws.id
    val names = rememberChatNames()
    val compare = rememberCompare()
    val members = remember(view) { view.members.associateBy { it.id } }
    var query by remember { mutableStateOf("") }
    var list by remember { mutableStateOf<List<RoomMember>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(room.id, room.members, room.agents, reload) {
        try {
            list = workspaces.roomMembers(ws, room.id)
            error = null
        } catch (e: kotlin.coroutines.cancellation.CancellationException) {
            throw e
        } catch (e: Exception) {
            error = ui.errorText(e)
        }
    }
    val writable = takesWrites(app, ws)
    val manager = room.kind == RoomKind.CHANNEL && room.role == "manager" && !room.archived && writable
    val chat by app.chatState.collectAsStateWithLifecycle()
    val addAgents = writable && room.role != "manager" && AgentRules.sponsorAdds(room, AgentRules.ownAgents(view.members, view.me.id, chat.agents))
    val shown = remember(list, query, members, compare) {
        list.orEmpty().filter { SheetRules.matches(names.display(members[it.member]), query) }
            .sortedWith { a, b -> compare.compare(names.display(members[a.member]), names.display(members[b.member])) }
    }
    val title = if (room.kind == RoomKind.CHANNEL) stringResource(R.string.chat_channel_members_title, room.name.orEmpty()) else names.title(room, members, view.me.id)
    SheetFrame(
        twoPane,
        title,
        onDismiss,
        buttons = { close ->
            if (room.kind == RoomKind.CHANNEL && writable) {
                RkLinkButton(stringResource(R.string.chat_head_leave), onClick = {
                    close()
                    ui.askLeaveChannel(ws, room, members, view.me.id)
                }, color = Rk.colors.danger, style = Rk.type.text13.semibold)
            }
            Secondary(stringResource(R.string.common_actions_close)) { close() }
        },
    ) {
        Form {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) { RkSearchField(query, { query = it }, placeholder = stringResource(R.string.chat_members_search)) }
                if (manager) {
                    RkButton(stringResource(R.string.chat_head_add_people), { app.openChatSheet(ChatSheet.ADD_PEOPLE, room.id) }, kind = RkButtonKind.SECONDARY, size = RkButtonSize.FIELD, icon = RukooIcons.Plus)
                }
                if (addAgents) {
                    RkButton(stringResource(R.string.chat_channel_add_agents), { app.openChatSheet(ChatSheet.ADD_PEOPLE, room.id) }, kind = RkButtonKind.SECONDARY, size = RkButtonSize.FIELD, icon = RukooIcons.Plus)
                }
            }
        }
        Column {
            when {
                list == null && error == null -> Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { Spinner(size = 16.dp) }
                list != null && shown.isEmpty() -> Form { Help(stringResource(R.string.chat_new_none)) }
            }
            for (rm in shown) {
                val m = members[rm.member]
                val name = names.display(m)
                val label = if (rm.member == view.me.id) stringResource(R.string.chat_members_you, name) else name
                val actions = SheetRules.channelMemberActions(room, view.me.id, rm, writable, m)
                PersonRow(
                    rm.member,
                    m,
                    label,
                    tags = memberTags(m),
                    pill = if (rm.role == "manager" && room.kind == RoomKind.CHANNEL) stringResource(R.string.chat_roles_manager) else null,
                    note = if (m?.isAgent == true) agentNote(m.agent, members) else null,
                    trailing = if (actions.isEmpty()) null else {
                        {
                            MemberMenu(stringResource(R.string.chat_members_more, name)) { dismissMenu ->
                                for (action in actions) {
                                    when (action) {
                                        ChannelMemberAction.MAKE_MANAGER -> RkMenuItem(stringResource(R.string.chat_channel_make_manager), icon = RukooIcons.People, onClick = {
                                            dismissMenu()
                                            ui.changeChannelRole(ws, room.id, rm.member, name, "manager") { reload++ }
                                        })
                                        ChannelMemberAction.MAKE_MEMBER -> RkMenuItem(stringResource(R.string.chat_channel_make_member), icon = RukooIcons.Person, onClick = {
                                            dismissMenu()
                                            ui.changeChannelRole(ws, room.id, rm.member, name, "member") { reload++ }
                                        })
                                        ChannelMemberAction.REMOVE -> {
                                            // An agent's menu has only Remove, with nothing above it to set apart.
                                            if (actions.size > 1) MenuSeparator()
                                            RkMenuItem(stringResource(R.string.chat_channel_remove_member, room.name.orEmpty()), icon = RukooIcons.Trash, danger = true, onClick = {
                                                dismissMenu()
                                                ui.askRemoveFromChannel(ws, room, rm.member, name)?.invokeOnCompletion { reload++ }
                                            })
                                        }
                                    }
                                }
                            }
                        }
                    },
                )
            }
        }
        error?.let { Form { ErrorLine(it) } }
    }
}

// ---- Add people to a channel (desktop-ui 6.6) ----

private const val KEY_ADD = "sheet:addPeople"

/**
 * Members who aren't in the channel, found by name, with check boxes. A guest needs an owner or admin, so their row is
 * off for anyone else. The agents the person may add ([AgentRules.addable]) come after them under an Agents heading
 * and the line about what agents pass on, each saying whom it answers: any agent whose sponsor may see the channel for
 * a manager, and their own agents for a sponsor in a channel the workspace sees, who gets only that group, worded Add
 * agents. People get a heading of their own when both groups show. Add adds them one by one; the ones that failed are
 * named.
 */
@Composable
private fun AddPeopleSheet(app: AppViewModel, target: String, twoPane: Boolean, onDismiss: () -> Unit) {
    val ui = app.chatUi
    val workspaces = app.services.workspaces ?: return
    val view = selectedView(app) ?: return
    val room = view.rooms.firstOrNull { it.id == target } ?: return LaunchedEffect(Unit) { onDismiss() }
    val ws = view.ws.id
    val names = rememberChatNames()
    val compare = rememberCompare()
    var inside by remember { mutableStateOf<Set<String>?>(null) }
    var query by remember { mutableStateOf("") }
    var chosen by remember { mutableStateOf(setOf<String>()) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    val busy = ui.isBusy(KEY_ADD)
    LaunchedEffect(room.id, reload) {
        try {
            inside = workspaces.roomMembers(ws, room.id).mapTo(HashSet()) { it.member }
        } catch (e: kotlin.coroutines.cancellation.CancellationException) {
            throw e
        } catch (e: Exception) {
            error = ui.errorText(e)
        }
    }
    // A sponsor who doesn't manage the channel adds only their own agents; the server takes people from managers.
    val manager = room.role == "manager"
    val byId = remember(view) { view.members.associateBy { it.id } }
    val candidates = remember(view, inside, compare, manager) { inside?.let { if (manager) SheetRules.addCandidates(view.members, it, compare) else emptyList() } }
    val chat by app.chatState.collectAsStateWithLifecycle()
    val agents = remember(view, inside, compare, chat.agents) { inside?.let { AgentRules.addable(view.members, it, room, view.me.id, compare, on = chat.agents) } }
    val shown = candidates.orEmpty().filter { SheetRules.matches(it.name, query) }
    val shownAgents = agents.orEmpty().filter { SheetRules.matches(it.name, query) }
    val locked = stringResource(R.string.chat_channel_add_guest_needs_admin)
    val guest = stringResource(R.string.chat_roles_guest)

    fun submit() {
        val ids = chosen.toList()
        if (ids.isEmpty()) return
        error = null
        ui.attempt(KEY_ADD, failed = { e -> error = ui.errorText(e) }) {
            val failed = ArrayList<String>()
            var first: Exception? = null
            for (id in ids) {
                try {
                    addToChannel(ws, room.id, id)
                    chosen = chosen - id
                } catch (e: kotlin.coroutines.cancellation.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    failed += names.display(view.members.firstOrNull { it.id == id })
                    if (first == null) first = e
                }
            }
            val problem = first
            if (problem == null) {
                app.openChatSheet(ChatSheet.MEMBERS, room.id)
            } else {
                error = "${ui.strings.get(R.string.chat_channel_add_failed, names.list(failed))} ${ui.errorText(problem)}"
                reload++
            }
        }
    }

    SheetFrame(
        twoPane,
        stringResource(if (manager) R.string.chat_channel_add_title else R.string.chat_channel_add_agents_title, room.name.orEmpty()),
        onDismiss,
        buttons = { close ->
            Secondary(stringResource(R.string.common_actions_cancel)) { close() }
            Primary(stringResource(R.string.common_actions_add), busy = busy, enabled = chosen.isNotEmpty(), onClick = ::submit)
        },
    ) {
        Form { RkSearchField(query, { query = it }, placeholder = stringResource(R.string.chat_members_search)) }
        Column {
            when {
                candidates == null && error == null -> Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { Spinner(size = 16.dp) }
                // Only their own agents to add: a search that finds none, or all of them in already.
                !manager && candidates != null && shownAgents.isEmpty() ->
                    Form { Help(if (query.isNotBlank()) stringResource(R.string.chat_new_none) else stringResource(R.string.chat_agents_all_in, room.name.orEmpty())) }
                candidates != null && shown.isEmpty() && shownAgents.isEmpty() -> {
                    // Nobody to add: say whether the workspace has nobody else or everyone is in already, with Invite people.
                    val others = view.members.count { it.state == "active" && it.id != view.me.id && !it.isAgent }
                    when (SheetRules.addPeopleEmpty(shown.size, candidates.size + agents.orEmpty().size, others, query)) {
                        PickerEmpty.NONE -> Form { Help(stringResource(R.string.chat_new_none)) }
                        PickerEmpty.EVERYONE -> NobodyElse(stringResource(R.string.chat_channel_add_everyone, view.ws.name, room.name.orEmpty()), SheetRules.canInvite(view.me.role)) {
                            app.openChatSheet(ChatSheet.INVITE)
                        }
                        PickerEmpty.NOBODY -> NobodyElse(stringResource(R.string.chat_new_nobody, view.ws.name), SheetRules.canInvite(view.me.role)) {
                            app.openChatSheet(ChatSheet.INVITE)
                        }
                        null -> Unit
                    }
                }
            }
            // A heading over the people only when agents are listed under them.
            if (shown.isNotEmpty() && shownAgents.isNotEmpty()) SheetHeading(stringResource(R.string.chat_channel_people_group), Modifier.padding(start = 4.dp))
            for (m in shown) {
                val off = SheetRules.guestLocked(m, view.me.role)
                CheckRow(
                    names.display(m),
                    checked = m.id in chosen,
                    enabled = !off && !busy,
                    note = if (off) locked else null,
                    tag = if (m.role == "guest") guest else null,
                    onChange = { now -> chosen = if (now) chosen + m.id else chosen - m.id },
                    leading = { Avatar(m.name, m.id, size = 24.dp) },
                )
            }
            if (shownAgents.isNotEmpty()) {
                // What adding one means for the channel's messages, before anyone is picked.
                SheetHeading(stringResource(R.string.chat_roles_agents), Modifier.padding(start = 4.dp))
                Form { Help(stringResource(R.string.chat_host_agents)) }
                for (m in shownAgents) {
                    CheckRow(
                        names.display(m),
                        checked = m.id in chosen,
                        enabled = !busy,
                        note = agentAnswersText(m.agent, byId),
                        onChange = { now -> chosen = if (now) chosen + m.id else chosen - m.id },
                        leading = { Avatar(m.name, m.id, size = 24.dp, agent = true) },
                    )
                }
            }
        }
        error?.let { Form { ErrorLine(it) } }
    }
}

// ---- Invite people (desktop-ui 6.3, contract §3.2, §3.16) ----

private const val KEY_INVITE = "sheet:invite"

/**
 * Member or Guest, the channels the person manages (a guest needs one, 20 at most), and 1, 3 or 7 days. Make link
 * shows the link once, with Share and Copy, both marked sensitive, and a line that says what it grants. Until the link
 * is shared or copied, Share link is the filled button and closing the sheet asks first. Open invitations sit below,
 * each with Withdraw; withdrawing the link on screen says it no longer works. A guest with no channel to pick gets
 * New channel instead.
 */
@Composable
private fun InviteSheet(app: AppViewModel, twoPane: Boolean, onDismiss: () -> Unit) {
    val ui = app.chatUi
    val workspaces = app.services.workspaces ?: return
    val view = selectedView(app) ?: return
    val ws = view.ws.id
    val context = LocalContext.current
    val names = rememberChatNames()
    val compare = rememberCompare()
    val managed = remember(view, compare) { SheetRules.managedChannels(view.rooms, compare) }
    var role by remember { mutableStateOf("member") }
    var chosen by remember { mutableStateOf(setOf<String>()) }
    var days by remember { mutableIntStateOf(SheetRules.INVITE_DAYS.first()) }
    var made by remember { mutableStateOf<MadeInvite?>(null) }
    var madeNames by remember { mutableStateOf(emptyList<String>()) }
    var kept by remember { mutableStateOf(false) }
    var withdrawn by remember { mutableStateOf(false) }
    var asking by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var invites by remember { mutableStateOf<List<Invite>?>(null) }
    var invitesError by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    val busy = ui.isBusy(KEY_INVITE)
    LaunchedEffect(ws, reload) {
        try {
            invites = workspaces.invites(ws).sortedByDescending { it.createdAt }
            invitesError = null
        } catch (e: kotlin.coroutines.cancellation.CancellationException) {
            throw e
        } catch (e: Exception) {
            invitesError = ui.errorText(e)
        }
    }
    val copied = stringResource(R.string.chat_invite_copied)
    val shareTitle = stringResource(R.string.chat_invite_share)
    val asks = SheetRules.inviteCloseAsks(made != null, kept, withdrawn)
    // A swipe, a tap outside, Back or Done before the link was shared or copied asks first. While the link is being
    // made the sheet stays put: closing it then would lose a link the server already made.
    val holdClose: () -> Boolean = {
        val making = ui.isBusy(KEY_INVITE)
        if (!making && SheetRules.inviteCloseAsks(made != null, kept, withdrawn)) asking = true
        SheetRules.inviteCloseHeld(making, made != null, kept, withdrawn)
    }

    fun submit() {
        if (!SheetRules.inviteReady(role, chosen.size)) return
        error = null
        val picked = managed.filter { it.id in chosen }
        val expiresIn = days * 86_400L
        ui.attempt(KEY_INVITE, failed = { e -> error = ui.errorText(e) }) {
            val invite = createInvite(ws, role, picked.map { it.id }, expiresIn)
            madeNames = picked.map { it.name.orEmpty() }.filter { it.isNotEmpty() }
            made = invite
            reload++
        }
    }

    SheetFrame(
        twoPane,
        stringResource(R.string.chat_invite_title, view.ws.name),
        onDismiss,
        holdClose = holdClose,
        buttons = { close ->
            if (made != null) {
                if (asks) {
                    Secondary(stringResource(R.string.chat_invite_done)) { asking = true }
                } else {
                    Primary(stringResource(R.string.chat_invite_done), busy = false) { close() }
                }
            } else {
                Secondary(stringResource(R.string.common_actions_cancel), enabled = !busy) { close() }
                Primary(stringResource(R.string.chat_invite_make), busy = busy, enabled = SheetRules.inviteReady(role, chosen.size), onClick = ::submit)
            }
        },
    ) { close ->
        val result = made
        if (result != null) {
            val channels = SheetRules.inviteChannelList(
                madeNames,
                and = { list, last -> context.getString(R.string.chat_invite_list_and, list, last) },
                more = { list, n -> context.getString(R.string.chat_invite_list_more, list, n) },
            )
            val until = dateTime(result.invite.expiresAt.takeIf { it > 0 } ?: (System.currentTimeMillis() + days * 86_400_000L))
            val grant = SheetRules.inviteGrant(
                result.invite.role.ifEmpty { role },
                channels,
                guest = { context.getString(R.string.chat_invite_ready_guest, it, until) },
                memberIn = { context.getString(R.string.chat_invite_ready_member_in, it, until) },
                member = { context.getString(R.string.chat_invite_ready_member, until) },
            )
            Form {
                RkTextField(value = result.link, onValueChange = {}, label = stringResource(R.string.chat_join_link), readOnly = true, singleLine = false, maxLines = 3, mono = true, enabled = !withdrawn)
                Help(if (withdrawn) stringResource(R.string.chat_invite_withdrawn) else grant)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RkButton(stringResource(R.string.chat_invite_share), {
                        kept = true
                        shareSensitive(context, result.link, shareTitle)
                    }, kind = if (asks) RkButtonKind.PRIMARY else RkButtonKind.SECONDARY, size = RkButtonSize.SMALL, icon = RukooIcons.Export, enabled = !withdrawn)
                    RkButton(stringResource(R.string.chat_invite_copy), {
                        kept = true
                        copyLink(context, result.link)
                        ui.toasts.showToast(copied)
                    }, kind = RkButtonKind.SECONDARY, size = RkButtonSize.SMALL, icon = PanelIcons.Copy, enabled = !withdrawn)
                }
                if (!withdrawn) Help(stringResource(R.string.chat_invite_once))
            }
        } else {
            Form {
                Text(stringResource(R.string.chat_invite_role), style = Rk.type.text12_5, color = Rk.colors.text2)
                Segmented(
                    listOf("member" to stringResource(R.string.chat_roles_member), "guest" to stringResource(R.string.chat_roles_guest)),
                    selected = role,
                    label = stringResource(R.string.chat_invite_role),
                ) { role = it }
                Help(stringResource(if (role == "guest") R.string.chat_invite_guest_hint else R.string.chat_invite_member_hint))
                Text(stringResource(R.string.chat_invite_channels), style = Rk.type.text12_5, color = Rk.colors.text2)
            }
            Column {
                if (managed.isEmpty()) {
                    Form {
                        if (role == "guest") {
                            // A guest can only be added to channels the person manages: say so, and offer to make one.
                            Help(stringResource(R.string.chat_invite_guest_no_channels))
                            RkButton(
                                stringResource(R.string.chat_invite_new_channel),
                                { app.openChatSheet(ChatSheet.NEW_CHANNEL) },
                                kind = RkButtonKind.SECONDARY,
                                size = RkButtonSize.SMALL,
                                icon = RukooIcons.Plus,
                            )
                        } else {
                            Help(stringResource(R.string.chat_invite_channels_none))
                        }
                    }
                }
                for (r in managed) {
                    val on = r.id in chosen
                    CheckRow(
                        r.name.orEmpty(),
                        checked = on,
                        enabled = !busy && (on || chosen.size < SheetRules.INVITE_CHANNELS_MAX),
                        onChange = { now -> chosen = if (now) chosen + r.id else chosen - r.id },
                        leading = { RkIcon(channelIcon(r.visibility), null, size = 16.dp, tint = Rk.colors.text3) },
                    )
                }
            }
            Form {
                if (role == "guest" && chosen.isEmpty() && managed.isNotEmpty()) Help(stringResource(R.string.chat_invite_guest_needs_channel), warn = true)
                Text(stringResource(R.string.chat_invite_expires), style = Rk.type.text12_5, color = Rk.colors.text2)
                Segmented(
                    SheetRules.INVITE_DAYS.map { it to pluralStringResource(R.plurals.chat_invite_days, it, it) },
                    selected = days,
                    label = stringResource(R.string.chat_invite_expires),
                ) { days = it }
                error?.let { ErrorLine(it) }
            }
        }
        SheetDivider()
        SheetHeading(stringResource(R.string.chat_invite_open), Modifier.padding(start = 4.dp))
        val list = invites
        Column {
            when {
                list == null && invitesError == null -> Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) { Spinner(size = 16.dp) }
                list != null && list.isEmpty() -> Form { Help(stringResource(R.string.chat_invite_none)) }
            }
            invitesError?.let { Form { ErrorLine(it) } }
            for (i in list.orEmpty()) {
                val channelNames = i.channels
                    .map { id -> view.rooms.firstOrNull { it.id == id }?.name ?: view.channels.firstOrNull { it.id == id }?.name.orEmpty() }
                    .filter { it.isNotEmpty() }
                    .sortedWith(compare)
                InviteRow(
                    i,
                    channelNames,
                    issuer = names.display(view.members.firstOrNull { it.id == i.issuer }),
                    busy = ui.isBusy("withdraw:${i.id}"),
                    onWithdraw = {
                        ui.launch("withdraw:${i.id}", ui.context(ws)) {
                            withdrawInvite(ws, i.id)
                            // The link on screen no longer works: say so, and nothing shares or copies it.
                            if (i.id == made?.invite?.id) withdrawn = true
                        }?.invokeOnCompletion { reload++ }
                    },
                )
            }
        }
        if (asking) {
            RkDialog(
                title = stringResource(R.string.chat_invite_close_title),
                text = stringResource(R.string.chat_invite_close_body),
                confirmLabel = stringResource(R.string.common_actions_close),
                dismissLabel = stringResource(R.string.chat_invite_go_back),
                onConfirm = {
                    asking = false
                    kept = true
                    close()
                },
                onDismiss = { asking = false },
            )
        }
    }
}

/** An open invitation: the role, its channels by name, until when and by whom, with Withdraw. */
@Composable
private fun InviteRow(invite: Invite, channelNames: List<String>, issuer: String, busy: Boolean, onWithdraw: () -> Unit) {
    val c = Rk.colors
    val context = LocalContext.current
    val channels = SheetRules.inviteRowChannels(channelNames, invite.channelCount) { shown, n -> context.getString(R.string.chat_invite_names_more, shown, n) }
        ?: pluralStringResource(R.plurals.chat_invite_channel_count, invite.channelCount, invite.channelCount)
    val meta = listOf(
        channels,
        stringResource(R.string.chat_invite_until, dateTime(invite.expiresAt)),
        stringResource(R.string.chat_invite_by, issuer),
    ).joinToString(" · ")
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(start = 20.dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(roleName(invite.role), style = Rk.type.text13.medium, color = c.text, maxLines = 1)
            Text(meta, style = Rk.type.text12, color = c.text3, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        RkLinkButton(stringResource(R.string.chat_invite_withdraw), onClick = onWithdraw, color = c.danger, enabled = !busy, style = Rk.type.text12_5.medium)
    }
}

/** The clip of an invitation link, marked sensitive so Android keeps it out of previews and suggestions. */
internal fun sensitiveClip(link: String): ClipData {
    val clip = ClipData.newPlainText("Rukoo", link)
    val key = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE"
    clip.description.extras = PersistableBundle().apply { putBoolean(key, true) }
    return clip
}

private fun copyLink(context: Context, link: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(sensitiveClip(link))
}

/** Shares an invitation link as text, its clip marked sensitive like the copy. */
private fun shareSensitive(context: Context, link: String, title: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link)
    send.clipData = sensitiveClip(link)
    runCatching { context.startActivity(Intent.createChooser(send, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

// ---- Blocked people (desktop-ui 6.13, 6.16) ----

/** The person's blocks, by name, each with Unblock (no question). */
@Composable
private fun BlockedSheet(app: AppViewModel, twoPane: Boolean, onDismiss: () -> Unit) {
    val ui = app.chatUi
    val view = selectedView(app) ?: return
    val ws = view.ws.id
    val names = rememberChatNames()
    val compare = rememberCompare()
    val members = remember(view) { view.members.associateBy { it.id } }
    val blocks = remember(view, compare) { view.blocks.sortedWith { a, b -> compare.compare(names.display(members[a.member]), names.display(members[b.member])) } }
    SheetFrame(
        twoPane,
        stringResource(R.string.chat_block_list),
        onDismiss,
        buttons = { close -> Secondary(stringResource(R.string.common_actions_close)) { close() } },
    ) {
        Column {
            if (blocks.isEmpty()) Form { Help(stringResource(R.string.chat_block_none)) }
            for (b in blocks) {
                val m = members[b.member]
                val name = names.display(m)
                PersonRow(b.member, m, name, tags = memberTags(m), trailing = {
                    val busy = ui.isBusy("block:${b.member}")
                    RkButton(stringResource(R.string.chat_block_unblock), { ui.unblockMember(ws, b.member, name) }, kind = RkButtonKind.SECONDARY, size = RkButtonSize.SMALL, enabled = !busy)
                })
            }
        }
    }
}

// ---- prompts (ChatUi.prompt) ----

/**
 * Who takes a channel over: a radio row per person, nothing picked until the person chooses, and a search field above
 * more than [SheetRules.SUCCESSOR_SEARCH_FROM] people; the picked row stays through a search. [people] null shows a
 * spinner while they load. [nobody] replaces "Nobody found" when the list is empty before any search.
 */
@Composable
private fun SuccessorPicker(people: List<Member>?, pick: String?, nobody: (@Composable () -> Unit)? = null, onPick: (String) -> Unit) {
    val names = rememberChatNames()
    var query by remember { mutableStateOf("") }
    if (people != null && SheetRules.successorSearch(people.size)) {
        Form { RkSearchField(query, { query = it }, placeholder = stringResource(R.string.chat_members_search)) }
    }
    val shown = SheetRules.pickerShown(people.orEmpty(), query, pick) { names.display(it) }
    Column(Modifier.selectableGroup()) {
        when {
            people == null -> Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { Spinner(size = 16.dp) }
            people.isEmpty() && nobody != null -> nobody()
            shown.isEmpty() -> Form { Help(stringResource(R.string.chat_new_none)) }
        }
        for (m in shown) {
            RadioRow(names.display(m), selected = pick == m.id, onClick = { onPick(m.id) }, leading = { Avatar(m.name, m.id, size = 24.dp) })
        }
    }
}

/** The only manager of a channel picks a successor before leaving (desktop-ui 6.9). */
@Composable
private fun SuccessorPrompt(app: AppViewModel, p: ChatPrompt.Successor) {
    val ui = app.chatUi
    var pick by remember(p.room.id) { mutableStateOf<String?>(null) }
    val people = p.people
    val busy = ui.isBusy("leave:${p.room.id}")
    val ready = pick != null && people?.any { it.id == pick } == true
    SheetFrame(
        twoPane = true,
        title = stringResource(R.string.chat_channel_successor_title, p.room.name.orEmpty()),
        onDismiss = ui::dismissPrompt,
        buttons = { close ->
            Secondary(stringResource(R.string.common_actions_cancel)) { close() }
            Primary(stringResource(R.string.chat_channel_successor_submit), busy = busy, enabled = ready, danger = true) { pick?.let(ui::handOver) }
        },
    ) {
        Form { SheetText(stringResource(R.string.chat_channel_successor_body)) }
        p.agents?.let { Form { SheetText(it) } }
        SuccessorPicker(people, pick) { pick = it }
        ui.promptError?.let { Form { ErrorLine(it) } }
    }
}

/**
 * Leaving a workspace as the only manager of channels (6.10): a successor picker for each, then one button that makes
 * the picks managers and leaves. A channel with nobody who can take it over (only guests beside the person) says so,
 * with its Members to add someone. The pickers spin while the channels' members load.
 */
@Composable
private fun HandOverPrompt(app: AppViewModel, p: ChatPrompt.HandOver) {
    val ui = app.chatUi
    var picks by remember(p.ws) { mutableStateOf(emptyMap<String, String>()) }
    // While the members still load, the same key is busy without anything being sent.
    val busy = ui.isBusy("leaveWs:${p.ws}") && p.channels.none { it.people == null }
    SheetFrame(
        twoPane = true,
        title = stringResource(R.string.chat_leave_title, p.name),
        onDismiss = ui::dismissPrompt,
        buttons = { close ->
            Secondary(stringResource(R.string.common_actions_cancel)) { close() }
            Primary(stringResource(R.string.chat_channel_successor_submit), busy = busy, enabled = SheetRules.handOverReady(p.channels, picks), danger = true) {
                ui.handOverAndLeave(picks) { app.openChatSheet(ChatSheet.MEMBERS) }
            }
        },
    ) {
        Form {
            SheetText(stringResource(R.string.chat_leave_manager_first))
            SheetText(stringResource(R.string.chat_leave_body))
        }
        for (ch in p.channels) {
            key(ch.id) {
                Column {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 36.dp).padding(start = 20.dp, end = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RkIcon(if (ch.private) ChatIcons.Lock else ChatIcons.Hash, null, size = 16.dp, tint = Rk.colors.text3)
                        Text(ch.name, style = Rk.type.text13.semibold, color = Rk.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    }
                    val nobody: (@Composable () -> Unit)? = if (ch.failed) null else {
                        {
                            Form {
                                Help(stringResource(R.string.chat_leave_handover_nobody))
                                Row {
                                    RkButton(stringResource(R.string.chat_head_members_button), {
                                        ui.dismissPrompt()
                                        app.openRoom(ch.id)
                                        app.openChatSheet(ChatSheet.MEMBERS, ch.id)
                                    }, kind = RkButtonKind.SECONDARY, size = RkButtonSize.SMALL, icon = RukooIcons.People)
                                }
                            }
                        }
                    }
                    SuccessorPicker(ch.people, picks[ch.id], nobody) { picks = picks + (ch.id to it) }
                }
            }
        }
        ui.promptError?.let { Form { ErrorLine(it) } }
    }
}
