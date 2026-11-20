package nl.bvdm.rukoo.workspaces

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/**
 * Team chat as the UI uses it (contract §7.2). It mirrors desktop's `chat*` IPC methods name for name, and every
 * mention is in UTF-8 byte offsets (§3.17): only the composer converts, through [Utf8Offsets].
 *
 * Calls that fail throw [WorkspaceError] with a §3.15 code. The engine handles feed and send outcomes itself and
 * reports them through [state], room rows and [Pending] rows, never as call errors.
 */
interface Workspaces {
    val state: StateFlow<ChatState>

    /** The workspace from the cache, again after every change to it. */
    fun view(ws: String): Flow<WorkspaceView>

    /** A room's main timeline from the cache, again after every change to the room. */
    fun timeline(ws: String, room: String): Flow<RoomTimeline>

    /** One thread from the cache, again after every change to the room. */
    fun thread(ws: String, room: String, root: String): Flow<ThreadTimeline>

    /** Selects a workspace, or none; kept in the cache's `meta.selected`. */
    suspend fun select(ws: String?)

    /** What is on screen, for the socket, inline events, alerts and reading. Nulls when Chat isn't showing. */
    fun onScreen(ws: String?, room: String?, thread: String?)

    /** Runs the feed now: one workspace, or every one. */
    suspend fun refresh(ws: String? = null)

    /** Start over: a quarantined workspace back to `ok` and a fresh pass (§3.6). */
    suspend fun reload(ws: String)

    /** Opens a room, answering from the cache and then catching up; [at] opens it at a seq (§3.7). */
    suspend fun open(ws: String, room: String, at: Long? = null)
    suspend fun loadOlder(ws: String, room: String)

    /** Backfills a thread's room up to 10 more pages towards its root (§3.7). */
    suspend fun loadThread(ws: String, room: String, root: String)
    suspend fun roomMembers(ws: String, room: String): List<RoomMember>

    /** Reports the highest message seq fully in view in the main timeline (§3.9). Never from a thread. */
    fun markRead(ws: String, room: String, seq: Long)

    /** Marks everything up to the room's head as read. */
    suspend fun markAllRead(ws: String, room: String)
    suspend fun setMuted(ws: String, room: String, muted: Boolean)

    /** Keeps the composer's text for the room ([root] null) or a thread; a null [draft] removes it. */
    suspend fun saveDraft(ws: String, room: String, root: String?, draft: Draft?)

    /** Queues a message and returns its local ID once it is on disk, or throws `not_saved` (§3.8). */
    suspend fun send(ws: String, room: String, root: String?, text: String, mentions: List<Mention>): String
    suspend fun resend(localId: String, mode: ResendMode)
    suspend fun discard(localId: String)
    suspend fun redact(ws: String, room: String, message: String)

    /** Makes a workspace and returns its ID, selected. */
    suspend fun createWorkspace(name: String, displayName: String): String
    suspend fun previewInvite(link: InviteLink): InvitePreview

    /** Joins with an invitation and returns the workspace's ID, selected. */
    suspend fun join(link: InviteLink, displayName: String): String

    /** Keeps the link of a sign-up with an invitation in memory, for the Join sheet to take (§3.3). */
    fun rememberJoin(link: InviteLink)
    fun takePendingJoin(): InviteLink?

    /**
     * [ChatState.lostUnsent] once (§3.4): the count a broken cache took with it, which the state carries until the UI
     * that showed it takes it here; then it is 0 again.
     */
    fun takeLostUnsent(): Int = 0
    suspend fun leaveWorkspace(ws: String)
    suspend fun deleteWorkspace(ws: String)
    suspend fun renameMe(ws: String, name: String)
    suspend fun setRole(ws: String, member: String, role: String)
    suspend fun removeMember(ws: String, member: String)
    suspend fun invites(ws: String): List<Invite>

    /** Makes an invitation and returns it with its link (§3.2). [expiresIn] is 86,400, 259,200 or 604,800 seconds. */
    suspend fun createInvite(ws: String, role: String, channels: List<String>, expiresIn: Long): MadeInvite
    suspend fun withdrawInvite(ws: String, invite: String)

    /** Makes a channel and returns its ID. [visibility] is `workspace` or `private`. */
    suspend fun createChannel(ws: String, name: String, visibility: String): String
    suspend fun renameChannel(ws: String, channel: String, name: String)
    suspend fun archiveChannel(ws: String, channel: String)
    suspend fun joinChannel(ws: String, channel: String)
    suspend fun addToChannel(ws: String, channel: String, member: String)
    suspend fun setChannelRole(ws: String, channel: String, member: String, role: String)
    suspend fun removeFromChannel(ws: String, channel: String, member: String)

    /** Leaves a channel; the only manager names a [successor], or gets `last_manager` with the channels. */
    suspend fun leaveChannel(ws: String, channel: String, successor: String?)

    /** Opens the DM with these 1 to 7 other people, new or existing, and returns its room ID. */
    suspend fun startDm(ws: String, members: List<String>): String
    suspend fun leaveDm(ws: String, room: String)
    suspend fun block(ws: String, member: String)
    suspend fun unblock(ws: String, member: String)
}

// ---- UI models: contract §4.6, field for field ----

/** Everything Chat shows outside a workspace. */
data class ChatState(
    /** The configured server has team chat on (§3.1). */
    val available: Boolean = false,
    /** False when the cache couldn't open. */
    val storage: Boolean = true,
    val signedIn: Boolean = false,
    /** The credential URL. */
    val server: String = "",
    /** Its host name, for text. */
    val host: String = "",
    val operator: ChatOperator? = null,
    /** eu | us | fedramp, or null. */
    val jurisdiction: String? = null,
    /** open | invite | closed, or null. */
    val signups: String? = null,
    /** `info.workspace.inviteSignups` (§2.12). */
    val inviteSignups: Boolean = false,
    val retention: ChatRetention? = null,
    val limits: ChatLimits? = null,
    /** Settings > Notifications > Team chat. */
    val notifications: Boolean = true,
    val pendingJoin: Boolean = false,
    val unsent: Int = 0,
    /** Unsent messages a broken cache took with it, reported once. */
    val lostUnsent: Int = 0,
    val selected: String? = null,
    val connection: Connection = Connection.IDLE,
    /** 0..100, §3.10. */
    val attention: Int = 0,
    val unread: Boolean = false,
    val workspaces: List<WorkspaceSummary> = emptyList(),
)

data class ChatOperator(val name: String, val url: String?)
data class ChatRetention(val contentDays: Int, val feedDays: Int)
data class ChatLimits(val workspacesPerAccount: Int, val members: Int)

enum class Connection { ONLINE, CONNECTING, OFFLINE, IDLE }

enum class WorkspaceStatus { LOADING, OK, QUARANTINED, UPGRADE }

enum class SocketState { OPEN, CONNECTING, DOWN, OFF }

data class WorkspaceSummary(
    val id: String,
    val name: String,
    /** owner | admin | member | guest */
    val role: String,
    val status: WorkspaceStatus = WorkspaceStatus.LOADING,
    val syncing: Boolean = false,
    val socket: SocketState = SocketState.OFF,
    /** A §3.15 code, or null. */
    val error: String? = null,
    val attention: Int = 0,
    val unread: Boolean = false,
)

data class WorkspaceView(
    val ws: WorkspaceSummary,
    val me: Member,
    val rooms: List<Room>,
    val members: List<Member>,
    val membersMore: Boolean,
    val channels: List<Channel>,
    val blocks: List<Block>,
)

enum class RoomKind {
    CHANNEL, DM;

    val wire: String get() = name.lowercase()

    companion object {
        fun of(kind: String): RoomKind = if (kind == "dm") DM else CHANNEL
    }
}

data class Room(
    val id: String,
    val kind: RoomKind,
    /** Null for a DM, whose title comes from its participants (§3.12). */
    val name: String?,
    /** workspace | private | dm */
    val visibility: String,
    val archived: Boolean,
    /** null | left | ineligible | closed */
    val closedReason: String?,
    /** DMs: the participants as member IDs, the person included. */
    val participants: List<String>?,
    val startedBy: String?,
    /** manager | member */
    val role: String?,
    val members: Int,
    val head: Long,
    val floor: Long,
    val lastAt: Long?,
    /** The read position the person has here: max of the server's and this phone's (`readLocal`). */
    val read: Long,
    val unread: Int,
    val mentions: Int,
    val attention: Int,
    val muted: Boolean,
    val hasCache: Boolean,
    /** Android only (§7.4): the newest cached message, for a DM row's preview. */
    val preview: Event? = null,
)

/** A room's main timeline. [replies] maps a root's ID to its summary, for the roots on screen. */
data class RoomTimeline(
    val room: Room,
    val events: List<Event>,
    val pending: List<Pending>,
    val replies: Map<String, ReplySummary>,
    /** The read position when the room opened, for the New divider. */
    val readAtOpen: Long,
    val hasOlder: Boolean,
    /** False when an open at a seq didn't reach it within the backfill limit. */
    val complete: Boolean,
    val loading: Boolean,
    /** The main composer's. */
    val draft: Draft?,
)

/** A root's cached replies: how many, the newest, and up to three repliers, newest first. */
data class ReplySummary(val count: Int, val lastSeq: Long, val lastAt: Long, val authors: List<String>)

data class ThreadTimeline(
    /** Null while the root isn't cached. */
    val root: Event?,
    val replies: List<Event>,
    val pending: List<Pending>,
    val complete: Boolean,
    /** The root is older than retention. */
    val expired: Boolean,
    val draft: Draft?,
    val loading: Boolean = false,
)

/** A cached event. [text] is null when removed or not a message; [mentions] are UTF-8 byte offsets. */
data class Event(
    val seq: Long,
    val id: String,
    val kind: String,
    val actor: String,
    val at: Long,
    val root: String?,
    val text: String?,
    val mentions: List<Mention>,
    val redacted: Boolean,
    val data: EventData = EventData(),
) {
    val isMessage: Boolean get() = kind == WireEvent.MESSAGE_POSTED
}

/** The fields of event kinds other than a message. */
@kotlinx.serialization.Serializable
data class EventData(
    val name: String? = null,
    val visibility: String? = null,
    val member: String? = null,
    val members: List<String>? = null,
    val role: String? = null,
    val target: String? = null,
    val targetSeq: Long? = null,
)

enum class PendingState {
    QUEUED, SENDING,

    /** Derived: an earlier row of the room is held or failed, so this one waits behind it (§3.8). */
    WAITING, HELD, FAILED;

    val wire: String get() = name.lowercase()
}

/** A message on its way: an outbox row as the UI shows it. */
data class Pending(
    val local: String,
    val ws: String,
    val conversation: String,
    val root: String?,
    val text: String,
    val mentions: List<Mention>,
    val state: PendingState,
    /** null | lookup | stale_grant | unknown | conflict | archived | quota | mentions | invalid | no_access */
    val reason: String?,
    val nextAt: Long,
    val createdAt: Long,
)

@kotlinx.serialization.Serializable
data class Draft(val text: String, val mentions: List<Mention> = emptyList())

enum class ResendMode { SEND, RETRY, WITHOUT_MENTIONS }
