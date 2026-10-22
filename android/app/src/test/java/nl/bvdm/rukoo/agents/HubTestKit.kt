package nl.bvdm.rukoo.agents

import java.io.File
import java.nio.file.Files
import java.time.ZoneId
import java.util.Collections
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.job
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.TurnStatus
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.SecretCipher
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.demo.PreviewMailEngine
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.MoveResult
import nl.bvdm.rukoo.ui.ScreenState

/** An agent that runs whatever the test scripts and records every turn it got. */
class ScriptedAdapter(override val id: String, var script: suspend (TurnHandle) -> TurnResult = { TurnResult.DONE }) : AgentAdapter {
    val turns: MutableList<TurnHandle> = Collections.synchronizedList(mutableListOf())
    val forgotten: MutableList<String> = Collections.synchronizedList(mutableListOf())
    var statusValue = AgentStatus(AgentState.READY, "ok")
    var modelList = ModelOptions(id)
    var skillList = emptyList<OwnSkill>()
    var modelCalls = 0

    override suspend fun status(force: Boolean) = statusValue

    override suspend fun runTurn(turn: TurnHandle): TurnResult {
        turns += turn
        return script(turn)
    }

    override suspend fun models(): ModelOptions {
        modelCalls++
        return modelList
    }

    override suspend fun skills() = skillList

    override suspend fun forget(conversationId: String) {
        forgotten += conversationId
    }
}

object PlainCipher : SecretCipher {
    override fun encrypt(plain: String) = plain

    override fun decrypt(blob: String): String = blob
}

class RecordingAlerts : AgentAlerts {
    val replies: MutableList<Pair<String, TurnStatus>> = Collections.synchronizedList(mutableListOf())
    val approvals: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val drafts: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val seen: MutableList<String> = Collections.synchronizedList(mutableListOf())

    override fun replyReady(conversation: Conversation, status: TurnStatus) {
        replies += conversation.id to status
    }

    override fun approvalWaiting(conversation: Conversation, item: Item.Approval) {
        approvals += item.id
    }

    override fun draftWritten(conversation: Conversation, item: Item.Draft) {
        drafts += item.id
    }

    override fun seen(conversationId: String) {
        seen += conversationId
    }
}

/** The demo mailbox, with a delay on loading or moving mail when a test needs one. */
class SlowMail(private val base: PreviewMailEngine) : MailEngine by base {
    var fullDelayMs = 0L
    var moveDelayMs = 0L

    override suspend fun fullMessage(id: String): FullMessage {
        if (fullDelayMs > 0) delay(fullDelayMs)
        return base.fullMessage(id)
    }

    override suspend fun archive(ids: List<String>): MoveResult {
        if (moveDelayMs > 0) delay(moveDelayMs)
        return base.archive(ids)
    }
}

/** One hub on the test scheduler, its adapters, mail and screen. */
@OptIn(ExperimentalCoroutinesApi::class)
class HubKit(
    val test: TestScope,
    val dir: File = Files.createTempDirectory("rukoo-hub").toFile(),
    val clark: ScriptedAdapter = ScriptedAdapter("clark"),
    val openclaw: ScriptedAdapter = ScriptedAdapter("openclaw"),
    settings: AgentSettings = AgentSettings(clark = ClarkSettings(name = "Clark", url = "http://clark", key = "k")),
    val zone: ZoneId = ZoneId.of("Europe/Amsterdam"),
) {
    val clock = Clock { BASE + test.testScheduler.currentTime }
    val engine = PreviewMailEngine(clock, null, zone)
    val mail = SlowMail(engine)
    val screen = ScreenState(clock)
    val alerts = RecordingAlerts()
    val settingsStore = AgentSettingsStore(File(dir, "agents.json"), PlainCipher).also { store ->
        if (settings != AgentSettings()) kotlinx.coroutines.runBlocking { store.update { settings } }
    }
    val adapters = mutableMapOf<String, AgentAdapter>("clark" to clark, "openclaw" to openclaw)
    private val dispatcher = StandardTestDispatcher(test.testScheduler)

    // Ends with the test, but isn't background work: advanceUntilIdle() runs the hub's turns.
    private val scope = CoroutineScope(SupervisorJob(test.backgroundScope.coroutineContext.job) + dispatcher)
    val hub = newHub()

    fun newHub() = Hub(
        scope = scope,
        mail = mail,
        screen = screen,
        settings = settingsStore,
        factory = AdapterFactory { adapters[it] },
        dataDir = dir,
        rukooSkills = RukooSkills(FileSkillTree(Fixtures.bundledSkills), null),
        alerts = alerts,
        clock = clock,
        zone = { zone },
        dispatcher = dispatcher,
        io = dispatcher,
    )

    fun settle() = test.runCurrent()

    companion object {
        /** 22 October 2026, 10:00 UTC. */
        const val BASE = 1792663200000L
    }
}
