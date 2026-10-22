package nl.bvdm.rukoo.agents.adapters

import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import nl.bvdm.rukoo.agents.AgentSettings
import nl.bvdm.rukoo.agents.PairedComputer
import nl.bvdm.rukoo.agents.TurnFile
import nl.bvdm.rukoo.agents.model.AdapterEvent
import nl.bvdm.rukoo.agents.model.AgentErrorInfo
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.ComputerProgram
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.HostLine
import nl.bvdm.rukoo.agents.model.HostStream
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.NoticeParams
import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.OwnSkills
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.agents.model.TurnStatus
import nl.bvdm.rukoo.desktop.DesktopException
import nl.bvdm.rukoo.desktop.DesktopLink
import nl.bvdm.rukoo.desktop.ExportBundle
import nl.bvdm.rukoo.desktop.HelloResponse
import nl.bvdm.rukoo.desktop.HostAgentInfo
import nl.bvdm.rukoo.desktop.HostTurnRequest
import nl.bvdm.rukoo.agents.McpGrant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** A computer host scripted line by line, in the NDJSON the desktop writes (F contract). */
class ScriptedDesktop : DesktopLink {
    override val computers: Flow<List<PairedComputer>> = MutableStateFlow(emptyList())

    val turns = CopyOnWriteArrayList<HostTurnRequest>()
    val reattaches = CopyOnWriteArrayList<Pair<String, Long>>()
    val answers = CopyOnWriteArrayList<Triple<String, String, String>>()
    val stops = CopyOnWriteArrayList<String>()
    val startOvers = CopyOnWriteArrayList<Triple<String, String, String>>()
    val forgotten = CopyOnWriteArrayList<Pair<String, String>>()
    var hellos = 0

    var hello: () -> HelloResponse = { HelloResponse() }
    var models: ModelOptions = ModelOptions(agent = "claude")
    var skills: OwnSkills = OwnSkills(agent = "claude")
    var answer: (String) -> Unit = {}

    /** One script per stream: the start, then each reattach. A script gets the turn's fake events to wait on. */
    val streams = ArrayDeque<suspend kotlinx.coroutines.flow.FlowCollector<HostLine>.() -> Unit>()

    override suspend fun pair(address: String, code: String): PairedComputer = throw DesktopException("offline")

    override suspend fun hello(pairingId: String): HelloResponse {
        hellos++
        return hello()
    }

    override suspend fun export(pairingId: String): ExportBundle = throw DesktopException("offline")

    override suspend fun forget(pairingId: String) = Unit

    /** The refresh flag of each models and skills call, in order. */
    val listRefreshes = CopyOnWriteArrayList<Boolean>()

    override suspend fun models(pairingId: String, agent: String, refresh: Boolean): ModelOptions {
        listRefreshes.add(refresh)
        return models
    }

    override suspend fun skills(pairingId: String, agent: String, refresh: Boolean): OwnSkills {
        listRefreshes.add(refresh)
        return skills
    }

    private fun next(): Flow<HostLine> {
        val script: suspend kotlinx.coroutines.flow.FlowCollector<HostLine>.() -> Unit =
            synchronized(streams) { streams.removeFirstOrNull() } ?: { throw DesktopException("not-found", "No such turn", 404) }
        return flow { script() }
    }

    override fun startTurn(pairingId: String, request: HostTurnRequest): Flow<HostLine> {
        turns.add(request)
        return next()
    }

    override fun reattach(pairingId: String, turnId: String, afterSeq: Long): Flow<HostLine> {
        reattaches.add(turnId to afterSeq)
        return next()
    }

    override suspend fun answerApproval(pairingId: String, turnId: String, approvalId: String, choice: String) {
        answer(choice)
        answers.add(Triple(turnId, approvalId, choice))
    }

    override suspend fun stopTurn(pairingId: String, turnId: String) {
        stops.add(turnId)
    }

    override suspend fun startOver(pairingId: String, turnId: String, requestId: String, input: String) {
        startOvers.add(Triple(turnId, requestId, input))
    }

    override suspend fun forgetConversation(pairingId: String, agent: String, conversationId: String) {
        forgotten.add(agent to conversationId)
    }
}

/** A desktop NDJSON line, parsed as the phone parses it. */
private fun line(json: String): HostLine = HostStream.parse(json) ?: error("not a line: $json")

class ComputerAdapterTest {
    private val desktop = ScriptedDesktop()
    private val scope = testScope()
    private var settings = AgentSettings(
        computers = listOf(PairedComputer(pairingId = "ph_k3j9x0m2qa", name = "office-pc", address = "100.101.102.103", token = "t", mcpToken = "phone-mcp-token")),
    )
    private val hello = HelloCache(desktop, scope, nl.bvdm.rukoo.core.Clock.System)

    private fun adapter(program: ComputerProgram = ComputerProgram.CLAUDE) =
        ComputerAdapter("ph_k3j9x0m2qa", program, { settings }, desktop, hello, scope, XmlTexts(), timing = ComputerAdapter.Timing(backoff = 10, reattachWindow = 2_000))

    // The hub's grant for this computer: the phone's endpoint and the token it made for it.
    private val grant = McpGrant("http://100.64.0.3:47800/mcp", "phone-mcp-token")

    private fun turn(
        mcp: McpGrant = grant,
        choose: suspend (nl.bvdm.rukoo.agents.model.ApprovalRequest) -> String = { "allow" },
    ) = RecordingTurn(
        conversation = Conversation(id = "c_mgx1_abc123", agent = "computer:ph_k3j9x0m2qa:claude", title = "Invoice", provider = mapOf("sessionId" to "sess-1", "agent" to "ignored")),
        model = "opus",
        effort = "high",
        skills = listOf("pdf"),
        emails = listOf("acc:INBOX:7"),
        mcp = mcp,
        choose = choose,
    )

    @Test
    fun aTurnSendsTheRequestAndRelaysTheStream() = runBlocking {
        desktop.streams.add {
            emit(line("""{"seq":1,"type":"started","turnId":"t_abcdefghijkl","conversationId":"c_mgx1_abc123","agent":"claude"}"""))
            emit(line("""{"seq":2,"type":"provider","patch":{"sessionId":"sess-2"}}"""))
            emit(line("""{"seq":3,"type":"accepted"}"""))
            emit(line("""{"type":"ping"}"""))
            emit(line("""{"seq":4,"type":"thinking","delta":"Reading"}"""))
            emit(line("""{"seq":5,"type":"thinking-done"}"""))
            emit(line("""{"seq":6,"type":"tool-start","key":"k1","name":"mcp__rukoo__get_context","detail":""}"""))
            emit(line("""{"seq":7,"type":"tool-end","key":"k1","error":false}"""))
            emit(line("""{"seq":8,"type":"text","delta":"Done."}"""))
            emit(line("""{"seq":9,"type":"notice","tone":"info","code":"new-thread","text":"Codex started a new thread"}"""))
            emit(line("""{"seq":10,"type":"done","status":"done"}"""))
        }
        val turn = turn()
        val result = withTimeout(5_000) { adapter().runTurn(turn) }
        assertEquals(TurnStatus.DONE, result.status)
        assertEquals(
            listOf(
                AdapterEvent.Thinking("Reading"),
                AdapterEvent.ThinkingDone,
                AdapterEvent.ToolStart("k1", "mcp__rukoo__get_context", ""),
                AdapterEvent.ToolEnd("k1", false),
                AdapterEvent.Text("Done."),
                AdapterEvent.Notice("Codex started a new thread", Tone.INFO, "new-thread"),
            ),
            turn.events.toList(),
        )
        assertEquals(listOf(mapOf("sessionId" to "sess-2")), turn.providers.toList())
        assertEquals(1, turn.accepted)
        val r = desktop.turns.single()
        assertEquals("claude", r.agent)
        assertEquals("c_mgx1_abc123", r.conversation.id)
        assertEquals("Invoice", r.conversation.title)
        // Only the ids the computer keeps.
        assertEquals(mapOf("sessionId" to "sess-1"), r.conversation.provider)
        assertEquals(turn.input, r.input)
        assertEquals("hello", r.text)
        assertEquals("INSTRUCTIONS", r.instructions)
        assertEquals(listOf("pdf"), r.skills.map { it.name })
        assertEquals(true, r.firstTurn)
        assertEquals("opus" to "high", r.model to r.effort)
        assertEquals(listOf("acc:INBOX:7"), r.emails)
        assertEquals("http://100.64.0.3:47800/mcp", r.mcp?.url)
        assertEquals("phone-mcp-token", r.mcp?.token)
    }

    @Test
    fun withoutThePhonesToolsTheTurnSaysSoAndSendsNoMcp() = runBlocking {
        desktop.streams.add {
            emit(line("""{"seq":1,"type":"started","turnId":"t_1","conversationId":"c","agent":"claude"}"""))
            emit(line("""{"seq":2,"type":"done","status":"done"}"""))
        }
        val turn = turn(mcp = McpGrant())
        adapter().runTurn(turn)
        assertNull(desktop.turns.single().mcp)
        // A grant without a token would be refused whole by the computer: it goes as none too.
        assertNull(adapter().request(turn(mcp = McpGrant("http://100.64.0.3:47800/mcp", "")), settings.computers.single()).mcp)
        assertEquals(
            AdapterEvent.Notice("Claude Code works without Rukoo's tools this turn: this phone isn't serving them right now.", Tone.INFO, "no-phone-tools"),
            turn.events.first(),
        )
    }

    @Test
    fun anApprovalRoundTripsAndAnExpiredOneIsRetired() = runBlocking {
        val answered = CompletableDeferred<Unit>()
        desktop.answer = { answered.complete(Unit) }
        val card = """{"title":"Claude wants to run a command","detail":"","fields":[{"key":"command","label":"Command","value":"ls"}],"tool":{"name":"Bash","kind":"command"},"choices":[{"id":"allow","label":"Allow","kind":"primary"},{"id":"deny","label":"Deny","kind":"danger"}],"source":"claude","kind":"runtime"}"""
        desktop.streams.add {
            emit(line("""{"seq":1,"type":"started","turnId":"t_1","conversationId":"c","agent":"claude"}"""))
            emit(line("""{"seq":2,"type":"approval","approvalId":"a_1","card":$card,"status":"pending"}"""))
            answered.await()
            emit(line("""{"seq":3,"type":"approval-decided","approvalId":"a_1","decision":"allow"}"""))
            emit(line("""{"seq":4,"type":"approval","approvalId":"a_2","card":$card,"status":"pending"}"""))
            emit(line("""{"seq":5,"type":"approval-expired","approvalId":"a_2"}"""))
            emit(line("""{"seq":6,"type":"done","status":"done"}"""))
        }
        var asked = 0
        val turn = turn(choose = { if (++asked == 1) "allow" else awaitCancellation() })
        val result = withTimeout(5_000) { adapter().runTurn(turn) }
        assertEquals(TurnStatus.DONE, result.status)
        assertEquals(listOf(Triple("t_1", "a_1", "allow")), desktop.answers.toList())
        val request = turn.approvals.first()
        assertEquals("Claude wants to run a command", request.title)
        assertEquals("a_1", request.key)
        assertEquals("computer:ph_k3j9x0m2qa:claude", request.source)
        assertEquals("ls", request.fields.single().value)
        assertEquals(listOf("a_1", "a_2"), turn.expired.toList())
    }

    // The computer cut a field and declined the card: the hub records it as for a local turn (the denied card and its
    // notice), and nobody answers the computer.
    @Test
    fun aCardTheComputerDeclinedGoesToTheHubAsItsCard() = runBlocking {
        val card = """{"title":"Claude wants to change files","fields":[{"key":"diff","label":"Changes","value":"ddd","truncated":812}],"choices":[{"id":"allow","label":"Allow","kind":"primary"},{"id":"deny","label":"Deny","kind":"danger"}]}"""
        desktop.streams.add {
            emit(line("""{"seq":1,"type":"started","turnId":"t_1","conversationId":"c","agent":"claude"}"""))
            emit(line("""{"seq":2,"type":"approval","approvalId":"a_1","card":$card,"status":"denied","decision":"deny","declinedBy":"rukoo"}"""))
            emit(line("""{"seq":3,"type":"done","status":"done"}"""))
        }
        val turn = turn(choose = { "deny" })
        adapter().runTurn(turn)
        val request = turn.approvals.single()
        assertEquals("a_1", request.key)
        assertEquals(812, request.fields.single().truncated)
        assertTrue(turn.events.isEmpty())
        assertTrue(desktop.answers.isEmpty())
    }

    @Test
    fun aDeclinedCardWithoutACutFieldBecomesANotice() = runBlocking {
        desktop.streams.add {
            emit(line("""{"seq":1,"type":"started","turnId":"t_1","conversationId":"c","agent":"claude"}"""))
            emit(line("""{"seq":2,"type":"approval","approvalId":"a_1","card":{"title":"Claude wants to change files","choices":[{"id":"deny","label":"Deny","kind":"danger"}]},"status":"denied","decision":"deny","declinedBy":"rukoo"}"""))
            emit(line("""{"seq":3,"type":"done","status":"done"}"""))
        }
        val turn = turn()
        adapter().runTurn(turn)
        assertTrue(turn.approvals.isEmpty())
        assertEquals(
            AdapterEvent.Notice(
                "Declined without asking: Claude wants to change files. Part of it is too long to show here, so you could not check it.",
                Tone.INFO,
                "approval-too-long",
                NoticeParams("Claude wants to change files"),
            ),
            turn.events.single(),
        )
    }

    @Test
    fun aStartOverSendsTheRecapBack() = runBlocking {
        desktop.streams.add {
            emit(line("""{"seq":1,"type":"started","turnId":"t_1","conversationId":"c","agent":"claude"}"""))
            emit(line("""{"seq":2,"type":"notice","tone":"info","code":"new-session","text":"Claude started a new session"}"""))
            emit(line("""{"seq":3,"type":"start-over","requestId":"r_1"}"""))
            emit(line("""{"seq":4,"type":"done","status":"done"}"""))
        }
        val turn = turn()
        adapter().runTurn(turn)
        assertEquals(1, turn.startOvers)
        eventually { desktop.startOvers.isNotEmpty() }
        assertEquals(Triple("t_1", "r_1", "RECAP INPUT"), desktop.startOvers.single())
    }

    @Test
    fun aDroppedStreamIsReattachedWithoutRepeats() = runBlocking {
        desktop.streams.add {
            emit(line("""{"seq":1,"type":"started","turnId":"t_1","conversationId":"c","agent":"claude"}"""))
            emit(line("""{"seq":2,"type":"text","delta":"One "}"""))
            throw DesktopException("offline", "connection reset")
        }
        // The first reattach fails too; the second one gets the rest, from where the phone left off.
        desktop.streams.add { throw DesktopException("offline", "no route") }
        desktop.streams.add {
            emit(line("""{"type":"gap"}"""))
            emit(line("""{"seq":2,"type":"text","delta":"One "}"""))
            emit(line("""{"seq":3,"type":"text","delta":"two"}"""))
            emit(line("""{"seq":4,"type":"done","status":"done"}"""))
        }
        val turn = turn()
        val result = withTimeout(5_000) { adapter().runTurn(turn) }
        assertEquals(TurnStatus.DONE, result.status)
        assertEquals("One two", turn.text())
        assertEquals(listOf("t_1" to 2L, "t_1" to 2L), desktop.reattaches.toList())
    }

    @Test
    fun aReattachThatOnlyGetsPingsStartsAFreshGraceAtTheNextDrop() = runBlocking {
        desktop.streams.add {
            emit(line("""{"seq":1,"type":"started","turnId":"t_1","conversationId":"c","agent":"claude"}"""))
            emit(line("""{"seq":2,"type":"text","delta":"One "}"""))
            throw DesktopException("offline", "connection reset")
        }
        // Attached again, but the agent works quietly past the test's 2 s window before the stream drops once more.
        desktop.streams.add {
            emit(line("""{"type":"ping"}"""))
            kotlinx.coroutines.delay(2_500)
            throw DesktopException("offline", "connection reset")
        }
        desktop.streams.add {
            emit(line("""{"seq":3,"type":"text","delta":"two"}"""))
            emit(line("""{"seq":4,"type":"done","status":"done"}"""))
        }
        val turn = turn()
        val result = withTimeout(10_000) { adapter().runTurn(turn) }
        assertEquals(TurnStatus.DONE, result.status)
        assertEquals("One two", turn.text())
        assertTrue(desktop.stops.isEmpty())
    }

    @Test
    fun aTurnTheComputerNoLongerHasFailsAsOffline() = runBlocking {
        desktop.streams.add {
            emit(line("""{"seq":1,"type":"started","turnId":"t_1","conversationId":"c","agent":"claude"}"""))
        }
        // No more scripts: reattach answers 404 not-found.
        val result = withTimeout(5_000) { adapter().runTurn(turn()) }
        assertEquals(ErrorCodes.OFFLINE to "Lost the connection to office-pc during the turn", result.error?.code to result.error?.detail)
        eventually { desktop.stops.isNotEmpty() }
        assertEquals(listOf("t_1"), desktop.stops.toList())
    }

    @Test
    fun aRefusedStartIsTheTurnsError() = runBlocking {
        desktop.streams.add { throw DesktopException("busy", "A turn of this chat is still running", 409) }
        val result = adapter().runTurn(turn())
        assertEquals(ErrorCodes.BUSY to "A turn of this chat is still running", result.error?.code to result.error?.detail)
        assertTrue(desktop.reattaches.isEmpty())

        desktop.streams.add { throw DesktopException("invalid", "effort must be one of …", 422) }
        assertEquals(ErrorCodes.UNKNOWN, adapter().runTurn(turn()).error?.code)
    }

    @Test
    fun anErrorFromTheComputerEndsTheTurnWithIt() = runBlocking {
        desktop.streams.add {
            emit(line("""{"seq":1,"type":"started","turnId":"t_1","conversationId":"c","agent":"claude"}"""))
            emit(line("""{"seq":2,"type":"error","code":"not-installed","detail":"claude not found"}"""))
            emit(line("""{"seq":3,"type":"done","status":"error","error":{"code":"not-installed","detail":"claude not found"}}"""))
        }
        val turn = turn()
        val result = adapter().runTurn(turn)
        assertEquals(TurnStatus.ERROR, result.status)
        assertEquals(AgentErrorInfo("not-installed", "claude not found"), result.error)
        assertEquals(AdapterEvent.Error("not-installed", "claude not found"), turn.events.single())
    }

    @Test
    fun cancellingTheTurnStopsItOnTheComputer() = runBlocking {
        desktop.streams.add {
            emit(line("""{"seq":1,"type":"started","turnId":"t_1","conversationId":"c","agent":"claude"}"""))
            emit(line("""{"seq":2,"type":"text","delta":"Working"}"""))
            awaitCancellation()
        }
        val turn = turn()
        val job = async { adapter().runTurn(turn) }
        eventually { turn.text() == "Working" }
        job.cancel()
        try {
            job.await()
            fail("cancelled")
        } catch (_: CancellationException) {
        }
        eventually { desktop.stops.isNotEmpty() }
        assertEquals(listOf("t_1"), desktop.stops.toList())
    }

    @Test
    fun inlineImagesGoAlongAsBase64() = runBlocking {
        val dir = Files.createTempDirectory("rukoo-images").toFile()
        val png = File(dir, "shot.png").apply { writeBytes(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 1, 2, 3)) }
        val pdf = File(dir, "doc.pdf").apply { writeBytes(byteArrayOf(1)) }
        val files = listOf(
            TurnFile("f1", "shot.png", "image/png", "image", png.length(), png.path, inline = true),
            TurnFile("f2", "doc.pdf", "application/pdf", "file", pdf.length(), pdf.path, inline = false),
            TurnFile("f3", "gone.png", "image/png", "image", 1, File(dir, "gone.png").path, inline = true),
        )
        val a = adapter()
        val request = a.request(RecordingTurn(files = files), settings.computers.single())
        val image = request.files.single()
        assertEquals("f1" to "image/png", image.id to image.type)
        assertEquals(7L, image.size)
        assertEquals(java.util.Base64.getEncoder().encodeToString(png.readBytes()), image.data)
        dir.deleteRecursively()
        Unit
    }

    @Test
    fun statusComesFromHelloSharedByBothPrograms() = runBlocking {
        desktop.hello = {
            HelloResponse(
                agents = mapOf(
                    "claude" to HostAgentInfo(enabled = true, state = "ready", detail = "Claude Code 2.1.3"),
                    "codex" to HostAgentInfo(enabled = false, state = "disabled"),
                ),
            )
        }
        assertEquals(AgentStatus(AgentState.READY, "Claude Code 2.1.3"), adapter(ComputerProgram.CLAUDE).status(false))
        assertEquals(AgentStatus(AgentState.DISABLED, "Turned off on office-pc"), adapter(ComputerProgram.CODEX).status(false))
        assertEquals(1, desktop.hellos)

        desktop.hello = { HelloResponse(agents = mapOf("claude" to HostAgentInfo(enabled = true, state = "nonsense"))) }
        assertEquals(AgentState.UNKNOWN, adapter().status(true).state)
        desktop.hello = { HelloResponse() }
        assertEquals(AgentStatus(AgentState.MISSING, "office-pc does not offer Claude Code"), adapter().status(true))
        desktop.hello = { throw DesktopException("unauthorized", "", 401) }
        assertEquals(AgentStatus(AgentState.UNAUTHORIZED, "office-pc no longer knows this phone. Pair it again."), adapter().status(true))
        desktop.hello = { throw DesktopException("offline", "") }
        assertEquals(
            AgentStatus(AgentState.OFFLINE, "Rukoo isn't reachable on office-pc. Check that it's open and that Tailscale is on."),
            adapter().status(true),
        )

        settings = settings.copy(computers = listOf(settings.computers.single().copy(claudeEnabled = false)))
        assertEquals(AgentStatus(AgentState.DISABLED, ""), adapter().status(true))
        assertEquals(ErrorCodes.DISABLED to "Claude Code is turned off", adapter().runTurn(turn()).let { it.error?.code to it.error?.detail })
        settings = AgentSettings()
        assertEquals(AgentStatus(AgentState.UNCONFIGURED, "This computer is no longer paired"), adapter().status(true))
        assertEquals(ErrorCodes.NOT_CONFIGURED, adapter().runTurn(turn()).error?.code)
    }

    @Test
    fun modelsSkillsAndForgetGoThroughTheLink() = runBlocking {
        desktop.models = ModelOptions(agent = "claude", models = listOf(nl.bvdm.rukoo.agents.model.ModelOption("opus")))
        assertEquals("computer:ph_k3j9x0m2qa:claude" to listOf("opus"), adapter().models().let { it.agent to it.models.map { m -> m.id } })
        desktop.skills = OwnSkills(agent = "claude", skills = listOf(OwnSkill("pdf")))
        assertEquals(listOf("pdf"), adapter().skills().map { it.name })
        desktop.skills = OwnSkills(agent = "claude", error = AgentErrorInfo("offline", "claude not answering"))
        try {
            adapter().skills()
            fail("a failed list")
        } catch (e: nl.bvdm.rukoo.agents.AgentException) {
            assertEquals("offline", e.code)
        }
        adapter(ComputerProgram.CODEX).forget("c_mgx1_abc123")
        assertEquals(listOf("codex" to "c_mgx1_abc123"), desktop.forgotten.toList())
    }

    // The hub's refresh reaches the computer, which then lists afresh instead of from its own cache.
    @Test
    fun aRefreshGoesOnToTheComputer() = runBlocking {
        desktop.listRefreshes.clear()
        adapter().models()
        adapter().models(refresh = true)
        adapter().skills(refresh = true)
        assertEquals(listOf(false, true, true), desktop.listRefreshes.toList())
        // A list the computer answers with an error keeps it, for the hub to read.
        desktop.models = ModelOptions(agent = "codex", error = AgentErrorInfo("busy", "Codex is restarting"))
        assertEquals("busy", adapter(ComputerProgram.CODEX).models().error?.code)
    }
}
