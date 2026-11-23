package nl.bvdm.rukoo.workspaces

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import nl.bvdm.rukoo.account.AccountDetails
import nl.bvdm.rukoo.account.AccountError
import nl.bvdm.rukoo.account.BorrowedSession
import nl.bvdm.rukoo.account.ServerInfo
import nl.bvdm.rukoo.core.RukooJson
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every answer the real server gave in the recording (src/test/resources/workspace/vectors.json) goes through the
 * phone's own client and parsers: a success decodes into its model, a refusal into the [WorkspaceError] its `error`
 * and `scope` say. Every route the client has is in the recording, so a route the server changes shows up here once
 * make-fixtures.js records again.
 */
class WorkspaceVectorsTest {
    private val v = WorkspaceVectors

    /** One of the client's routes: how to recognize its recordings, and how to make the same call. */
    private class Route(val method: String, pattern: String, val call: suspend WorkspaceClient.(List<String>, JsonObject) -> Any?) {
        val path = Regex("^/v1/workspaces$pattern$")
    }

    private fun JsonObject.s(key: String) = (getValue(key) as JsonPrimitive).content

    private fun JsonObject.sOrNull(key: String) = (get(key) as? JsonPrimitive)?.content

    private fun JsonObject.ids(key: String) = get(key)?.jsonArray?.map { (it as JsonPrimitive).content }

    private val id = "([A-Za-z0-9_-]+)"
    private val routes = listOf(
        Route("GET", "", { _, _ -> list() }),
        Route("POST", "", { _, b -> create(b.s("name"), b.s("displayName")) }),
        Route("GET", "/$id", { p, _ -> get(p[0]) }),
        Route("DELETE", "/$id", { p, _ -> deleteWorkspace(p[0]) }),
        Route("GET", "/$id/members", { p, _ -> members(p[0]) }),
        Route("PATCH", "/$id/members/me", { p, b -> renameMe(p[0], b.s("name")) }),
        Route("PATCH", "/$id/members/(u_[A-Za-z0-9_-]+)", { p, b -> setRole(p[0], p[1], b.s("role")) }),
        Route("DELETE", "/$id/members/me", { p, _ -> leave(p[0]) }),
        Route("DELETE", "/$id/members/(u_[A-Za-z0-9_-]+)", { p, _ -> removeMember(p[0], p[1]) }),
        Route("GET", "/$id/invites", { p, _ -> invites(p[0]) }),
        Route("POST", "/$id/invites", { p, b ->
            createInvite(p[0], b.s("role"), b["channels"]?.jsonArray?.map { (it as JsonPrimitive).content }.orEmpty(), (b["expiresIn"] as? JsonPrimitive)?.longOrNull)
        }),
        Route("DELETE", "/$id/invites/$id", { p, _ -> withdrawInvite(p[0], p[1]) }),
        Route("POST", "/$id/invites/preview", { p, b -> previewInvite(p[0], b.s("invite")) }),
        Route("POST", "/$id/join", { p, b -> join(p[0], b.s("invite"), b.s("name")) }),
        Route("GET", "/$id/channels", { p, _ -> channels(p[0]) }),
        Route("POST", "/$id/channels", { p, b -> createChannel(p[0], b.s("name"), b.s("visibility")) }),
        Route("PATCH", "/$id/channels/$id", { p, b ->
            if ((b["archived"] as? JsonPrimitive)?.boolean == true) archiveChannel(p[0], p[1]) else renameChannel(p[0], p[1], b.s("name"))
        }),
        Route("POST", "/$id/channels/$id/join", { p, _ -> joinChannel(p[0], p[1]) }),
        Route("GET", "/$id/channels/$id/members", { p, _ -> channelMembers(p[0], p[1]) }),
        Route("POST", "/$id/channels/$id/members", { p, b -> admit(p[0], p[1], b.s("member")) }),
        Route("PATCH", "/$id/channels/$id/members/$id", { p, b -> setChannelRole(p[0], p[1], p[2], b.s("role")) }),
        Route("DELETE", "/$id/channels/$id/members/me(?:\\?successor=$id)?", { p, _ -> leaveChannel(p[0], p[1], p[2].ifEmpty { null }) }),
        Route("DELETE", "/$id/channels/$id/members/(u_[A-Za-z0-9_-]+)(?:\\?successor=$id)?", { p, _ -> removeFromChannel(p[0], p[1], p[2], p[3].ifEmpty { null }) }),
        Route("POST", "/$id/dms", { p, b -> startDm(p[0], b.getValue("members").jsonArray.map { (it as JsonPrimitive).content }) }),
        Route("POST", "/$id/dms/$id/leave", { p, _ -> leaveDm(p[0], p[1]) }),
        Route("GET", "/$id/blocks", { p, _ -> blocks(p[0]) }),
        Route("POST", "/$id/blocks", { p, b -> block(p[0], b.s("member")) }),
        Route("DELETE", "/$id/blocks/$id", { p, _ -> unblock(p[0], p[1]) }),
        Route("GET", "/$id/agents", { p, _ -> agents(p[0]) }),
        Route("POST", "/$id/agents", { p, b -> createAgent(p[0], b.s("name"), b.s("answers"), b.ids("members").orEmpty(), (b.getValue("agents") as JsonPrimitive).boolean) }),
        Route("PATCH", "/$id/agents/(u_[A-Za-z0-9_-]+)", { p, b ->
            updateAgent(p[0], p[1], b.sOrNull("name"), b.sOrNull("answers"), b.ids("members"), (b["agents"] as? JsonPrimitive)?.boolean)
        }),
        Route("POST", "/$id/agents/(u_[A-Za-z0-9_-]+)/key", { p, _ -> agentKey(p[0], p[1]) }),
        Route("DELETE", "/$id/agents/(u_[A-Za-z0-9_-]+)", { p, _ -> removeAgent(p[0], p[1]) }),
        Route("POST", "/$id/conversations/$id/messages", { p, b -> post(p[0], p[1], RukooJson.decodeFromJsonElement(SendBody.serializer(), b)) }),
        Route("GET", "/$id/conversations/$id/operations/([0-9a-f-]+)", { p, _ -> operation(p[0], p[1], p[2]) }),
        Route("GET", "/$id/conversations/$id/events\\?(?:after=(\\d+)&)?(?:before=(\\d+)&)?limit=(\\d+)", { p, _ ->
            events(p[0], p[1], after = p[2].toLongOrNull(), before = p[3].toLongOrNull(), limit = p[4].toInt())
        }),
        Route("POST", "/$id/conversations/$id/messages/$id/redact", { p, _ -> redact(p[0], p[1], p[2]) }),
        Route("POST", "/$id/conversations/$id/read", { p, b -> read(p[0], p[1], (b.getValue("seq") as JsonPrimitive).long) }),
        Route("GET", "/$id/changes(?:\\?(?:after=(\\{cursor\\})&?)?(?:limit=(\\d+))?)?", { p, _ ->
            changes(p[0], after = p.getOrNull(1)?.takeIf { it.isNotEmpty() }?.let { "recorded_cursor" }, limit = p.getOrNull(2)?.toIntOrNull())
        }),
        Route("POST", "/$id/socket-ticket", { p, _ -> socketTicket(p[0]) }),
    )

    /** The route a recorded workspace exchange belongs to, and the parts its pattern took from the path. */
    private fun routeOf(e: WorkspaceVectors.Exchange): Pair<Route, List<String>>? {
        for (r in routes) {
            if (r.method != e.method) continue
            val m = r.path.matchEntire(e.path) ?: continue
            return r to m.groupValues.drop(1)
        }
        return null
    }

    private val accountRoutes = setOf("GET /v1/info", "GET /v1/account", "POST /v1/signup")

    @Test
    fun `every recorded workspace answer goes through the client and decodes`() = runBlocking {
        val workspaceExchanges = v.exchanges.filter { "${it.method} ${it.path.substringBefore('?')}" !in accountRoutes }
        assertTrue(workspaceExchanges.size > 80)
        RecordedWorkspaceServer().use { server ->
            val client = WorkspaceClient(OkHttpWorkspaceHttp(OkHttpClient()), { BorrowedSession(server.url, server.nextAuth ?: "nobody", "tag", Unit) }, { })
            for (e in workspaceExchanges) {
                val (route, parts) = routeOf(e) ?: throw AssertionError("No client route for $e")
                server.answer(e.name)
                val body = (e.requestBody as? JsonObject) ?: JsonObject(emptyMap())
                try {
                    val result = client.(route.call)(parts, body)
                    if (route.path.pattern.contains("/operations/") && e.status == 404 && e.body?.sOrNull("scope") == null) {
                        // The lookup of an operation the server has no message from: null, which the outbox acts on.
                        assertNull("$e", result)
                        continue
                    }
                    assertTrue("$e answered, so it isn't a refusal", e.status in 200..299)
                    if (e.status != 204) assertNotNull("$e decodes", result)
                } catch (err: WorkspaceError) {
                    assertFalse("$e is a success, but the client threw $err", e.status in 200..299)
                    val expected = when (e.status) {
                        401 -> "signed_out"
                        426 -> "upgrade_required"
                        else -> e.error
                    }
                    assertEquals("$e", expected, err.code)
                    assertEquals("$e", e.status, err.status)
                    assertEquals("$e", e.body?.sOrNull("scope"), err.scope)
                    assertEquals("$e", e.body?.sOrNull("field"), err.field)
                    assertEquals("$e", e.body?.sOrNull("limit"), err.limit)
                    assertEquals("$e", e.body?.sOrNull("member"), err.member)
                }
            }
            server.verify()
        }
    }

    @Test
    fun `the recording holds every route the client has`() {
        val used = v.exchanges.mapNotNull { routeOf(it)?.first }.toSet()
        val missing = routes.filter { it !in used }.map { "${it.method} ${it.path.pattern}" }
        assertEquals("routes without a recorded answer", emptyList<String>(), missing)
    }

    @Test
    fun `every recorded refusal has a code the phone knows`() {
        for (e in v.exchanges.filter { it.status >= 400 }) {
            val code = e.error ?: throw AssertionError("$e has no error code")
            if ("${e.method} ${e.path}" == "POST /v1/signup") {
                assertTrue("$e", code in AccountError.CODES)
            } else {
                assertTrue("$e: $code", code in WorkspaceError.CODES || e.status == 401)
            }
        }
    }

    @Test
    fun `the server info turns Chat on and says invitations work for sign-up`() {
        val info = RukooJson.decodeFromJsonElement(ServerInfo.serializer(), v.exchange("info").body!!)
        assertTrue(WORKSPACES_FEATURE in info.features)
        assertTrue(info.teamChat)
        val ws = info.workspace!!
        // The server speaks the rich chat contract's version 2 too; the phone speaks 1, which it still lists.
        assertTrue(WORKSPACE_VERSION in ws.versions)
        assertTrue(ws.inviteSignups)
        assertEquals(6, ws.limits.members)
        assertEquals(12, ws.limits.conversations)
        assertEquals(16384, ws.limits.textBytes)
        assertEquals(90, ws.retention?.contentDays)
        assertNotNull(ws.home?.installation)
        // An older server's answer, without either field, still reads, with Chat off.
        val old = RukooJson.decodeFromJsonElement(ServerInfo.serializer(), JsonObject(v.exchange("info").body!!.filterKeys { it != "features" && it != "workspace" }))
        assertFalse(old.teamChat)
        assertNull(old.workspace)
    }

    @Test
    fun `the account answer and a sign-up with an invitation read their class and incarnation`() {
        val account = RukooJson.decodeFromJsonElement(AccountDetails.serializer(), v.exchange("account").body!!)
        assertEquals("full", account.accountClass)
        val signup = v.exchange("sign up with invitation")
        assertEquals(201, signup.status)
        assertEquals("tokens are names in the recording", "nina", signup.body!!.s("token"))
        val invite = signup.requestBody!!.jsonObject.getValue("workspaceInvite").jsonObject
        assertEquals(v.id("workspace"), invite.s("workspace"))
        assertNull("a sign-up with an invitation sends no invite code", signup.requestBody!!.jsonObject["invite"])
        assertEquals("full", RukooJson.decodeFromJsonElement(AccountDetails.serializer(), signup.body!!.getValue("account")).accountClass)
        assertEquals("invite_required", v.exchange("sign up with used invitation").error)
    }

    @Test
    fun `DM rows and the feed's directory read as contract 2_4 describes`() {
        val feed = RukooJson.decodeFromJsonElement(FeedPage.serializer(), v.exchange("feed after block").body!!)
        val closed = feed.changes.single { it.conversation == v.id("bartDm") }
        assertEquals("dm", closed.kind)
        assertNull(closed.name)
        assertTrue(closed.archived)
        assertEquals("closed", closed.closedReason)
        assertEquals(listOf(v.id("olga"), v.id("bart")), closed.participants)
        assertTrue("a block tells the blocker's devices to load the blocks again", feed.directory.blocks)
        val first = RukooJson.decodeFromJsonElement(FeedPage.serializer(), v.exchange("feed first pass").body!!)
        assertTrue(first.changes.all { it.kind == "channel" && it.lastAt != null && it.members > 0 })
        val events = RukooJson.decodeFromJsonElement(EventPage.serializer(), v.exchange("dm events").body!!)
        val started = events.events.first()
        assertEquals("dm.started", started.kind)
        assertEquals(listOf(v.id("olga"), v.id("mila")), started.members)
        assertEquals(started.members, started.data()?.members)
    }

    @Test
    fun `agents read in the server info, the directory, the feed and an agent's reply`() {
        val info = RukooJson.decodeFromJsonElement(ServerInfo.serializer(), v.exchange("info").body!!).workspace!!
        assertTrue(info.agentsOn)
        assertEquals(WorkspaceAgentLimits(max = 2, depth = 3, repliesPerHour = 120), info.agents)

        // In the directory an agent is a member of kind agent, with its settings and never its key.
        val members = RukooJson.decodeFromJsonElement(MembersPage.serializer(), v.exchange("members with agent").body!!).members
        val clark = members.single { it.isAgent }
        assertEquals(v.id("clark"), clark.id)
        assertEquals("member", clark.role)
        assertEquals(AgentSettings(sponsor = v.id("mila"), answers = "members", members = listOf(v.id("olga")), agents = true), clark.agent)
        assertTrue(members.filter { it.id != clark.id }.none { it.isAgent || it.agent != null })
        assertFalse(v.exchange("members with agent").body.toString().contains("rka_"))

        // A feed row counts its people in members and its agents apart.
        val feed = RukooJson.decodeFromJsonElement(FeedPage.serializer(), v.exchange("feed with agents").body!!)
        FeedApplier.check(feed)
        val general = feed.changes.single { it.conversation == v.id("general") }
        assertEquals(1, general.agents)
        assertTrue(feed.changes.filter { it.conversation != v.id("general") }.all { it.agents == 0 })

        // The reply names its trigger, its depth and the person who started the chain (Olga, who asked), goes in the
        // trigger's thread, and keeps all three in the cache's data.
        val page = RukooJson.decodeFromJsonElement(EventPage.serializer(), v.exchange("events with agent reply").body!!)
        FeedApplier.check(page)
        val trigger = page.events.single { it.id == v.id("agentTrigger") }
        val reply = page.events.single { it.id == v.id("agentReply") }
        assertEquals(v.id("clark"), reply.actor)
        assertEquals(v.id("agentTrigger"), reply.trigger)
        assertEquals(1, reply.depth)
        assertEquals(v.id("olga"), reply.origin)
        assertEquals(trigger.actor, reply.origin)
        assertEquals(v.id("agentTrigger"), reply.root)
        assertEquals(EventData(trigger = v.id("agentTrigger"), depth = 1, origin = v.id("olga")), reply.data())
        assertNull("a person's message has no trigger, depth or origin", trigger.trigger ?: trigger.depth ?: trigger.origin)
        assertNull(trigger.data())

        // The key is shown in the answers that make one, and works for that agent only.
        val made = RukooJson.decodeFromJsonElement(MadeAgent.serializer(), v.exchange("create agent").body!!)
        assertTrue(WorkspaceIds.isAgentKey(made.key, made.agent.id))
        assertFalse(WorkspaceIds.isAgentKey(made.key, v.id("mila")))
        val rekeyed = RukooJson.decodeFromJsonElement(MadeAgent.serializer(), v.exchange("agent key").body!!)
        assertTrue(WorkspaceIds.isAgentKey(rekeyed.key, made.agent.id))
        assertTrue("a new key is another key", rekeyed.key != made.key)
        // Its sponsor makes it; an owner gets no key at all.
        assertEquals("mila", v.exchange("agent key").auth)
        assertFalse(v.exchange("agent key as owner").body.toString().contains("rka_"))
    }

    @Test
    fun `mentions arrive as UTF-8 byte offsets of the text`() {
        val events = RukooJson.decodeFromJsonElement(EventPage.serializer(), v.exchange("events").body!!)
        val posted = events.events.firstOrNull { it.id == v.id("message") }
        // The message was removed after this page was recorded; the page still has it with its mention.
        assertNotNull(posted)
        val m = posted!!.mentions.single()
        assertEquals(v.id("mila"), m.actor)
        assertEquals("@Mila", posted.text!!.toByteArray(Charsets.UTF_8).copyOfRange(m.start, m.end).toString(Charsets.UTF_8))
        assertTrue(Utf8Offsets.isValid(posted.text!!, posted.mentions))
    }

    @Test
    fun `the recording holds names, never tokens`() {
        val names = setOf("olga", "mila", "bart", "pia", "tom", "gus", "zoe", "rex", "tina")
        for (e in v.exchanges) if (e.auth != null) assertTrue("$e", e.auth in names)
        val text = WorkspaceVectors::class.java.getResource("/workspace/vectors.json")!!.readText()
        assertFalse("no address of the recording server", text.contains("127.0.0.1"))
    }
}
