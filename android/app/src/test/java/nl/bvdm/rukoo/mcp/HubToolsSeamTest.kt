package nl.bvdm.rukoo.mcp

import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import nl.bvdm.rukoo.agents.AgentSettings
import nl.bvdm.rukoo.agents.HubKit
import nl.bvdm.rukoo.agents.SendRequest
import nl.bvdm.rukoo.agents.ToolIdentity
import nl.bvdm.rukoo.agents.adapters.FakeAdapter
import nl.bvdm.rukoo.agents.adapters.FakeTools
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalStatus
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.TaskStatus
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.UnsubscribeResult
import nl.bvdm.rukoo.mcp.tools.McpTools
import nl.bvdm.rukoo.mcp.tools.ToolDeps
import nl.bvdm.rukoo.ui.ComposerState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Rukoo's tools against the real Hub, the seam the two were first built apart across: the hub runs every mail action,
 * once, on the chat's mail chain; the tool only asks. The fake agent goes through the same tools.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HubToolsSeamTest {
    private val callId = MessageIds.encode("demo", "INBOX", 12) // Sanne's "Call on Thursday"
    private val contract = MessageIds.encode("demo", "INBOX", 3)
    private val newsletter = MessageIds.encode("demo", "INBOX", 1) // ANWB, with List-Unsubscribe
    private val clark = ToolIdentity("clark")
    private var settings = AgentSettings()

    private class Seam(val k: HubKit, val tools: McpTools)

    private suspend fun TestScope.seam(kit: HubKit = HubKit(this), mailWaitMs: Long = 90_000): Seam {
        runCurrent()
        kit.hub.ready()
        return Seam(kit, McpTools(ToolDeps(kit.mail, kit.hub, kit.screen, kit.composer, { settings }, mailWaitMs = mailWaitMs)))
    }

    private suspend fun Seam.call(name: String, args: String, identity: ToolIdentity = clark): JsonObject =
        tools.callTool(identity, name, Json.parseToJsonElement(args).jsonObject, JsonObject(emptyMap()))

    private fun JsonObject.data(): JsonObject {
        assertTrue("unexpected error: $this", this["isError"] == null)
        return this["structuredContent"]!!.jsonObject
    }

    private fun Seam.items(cid: String) = k.hub.get(cid)!!.items

    @Test
    fun anApprovedMailCardRunsOnceInTheHub() = runTest {
        val s = seam()
        val c = s.k.hub.create("clark", MessageRef(callId))
        val r = s.call("mail_action", """{"conversation_id":"${c.id}","action":"archive","message_ids":["$contract"]}""").data()
        assertEquals("waiting_for_user", r["status"]!!.jsonPrimitive.content)
        val card = s.items(c.id).filterIsInstance<Item.Approval>().single()
        assertEquals(ApprovalKind.MAIL, card.kind)
        advanceUntilIdle()
        assertEquals(0, s.k.mail.archives)
        s.k.hub.decide(c.id, card.id, "approve")
        advanceUntilIdle()
        assertEquals(1, s.k.mail.archives)
        val notice = s.items(c.id).filterIsInstance<Item.Notice>().single()
        assertEquals("Archived 1 email", notice.text)
        assertEquals(Tone.SUCCESS, notice.tone)
        assertEquals(
            listOf("The user approved: <unsafe_content source=\"mail action\">Archive 1 email</unsafe_content>. Rukoo: <unsafe_content source=\"mail result\">Archived 1 email</unsafe_content>."),
            s.k.hub.get(c.id)!!.notes,
        )
        // Its undo works, once.
        s.k.hub.undo(c.id, notice.id)
        advanceUntilIdle()
        assertEquals("Restored 1 email", s.items(c.id).filterIsInstance<Item.Notice>().last().text)
        assertNotNull(s.k.engine.listMessages(MailView.folder("demo", "INBOX")).firstOrNull { it.subject == "Here is another copy of your contract" })
    }

    @Test
    fun aDeclinedMailCardIsOneNoteAndNothingRuns() = runTest {
        val s = seam()
        val c = s.k.hub.create("clark", MessageRef(callId))
        s.call("mail_action", """{"conversation_id":"${c.id}","action":"archive","message_ids":["$contract"]}""").data()
        s.k.hub.decide(c.id, s.items(c.id).last().id, "decline")
        advanceUntilIdle()
        assertEquals(0, s.k.mail.archives)
        assertTrue(s.items(c.id).none { it is Item.Notice })
        assertEquals(listOf("The user declined: <unsafe_content source=\"mail action\">Archive 1 email</unsafe_content>."), s.k.hub.get(c.id)!!.notes)
    }

    // An action that runs without asking and outlasts the call: the agent's next turn waits for it and hears how it ended.
    @Test
    fun anAutomaticActionThatOutlastsTheCallReachesTheNextTurn() = runTest {
        settings = AgentSettings(autoMailActions = true)
        val s = seam(mailWaitMs = 1_000)
        val c = s.k.hub.create("clark", MessageRef(callId))
        s.k.mail.moveDelayMs = 5_000
        val answer = async { s.call("mail_action", """{"conversation_id":"${c.id}","action":"archive","message_ids":["$contract"]}""") }
        advanceTimeBy(1_500)
        runCurrent()
        assertEquals("in_progress", answer.await().data()["status"]!!.jsonPrimitive.content)
        s.k.hub.send(c.id, SendRequest("Next"))
        advanceUntilIdle()
        assertEquals(1, s.k.mail.archives)
        assertTrue(
            s.k.clark.turns.last().input,
            s.k.clark.turns.last().input.contains("Rukoo finished <unsafe_content source=\"mail action\">Archive 1 email</unsafe_content>: <unsafe_content source=\"mail result\">Archived 1 email</unsafe_content>."),
        )
        assertEquals(1, s.items(c.id).filterIsInstance<Item.Notice>().size)
    }

    // The phone has one composer: an approved unsubscribe email never takes it from the user's own email.
    @Test
    fun anApprovedUnsubscribeEmailLeavesTheUsersComposerAlone() = runTest {
        val s = seam()
        s.k.mail.unsubscribeAs = UnsubscribeResult.SendEmail("unsubscribe@anwb.nl, list@anwb.nl", "unsubscribe", "")
        val c = s.k.hub.create("clark", MessageRef(newsletter))
        s.k.composer.open(ComposerState(body = "My own words", dirty = true))
        s.call("mail_action", """{"conversation_id":"${c.id}","action":"unsubscribe","message_ids":["$newsletter"]}""").data()
        s.k.hub.decide(c.id, s.items(c.id).last().id, "approve")
        advanceUntilIdle()
        assertEquals("My own words", s.k.composer.current()!!.body)
        assertTrue(s.items(c.id).filterIsInstance<Item.Notice>().single().text.startsWith("Could not unsubscribe 1 email. 1 failed: Rukoo's composer holds another email"))
        // With the composer free it opens there, from the account the newsletter came to, to every address.
        s.k.composer.close()
        s.call("mail_action", """{"conversation_id":"${c.id}","action":"unsubscribe","message_ids":["$newsletter"]}""").data()
        s.k.hub.decide(c.id, s.items(c.id).last().id, "approve")
        advanceUntilIdle()
        val opened = s.k.composer.current()!!
        assertEquals("demo", opened.accountId)
        assertEquals("demo@example.com", opened.from?.address)
        assertEquals(listOf("unsubscribe@anwb.nl", "list@anwb.nl"), opened.to.map { it.address })
        assertEquals("Opened an unsubscribe email to unsubscribe@anwb.nl. Send it to finish", s.items(c.id).filterIsInstance<Item.Notice>().last().text)
    }

    // The draft card's key is what the composer's Undo compares: undoing it marks the card, as the app's view model does.
    @Test
    fun theComposersUndoFindsTheDraftCard() = runTest {
        val s = seam()
        val c = s.k.hub.create("clark", MessageRef(callId))
        s.call("write_draft", """{"conversation_id":"${c.id}","body":"Thursday works."}""").data()
        val open = s.k.composer.current()!!
        assertEquals("Clark", open.draftedBy)
        assertTrue(s.k.composer.undoAgentDraft())
        // AppViewModel.undoAgentDraft: the chat's card for that composer.
        val row = s.k.hub.conversations.value.first { r -> s.k.hub.get(r.id)!!.items.any { it is Item.Draft && it.composerKey == open.id && !it.undone } }
        val card = s.k.hub.get(row.id)!!.items.filterIsInstance<Item.Draft>().last()
        s.k.hub.patchDraft(row.id, card.id, undone = true)
        assertTrue((s.items(c.id).last { it is Item.Draft } as Item.Draft).undone)
    }

    // The debug fake agent calls the phone's tools: its reply is a real draft in the composer, its unsubscribe a real card.
    @Test
    fun theFakeAgentRunsTheRealTools() = runTest {
        val kit = HubKit(this, includeFake = true)
        lateinit var s: Seam
        kit.adapters[AgentIds.FAKE] = FakeAdapter(AgentIds.FAKE, FakeTools { i, n, a -> s.tools.callTool(i, n, a, JsonObject(emptyMap())) }, { kit.hub }, scale = 0.001)
        s = seam(kit)
        val chat = kit.hub.create(AgentIds.FAKE, MessageRef(callId))
        kit.hub.send(chat.id, SendRequest("Reply to Sanne", action = "reply"))
        advanceUntilIdle()
        val draft = s.items(chat.id).filterIsInstance<Item.Draft>().single()
        val open = kit.composer.current()!!
        assertEquals("Test agent", open.draftedBy)
        assertEquals(open.id, draft.composerKey)
        assertEquals("Re: Call on Thursday", open.subject)
        assertTrue(s.items(chat.id).filterIsInstance<Item.Tool>().all { it.status == nl.bvdm.rukoo.agents.model.ToolStatus.DONE })

        val news = kit.hub.create(AgentIds.FAKE, MessageRef(newsletter))
        kit.hub.send(news.id, SendRequest("Unsubscribe", action = "unsubscribe"))
        advanceUntilIdle()
        val card = s.items(news.id).filterIsInstance<Item.Approval>().single()
        assertEquals("Unsubscribe from ANWB Newsletter", card.title)
        kit.hub.decide(news.id, card.id, "approve")
        advanceUntilIdle()
        assertEquals(ApprovalStatus.APPROVED, s.items(news.id).filterIsInstance<Item.Approval>().single().status)
        assertEquals("Unsubscribed from ANWB Newsletter", s.items(news.id).filterIsInstance<Item.Notice>().single().text)
    }

    // Tool calls run side by side off the main thread: plan updates at the same time must not undo each other.
    @Test
    fun plansChangedAtTheSameTimeKeepEveryChange() = runTest {
        val k = HubKit(this)
        runCurrent()
        k.hub.ready()
        val tools = McpTools(ToolDeps(k.mail, k.hub, k.screen, k.composer, { settings }, workContext = Dispatchers.Default))
        suspend fun plan(args: String) = tools.callTool(clark, "show_plan", Json.parseToJsonElement(args).jsonObject, JsonObject(emptyMap()))
        val c = k.hub.create("clark", null)
        plan("""{"conversation_id":"${c.id}","title":"All","tasks":[${(1..20).joinToString(",") { """{"id":"t$it","title":"Task $it"}""" }}]}""").data()
        coroutineScope {
            (1..20).map { i -> async(Dispatchers.Default) { plan("""{"conversation_id":"${c.id}","plan_id":"p1","tasks":[{"id":"t$i","status":"done"}]}""") } }.awaitAll()
        }
        val all = k.hub.get(c.id)!!.items.filterIsInstance<Item.Plan>().single()
        assertTrue(all.tasks.all { it.status == TaskStatus.DONE })
        coroutineScope {
            (1..10).map { i -> async(Dispatchers.Default) { plan("""{"conversation_id":"${c.id}","title":"P$i","tasks":[{"title":"x"}]}""") } }.awaitAll()
        }
        val ids = k.hub.get(c.id)!!.items.filterIsInstance<Item.Plan>().map { it.planId }
        assertEquals(11, ids.toSet().size)
    }

    // After boot the socket can be up before conversations.json is read: hello still knows the stored chat.
    @Test
    fun helloWaitsForTheStoredChats() = runTest {
        val dir = java.nio.file.Files.createTempDirectory("rukoo-hub").toFile()
        File(dir, "conversations.json").writeText("""{"version":1,"conversations":[{"id":"c_old","agent":"clark","title":"Old","createdAt":${HubKit.BASE},"items":[]}]}""")
        val k = HubKit(this, dir = dir)
        val handler = McpHandler(McpTools(ToolDeps(k.mail, k.hub, k.screen, k.composer, { settings })), "1", { "test" })
        val hello = handler.dispatch(McpCaller.Clark, Json.parseToJsonElement("""{"jsonrpc":"2.0","id":1,"method":"rukoo/hello","params":{"conversation_id":"c_old"}}"""))
        assertEquals("true", hello!!["result"]!!.jsonObject["owns"].toString())
    }
}
