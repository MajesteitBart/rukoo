package nl.bvdm.rukoo.agents.adapters

// Clark: the user's Hermes Agent, reached over Tailscale through the Hermes API server. A port of desktop's
// src/main/agents/hermes.js (spec 1 §3), with dudan's Hermes client (HermesApi.kt, SseReader.kt) as the model
// for the OkHttp side.
//
// A turn is a run (POST /v1/runs) bound to a Hermes session, one session per Rukoo conversation. Runs keep going
// when the event stream drops, can be resumed with Last-Event-ID, and report tool errors. A run with session_id
// loads that session's history and appends the turn to it.
//
// Stop is the turn coroutine's cancellation. Hermes keeps a run going without its client, so whatever must outlive
// the turn (the stop request, retrying it, stopping a run whose start was still out) runs in the app scope.

import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.AgentAdapter
import nl.bvdm.rukoo.agents.AgentException
import nl.bvdm.rukoo.agents.ClarkSettings
import nl.bvdm.rukoo.agents.TurnHandle
import nl.bvdm.rukoo.agents.TurnResult
import nl.bvdm.rukoo.agents.model.AdapterEvent
import nl.bvdm.rukoo.agents.model.AgentErrorInfo
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.agents.model.TurnStatus
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.core.UriComponent
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * An adapter that can hand out the instructions of the agent's own skills (`$name`). The Hermes adapter puts them
 * in the run itself, as desktop does; a hub that builds them into the input with [skillBlocks] first gets the same
 * message, because the adapter leaves an input that already starts with a skill block alone.
 */
interface SkillBodies {
    /** The skill's SKILL.md body, trimmed, or null when the server can't send it. */
    suspend fun skillBody(name: String): String?

    /** The blocks desktop puts before the input for the first three of these skills, each with its intro line. */
    suspend fun skillBlocks(names: List<String>): List<String>
}

class HermesAdapter internal constructor(
    private val settings: () -> ClarkSettings,
    http: OkHttpClient,
    /** The app's scope: stop requests and their retries outlive the turn that sent them. */
    private val scope: CoroutineScope,
    private val texts: AdapterTexts,
    private val clock: Clock = Clock.System,
    private val timing: Timing = Timing(),
    override val id: String = AgentIds.CLARK,
) : AgentAdapter, SkillBodies {
    /** hermes.js's timings; tests shorten them. */
    data class Timing(
        val backoff: Long = 1_000,
        val pollEvery: Long = 3_000,
        val pollMisses: Int = 20,
        val stopRetry: Long = 30_000,
        val stopWait: Long = 10_000,
        val errorBody: Long = 2_000,
        // Hermes sends a keepalive comment every 10 s, so this much silence means the connection is gone.
        val silence: Long = 45_000,
        val connect: Long = CONNECT_TIMEOUT,
        val submit: Long = 20_000,
        val statusTtl: Long = 30_000,
        // A stop for a run whose start answered late: the repeated start that names it.
        val quitAnswer: Long = 1_500,
        // How long Stop waits for a run start already on its way, so the hub knows whether Hermes took the message.
        // Well inside the 12 s the hub gives a stopped adapter.
        val stopAnswer: Long = 8_000,
        // After a 500 on /v1/skills (stock Hermes answers every list with one), skills() doesn't ask again this long.
        val brokenSkills: Long = 10 * 60_000,
    )

    private data class S(val enabled: Boolean, val name: String, val url: String, val key: String, val model: String)

    private data class Server(val base: ServerBase, val key: String)

    private val http = http.forAgents()
    private val streamHttp = this.http.newBuilder().readTimeout(timing.silence, TimeUnit.MILLISECONDS).build()
    private val statusCache = StatusCache<AgentStatus>(scope, clock, timing.statusTtl)

    // run id -> the run Rukoo let go of whose stop Hermes hasn't taken yet (keepStopping).
    private val unstopped = ConcurrentHashMap<String, Job>()

    // The server whose skill list answered 500, and since when.
    @Volatile private var skillsBroken: Pair<String, Long>? = null

    private fun s(): S {
        val c = settings()
        return S(c.enabled, c.name.trim().ifEmpty { "Hermes" }, c.url.trim(), c.key.trim(), c.model.trim())
    }

    private fun ready(s: S): Server {
        if (!s.enabled) throw AgentException(ErrorCodes.DISABLED, texts.get(R.string.adapters_turned_off, s.name))
        if (s.url.isEmpty()) throw AgentException(ErrorCodes.NOT_CONFIGURED, texts.get(R.string.adapters_hermes_no_url))
        if (s.key.isEmpty()) throw AgentException(ErrorCodes.NOT_CONFIGURED, texts.get(R.string.adapters_hermes_no_key))
        return Server(ServerBase.parse(s.url, texts), s.key)
    }

    private suspend fun request(
        method: String,
        server: Server,
        path: String,
        body: JsonElement? = null,
        headers: Map<String, String> = emptyMap(),
        auth: Boolean = true,
        timeoutMs: Long = timing.connect,
    ): HttpAnswer = http.jsonRequest(method, server.base, path, texts, if (auth) server.key else null, body, headers, timeoutMs)

    private fun enc(id: String) = UriComponent.encode(id)

    // ---------- status ----------

    override suspend fun status(force: Boolean): AgentStatus {
        val s = s()
        if (!s.enabled) return AgentStatus(AgentState.DISABLED, "")
        if (s.url.isEmpty()) return AgentStatus(AgentState.UNCONFIGURED, texts.get(R.string.adapters_hermes_no_url))
        if (s.key.isEmpty()) return AgentStatus(AgentState.UNCONFIGURED, texts.get(R.string.adapters_hermes_no_key))
        return statusCache.get(s.url + "\u0000" + sha256Hex(s.key), force) { check(s) }.redacted(s.key)
    }

    /** /health says the server is there (no key), /v1/capabilities that the key works and the Runs API is on. */
    private suspend fun check(s: S): AgentStatus = try {
        val server = Server(ServerBase.parse(s.url, texts), s.key)
        val started = System.nanoTime()
        val health = request("GET", server, "/health", auth = false)
        if (!health.ok) {
            AgentStatus(AgentState.OFFLINE, texts.get(R.string.adapters_health_http, health.status))
        } else {
            // Both checks together stay inside the hub's 12 s status deadline.
            val elapsed = (System.nanoTime() - started) / 1_000_000
            val caps = request("GET", server, "/v1/capabilities", timeoutMs = max(2_000, 10_000 - elapsed))
            val features = caps.obj?.get("features") as? JsonObject
            when {
                caps.status == 401 || caps.status == 403 -> AgentStatus(AgentState.UNAUTHORIZED, texts.get(R.string.adapters_hermes_key_refused))
                !caps.ok -> AgentStatus(AgentState.UNKNOWN, texts.get(R.string.adapters_capabilities_http, caps.status))
                features?.bool("run_submission") == false || features?.bool("run_events_sse") == false ->
                    AgentStatus(AgentState.UNKNOWN, texts.get(R.string.adapters_hermes_no_runs))
                else -> {
                    val version = health.obj?.get("version")?.takeIf { it.truthy() }?.let(HermesWire::jsText)
                    AgentStatus(AgentState.READY, if (version != null) "Hermes $version" else "Hermes")
                }
            }
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: AgentException) {
        AgentStatus(if (e.code == ErrorCodes.NOT_CONFIGURED) AgentState.UNCONFIGURED else AgentState.OFFLINE, e.detail)
    } catch (e: Exception) {
        AgentStatus(AgentState.OFFLINE, clip(describe(e), 200))
    }

    // ---------- models and skills ----------

    /**
     * The model_routes aliases (GET /v1/models) and the models of each provider Hermes has credentials for
     * (GET /api/model/options), named provider::model. Either list can be missing; the menu has the other one.
     */
    // Hermes keeps no list of its own between calls, so a refresh asks the same as any call.
    override suspend fun models(refresh: Boolean): ModelOptions = redacting { loadModels() }

    override suspend fun skills(refresh: Boolean): List<OwnSkill> = redacting { loadSkills() }

    /** Errors whose text came from the server, without the key. */
    private suspend fun <T> redacting(block: suspend () -> T): T {
        val secret = s().key
        return try {
            block()
        } catch (e: AgentException) {
            throw e.redacted(secret)
        }
    }

    private suspend fun loadModels(): ModelOptions = coroutineScope {
        val s = s()
        val server = ready(s)
        val routes = async { runCatching { request("GET", server, "/v1/models") } }
        val options = async { runCatching { request("GET", server, "/api/model/options?include_unconfigured=false", timeoutMs = 15_000) } }
        val (r, o) = awaitAll(routes, options)
        r.exceptionOrNull()?.let { if (it is CancellationException) throw it }
        o.exceptionOrNull()?.let { if (it is CancellationException) throw it }
        fun good(x: Result<HttpAnswer>) = x.getOrNull()?.takeIf { it.ok }?.obj
        if (good(r) == null && good(o) == null) {
            val answered = listOf(r, o).firstNotNullOfOrNull { it.getOrNull() }
            if (answered != null) throw httpError(answered)
            throw r.exceptionOrNull() as? AgentException ?: AgentException(ErrorCodes.OFFLINE, "")
        }
        val (models, efforts, custom) = HermesWire.models(good(r), good(o))
        ModelOptions(agent = id, models = models, efforts = efforts, custom = custom, defaultModel = s.model)
    }

    /** For the `$` menu: the skills installed on the Hermes server. An older Hermes has no such endpoint and offers none. */
    private suspend fun loadSkills(): List<OwnSkill> {
        val s = s()
        val server = ready(s)
        val key = s.url + "\u0000" + sha256Hex(s.key)
        val broken = skillsBroken
        // Stock Hermes answers this list with a 500 every time: don't ask again on every `$` and menu open.
        if (broken != null && broken.first == key && clock.now() - broken.second < timing.brokenSkills) {
            throw AgentException(ErrorCodes.PROTOCOL, "HTTP 500")
        }
        val res = request("GET", server, "/v1/skills", timeoutMs = 15_000)
        if (res.status == 404) return emptyList()
        if (res.status == 500) skillsBroken = key to clock.now()
        if (!res.ok) throw httpError(res)
        skillsBroken = null
        return HermesWire.skills(res.data)
    }

    override suspend fun skillBody(name: String): String? = skillBody(name, ready(s()))

    override suspend fun skillBlocks(names: List<String>): List<String> = skillBlocks(names, ready(s()))

    private suspend fun skillBody(name: String, server: Server): String? = try {
        val res = request("GET", server, "/v1/skills/${enc(name)}")
        (res.obj?.get("body") as? JsonPrimitive)?.takeIf { res.ok && it.isString }?.content?.trim()
    } catch (e: AgentException) {
        // A skill that can't be read is left to Hermes to load with its own skill_view tool.
        null
    }

    private suspend fun skillBlocks(names: List<String>, server: Server): List<String> =
        names.take(HermesWire.SKILLS_PER_TURN).map { name -> HermesWire.skillBlock(name, skillBody(name, server)) }

    // ---------- a turn ----------

    override suspend fun runTurn(turn: TurnHandle): TurnResult {
        // Whatever the server says reaches the chat without the key: events, errors and the result.
        val secret = s().key
        val result = try {
            turn(turn.redacting(secret))
        } catch (e: CancellationException) {
            throw e
        } catch (e: AgentException) {
            if (e.code == ErrorCodes.STOPPED) TurnResult.STOPPED else TurnResult.error(e.code, e.detail)
        } catch (e: Exception) {
            AppLog.w(TAG, "turn failed", e)
            TurnResult.error(ErrorCodes.UNKNOWN, clip(describe(e), 200))
        }
        return result.redacted(secret)
    }

    private suspend fun turn(turn: TurnHandle): TurnResult {
        val s = s()
        // The whole turn talks to this server, so a changed URL or key can't split a run between two.
        val server = ready(s)
        val sessionId = session(turn, server, s.name)
        val input = turn.input
        val blocks = if (input.startsWith(HermesWire.SKILL_BLOCK_START)) emptyList() else skillBlocks(turn.skills, server)
        val body = buildJsonObject {
            put("input", if (blocks.isNotEmpty()) "${blocks.joinToString("\n\n")}\n\n$input" else input)
            put("session_id", sessionId)
            if (turn.instructions.isNotEmpty()) put("instructions", turn.instructions)
            // The chat's own model and effort, else the model in Settings. Without either, Hermes uses its own.
            val (provider, model) = HermesWire.splitModel(turn.model?.trim()?.ifEmpty { null } ?: s.model)
            if (model.isNotEmpty()) put("model", model)
            if (provider.isNotEmpty()) put("provider", provider)
            val effort = turn.effort
            if (effort != null && effort in HermesWire.EFFORTS) putJsonObject("model_options") { putJsonObject("reasoning") { put("effort", effort) } }
        }
        // A retried POST (lost response) must not start the same turn twice.
        val idem = turn.id.filter { it in '!'..'~' }.take(200).ifEmpty { UUID.randomUUID().toString() }
        val started = submit(turn, body, "rukoo-$idem", server)
        val runId = runIdOf(started) ?: throw AgentException(ErrorCodes.PROTOCOL, texts.get(R.string.adapters_hermes_no_run_id))
        // Hermes has the message now: even a run stopped before its first event used up this turn's email and notes.
        turn.accepted()
        statusCache.invalidate()
        return follow(turn, runId, server, s.name)
    }

    private fun runIdOf(res: HttpAnswer?): String? =
        res?.takeIf { it.status == 200 || it.status == 202 }?.obj?.get("run_id")?.takeIf { it.truthy() }?.let(HermesWire::jsText)

    /** The Hermes session behind a conversation: reused while it exists, recreated when it was deleted. */
    private suspend fun session(turn: TurnHandle, server: Server, name: String): String {
        val conversation = turn.conversation
        val known = conversation.provider["sessionId"]?.takeIf { it.isNotEmpty() }
        if (known != null) {
            val res = request("GET", server, "/api/sessions/${enc(known)}")
            if (res.ok) return known
            if (res.status != 404) throw httpError(res)
            AppLog.i(TAG, "session is gone, starting a new one")
        }
        // Hermes wants unique session titles; a second chat about the same subject gets the chat id as well.
        val title = clip("Rukoo: ${conversation.title.ifEmpty { "Chat" }}", 100)
        val suffix = conversation.id.takeLast(6).ifEmpty { clock.now().toString(36) }
        val titles = listOf(title, clip("${title.take(85)} ($suffix)", 100), null)
        for (t in titles) {
            val res = request("POST", server, "/api/sessions", body = buildJsonObject { if (t != null) put("title", t) })
            val id = ((res.obj?.get("session") as? JsonObject)?.get("id"))?.takeIf { res.ok && it.truthy() }?.let(HermesWire::jsText)
            if (id != null) {
                turn.setProvider(mapOf("sessionId" to id))
                if (known != null) {
                    // The new session knows nothing of the chat: the input gets the email and a recap before the run.
                    turn.emit(AdapterEvent.Notice(texts.get(R.string.adapters_new_session, name), Tone.INFO, "new-session"))
                    turn.startOver()
                }
                return id
            }
            if (res.status != 400) throw httpError(res)
        }
        throw AgentException(ErrorCodes.PROTOCOL, texts.get(R.string.adapters_hermes_no_session))
    }

    /**
     * Starts the run. No answer, a timeout or a passing server error says nothing about whether Hermes took the
     * POST, so it goes again with the same Idempotency-Key, for which Hermes returns the run it already started.
     * A rate limit (429) is a refusal: nothing started. Stop ends the retries, but a POST already on its way is
     * not cut off: it finishes in the app scope, and the run it reports is stopped.
     */
    private suspend fun submit(turn: TurnHandle, body: JsonObject, key: String, server: Server): HttpAnswer {
        var failure: AgentException? = null
        for (attempt in 0 until 3) {
            if (attempt > 0) delay(timing.backoff shl (attempt - 1))
            // In the app scope, wrapped in a Result, so a failed start never fails that scope.
            val pending = scope.async { runCatching { request("POST", server, "/v1/runs", body, mapOf("Idempotency-Key" to key), timeoutMs = timing.submit) } }
            val res = try {
                pending.await().getOrThrow()
            } catch (e: CancellationException) {
                // Desktop waits for this answer before the hub decides whether the turn reached Hermes. A run Hermes took
                // has used up the email and notes, so it must count as reached before the cancellation goes on.
                val early = withContext(NonCancellable) { withTimeoutOrNull(timing.stopAnswer) { pending.await().getOrNull() } }
                if (runIdOf(early) != null) runCatching { turn.accepted() }
                scope.launch { stopSubmitted(turn, pending, body, key, server) }
                throw e
            } catch (e: AgentException) {
                if (e.code != ErrorCodes.OFFLINE) throw e
                failure = e
                continue
            }
            if (res.status == 200 || res.status == 202) return res
            failure = httpError(res)
            if (!(res.status >= 500 || res.status == 408)) throw failure
        }
        throw failure ?: AgentException(ErrorCodes.OFFLINE, "")
    }

    /**
     * Stop came while a run start was out: Hermes may have taken it. Without its answer the start goes once more
     * with the same Idempotency-Key, for which Hermes names the run it took (or starts it now). Either way that run
     * is stopped, so nothing the user stopped goes on unseen.
     */
    private suspend fun stopSubmitted(turn: TurnHandle, pending: Deferred<Result<HttpAnswer>>, body: JsonObject, key: String, server: Server) {
        try {
            stopSubmittedRun(turn, pending, body, key, server)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // It runs in the app's scope after the turn has ended, so nothing above it would catch this.
            AppLog.w(TAG, "stopping a run being started failed", e)
        }
    }

    private suspend fun stopSubmittedRun(turn: TurnHandle, pending: Deferred<Result<HttpAnswer>>, body: JsonObject, key: String, server: Server) {
        var runId = runIdOf(pending.await().getOrNull())
        if (runId == null) {
            runId = try {
                runIdOf(request("POST", server, "/v1/runs", body, mapOf("Idempotency-Key" to key), timeoutMs = timing.quitAnswer))
            } catch (e: AgentException) {
                AppLog.w(TAG, "asking for a run being started failed")
                null
            }
        }
        if (runId == null) return
        // Hermes has the message: the next one isn't a first turn again.
        runCatching { turn.accepted() }
        if (!sendStop(server, runId, timing.connect)) keepStopping(server, runId)
    }

    // ---------- following a run ----------

    private class Pending(val requestId: String) {
        @Volatile var expired = false
    }

    private class RunState(val runId: String, val server: Server, val turn: TurnHandle, val name: String) {
        var lastSeq = -1L

        // Read by the approval coroutines too, which may run on another thread than the stream.
        @Volatile var terminal: Terminal? = null
        var lost = false

        // All text the run streamed, and the part since the last tool call.
        val text = StringBuilder()
        var segment = StringBuilder()
        val counters = HashMap<String, Int>()
        val open = LinkedHashMap<String, ArrayDeque<String>>()
        val subagents = LinkedHashMap<String, String>()
        val approvals = ConcurrentHashMap<String, Pending>()

        @Volatile var stopping = false
        val aborted = CompletableDeferred<Unit>()

        @Volatile var call: Call? = null

        /** Ends following the run (desktop's state.controller.abort()). */
        fun abort() {
            aborted.complete(Unit)
            call?.cancel()
        }

        val isAborted get() = aborted.isCompleted
    }

    private data class Terminal(val status: TurnStatus, val output: String = "", val error: AgentErrorInfo? = null)

    private enum class Outcome { END, IDLE, ABORTED, GONE }

    /** Sleeps [ms], waking early when the run is let go. */
    private suspend fun sleep(ms: Long, state: RunState) {
        withTimeoutOrNull(ms) { state.aborted.await() }
    }

    /** Streams one run's events into the turn until it ends, reconnecting where the stream left off. */
    private suspend fun follow(turn: TurnHandle, runId: String, server: Server, name: String): TurnResult {
        val state = RunState(runId, server, turn, name)
        try {
            coroutineScope {
                try {
                    var failures = 0
                    while (state.terminal == null && !state.isAborted) {
                        val seen = state.lastSeq
                        val outcome = try {
                            stream(state, this)
                        } catch (e: AgentException) {
                            if (e.code != ErrorCodes.OFFLINE) throw e
                            AppLog.i(TAG, "event stream failed (${e.code})")
                            null
                        }
                        if (state.terminal != null || state.isAborted) break
                        // Five reconnects in a row without progress, not five over a long run.
                        if (state.lastSeq > seen) failures = 0
                        if (outcome == Outcome.GONE || ++failures > RECONNECTS) {
                            // Follow the run by its status. A stream that only kept failing is tried again once Hermes
                            // answers that the run goes on; a stream that is gone is followed by status until the end.
                            val res = watch(state, retry = outcome != Outcome.GONE)
                            if (res != null && res.terminal == null) {
                                failures = 0
                                continue
                            }
                            state.lost = true
                            state.terminal = res?.terminal
                            break
                        }
                        sleep(min(timing.backoff shl (failures - 1), 8 * timing.backoff), state)
                    }
                } finally {
                    // The approval answers and stop timers of this run end with it.
                    coroutineContext.cancelChildren()
                }
            }
        } catch (e: CancellationException) {
            // Stop: the run keeps going on the server until Hermes takes the stop request.
            if (state.terminal == null && !state.stopping) {
                state.stopping = true
                scope.launch { if (!sendStop(server, runId, timing.connect)) keepStopping(server, runId) }
            }
            throw e
        } catch (e: Exception) {
            // Rukoo lets go of a run that may still be going: stop it first, so an approved action doesn't go on
            // where Stop no longer reaches it. watch() and the answer path already sent their own stop.
            if (state.terminal == null && !state.stopping) {
                state.stopping = true
                // A turn that is being cancelled can't send it itself; the app scope can.
                if (currentCoroutineContext().isActive) {
                    if (!sendStop(server, runId)) keepStopping(server, runId)
                } else {
                    scope.launch { if (!sendStop(server, runId, timing.connect)) keepStopping(server, runId) }
                }
            }
            throw e
        } finally {
            // The run is over: a stop that didn't go through no longer matters.
            if (state.terminal != null) unstopped.remove(runId)?.cancel()
        }
        for (key in state.open.values.flatten()) turn.emit(AdapterEvent.ToolEnd(key, error = false))
        val t = state.terminal ?: return TurnResult.STOPPED
        // The final output can hold more than what streamed (the connection dropped part-way, or only an earlier
        // segment streamed): add what is missing.
        if (t.status == TurnStatus.DONE && t.output.isNotEmpty()) {
            val missing = HermesWire.missingText(state.text.toString(), state.segment.toString(), t.output, state.lost)
            if (missing.isNotEmpty()) turn.emit(AdapterEvent.Text(missing))
        }
        if (t.status == TurnStatus.ERROR) {
            val error = t.error ?: AgentErrorInfo()
            turn.emit(AdapterEvent.Error(error.code, error.detail))
            return TurnResult(TurnStatus.ERROR, error)
        }
        return TurnResult(t.status)
    }

    /** One connection to the run's event stream. */
    private suspend fun stream(state: RunState, runScope: CoroutineScope): Outcome {
        var path = "/v1/runs/${enc(state.runId)}/events"
        val request = Request.Builder().header("Authorization", "Bearer ${state.server.key}").header("Accept", "text/event-stream")
        if (state.lastSeq >= 0) {
            request.header("Last-Event-ID", state.lastSeq.toString())
            path += "?last_seq=${state.lastSeq}"
        }
        val call = streamHttp.newCall(request.url(state.server.base.endpoint(path)).build())
        state.call = call
        if (state.isAborted) return Outcome.ABORTED
        // Only connecting has a deadline; the stream itself stays open as long as the run takes.
        val res = try {
            call.awaitHeaders(timing.connect)
        } catch (e: IOException) {
            if (state.isAborted) return Outcome.ABORTED
            throw networkError(e, state.server.base.host, timing.connect, texts)
        }
        if (res.code == 404) {
            res.close()
            return Outcome.GONE
        }
        if (!res.isSuccessful) {
            // The connect deadline is over once the headers are in, so the body gets a deadline of its own.
            val err = httpError(HttpAnswer.of(res.code, readCapped(call, res, timing.errorBody), state.server.key))
            // A server or gateway error, a timeout or a rate limit can pass and says nothing about the run: like a
            // dropped connection, the stream is tried again and the run then followed by its status.
            if (res.code >= 500 || res.code == 408 || res.code == 429) throw AgentException(ErrorCodes.OFFLINE, err.detail)
            throw err
        }
        val outcome = try {
            streamSse(call, res) { frame -> onFrame(state, runScope, frame) }
        } catch (e: IOException) {
            throw AgentException(ErrorCodes.OFFLINE, clip(describe(e), 200))
        }
        return when (outcome) {
            SseOutcome.END -> Outcome.END
            SseOutcome.IDLE -> Outcome.IDLE
            SseOutcome.ABORTED -> Outcome.ABORTED
        }
    }

    /** A poll's answer: [terminal] when the run ended, null [terminal] while it still runs. */
    private class Poll(val terminal: Terminal?) {
        val status: TurnStatus? get() = terminal?.status
    }

    /** The run's state on the server, or null when it didn't answer usefully (hermes.js poll). */
    private suspend fun poll(state: RunState): Poll? {
        val res = request("GET", state.server, "/v1/runs/${enc(state.runId)}")
        val d = res.obj?.takeIf { res.ok } ?: return null
        return when (d.str("status")) {
            "completed" -> Poll(Terminal(TurnStatus.DONE, output = d["output"]?.takeIf { it.truthy() }?.let(HermesWire::jsText).orEmpty()))
            "cancelled" -> Poll(Terminal(TurnStatus.STOPPED))
            "failed", "interrupted" -> Poll(Terminal(TurnStatus.ERROR, error = failure(d, state.server.key)))
            "queued", "running", "waiting_for_approval", "stopping" -> Poll(null)
            else -> null
        }
    }

    /**
     * Follows a run by its status once its event stream can't be resumed. Returns the terminal poll, a running one
     * as soon as Hermes reports the run going on when [retry] is set, or null once the run is let go. When the
     * server stops answering, the run is stopped first, and a stop Hermes doesn't take is sent again later.
     */
    private suspend fun watch(state: RunState, retry: Boolean): Poll? {
        var misses = 0
        while (!state.isAborted) {
            val res = try {
                poll(state)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
            if (res != null && (res.status != null || retry)) return res
            if (res != null) {
                misses = 0
            } else if (++misses >= timing.pollMisses) {
                state.stopping = true
                if (sendStop(state.server, state.runId)) {
                    throw AgentException(ErrorCodes.OFFLINE, texts.get(R.string.adapters_hermes_lost_stopped, state.name))
                }
                keepStopping(state.server, state.runId)
                throw AgentException(ErrorCodes.OFFLINE, texts.get(R.string.adapters_hermes_lost_stopping, state.name))
            }
            sleep(timing.pollEvery, state)
        }
        return null
    }

    private fun failure(data: JsonObject, secret: String): AgentErrorInfo {
        val (code, detail) = HermesWire.failure(data, texts.get(R.string.adapters_hermes_run_failed), secret)
        return AgentErrorInfo(code, detail)
    }

    private fun onFrame(state: RunState, runScope: CoroutineScope, frame: SseFrame) {
        val data = runCatching { RukooJson.parseToJsonElement(frame.data) }.getOrNull() as? JsonObject ?: return
        val seq = data.long("seq") ?: frame.id?.takeIf { DIGITS.matches(it) }?.toLongOrNull()
        // A resumed stream replays from Last-Event-ID; never apply an event twice.
        if (seq != null) {
            if (seq <= state.lastSeq) return
            state.lastSeq = seq
        }
        val event = data.str("event")?.takeIf { it.isNotEmpty() } ?: frame.event
        try {
            onEvent(state, runScope, event, data)
        } catch (e: Exception) {
            AppLog.w(TAG, "could not handle $event", e)
        }
        // The run is over: a server that keeps the stream open with keepalives must not hold the turn.
        if (state.terminal != null) state.call?.cancel()
    }

    private fun onEvent(state: RunState, runScope: CoroutineScope, event: String, data: JsonObject) {
        val turn = state.turn
        when (event) {
            "message.delta", "assistant.delta" -> {
                var delta = data.str("delta").orEmpty()
                // Text after a tool call starts with the blank lines that separated it in the model's output.
                if (state.segment.isEmpty()) delta = delta.trimStart()
                if (delta.isEmpty()) return
                state.segment.append(delta)
                // Kept across tool calls, to compare with the run's final output.
                state.text.append(delta)
                turn.emit(AdapterEvent.Text(delta))
            }
            "message.interim", "assistant.commentary" -> {
                val text = data.str("text")
                if (!data["already_streamed"].truthy() && text != null && text.isNotBlank()) {
                    state.segment = StringBuilder()
                    turn.emit(AdapterEvent.Commentary(text.trim()))
                }
            }
            "tool.started" -> {
                val tool = toolName(data)
                val n = (state.counters[tool] ?: 0) + 1
                state.counters[tool] = n
                val key = "$tool#$n"
                state.open.getOrPut(tool) { ArrayDeque() }.addLast(key)
                state.segment = StringBuilder()
                turn.emit(AdapterEvent.ToolStart(key, tool, HermesWire.preview(data.str("preview"), state.server.key)))
            }
            "tool.completed", "tool.failed" -> {
                val tool = toolName(data)
                var key = state.open[tool]?.removeFirstOrNull()
                if (key == null) {
                    // A completion without a start (it was before a reconnect window): show it anyway.
                    val n = (state.counters[tool] ?: 0) + 1
                    state.counters[tool] = n
                    key = "$tool#$n"
                    turn.emit(AdapterEvent.ToolStart(key, tool, ""))
                }
                val error = event == "tool.failed" || data["error"].truthy()
                val preview = data["preview"]?.takeIf { it.truthy() }?.let(HermesWire::jsText)
                state.segment = StringBuilder()
                turn.emit(AdapterEvent.ToolEnd(key, error, if (error && preview != null) clipSafe(preview, state.server.key, 200) else null))
            }
            "subagent.start" -> {
                val n = (state.counters["subagent"] ?: 0) + 1
                state.counters["subagent"] = n
                val sid = listOf("subagent_id", "delegation_id").firstNotNullOfOrNull { data[it]?.takeIf { v -> v.truthy() }?.let(HermesWire::jsText) } ?: "#$n"
                val key = "subagent:$sid"
                state.subagents[sid] = key
                state.segment = StringBuilder()
                val goal = listOf("goal", "preview").firstNotNullOfOrNull { data[it]?.takeIf { v -> v.truthy() }?.let(HermesWire::jsText) }.orEmpty()
                turn.emit(AdapterEvent.ToolStart(key, "subagent", clipSafe(goal, state.server.key, 200)))
            }
            "subagent.complete" -> {
                var sid = listOf("subagent_id", "delegation_id").firstNotNullOfOrNull { data[it]?.takeIf { v -> v.truthy() }?.let(HermesWire::jsText) }.orEmpty()
                var key = state.subagents[sid]
                if (key == null) {
                    val first = state.subagents.entries.firstOrNull() ?: return
                    sid = first.key
                    key = first.value
                }
                state.subagents.remove(sid)
                val status = data["status"]?.takeIf { it.truthy() }?.let(HermesWire::jsText).orEmpty()
                turn.emit(AdapterEvent.ToolEnd(key, error = FAILED.containsMatchIn(status)))
            }
            "approval.request" -> {
                state.segment = StringBuilder()
                val request = HermesWire.approval(state.name, id, data)
                val pending = Pending(request.key.orEmpty())
                if (pending.requestId.isNotEmpty()) state.approvals[pending.requestId] = pending
                // Undispatched, as desktop calls approve() at once: the card is up before the next event, which may
                // already withdraw it.
                runScope.launch(start = CoroutineStart.UNDISPATCHED) {
                    try {
                        approval(state, runScope, request, pending)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        AppLog.w(TAG, "approval failed", e)
                    }
                }
            }
            "approval.responded" -> {
                // Answered somewhere else (another client, or Hermes timed it out): retire our card.
                val requestId = data["request_id"]?.takeIf { it.truthy() }?.let(HermesWire::jsText).orEmpty()
                val pending = state.approvals[requestId] ?: return
                pending.expired = true
                turn.expireApproval(pending.requestId)
            }
            "run.completed" -> {
                state.terminal = Terminal(TurnStatus.DONE, output = data.str("output").orEmpty())
                if (data["usage"].truthy()) turn.emit(AdapterEvent.Usage)
            }
            "run.cancelled" -> state.terminal = Terminal(TurnStatus.STOPPED)
            "run.failed", "run.interrupted" -> state.terminal = Terminal(TurnStatus.ERROR, error = failure(data, state.server.key))
            "error" -> {
                val message = data["message"]?.takeIf { it.truthy() }?.let(HermesWire::jsText) ?: texts.get(R.string.adapters_hermes_reported_error)
                state.terminal = Terminal(TurnStatus.ERROR, error = AgentErrorInfo(ErrorCodes.UNKNOWN, clipSafe(message, state.server.key, 200)))
            }
            // reasoning.available and tool.progress repeat the visible text; the rest is bookkeeping.
            else -> Unit
        }
    }

    private fun toolName(data: JsonObject): String =
        listOf("tool", "tool_name").firstNotNullOfOrNull { data[it]?.takeIf { v -> v.truthy() }?.let(HermesWire::jsText) } ?: "tool"

    // ---------- approvals ----------

    private suspend fun approval(state: RunState, runScope: CoroutineScope, request: ApprovalRequest, pending: Pending) {
        val requestId = pending.requestId
        val choice = try {
            state.turn.approve(request)
        } finally {
            state.approvals.remove(requestId)
        }
        if (choice.isEmpty() || choice == "cancel" || pending.expired || state.terminal != null) return
        answer(state, runScope, buildJsonObject {
            put("choice", choice)
            if (requestId.isNotEmpty()) put("request_id", requestId)
        })
    }

    /**
     * The user's choice. The card is gone once they chose, so a lost answer would leave the run waiting for a choice
     * nobody can make again: no answer or a passing server error is sent again, with the same request_id. An answer
     * that still doesn't get through stops the run instead.
     */
    private suspend fun answer(state: RunState, runScope: CoroutineScope, body: JsonObject) {
        var failure: AgentException? = null
        for (attempt in 0 until 3) {
            if (attempt > 0) sleep(timing.backoff shl (attempt - 1), state)
            // Stop wins: an answer sent after the user stopped would let the waiting command go on.
            if (state.terminal != null || state.stopping || state.isAborted) return
            val res = try {
                request("POST", state.server, "/v1/runs/${enc(state.runId)}/approval", body)
            } catch (e: AgentException) {
                if (e.code != ErrorCodes.OFFLINE) throw e
                failure = e
                continue
            }
            // 409: the run ended or Hermes already gave up waiting; nothing left to answer.
            if (res.ok || res.status == 409) return
            failure = httpError(res)
            if (!(res.status >= 500 || res.status == 408 || res.status == 429)) break
        }
        if (state.terminal != null || state.stopping) return
        val f = failure ?: AgentException(ErrorCodes.OFFLINE, "")
        val lead = if (f.detail.isNotEmpty()) "${f.detail}. " else ""
        state.turn.emit(AdapterEvent.Error(f.code, lead + texts.get(R.string.adapters_hermes_answer_lost)))
        stopRun(state, runScope)
    }

    // ---------- stopping ----------

    /** Asks Hermes to stop a run Rukoo still follows; the stream ends after [Timing.stopWait] either way. */
    private fun stopRun(state: RunState, runScope: CoroutineScope) {
        if (state.stopping) return
        state.stopping = true
        scope.launch {
            // The turn ends after stopWait either way; a run that may still be going is asked again later.
            if (!sendStop(state.server, state.runId, timing.connect) && state.terminal == null) keepStopping(state.server, state.runId)
        }
        // The cancelled event normally follows within a second; don't wait on a server that went away.
        runScope.launch {
            delay(timing.stopWait)
            state.abort()
        }
    }

    /**
     * One stop request. True when Hermes took it or answered that nothing is left to stop: a run that already ended
     * answers 200, an unknown run 404, a run Hermes no longer holds 409. Anything else says nothing about the run.
     */
    private suspend fun sendStop(server: Server, runId: String, timeoutMs: Long = 5_000): Boolean = try {
        val res = request("POST", server, "/v1/runs/${enc(runId)}/stop", timeoutMs = timeoutMs)
        val taken = res.ok || res.status == 404 || res.status == 409
        if (!taken) AppLog.w(TAG, "stopping a run failed: HTTP ${res.status}")
        taken
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        AppLog.w(TAG, "stopping a run failed", e)
        false
    }

    /**
     * Sends the stop of a run Rukoo let go of again until Hermes takes it: once the server answers again, an
     * approved action must not go on unseen. The wait doubles from [Timing.stopRetry] up to ten times that.
     */
    private fun keepStopping(server: Server, runId: String) {
        if (unstopped.containsKey(runId)) return
        val job = scope.launch(start = CoroutineStart.LAZY) {
            var wait = timing.stopRetry
            try {
                while (true) {
                    delay(wait)
                    if (sendStop(server, runId)) break
                    wait = min(wait * 2, 10 * timing.stopRetry)
                }
            } finally {
                unstopped.remove(runId, coroutineContext[Job])
            }
        }
        if (unstopped.putIfAbsent(runId, job) == null) job.start() else job.cancel()
    }

    /** Runs whose stop Hermes hasn't taken yet (for tests and diagnostics). */
    internal fun unstoppedRuns(): Set<String> = unstopped.keys.toSet()

    private companion object {
        const val TAG = "Hermes"
        const val RECONNECTS = 5
        val DIGITS = Regex("^\\d+$")
        val FAILED = Regex("fail|error", RegexOption.IGNORE_CASE)
    }
}
