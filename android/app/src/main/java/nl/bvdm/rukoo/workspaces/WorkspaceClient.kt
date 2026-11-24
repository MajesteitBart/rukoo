package nl.bvdm.rukoo.workspaces

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import nl.bvdm.rukoo.account.AccountDetails
import nl.bvdm.rukoo.account.BorrowedSession
import nl.bvdm.rukoo.core.RukooJson

/** An answer that is either new (201) or one that already existed (200): a join, a DM start, a block. */
data class Created<T>(val value: T, val created: Boolean)

/**
 * The team chat routes of the Rukoo account server, one suspend function each (android.md "Routes", contract 2 and
 * server/WORKSPACES.md "Gate 1 routes"). Paths below `/v1/workspaces/{w}` take the workspace's raw `w_` ID.
 *
 * Each call borrows the session at call time from [session] and throws `signed_out` without one, before anything is
 * sent. The session's server is where the call goes, so the token only ever reaches the address it signed in at. A
 * 401 tells [refused] once, with the session it was for, which signs the phone out when that is still its session:
 * the server answers an ended session with `scope: account`. A 401 with `scope: workspace` is about a socket ticket
 * and signs nothing out. A denial is never retried under another account.
 *
 * Failures are [WorkspaceError]s: the server's refusals as decoded by [WorkspaceError.fromAnswer], `network` when no
 * answer came, and `server` for an answer of the wrong shape.
 */
class WorkspaceClient internal constructor(
    private val http: WorkspaceHttp,
    private val session: () -> BorrowedSession?,
    private val refused: (BorrowedSession) -> Unit,
) {
    // ---- the account and the list ----

    /** `GET /v1/account`: the account's [AccountDetails.accountClass] and [AccountDetails.incarnation]. */
    suspend fun identity(): AccountDetails = fetch("/v1/account", AccountDetails.serializer())

    /** `GET /v1/workspaces`: the workspaces the account is an active member of. */
    suspend fun list(): List<WorkspaceRef> = fetch("/v1/workspaces", WorkspaceList.serializer()).workspaces

    /** `POST /v1/workspaces`: a new workspace with the caller as its owner, named [displayName] there. */
    suspend fun create(name: String, displayName: String): Joined =
        send("POST", "/v1/workspaces", Joined.serializer(), buildJsonObject {
            put("name", name)
            put("displayName", displayName)
        })

    /** `GET /v1/workspaces/{w}`: its generation, key, limits and the server's clock, and the caller. */
    suspend fun get(w: String): WorkspaceDetails = fetch(ws(w), WorkspaceDetails.serializer())

    /** `DELETE /v1/workspaces/{w}`: only its owner, and only while nobody else is in it (contract 2.14). */
    suspend fun deleteWorkspace(w: String) = none("DELETE", ws(w))

    // ---- members ----

    /** `GET …/members`: every active member, and for full members the most recent former ones. */
    suspend fun members(w: String): MembersPage = fetch(ws(w, "/members"), MembersPage.serializer())

    /** `PATCH …/members/me`: the caller's name in this workspace. */
    suspend fun renameMe(w: String, name: String): Member =
        send("PATCH", ws(w, "/members/me"), MeAnswer.serializer(), buildJsonObject { put("name", name) }).me

    /** `PATCH …/members/{u}`: owner, admin, member or guest. */
    suspend fun setRole(w: String, member: String, role: String): Member =
        send("PATCH", ws(w, "/members/${id(member)}"), MemberAnswer.serializer(), buildJsonObject { put("role", role) }).member

    /** `DELETE …/members/{u}`. */
    suspend fun removeMember(w: String, member: String) = none("DELETE", ws(w, "/members/${id(member)}"))

    /** `DELETE …/members/me`: the caller leaves the workspace. */
    suspend fun leave(w: String) = none("DELETE", ws(w, "/members/me"))

    // ---- invitations and joining ----

    /** `GET …/invites`: the open invitations, for owners and admins. */
    suspend fun invites(w: String): List<Invite> = fetch(ws(w, "/invites"), InvitesPage.serializer()).invites

    /** `POST …/invites`: [role] `member` or `guest`, into [channels], for [expiresIn] seconds (the server's default when null). */
    suspend fun createInvite(w: String, role: String, channels: List<String>, expiresIn: Long?): CreatedInvite =
        send("POST", ws(w, "/invites"), CreatedInvite.serializer(), buildJsonObject {
            put("role", role)
            putJsonArray("channels") { channels.forEach { add(it) } }
            if (expiresIn != null) put("expiresIn", expiresIn)
        })

    /** `DELETE …/invites/{i}`. */
    suspend fun withdrawInvite(w: String, invite: String) = none("DELETE", ws(w, "/invites/${id(invite)}"))

    /** `POST …/invites/preview`: what the invitation [secret] is for, before joining. */
    suspend fun previewInvite(w: String, secret: String): InvitePreview =
        send("POST", ws(w, "/invites/preview"), InvitePreview.serializer(), buildJsonObject { put("invite", secret) })

    /** `POST …/join`: in [Created.created] false when the caller was a member already. */
    suspend fun join(w: String, secret: String, name: String): Created<Joined> =
        created("POST", ws(w, "/join"), Joined.serializer(), buildJsonObject {
            put("invite", secret)
            put("name", name)
        })

    // ---- channels ----

    /** `GET …/channels`: the channels the caller can see. DMs aren't channels. */
    suspend fun channels(w: String): List<Channel> = fetch(ws(w, "/channels"), ChannelsPage.serializer()).channels

    /** `POST …/channels`: [visibility] `workspace` or `private`. */
    suspend fun createChannel(w: String, name: String, visibility: String): Channel =
        send("POST", ws(w, "/channels"), ChannelAnswer.serializer(), buildJsonObject {
            put("name", name)
            put("visibility", visibility)
        }).channel

    /** `PATCH …/channels/{c}` with a name. */
    suspend fun renameChannel(w: String, channel: String, name: String): Channel =
        send("PATCH", ws(w, "/channels/${id(channel)}"), ChannelAnswer.serializer(), buildJsonObject { put("name", name) }).channel

    /** `PATCH …/channels/{c}` with `archived: true`. */
    suspend fun archiveChannel(w: String, channel: String): Channel =
        send("PATCH", ws(w, "/channels/${id(channel)}"), ChannelAnswer.serializer(), buildJsonObject { put("archived", true) }).channel

    /** `POST …/channels/{c}/join`: a channel visible to the whole workspace. */
    suspend fun joinChannel(w: String, channel: String): Channel =
        send("POST", ws(w, "/channels/${id(channel)}/join"), ChannelAnswer.serializer()).channel

    /** `GET …/channels/{c}/members`. */
    suspend fun channelMembers(w: String, channel: String): List<RoomMember> =
        fetch(ws(w, "/channels/${id(channel)}/members"), RoomMembersPage.serializer()).members

    /** `POST …/channels/{c}/members`: a manager adds someone. */
    suspend fun admit(w: String, channel: String, member: String): RoomMember =
        send("POST", ws(w, "/channels/${id(channel)}/members"), RoomMember.serializer(), buildJsonObject { put("member", member) })

    /** `PATCH …/channels/{c}/members/{u}`: manager or member. */
    suspend fun setChannelRole(w: String, channel: String, member: String, role: String): RoomMember =
        send("PATCH", ws(w, "/channels/${id(channel)}/members/${id(member)}"), RoomMember.serializer(), buildJsonObject { put("role", role) })

    /** `DELETE …/channels/{c}/members/{u}`, with `?successor=` when the last manager goes. */
    suspend fun removeFromChannel(w: String, channel: String, member: String, successor: String? = null) =
        none("DELETE", ws(w, "/channels/${id(channel)}/members/${id(member)}") + successorQuery(successor))

    /** `DELETE …/channels/{c}/members/me`: the caller leaves, naming [successor] when they are its last manager. */
    suspend fun leaveChannel(w: String, channel: String, successor: String? = null) =
        none("DELETE", ws(w, "/channels/${id(channel)}/members/me") + successorQuery(successor))

    // ---- direct messages and blocks ----

    /**
     * `POST …/dms` with the other participants: the DM's feed row, new ([Created.created]) or the open one for exactly
     * this set. A retry after a lost answer finds the same DM, so it takes no operation ID (contract 2.2).
     */
    suspend fun startDm(w: String, members: List<String>): Created<Change> {
        val answer = created("POST", ws(w, "/dms"), DmAnswer.serializer(), buildJsonObject {
            putJsonArray("members") { members.forEach { add(it) } }
        })
        return Created(answer.value.dm, answer.created)
    }

    /** `POST …/dms/{c}/leave`: the caller's grant ends, and an open DM closes for the others. */
    suspend fun leaveDm(w: String, dm: String) = none("POST", ws(w, "/dms/${id(dm)}/leave"))

    /** `GET …/blocks`: the caller's own blocks, newest first. */
    suspend fun blocks(w: String): List<Block> = fetch(ws(w, "/blocks"), BlocksPage.serializer()).blocks

    /** `POST …/blocks`: new, or the block that was there with its first time. */
    suspend fun block(w: String, member: String): Created<Block> {
        val answer = created("POST", ws(w, "/blocks"), BlockAnswer.serializer(), buildJsonObject { put("member", member) })
        return Created(answer.value.block, answer.created)
    }

    /** `DELETE …/blocks/{u}`, also when there was no block. */
    suspend fun unblock(w: String, member: String) = none("DELETE", ws(w, "/blocks/${id(member)}"))

    // ---- agents ----

    /** `GET …/agents`: every active agent, for full members. */
    suspend fun agents(w: String): List<Agent> = fetch(ws(w, "/agents"), AgentsPage.serializer()).agents

    /** `POST …/agents`: an agent the caller sponsors, with its key. [members] counts only for `answers: members`. */
    suspend fun createAgent(w: String, name: String, answers: String, members: List<String>, agents: Boolean): MadeAgent =
        send("POST", ws(w, "/agents"), MadeAgent.serializer(), buildJsonObject {
            put("name", name)
            put("answers", answers)
            putJsonArray("members") { members.forEach { add(it) } }
            put("agents", agents)
        })

    /** `PATCH …/agents/{u}`: what is given changes, the rest stays. */
    suspend fun updateAgent(w: String, agent: String, name: String? = null, answers: String? = null, members: List<String>? = null, agents: Boolean? = null): Agent =
        send("PATCH", ws(w, "/agents/${id(agent)}"), AgentAnswer.serializer(), buildJsonObject {
            if (name != null) put("name", name)
            if (answers != null) put("answers", answers)
            if (members != null) putJsonArray("members") { members.forEach { add(it) } }
            if (agents != null) put("agents", agents)
        }).agent

    /** `POST …/agents/{u}/key`: a new key; the old one stops working at once. */
    suspend fun agentKey(w: String, agent: String): MadeAgent = send("POST", ws(w, "/agents/${id(agent)}/key"), MadeAgent.serializer())

    /** `DELETE …/agents/{u}`: its grants end and its key stops working. */
    suspend fun removeAgent(w: String, agent: String) = none("DELETE", ws(w, "/agents/${id(agent)}"))

    // ---- messages ----

    /** `POST …/conversations/{c}/messages`: the same [body] on every attempt; a replay answers the first result. */
    suspend fun post(w: String, conversation: String, body: SendBody): SendAck =
        send("POST", ws(w, "/conversations/${id(conversation)}/messages"), SendAck.serializer(), RukooJson.encodeToJsonElement(SendBody.serializer(), body))

    /**
     * `GET …/conversations/{c}/operations/{op}`: where the message of operation [op] landed, or null when the server
     * has none from it. A conversation the caller can't reach still throws its `not_found` with a scope.
     */
    suspend fun operation(w: String, conversation: String, op: String): OperationResult? = try {
        fetch(ws(w, "/conversations/${id(conversation)}/operations/${id(op)}"), OperationResult.serializer())
    } catch (e: WorkspaceError) {
        if (e.code == "not_found" && e.scope == null) null else throw e
    }

    /**
     * `GET …/conversations/{c}/events`: after [after] going forward, or before [before] going back, at most [limit]
     * (1 to 100). Without either it starts at the beginning, as the server does.
     */
    suspend fun events(w: String, conversation: String, after: Long? = null, before: Long? = null, limit: Int = 50): EventPage {
        require(after == null || before == null) { "after or before, not both" }
        val query = buildList {
            if (after != null) add("after=$after")
            if (before != null) add("before=$before")
            add("limit=$limit")
        }.joinToString("&")
        return fetch(ws(w, "/conversations/${id(conversation)}/events?$query"), EventPage.serializer())
    }

    /** `POST …/conversations/{c}/messages/{e}/redact`: by its author, or a channel's manager. */
    suspend fun redact(w: String, conversation: String, message: String): RedactAck =
        send("POST", ws(w, "/conversations/${id(conversation)}/messages/${id(message)}/redact"), RedactAck.serializer())

    /** `POST …/conversations/{c}/read`: the read position, which never goes back on the server. */
    suspend fun read(w: String, conversation: String, seq: Long): ReadAck =
        send("POST", ws(w, "/conversations/${id(conversation)}/read"), ReadAck.serializer(), buildJsonObject { put("seq", seq) })

    // ---- the feed and the socket ----

    /**
     * `GET …/changes`: the rooms changed after cursor [after] (all of them without one), at most [limit] per page.
     * [active] and [roomAfter] ask for the open room's new events inline.
     */
    suspend fun changes(w: String, after: String? = null, limit: Int? = null, active: String? = null, roomAfter: Long? = null): FeedPage {
        val query = buildList {
            if (after != null) add("after=${id(after)}")
            if (limit != null) add("limit=$limit")
            if (active != null) add("active=${id(active)}")
            if (roomAfter != null) add("roomAfter=$roomAfter")
        }
        return fetch(ws(w, "/changes") + if (query.isEmpty()) "" else "?" + query.joinToString("&"), FeedPage.serializer())
    }

    /** `POST …/socket-ticket`: a short-lived ticket for the wake socket's `Authorization: Ticket` header. */
    suspend fun socketTicket(w: String): SocketTicket = send("POST", ws(w, "/socket-ticket"), SocketTicket.serializer())

    // ---- plumbing ----

    private suspend fun call(method: String, path: String, body: JsonElement?): WorkspaceAnswer {
        val s = session() ?: throw WorkspaceError("signed_out")
        try {
            return http.request(s.server, method, path, body, s.token)
        } catch (e: WorkspaceError) {
            if (e.status == 401 && e.scope != "workspace") refused(s)
            throw e
        }
    }

    private fun <T> decode(answer: WorkspaceAnswer, serializer: KSerializer<T>): T {
        val body = answer.body as? JsonObject ?: throw WorkspaceError("server", answer.status, message = "no answer")
        return try {
            RukooJson.decodeFromJsonElement(serializer, body)
        } catch (e: IllegalArgumentException) {
            // kotlinx.serialization's SerializationException is one: an answer of a shape this version can't read.
            throw WorkspaceError("server", answer.status, message = "an answer of the wrong shape", cause = e)
        }
    }

    private suspend fun <T> fetch(path: String, serializer: KSerializer<T>): T = decode(call("GET", path, null), serializer)

    private suspend fun <T> send(method: String, path: String, serializer: KSerializer<T>, body: JsonElement? = null): T =
        decode(call(method, path, body), serializer)

    private suspend fun <T> created(method: String, path: String, serializer: KSerializer<T>, body: JsonElement?): Created<T> {
        val answer = call(method, path, body)
        return Created(decode(answer, serializer), answer.status == 201)
    }

    private suspend fun none(method: String, path: String) {
        call(method, path, null)
    }

    private fun successorQuery(successor: String?) = if (successor == null) "" else "?successor=${id(successor)}"

    private fun ws(w: String, rest: String = "") = "/v1/workspaces/${id(w)}$rest"

    companion object {
        // Every ID, cursor and operation ID is base64url or a UUID. Anything else is refused here as the server would
        // refuse it, so nothing such as ".." or "/" ever lands in a path.
        private val SEGMENT = Regex("^[A-Za-z0-9_-]{1,400}$")

        private fun id(value: String): String = if (SEGMENT.matches(value)) value else throw WorkspaceError("not_found", message = "not an id")
    }
}
