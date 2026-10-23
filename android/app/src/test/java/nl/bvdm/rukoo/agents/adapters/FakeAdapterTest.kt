package nl.bvdm.rukoo.agents.adapters

import android.content.ContextWrapper
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import nl.bvdm.rukoo.agents.AdapterDeps
import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.AgentSettings
import nl.bvdm.rukoo.agents.AgentSettingsStore
import nl.bvdm.rukoo.agents.PairedComputer
import nl.bvdm.rukoo.agents.model.AdapterEvent
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ComputerProgram
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.TaskStatus
import nl.bvdm.rukoo.agents.model.TurnStatus
import nl.bvdm.rukoo.agents.preview.PreviewAgentHub
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.SecretCipher
import nl.bvdm.rukoo.mail.demo.PreviewMailEngine
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mcp.tools.McpTools
import nl.bvdm.rukoo.mcp.tools.ToolDeps
import nl.bvdm.rukoo.ui.ComposerController
import nl.bvdm.rukoo.ui.ScreenState
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class FakeAdapterTest {
    private val scope = testScope()
    private val preview = PreviewAgentHub(scope, Clock.System)

    // The preview hub as the chat store, with the fake agent turned on as debug builds have it.
    private val hub = object : AgentHub by preview {
        override fun agentEnabled(agent: String) = agent == AgentIds.FAKE || preview.agentEnabled(agent)

        override fun agentName(agent: String) = if (agent == AgentIds.FAKE) "Test agent" else preview.agentName(agent)
    }
    private val composer = ComposerController()
    private val screen = ScreenState(Clock.System)

    // The phone's real tools, as the app hands them to the fake agent.
    private val tools = McpTools(ToolDeps(PreviewMailEngine(Clock.System), hub, screen, composer, { AgentSettings() }))
    private val fakeTools = FakeTools { identity, name, args -> tools.callTool(identity, name, args, JsonObject(emptyMap())) }

    private fun fake(id: String = AgentIds.FAKE) = FakeAdapter(id, fakeTools, { hub }, scale = 0.01)

    // Sanne's "Call on Thursday" in the demo mailbox.
    private suspend fun chat() = hub.create(
        AgentIds.FAKE,
        MessageRef(id = MessageIds.encode("demo", "INBOX", 12), messageId = "<demo-13@example.com>", subject = "Call on Thursday", from = Address("Sanne de Vries", "sanne@example.com")),
    )

    @Test
    fun anEchoThinksThenStreamsInSmallSteps() = runBlocking {
        val a = fake()
        val turn = RecordingTurn(text = "What is the weather?")
        assertEquals(TurnStatus.DONE, a.runTurn(turn).status)
        assertEquals(AdapterEvent.Thinking("Thinking about your question."), turn.events[0])
        assertEquals(AdapterEvent.ThinkingDone, turn.events[1])
        assertTrue(turn.events.drop(2).all { it is AdapterEvent.Text && it.delta.length <= 6 })
        assertTrue(turn.text().startsWith("You asked: \"What is the weather?\". This is the fake agent."))
        assertEquals("What is the weather?", a.received.single().text)
    }

    @Test
    fun anApprovalIsAskedWithTheWholeCommand() = runBlocking {
        val allowed = RecordingTurn(text = "approval please", choose = { "allow" })
        fake().runTurn(allowed)
        assertEquals("Added \"Send proposal\" to Todoist, due Friday.", allowed.text())
        assertEquals(AdapterEvent.ToolEnd("fake-1", false), allowed.events.filterIsInstance<AdapterEvent.ToolEnd>().single())

        val denied = RecordingTurn(text = "approval please", choose = { "deny" })
        fake().runTurn(denied)
        assertEquals("OK, I did not run it.", denied.text())

        val expired = RecordingTurn(text = "approval please", choose = { "cancel" })
        assertEquals(TurnStatus.STOPPED, fake().runTurn(expired).status)

        val long = RecordingTurn(text = "a long command", choose = { "deny" })
        fake().runTurn(long)
        val command = long.approvals.single().fields.single().value
        assertEquals(900, command.length)
        assertTrue(command.endsWith(FakeAdapter.LONG_COMMAND_TAIL))
    }

    @Test
    fun anErrorAndALostSession() = runBlocking {
        val failing = RecordingTurn(text = "show an error")
        val result = fake().runTurn(failing)
        assertEquals(ErrorCodes.OFFLINE, result.error?.code)
        assertEquals(AdapterEvent.Error(ErrorCodes.OFFLINE, "connect ECONNREFUSED 100.91.52.84:8642"), failing.events.single())

        val lost = RecordingTurn(text = "lost session", recap = "<unsafe_content source=\"email\" from=\"x\">…</unsafe_content>")
        fake().runTurn(lost)
        assertEquals(1, lost.startOvers)
        assertEquals("new-session", (lost.events.first() as AdapterEvent.Notice).code)
        assertEquals("I started a new session. Rukoo sent me the email.", lost.text())
    }

    @Test
    fun theTasksActionShowsAPlanAndAProposalThroughTheHub() = runBlocking {
        val c = chat()
        val turn = RecordingTurn(conversation = c, action = "tasks")
        assertEquals(TurnStatus.DONE, fake().runTurn(turn).status)
        val items = hub.get(c.id)!!.items
        val plan = items.filterIsInstance<Item.Plan>().single()
        assertEquals("Follow-ups", plan.title)
        assertEquals(listOf(TaskStatus.DONE, TaskStatus.PROPOSED, TaskStatus.PROPOSED), plan.tasks.map { it.status })
        val proposal = items.filterIsInstance<Item.Approval>().single()
        assertEquals(ApprovalKind.PROPOSAL, proposal.kind)
        assertEquals("Add tasks", proposal.choices.first().label)
        assertEquals(listOf("mcp__rukoo__show_plan", "mcp__rukoo__propose_action"), turn.events.filterIsInstance<AdapterEvent.ToolStart>().map { it.name })

        // Approving it: the follow-up marks the open tasks done, in the same plan.
        val follow = RecordingTurn(conversation = hub.get(c.id)!!, action = "approved", text = "Approved: Add 2 tasks to Todoist")
        fake().runTurn(follow)
        val updated = hub.get(c.id)!!.items.filterIsInstance<Item.Plan>().single()
        assertTrue(updated.tasks.all { it.status == TaskStatus.DONE })
        assertEquals("Done. I added 2 tasks and linked them in the plan.", follow.text())
    }

    @Test
    fun theBriefShowsSourcesAndTheReplyWritesADraftCard() = runBlocking {
        val c = chat()
        val brief = RecordingTurn(conversation = c, action = "brief")
        fake().runTurn(brief)
        val sources = hub.get(c.id)!!.items.filterIsInstance<Item.Sources>().single()
        // The real search found Sanne's other email; it leads the list.
        assertEquals(listOf("Email", "CRM", "Obsidian"), sources.sources.map { it.source })
        assertEquals(listOf("Sanne (CRM)", "Call notes"), sources.sources.drop(1).map { it.title })
        assertTrue(brief.text().startsWith("Sanne wants a call on Thursday"))

        val reply = RecordingTurn(conversation = c, action = "reply")
        fake().runTurn(reply)
        val draft = hub.get(c.id)!!.items.filterIsInstance<Item.Draft>().single()
        assertEquals("Re: Call on Thursday", draft.subject)
        assertEquals(listOf("sanne@example.com"), draft.to.map { it.address })
        assertTrue(reply.text().endsWith("Done. The draft is in the composer."))
        // write_draft put it in the phone's composer, as the agent's.
        val open = composer.current()!!
        assertEquals("Test agent", open.draftedBy)
        assertEquals(c.id, open.draftedIn)
        assertEquals(open.id, draft.composerKey)
        assertTrue(open.body.startsWith("Hi Sanne,"))
    }

    // With the chat's email open, get_context sends it as open_message and chat_message as null.
    @Test
    fun theReplyGreetsTheSenderOfTheOpenEmail() = runBlocking {
        val c = chat()
        screen.update { it.copy(openMessageId = c.message!!.id) }
        fake().runTurn(RecordingTurn(conversation = c, action = "reply"))
        assertTrue(composer.current()!!.body, composer.current()!!.body.startsWith("Hi Sanne,"))
    }

    @Test
    fun withoutAHubTheToolsSayTheyAreNotConnected() = runBlocking {
        val a = FakeAdapter(AgentIds.FAKE, FakeTools.None, scale = 0.01)
        val turn = RecordingTurn(action = "reply")
        assertEquals(TurnStatus.DONE, a.runTurn(turn).status)
        assertTrue(turn.text().contains("I could not put the draft in the composer: Rukoo's tools are not connected to the fake agent"))
        assertTrue(turn.events.filterIsInstance<AdapterEvent.ToolEnd>().all { it.error })
    }

    @Test
    fun menusFollowTheAgentItStandsFor() = runBlocking {
        assertTrue(fake().models().models.any { it.route })
        assertEquals("fake", fake().models().agent)
        assertEquals(listOf("gpt-6-astra", "gpt-6-luna"), fake(AgentIds.computer("ph_x", ComputerProgram.CODEX)).models().models.map { it.id })
        assertEquals(emptyList<Any>(), fake(AgentIds.OPENCLAW).skills())
        assertEquals("humanizer", fake(AgentIds.computer("ph_x", ComputerProgram.CLAUDE)).skills().first().name)
        val skilled = RecordingTurn(skills = listOf("meeting-prep"))
        fake().runTurn(skilled)
        assertEquals("Started \$meeting-prep.", skilled.text())
        val which = RecordingTurn(text = "which model is this", model = "quick", effort = "low")
        fake().runTurn(which)
        assertEquals("Model: quick. Effort: low.", which.text())
    }
}

class DefaultAdapterFactoryTest {
    private object Plain : SecretCipher {
        override fun encrypt(plain: String) = plain

        override fun decrypt(blob: String) = blob
    }

    private val dir = Files.createTempDirectory("rukoo-factory").toFile()
    private val store = AgentSettingsStore(java.io.File(dir, "agents.json"), Plain)
    private val deps = AdapterDeps(
        context = ContextWrapper(null),
        settings = store,
        desktop = ScriptedDesktop(),
        http = OkHttpClient(),
        clock = Clock.System,
        filesDir = dir,
        scope = testScope(),
    )

    private fun factory(debug: Boolean = true, allFake: Boolean = false) = DefaultAdapterFactory(deps, debug = debug, allFake = allFake, texts = XmlTexts())

    @Test
    fun mapsIdsToOneAdapterEach() {
        val f = factory()
        val clark = f.create(AgentIds.CLARK)
        assertTrue(clark is HermesAdapter)
        assertSame(clark, f.create(AgentIds.CLARK))
        assertTrue(f.create(AgentIds.OPENCLAW) is OpenClawAdapter)
        assertTrue(f.create(AgentIds.FAKE) is FakeAdapter)
        assertNull(f.create("nonsense"))
        assertNull(f.create("computer:ph_x:other"))
    }

    @Test
    fun computerAgentsExistWhileTheirPairingDoes() = runBlocking {
        val f = factory()
        val id = AgentIds.computer("ph_k3j9x0m2qa", ComputerProgram.CODEX)
        assertNull(f.create(id))
        store.update { it.copy(computers = listOf(PairedComputer(pairingId = "ph_k3j9x0m2qa", name = "office-pc", address = "100.1.2.3"))) }
        val adapter = f.create(id)
        assertTrue(adapter is ComputerAdapter)
        assertEquals(id, adapter!!.id)
        assertSame(adapter, f.create(id))
        store.update { it.copy(computers = emptyList()) }
        assertNull(f.create(id))
    }

    @Test
    fun theFakeAgentIsForDebugBuildsOnly() {
        assertNull(factory(debug = false).create(AgentIds.FAKE))
        assertNotNull(factory(debug = true).create(AgentIds.FAKE))
        val all = factory(allFake = true)
        assertTrue(all.create(AgentIds.CLARK) is FakeAdapter)
        assertTrue(all.create(AgentIds.computer("ph_unpaired", ComputerProgram.CLAUDE)) is FakeAdapter)
        assertTrue(factory(debug = false, allFake = true).create(AgentIds.CLARK) is HermesAdapter)
    }
}
