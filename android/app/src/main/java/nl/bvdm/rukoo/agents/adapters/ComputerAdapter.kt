package nl.bvdm.rukoo.agents.adapters

// Claude Code and Codex on a paired computer: desktop Rukoo runs the turn there and streams the adapter events back
// (the computer host, spec 3 §7 and the F section of wave0-api.md). The phone owns the chat, builds the input and
// keeps the session or thread id; the computer is a stateless runner. Rukoo's tool calls of these turns come back to
// the phone's own MCP server (mcp.url), forwarded by the desktop with the token this phone gave that computer.

import java.io.File
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.min
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.AgentAdapter
import nl.bvdm.rukoo.agents.AgentException
import nl.bvdm.rukoo.agents.AgentSettings
import nl.bvdm.rukoo.agents.PairedComputer
import nl.bvdm.rukoo.agents.TurnFile
import nl.bvdm.rukoo.agents.TurnHandle
import nl.bvdm.rukoo.agents.TurnResult
import nl.bvdm.rukoo.agents.model.AdapterEvent
import nl.bvdm.rukoo.agents.model.AgentErrorInfo
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.ApprovalStatus
import nl.bvdm.rukoo.agents.model.ComputerProgram
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.HostEvent
import nl.bvdm.rukoo.agents.model.HostLine
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.NoticeParams
import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.agents.model.TurnStatus
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.core.Unsafe
import nl.bvdm.rukoo.desktop.DesktopException
import nl.bvdm.rukoo.desktop.DesktopLink
import nl.bvdm.rukoo.desktop.HelloResponse
import nl.bvdm.rukoo.desktop.HostConversation
import nl.bvdm.rukoo.desktop.HostFile
import nl.bvdm.rukoo.desktop.HostMcp
import nl.bvdm.rukoo.desktop.HostSkill
import nl.bvdm.rukoo.desktop.HostTurnRequest
import nl.bvdm.rukoo.mcp.McpStatus

/** `/hello` per paired computer, kept 30 s and shared by its Claude Code and Codex, so a status refresh asks once. */
internal class HelloCache(private val desktop: DesktopLink, private val scope: CoroutineScope, private val clock: Clock, private val ttlMs: Long = 30_000) {
    private val caches = ConcurrentHashMap<String, StatusCache<Result<HelloResponse>>>()

    suspend fun get(pairingId: String, force: Boolean): Result<HelloResponse> =
        caches.getOrPut(pairingId) { StatusCache(scope, clock, ttlMs) }.get(pairingId, force) {
            try {
                Result.success(desktop.hello(pairingId))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    fun invalidate(pairingId: String) {
        caches[pairingId]?.invalidate()
    }
}

class ComputerAdapter internal constructor(
    private val pairingId: String,
    private val program: ComputerProgram,
    private val settings: () -> AgentSettings,
    private val desktop: DesktopLink,
    /** The phone's MCP server now: its [McpStatus.url] goes to the computer as mcp.url. */
    private val mcp: () -> McpStatus,
    private val hello: HelloCache,
    /** The app's scope: a stop for the computer outlives the turn that was cancelled. */
    private val scope: CoroutineScope,
    private val texts: AdapterTexts,
    private val clock: Clock = Clock.System,
    private val timing: Timing = Timing(),
) : AgentAdapter {
    data class Timing(
        val backoff: Long = 1_000,
        // The computer keeps a turn whose stream dropped running for 30 s; reattaching stops a little before that.
        val reattachWindow: Long = 25_000,
    )

    override val id: String = AgentIds.computer(pairingId, program)

    private val programName = when (program) {
        ComputerProgram.CLAUDE -> "Claude Code"
        ComputerProgram.CODEX -> "Codex"
    }

    private fun computer(): PairedComputer? = settings().computer(pairingId)

    private fun enabledHere(c: PairedComputer) = when (program) {
        ComputerProgram.CLAUDE -> c.claudeEnabled
        ComputerProgram.CODEX -> c.codexEnabled
    }

    private fun ready(): PairedComputer {
        val c = computer() ?: throw AgentException(ErrorCodes.NOT_CONFIGURED, texts.get(R.string.adapters_computer_unpaired))
        if (!enabledHere(c)) throw AgentException(ErrorCodes.DISABLED, texts.get(R.string.adapters_turned_off, programName))
        return c
    }

    /** The computer's error codes in the hub's terms; the detail says what the computer said. */
    private fun agentError(e: DesktopException, computerName: String): AgentException {
        val code = when {
            e.code in ErrorCodes.TEXT -> e.code
            e.code == "not-found" -> ErrorCodes.OFFLINE
            else -> ErrorCodes.UNKNOWN
        }
        val detail = e.detail.ifEmpty { if (code == ErrorCodes.OFFLINE) texts.get(R.string.adapters_computer_unreachable, computerName) else e.code }
        return AgentException(code, clip(detail, 500))
    }

    override suspend fun status(force: Boolean): AgentStatus {
        val c = computer() ?: return AgentStatus(AgentState.UNCONFIGURED, texts.get(R.string.adapters_computer_unpaired))
        if (!enabledHere(c)) return AgentStatus(AgentState.DISABLED, "")
        val answer = hello.get(pairingId, force)
        val h = answer.getOrElse { e ->
            return when {
                e is DesktopException && e.code == ErrorCodes.UNAUTHORIZED ->
                    AgentStatus(AgentState.UNAUTHORIZED, texts.get(R.string.adapters_computer_unauthorized, c.name))
                e is DesktopException -> AgentStatus(AgentState.OFFLINE, agentError(e, c.name).detail)
                else -> AgentStatus(AgentState.OFFLINE, texts.get(R.string.adapters_computer_unreachable, c.name))
            }
        }
        val info = h.agents[program.wire] ?: return AgentStatus(AgentState.MISSING, texts.get(R.string.adapters_computer_no_program, programName, c.name))
        if (!info.enabled) return AgentStatus(AgentState.DISABLED, texts.get(R.string.adapters_computer_off_there, c.name))
        val state = runCatching { RukooJson.decodeFromJsonElement(AgentState.serializer(), JsonPrimitive(info.state)) }.getOrDefault(AgentState.UNKNOWN)
        return AgentStatus(if (state == AgentState.CHECKING) AgentState.UNKNOWN else state, info.detail)
    }

    override suspend fun models(): ModelOptions {
        val c = ready()
        return try {
            desktop.models(pairingId, program.wire).copy(agent = id)
        } catch (e: DesktopException) {
            throw agentError(e, c.name)
        }
    }

    override suspend fun skills(): List<OwnSkill> {
        val c = ready()
        val list = try {
            desktop.skills(pairingId, program.wire)
        } catch (e: DesktopException) {
            throw agentError(e, c.name)
        }
        val error = list.error
        if (error != null && list.skills.isEmpty()) throw AgentException(error.code, error.detail)
        return list.skills
    }

    override suspend fun forget(conversationId: String) {
        if (computer() == null) return
        try {
            desktop.forgetConversation(pairingId, program.wire, conversationId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Best effort: the computer forgets an idle chat's session on its own after a while.
            AppLog.w(TAG, "forgetting a chat on the computer failed", e)
        }
    }

    override suspend fun runTurn(turn: TurnHandle): TurnResult {
        val c = computer() ?: return TurnResult.error(ErrorCodes.NOT_CONFIGURED, texts.get(R.string.adapters_computer_unpaired))
        if (!enabledHere(c)) return TurnResult.error(ErrorCodes.DISABLED, texts.get(R.string.adapters_turned_off, programName))
        return try {
            HostRun(turn, c).run()
        } catch (e: CancellationException) {
            throw e
        } catch (e: AgentException) {
            TurnResult.error(e.code, e.detail)
        } catch (e: DesktopException) {
            val err = agentError(e, c.name)
            TurnResult.error(err.code, err.detail)
        } catch (e: Exception) {
            AppLog.w(TAG, "turn failed", e)
            TurnResult.error(ErrorCodes.UNKNOWN, clip(describe(e), 200))
        }
    }

    /** The request of spec 3 §7.6, within the limits the computer checks, so it isn't refused for size. */
    internal suspend fun request(turn: TurnHandle, computer: PairedComputer): HostTurnRequest {
        val url = mcp().url
        val grant = if (url != null && computer.mcpToken.isNotEmpty()) HostMcp(url, computer.mcpToken) else null
        val conversation = turn.conversation
        val provider = listOf("sessionId", "threadId").mapNotNull { k -> conversation.provider[k]?.takeIf { it.isNotEmpty() }?.let { k to it } }.toMap()
        return HostTurnRequest(
            agent = program.wire,
            conversation = HostConversation(id = conversation.id, title = conversation.title.take(80), provider = provider),
            input = turn.input,
            text = turn.text.take(TEXT_MAX),
            instructions = turn.instructions.ifEmpty { null },
            action = turn.action?.take(40)?.ifEmpty { null },
            skills = turn.skills.take(MAX_SKILLS).map { HostSkill(it) },
            firstTurn = turn.firstTurn,
            model = turn.model?.trim()?.takeIf { it.isNotEmpty() && it.length <= 200 && it.none { ch -> ch < ' ' || ch == '\u007f' } },
            effort = turn.effort?.takeIf { it in ModelOptions.EFFORTS },
            files = images(turn.files),
            emails = turn.emails.take(MAX_EMAILS),
            mcp = grant,
        )
    }

    /** Inline images only, as base64: the computer can't open the phone's files. */
    private suspend fun images(files: List<TurnFile>): List<HostFile> = withContext(Dispatchers.IO) {
        files.asSequence()
            .filter { it.kind == "image" && it.inline && it.type in IMAGE_TYPES }
            .mapNotNull { f ->
                val file = File(f.path)
                val bytes = runCatching { if (file.isFile && file.length() <= INLINE_IMAGE_MAX) file.readBytes() else null }.getOrNull()
                bytes?.let { HostFile(id = f.id, name = f.name, type = f.type, kind = "image", size = it.size.toLong(), data = Base64.getEncoder().encodeToString(it)) }
            }
            .take(MAX_FILES)
            .toList()
    }

    /** One turn on the computer: its stream, reattached after a drop, until `done`. */
    private inner class HostRun(val turn: TurnHandle, val computer: PairedComputer) {
        // Approval and start-over coroutines read these, possibly on another thread than the stream.
        @Volatile var turnId: String? = null
        var lastSeq = 0L
        @Volatile var done: HostEvent.Done? = null
        val settled: MutableSet<String> = ConcurrentHashMap.newKeySet()

        private fun lost() = AgentException(ErrorCodes.OFFLINE, texts.get(R.string.adapters_computer_lost, computer.name))

        suspend fun run(): TurnResult {
            val request = request(turn, computer)
            if (request.mcp == null) {
                // Without the phone's address the agent can't reach the mail it is asked about; say so in the chat.
                turn.emit(AdapterEvent.Notice(texts.get(R.string.adapters_computer_no_tools, programName), Tone.INFO, "no-phone-tools"))
            }
            try {
                coroutineScope {
                    try {
                        follow(this, desktop.startTurn(pairingId, request))
                    } finally {
                        // Approval answers and start-over replies end with the turn.
                        coroutineContext.cancelChildren()
                    }
                }
            } catch (e: CancellationException) {
                // Stop: the computer stops the turn and its agent; the stream would only carry the outcome.
                val id = turnId
                if (id != null && done == null) scope.launch { stop(id) }
                throw e
            } catch (e: Exception) {
                // Rukoo lets go of a turn that may still be running there: ask the computer to stop it.
                val id = turnId
                if (id != null && done == null) scope.launch { stop(id) }
                throw e
            }
            val d = done ?: throw lost()
            return if (d.status == TurnStatus.ERROR) TurnResult(TurnStatus.ERROR, d.error ?: AgentErrorInfo()) else TurnResult(d.status)
        }

        private suspend fun stop(turnId: String) {
            try {
                desktop.stopTurn(pairingId, turnId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // A stream the computer no longer has stops there after its own grace period.
                AppLog.w(TAG, "stopping a turn on the computer failed", e)
            }
        }

        /** Reads [first] and then reattached streams until `done`, within the computer's grace after each drop. */
        private suspend fun follow(runScope: CoroutineScope, first: Flow<HostLine>) {
            var flow = first
            var droppedAt: Long? = null
            var attempt = 0
            while (true) {
                // Any line, a ping included, means the stream was attached: the computer's grace starts afresh at the
                // next drop, as desktop's attach() clears its timer.
                var attached = false
                val failure: Exception? = try {
                    flow.takeWhile { line ->
                        attached = true
                        handle(runScope, line)
                        done == null
                    }.collect()
                    null
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    e
                }
                if (done != null) return
                val id = turnId
                // Nothing to reattach to before the computer named the turn: its refusal is the answer.
                if (id == null) {
                    if (failure is DesktopException) throw agentError(failure, computer.name)
                    throw failure?.let { AgentException(ErrorCodes.OFFLINE, clip(describe(it), 200)) } ?: lost()
                }
                // The computer no longer has the turn (it ended over two minutes ago, or the grace ran out).
                if (failure is DesktopException && (failure.status == 404 || failure.code == "not-found")) throw lost()
                if (attached) {
                    droppedAt = null
                    attempt = 0
                }
                val now = clock.now()
                val since = droppedAt ?: now.also { droppedAt = it }
                if (now - since > timing.reattachWindow) throw lost()
                AppLog.i(TAG, "turn stream dropped, reattaching")
                delay(min(timing.backoff shl attempt, 4 * timing.backoff))
                attempt++
                flow = desktop.reattach(pairingId, id, lastSeq)
            }
        }

        private fun handle(runScope: CoroutineScope, line: HostLine) {
            val seq = line.seq
            if (seq != null) {
                // A reattach replays what came after `after`; never apply a line twice.
                if (seq <= lastSeq) return
                lastSeq = seq
            }
            line.event?.let { turn.emit(it) }
            when (val h = line.host) {
                is HostEvent.Started -> turnId = h.turnId
                is HostEvent.Provider -> {
                    val patch = h.patch.filterValues { it.isNotEmpty() }
                    if (patch.isNotEmpty()) turn.setProvider(patch)
                }
                HostEvent.Accepted -> turn.accepted()
                is HostEvent.Approval -> when {
                    // Undispatched: the card is up before the next line, which may already expire it.
                    h.status == ApprovalStatus.PENDING -> runScope.launch(start = CoroutineStart.UNDISPATCHED) { guarded("approval") { approve(h) } }
                    h.declinedBy == "rukoo" -> {
                        // The computer declined it without asking, because a value was too long to show in full.
                        settled.add(h.approvalId)
                        val title = Unsafe.untag(h.card.title)
                        turn.emit(AdapterEvent.Notice(texts.get(R.string.adapters_approval_too_long, title), Tone.INFO, "approval-too-long", NoticeParams(title.take(200))))
                    }
                    else -> settled.add(h.approvalId)
                }
                is HostEvent.ApprovalDecided -> expire(h.approvalId)
                is HostEvent.ApprovalExpired -> expire(h.approvalId)
                is HostEvent.StartOver -> {
                    val id = turnId ?: return
                    // The phone has the transcript: it writes the first turn with the email and a recap for the new session.
                    runScope.launch(start = CoroutineStart.UNDISPATCHED) { guarded("start-over") { desktop.startOver(pairingId, id, h.requestId, turn.startOver()) } }
                }
                is HostEvent.Done -> done = h
                HostEvent.Ping, HostEvent.Gap, null -> Unit
            }
        }

        private fun expire(approvalId: String) {
            settled.add(approvalId)
            turn.expireApproval(approvalId)
        }

        private suspend fun guarded(what: String, block: suspend () -> Unit) {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                AppLog.w(TAG, "$what failed", e)
            }
        }

        private suspend fun approve(h: HostEvent.Approval) {
            val card = h.card
            val choice = turn.approve(
                ApprovalRequest(
                    title = card.title,
                    detail = card.detail,
                    fields = card.fields,
                    choices = card.choices,
                    source = id,
                    kind = ApprovalKind.RUNTIME,
                    key = h.approvalId,
                    tool = card.tool,
                ),
            )
            val tid = turnId ?: return
            if (choice.isEmpty() || choice == "cancel" || h.approvalId in settled || done != null) return
            answer(tid, h.approvalId, choice)
        }

        /**
         * The user's choice. The card is gone once they chose, so a lost answer would leave the agent waiting for a
         * choice nobody can make again: it is sent again while the computer is out of reach, and an answer that still
         * doesn't get through stops the turn instead.
         */
        private suspend fun answer(turnId: String, approvalId: String, choice: String) {
            var failure: DesktopException? = null
            for (attempt in 0 until 3) {
                if (attempt > 0) delay(timing.backoff shl (attempt - 1))
                if (done != null || approvalId in settled) return
                try {
                    desktop.answerApproval(pairingId, turnId, approvalId, choice)
                    return
                } catch (e: DesktopException) {
                    // Unknown to the computer: the turn or the request is gone, so nothing waits for this answer.
                    if (e.status == 404 || e.code == "not-found") return
                    failure = e
                    if (e.code != ErrorCodes.OFFLINE && e.status < 500 && e.code != ErrorCodes.RATE_LIMITED) break
                }
            }
            if (done != null) return
            val f = failure?.let { agentError(it, computer.name) } ?: lost()
            val lead = if (f.detail.isNotEmpty()) "${f.detail}. " else ""
            turn.emit(AdapterEvent.Error(f.code, lead + texts.get(R.string.adapters_computer_answer_lost, computer.name)))
            stop(turnId)
        }
    }

    private companion object {
        const val TAG = "Computer"
        val IMAGE_TYPES = setOf("image/png", "image/jpeg", "image/gif", "image/webp")
        // chatfiles.js INLINE_IMAGE_MAX: floor(3.75 MiB).
        const val INLINE_IMAGE_MAX = 3_932_160L
        const val MAX_FILES = 10
        const val MAX_EMAILS = 10
        const val MAX_SKILLS = 20
        const val TEXT_MAX = 20_000
    }
}
