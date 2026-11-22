package nl.bvdm.rukoo.workspaces

import kotlinx.serialization.Required
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// The workspace routes' answers (server/WORKSPACES.md "Gate 1 routes", contract §2), decoded with RukooJson, which
// ignores fields this version doesn't know. Where the UI shows a server shape as it is (members, channels, blocks,
// room members, an invitation preview), the type here serves both; Workspaces.kt holds the shapes the cache builds.

/** A mention in UTF-8 byte offsets of the exact text (contract §3.17), on the wire, in the cache and in the UI's API. */
@Serializable
data class Mention(val actor: String, val start: Int, val end: Int)

/** What `GET /v1/info` says about workspaces while the operator has team chat on (`info.workspace`). */
@Serializable
data class WorkspaceServerInfo(
    val versions: List<Int> = emptyList(),
    val home: WorkspaceHome? = null,
    val capabilities: List<String> = emptyList(),
    val limits: WorkspaceServerLimits = WorkspaceServerLimits(),
    val retention: WorkspaceRetention? = null,
    /** True when a workspace invitation works as the invite code at sign-up (§2.12). */
    val inviteSignups: Boolean = false,
    /** True when such a sign-up also needs a code emailed to the address, as on a server that checks addresses. */
    val inviteSignupsNeedCode: Boolean = false,
)

@Serializable
data class WorkspaceHome(val origin: String? = null, val installation: String? = null)

@Serializable
data class WorkspaceServerLimits(
    val workspacesPerAccount: Int = 0,
    val membershipsPerAccount: Int = 0,
    val members: Int = 0,
    val sockets: Int = 0,
    val conversations: Int = 0,
    val textBytes: Int = TEXT_BYTES,
)

/**
 * One workspace in `GET /v1/workspaces`, with the caller's [role]. An invitation preview names its workspace with
 * only the ID and name, so [role] is empty there.
 */
@Serializable
data class WorkspaceRef(val id: String, val name: String, val role: String = "")

@Serializable
data class WorkspaceList(val workspaces: List<WorkspaceRef> = emptyList())

@Serializable
data class WorkspaceLimits(val members: Int = 0, val conversations: Int = 0, val textBytes: Int = TEXT_BYTES)

@Serializable
data class WorkspaceRetention(val contentDays: Int = 90, val feedDays: Int = 14, val platformHistoryDays: Int? = null)

/** `GET /v1/workspaces/{w}`: the generation and key the feed depends on, and the server's clock. */
@Serializable
data class WorkspaceInfo(
    val id: String,
    val name: String,
    val createdAt: Long = 0,
    val generation: String,
    val keyId: String? = null,
    val time: Long,
    val limits: WorkspaceLimits = WorkspaceLimits(),
    val retention: WorkspaceRetention = WorkspaceRetention(),
)

/** `GET /v1/workspaces/{w}` also carries the caller as `me`. */
@Serializable
data class WorkspaceDetails(val workspace: WorkspaceInfo, val me: Member)

/** A person in a workspace: `GET /members`, `PATCH /members/…`, and the UI's member rows (§4.6 `Member`). */
@Serializable
data class Member(
    val id: String,
    val kind: String = "human",
    val name: String,
    /** owner | admin | member | guest */
    val role: String,
    /** active | former | deleted */
    val state: String,
    val joinedAt: Long = 0,
)

/** `POST /v1/workspaces` and `POST /join`. */
@Serializable
data class Joined(val workspace: WorkspaceInfo? = null, val me: Member)

@Serializable
data class MembersPage(val members: List<Member> = emptyList(), val more: Boolean = false)

@Serializable
data class MeAnswer(val me: Member)

@Serializable
data class MemberAnswer(val member: Member)

/** A channel in `GET /channels` and the UI's directory rows (§4.6 `Channel`). */
@Serializable
data class Channel(
    val id: String,
    val name: String,
    /** workspace | private */
    val visibility: String,
    val archived: Boolean = false,
    val joined: Boolean = false,
    /** The caller's role in it: manager | member, or null when not joined. */
    val role: String? = null,
    val members: Int = 0,
)

@Serializable
data class ChannelsPage(val channels: List<Channel> = emptyList())

@Serializable
data class ChannelAnswer(val channel: Channel)

/** Someone in a room: `GET /channels/{c}/members`, `POST` and `PATCH` there. */
@Serializable
data class RoomMember(val member: String, val role: String)

@Serializable
data class RoomMembersPage(val members: List<RoomMember> = emptyList())

/** One of the caller's blocks: `GET /blocks`, `POST /blocks` (§2.3) and the UI's list (§4.6 `Block`). */
@Serializable
data class Block(val member: String, val at: Long)

@Serializable
data class BlocksPage(val blocks: List<Block> = emptyList())

@Serializable
data class BlockAnswer(val block: Block)

/** An open invitation, as owners and admins list them. [issuer] is the issuer's member ID. */
@Serializable
data class Invite(
    val id: String,
    val role: String,
    val channels: List<String> = emptyList(),
    val channelCount: Int = 0,
    val issuer: String? = null,
    val createdAt: Long = 0,
    val expiresAt: Long = 0,
)

@Serializable
data class InvitesPage(val invites: List<Invite> = emptyList())

/** `POST /invites`: the invitation and its secret, which only this answer carries. */
@Serializable
data class CreatedInvite(val invite: Invite, val secret: String)

/** A new invitation and its link, which only the answer that made it carries (desktop's `{ invite, link }`). */
data class MadeInvite(val invite: Invite, val link: String)

@Serializable
data class IssuerName(val name: String)

/**
 * `POST /invites/preview`, and the Join sheet's card (§4.6 `InvitePreview`). [channels] is a count. [already] is
 * the phone's own: the workspace is in the local list.
 */
@Serializable
data class InvitePreview(
    val workspace: WorkspaceRef,
    val role: String,
    val channels: Int = 0,
    val issuer: IssuerName,
    val expiresAt: Long = 0,
    val already: Boolean = false,
)

/**
 * An event as the server sends it. Message events carry [text], [mentions] and [root], or [redacted] once removed.
 * Other kinds carry their own fields flat: [name] and [visibility] (`channel.created`, `channel.renamed`), [member]
 * (`member.joined`, `member.left`, `member.role`), [members] (`dm.started`), [target] and [targetSeq]
 * (`message.redacted`).
 */
@Serializable
data class WireEvent(
    val seq: Long,
    val id: String,
    val kind: String,
    val actor: String,
    val at: Long,
    val root: String? = null,
    val text: String? = null,
    val mentions: List<Mention> = emptyList(),
    val redacted: Boolean = false,
    val name: String? = null,
    val visibility: String? = null,
    val member: String? = null,
    val members: List<String>? = null,
    val role: String? = null,
    val target: String? = null,
    val targetSeq: Long? = null,
) {
    val isMessage: Boolean get() = kind == MESSAGE_POSTED

    /** The fields of a kind other than a message, as the cache keeps them in `event.data`; null when there are none. */
    fun data(): EventData? {
        if (isMessage) return null
        val out = EventData(name, visibility, member, members, role, target, targetSeq)
        return out.takeIf { it != EventData() }
    }

    companion object {
        const val MESSAGE_POSTED = "message.posted"
        const val MESSAGE_REDACTED = "message.redacted"
    }
}

/** `GET /conversations/{c}/events`. `events` is [Required], as on desktop: an answer without it isn't an empty page. */
@Serializable
data class EventPage(@Required val events: List<WireEvent> = emptyList(), val head: Long, val floor: Long, val more: Boolean = false)

/**
 * A room in the feed (`GET /changes`, contract §2.4), and the `dm` a `POST /dms` answers. A DM has `name` null,
 * `visibility` `dm`, its [participants] as member IDs ordered by the server's member order, the caller included,
 * [startedBy] and [closedReason] (`left`, `ineligible`, `closed`, or null while open). [archived] is true exactly
 * when [closedReason] isn't null, so posting stays `!archived` for every kind of room.
 */
@Serializable
data class Change(
    val conversation: String,
    /** channel | dm */
    val kind: String,
    val name: String? = null,
    /** workspace | private | dm */
    val visibility: String,
    @Required val archived: Boolean = false,
    val participants: List<String>? = null,
    val startedBy: String? = null,
    val closedReason: String? = null,
    val grant: String,
    /** manager | member */
    val role: String? = null,
    /** How many people hold a grant in the room now. */
    val members: Int = 0,
    val head: Long,
    val floor: Long,
    /** The `at` of the event at head, or null when retention removed it. */
    val lastAt: Long? = null,
    val read: Long,
    val unread: Int,
    val mentions: Int,
    val removed: List<String> = emptyList(),
    val removedMore: Boolean = false,
)

/**
 * Which directories to load again (§3.6): `GET /members`, `GET /channels`, `GET /blocks`. The server always sends
 * `members` and `channels`; `blocks` came later and may be missing. The defaults serve the code, never the wire.
 */
@Serializable
data class Directory(@Required val members: Boolean = false, @Required val channels: Boolean = false, val blocks: Boolean = false)

/**
 * One page of `GET /changes`. The fields the protocol always sends are [Required], as desktop's `wire.checkChanges`
 * requires them: a page without `evictions` would otherwise read as one with none, and commit its cursor past them.
 */
@Serializable
data class FeedPage(
    @Required val changes: List<Change> = emptyList(),
    @Required val evictions: List<String> = emptyList(),
    val inlineEvents: List<WireEvent> = emptyList(),
    @Required val directory: Directory = Directory(),
    val next: String,
    @Required val more: Boolean = false,
)

/** `POST /dms`: 201 for a new DM, 200 for the open one of the same set. */
@Serializable
data class DmAnswer(val dm: Change)

/** The body of `POST /conversations/{c}/messages`, the same bytes on every attempt (§3.8). */
@Serializable
data class SendBody(
    val operationId: String,
    val grant: String,
    val generation: String,
    val text: String,
    val mentions: List<Mention> = emptyList(),
    val root: String? = null,
)

/** `POST /conversations/{c}/messages`: 201 for a new message, 200 for a replay of the same operation. */
@Serializable
data class SendAck(val operationId: String? = null, val messageId: String, val seq: Long)

/** `GET /conversations/{c}/operations/{op}`. */
@Serializable
data class OperationResult(val messageId: String, val seq: Long, val visible: Boolean = true)

/** `POST /conversations/{c}/messages/{e}/redact`. */
@Serializable
data class RedactAck(val messageId: String, val redacted: Boolean = true)

/** `POST /conversations/{c}/read`: the read position the server now holds. */
@Serializable
data class ReadAck(val read: Long)

/** `POST /socket-ticket`. */
@Serializable
data class SocketTicket(val ticket: String, val expiresAt: Long = 0, val protocol: String = SOCKET_PROTOCOL)

/** The largest message, in UTF-8 bytes after trimming (§3.16). */
const val TEXT_BYTES = 16_384

/** At most this many mentions in one message (§3.17). */
const val MENTION_LIMIT = 32

/** The socket subprotocol both apps offer (§3.11). */
const val SOCKET_PROTOCOL = "rukoo.workspace.v1"

/** The feature `GET /v1/info` lists while team chat is on, and the protocol version this build speaks (§3.1). */
const val WORKSPACES_FEATURE = "workspaces-v1"
const val WORKSPACE_VERSION = 1

/** IDs as the server makes them: a prefix and 22 base64url characters. */
object WorkspaceIds {
    private fun id(prefix: String) = Regex("^${prefix}_[A-Za-z0-9_-]{22}$")
    val WORKSPACE = id("w")
    val MEMBER = id("u")
    val CONVERSATION = id("c")
    val EVENT = id("e")
    val GRANT = id("g")
    val INVITE = id("i")
    val SECRET = Regex("^[A-Za-z0-9_-]{43}$")

    fun isWorkspace(s: String?) = s != null && WORKSPACE.matches(s)
    fun isMember(s: String?) = s != null && MEMBER.matches(s)
    fun isConversation(s: String?) = s != null && CONVERSATION.matches(s)
    fun isEvent(s: String?) = s != null && EVENT.matches(s)
}

/** Reads a JSON body into one of the types above, for the client and the tests. */
internal inline fun <reified T> decodeWire(json: JsonElement): T =
    nl.bvdm.rukoo.core.RukooJson.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), json)
