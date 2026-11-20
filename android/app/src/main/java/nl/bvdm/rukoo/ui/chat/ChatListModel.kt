package nl.bvdm.rukoo.ui.chat

import kotlinx.serialization.Serializable
import nl.bvdm.rukoo.ui.components.NewsTone
import nl.bvdm.rukoo.workspaces.ChatState
import nl.bvdm.rukoo.workspaces.Connection
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind
import nl.bvdm.rukoo.workspaces.WorkspaceStatus
import nl.bvdm.rukoo.workspaces.WorkspaceSummary

/** The conversation list's quick filter. */
@Serializable
enum class ChatFilter { ALL, UNREAD }

/**
 * The mode badge (contract §3.10): the count of what calls for attention, shown as 99+ above 99, or a dot when only
 * something is unread. [of] gives null when there is nothing to show.
 */
data class ChatBadge(val count: Int, val dot: Boolean) {
    val text: String get() = if (count > 99) "99+" else count.toString()

    companion object {
        fun of(attention: Int, unread: Boolean): ChatBadge? = when {
            attention > 0 -> ChatBadge(attention, dot = false)
            unread -> ChatBadge(0, dot = true)
            else -> null
        }
    }
}

/**
 * A conversation row's badge (contract §3.10, desktop chat-model.js `roomBadge`). [pill] is the accent pill's number:
 * a DM's unread count, a channel's mentions. A channel with unread messages and no mentions shows a news [dot]
 * instead. Unread rows are [bold]; muted rows never are and show nothing; muted and closed rows are [dim].
 */
data class RowBadge(val attention: Int, val pill: Int?, val dot: Boolean, val bold: Boolean, val dim: Boolean) {
    companion object {
        /** What a room calls for: 0 when muted, else its unread count for a DM and its mentions for a channel. */
        fun attention(room: Room): Int = if (room.muted) 0 else maxOf(0, if (room.kind == RoomKind.DM) room.unread else room.mentions)

        fun of(room: Room): RowBadge {
            val closed = room.kind == RoomKind.DM && room.closedReason != null
            val dim = room.muted || closed
            if (room.muted) return RowBadge(0, pill = null, dot = false, bold = false, dim = dim)
            val unread = maxOf(0, room.unread)
            val mentions = maxOf(0, room.mentions)
            val pill = when {
                room.kind == RoomKind.DM -> unread.takeIf { it > 0 }
                else -> mentions.takeIf { it > 0 }
            }
            val dot = room.kind == RoomKind.CHANNEL && mentions == 0 && unread > 0
            return RowBadge(attention(room), pill, dot, bold = unread > 0, dim = dim)
        }
    }
}

/**
 * How members are named in titles and rows (contract §3.12, desktop `displayName` and `dmTitle`): [former] for someone
 * this phone doesn't know, [deleted] for an erased account, [others] for " and N others" after two names, and [list]
 * joining two or three names in the interface language ("Sanne, Mila and Olga").
 */
class ChatNames(
    val former: String,
    val deleted: String,
    val others: (Int) -> String,
    val list: (List<String>) -> String,
) {
    fun display(member: Member?): String = when {
        member == null -> former
        member.state == "deleted" -> deleted
        else -> member.name.trim().ifEmpty { former }
    }

    /** A DM's title from its participants other than [me]; yourself when nobody else is in it. */
    fun dmTitle(participants: List<String>?, members: Map<String, Member>, me: String?): String {
        val others = participants.orEmpty().distinct().filter { it != me }
        if (others.isEmpty()) return display(me?.let(members::get))
        val names = others.map { display(members[it]) }
        return when {
            names.size == 1 -> names[0]
            names.size <= 3 -> list(names)
            else -> names.take(2).joinToString(", ") + others(names.size - 2)
        }
    }

    /** Everyone in a DM but [me], all named and joined as the language lists them, as Close conversation names them. */
    fun everyoneElse(participants: List<String>?, members: Map<String, Member>, me: String?): String {
        val names = participants.orEmpty().distinct().filter { it != me }.map { display(members[it]) }
        return if (names.size == 1) names[0] else list(names)
    }

    /** A room's title: a channel's name (the UI puts # before it), a DM's people. */
    fun title(room: Room, members: Map<String, Member>, me: String?): String =
        if (room.kind == RoomKind.DM) dmTitle(room.participants, members, me) else room.name.orEmpty()
}

/**
 * A DM row's line under its title: the newest message, with its author's name in a group, or "You:" when it is the
 * person's own ([mine]), so their last message doesn't read as the other person's.
 */
data class RoomPreview(val author: String?, val text: String?, val removed: Boolean, val mine: Boolean = false)

/** One row of the conversation list. [title] is a channel's bare name or a DM's people. */
data class RoomRow(
    val room: Room,
    val title: String,
    val badge: RowBadge,
    val closed: Boolean,
    val private: Boolean,
    val preview: RoomPreview?,
    /** The room open beside the list. */
    val open: Boolean,
) {
    val key: String get() = room.id
}

/**
 * The list's sections. [showDms] is false for a guest without DMs: guests can't start one and see the section only for
 * DMs they had before. [canCreate] is true for full members, who get the plus buttons, Browse and New message.
 */
data class ChatSections(
    val channels: List<RoomRow>,
    val dms: List<RoomRow>,
    val archived: List<RoomRow>,
    val showDms: Boolean,
    val canCreate: Boolean,
    /** Rooms the Unread filter would list, for its count. */
    val unreadCount: Int,
) {
    val isEmpty: Boolean get() = channels.isEmpty() && dms.isEmpty() && archived.isEmpty()
}

/** What the status line under the workspace list says (desktop's foot status, contract §5.3). */
enum class ChatStatus { SIGNED_OUT, CATCHING_UP, CONNECTED, CONNECTING, OFFLINE, IDLE }

/**
 * A state of all of Chat that takes the place of its panes (android.md "States", contract §5.8): the cache can't open,
 * signed out, the first listing still on its way, or no workspace yet.
 */
enum class ChatGate { STORAGE, SIGNED_OUT, LOADING, NO_WORKSPACE }

/**
 * The conversation list as rows (android.md "Conversation list", contract §3.10, §3.12, §7.4), pure so it is tested
 * in ChatListModelTest: Channels by name, Direct messages by their last activity with closed ones last, archived
 * channels apart, the All and Unread filters, and each row's badge.
 */
object ChatListModel {
    /** Workspace roles that are full members: everyone but guests. */
    val FULL_ROLES = setOf("owner", "admin", "member")

    fun isFullMember(role: String?): Boolean = role in FULL_ROLES

    /** The state that replaces Chat's panes, or null when a workspace can show. */
    fun gate(state: ChatState): ChatGate? = when {
        !state.storage -> ChatGate.STORAGE
        !state.signedIn -> ChatGate.SIGNED_OUT
        state.workspaces.isNotEmpty() -> null
        state.connection == Connection.CONNECTING -> ChatGate.LOADING
        else -> ChatGate.NO_WORKSPACE
    }

    /** The status line: signed out, the first pass of [ws] running, else the connection. */
    fun status(state: ChatState, ws: WorkspaceSummary?): ChatStatus = when {
        !state.signedIn -> ChatStatus.SIGNED_OUT
        ws?.status == WorkspaceStatus.LOADING -> ChatStatus.CATCHING_UP
        state.connection == Connection.ONLINE -> ChatStatus.CONNECTED
        state.connection == Connection.CONNECTING -> ChatStatus.CONNECTING
        state.connection == Connection.OFFLINE -> ChatStatus.OFFLINE
        else -> ChatStatus.IDLE
    }

    /**
     * The dot on the list's workspace button, as desktop's workspace tile (chat.js `tileHtml`): a warning when the
     * [selected] workspace itself is stopped, else a dot when another workspace has something calling for attention or
     * unread messages (`othersAsk`); null for none.
     */
    fun othersNews(workspaces: List<WorkspaceSummary>, selected: String?): NewsTone? = when {
        workspaces.any { it.id == selected && it.status == WorkspaceStatus.QUARANTINED } -> NewsTone.WAITING
        workspaces.any { it.id != selected && (it.attention > 0 || it.unread) } -> NewsTone.UNREAD
        else -> null
    }

    /** What the Unread filter keeps: a room with unread messages that isn't muted, and the room open beside the list. */
    fun matches(room: Room, filter: ChatFilter, open: String?): Boolean = when (filter) {
        ChatFilter.ALL -> true
        ChatFilter.UNREAD -> room.id == open || (!room.muted && room.unread > 0)
    }

    /**
     * A DM's preview from its newest known message ([Room.preview]: the cache's, or the one an alert fetched); the
     * author's name only in a group and only for others, and [RoomPreview.mine] for the person's own. None when that
     * message is behind: with unread messages, a newest message that is already read isn't the newest one, and showing
     * it next to the unread count would pass it off as the new message (the cache fills when the DM opens).
     */
    fun preview(room: Room, members: Map<String, Member>, me: String?, names: ChatNames): RoomPreview? {
        if (room.kind != RoomKind.DM) return null
        val e = room.preview ?: return null
        if (room.unread > 0 && e.seq <= room.read) return null
        val removed = e.redacted || e.text == null
        val group = room.participants.orEmpty().distinct().count { it != me } > 1
        val author = if (group && e.actor != me) names.display(members[e.actor]) else null
        return RoomPreview(author, if (removed) null else e.text.replace(Regex("\\s+"), " ").trim(), removed, mine = me != null && e.actor == me)
    }

    /**
     * The sections for [rooms]. [me] is the person in this workspace (their role decides [ChatSections.canCreate]),
     * [members] the directory by ID, [open] the room open beside the list, which an Unread filter keeps listing and
     * which stays among Channels while archived. [compare] orders channel names in the interface language.
     */
    fun sections(
        rooms: List<Room>,
        filter: ChatFilter,
        me: Member?,
        members: Map<String, Member>,
        names: ChatNames,
        open: String? = null,
        compare: Comparator<String> = String.CASE_INSENSITIVE_ORDER,
    ): ChatSections {
        val myId = me?.id
        fun row(room: Room) = RoomRow(
            room = room,
            title = names.title(room, members, myId),
            badge = RowBadge.of(room),
            closed = room.kind == RoomKind.DM && room.closedReason != null,
            private = room.kind == RoomKind.CHANNEL && room.visibility == "private",
            preview = preview(room, members, myId, names),
            open = room.id == open,
        )
        val byName = Comparator<Room> { a, b -> compare.compare(a.name.orEmpty(), b.name.orEmpty()) }.thenBy { it.id }
        val shown = rooms.filter { matches(it, filter, open) }
        val channels = shown.filter { it.kind == RoomKind.CHANNEL && (!it.archived || it.id == open) }.sortedWith(byName)
        val archived = shown.filter { it.kind == RoomKind.CHANNEL && it.archived && it.id != open }.sortedWith(byName)
        val dms = shown.filter { it.kind == RoomKind.DM }.sortedWith(
            compareBy<Room> { if (it.closedReason != null) 1 else 0 }
                .thenByDescending { it.lastAt ?: 0L }
                .thenBy { it.id },
        )
        val canCreate = isFullMember(me?.role)
        return ChatSections(
            channels = channels.map(::row),
            dms = dms.map(::row),
            archived = archived.map(::row),
            showDms = canCreate || rooms.any { it.kind == RoomKind.DM },
            canCreate = canCreate,
            unreadCount = rooms.count { !it.muted && it.unread > 0 },
        )
    }
}
