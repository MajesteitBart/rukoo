package nl.bvdm.rukoo.agents.adapters

// OpenClaw: the user's own OpenClaw agent, reached through the OpenAI-compatible Chat Completions endpoint of their
// gateway. A port of desktop's src/main/agents/openclaw.js (spec 1 §4), built against OpenClaw 2026.10.5:
//
// - The endpoint is off until gateway.http.endpoints.chatCompletions.enabled is on; a gateway without it answers 404
//   before it checks the token.
// - `model` names an OpenClaw agent (openclaw/<agentId>); the x-openclaw-model header picks a backend model for it.
// - The `user` field keeps an agent session (agent:<agentId>:openai-user:<user>), so each turn sends one value per
//   chat and only the new message: the gateway keeps the transcript.
// - With stream: true the answer is SSE: text in choices[0].delta.content, a chunk with finish_reason, then [DONE].
//   The stream carries text only, no tool calls or thinking.
// - Closing the connection cancels the run. That is Stop: the turn coroutine's cancellation cancels the call.

import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.AgentAdapter
import nl.bvdm.rukoo.agents.AgentException
import nl.bvdm.rukoo.agents.OpenClawSettings
import nl.bvdm.rukoo.agents.TurnHandle
import nl.bvdm.rukoo.agents.TurnResult
import nl.bvdm.rukoo.agents.model.AdapterEvent
import nl.bvdm.rukoo.agents.model.AgentErrorInfo
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.AgentStatus
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.TurnStatus
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.RukooJson
import okhttp3.OkHttpClient
import okhttp3.Request

class OpenClawAdapter internal constructor(
    private val settings: () -> OpenClawSettings,
    http: OkHttpClient,
    scope: CoroutineScope,
    private val texts: AdapterTexts,
    clock: Clock = Clock.System,
    private val timing: Timing = Timing(),
    override val id: String = AgentIds.OPENCLAW,
) : AgentAdapter {
    data class Timing(
        // The gateway sends its headers before the run starts, but reads the request body first, for up to 60 s.
        val headers: Long = 30_000,
        val errorBody: Long = 2_000,
        // No keepalives on this stream, and an agent can work for minutes without text (tool calls don't show):
        // only a silence this long counts as a dead connection. Stop ends a turn at any time.
        val silence: Long = 30 * 60_000,
        val statusTtl: Long = 30_000,
    )

    private data class S(val enabled: Boolean, val url: String, val key: String, val agent: String, val model: String)

    private val http = http.forAgents()
    private val streamHttp = this.http.newBuilder().readTimeout(timing.silence, TimeUnit.MILLISECONDS).build()
    private val statusCache = StatusCache<AgentStatus>(scope, clock, timing.statusTtl)

    private fun s(): S {
        val c = settings()
        val agent = c.agentId.trim()
        return S(c.enabled, c.url.trim(), c.token.trim(), if (AGENT_ID.matches(agent)) agent else "", c.model.trim())
    }

    private fun ready(s: S): ServerBase {
        if (!s.enabled) throw AgentException(ErrorCodes.DISABLED, texts.get(R.string.adapters_turned_off, NAME))
        if (s.url.isEmpty()) throw AgentException(ErrorCodes.NOT_CONFIGURED, texts.get(R.string.adapters_openclaw_no_url))
        if (s.key.isEmpty()) throw AgentException(ErrorCodes.NOT_CONFIGURED, texts.get(R.string.adapters_openclaw_no_token))
        return ServerBase.parse(s.url, texts)
    }

    /**
     * OpenClaw's /v1/models lists agents, not backend models, and the gateway has no list of those over HTTP. So the
     * menu offers Default and the model in Settings (x-openclaw-model); Chat Completions takes no reasoning effort.
     */
    override suspend fun models(): ModelOptions {
        val s = s()
        ready(s)
        return ModelOptions(agent = id, defaultModel = s.model)
    }

    /** The gateway has no endpoint that lists an agent's skills; OpenClaw still uses its skills on its own. */
    override suspend fun skills(): List<OwnSkill> {
        ready(s())
        return emptyList()
    }

    override suspend fun status(force: Boolean): AgentStatus {
        val s = s()
        if (!s.enabled) return AgentStatus(AgentState.DISABLED, "")
        if (s.url.isEmpty()) return AgentStatus(AgentState.UNCONFIGURED, texts.get(R.string.adapters_openclaw_no_url))
        if (s.key.isEmpty()) return AgentStatus(AgentState.UNCONFIGURED, texts.get(R.string.adapters_openclaw_no_token))
        val key = listOf(s.url, s.agent, sha256Hex(s.key)).joinToString("\u0000")
        return statusCache.get(key, force) { check(s) }.redacted(s.key)
    }

    /**
     * GET /v1/models needs the token, so it checks the address, the token and that the endpoint is on at once; the
     * gateway's /health doesn't check a token. The list also says whether the agent in Settings exists.
     */
    private suspend fun check(s: S): AgentStatus = try {
        val base = ServerBase.parse(s.url, texts)
        val res = http.jsonRequest("GET", base, "/v1/models", texts, bearer = s.key)
        val list = (res.obj?.get("data") as? kotlinx.serialization.json.JsonArray)
        val agent = s.agent.ifEmpty { DEFAULT_AGENT }
        when {
            res.status == 401 || res.status == 403 -> AgentStatus(AgentState.UNAUTHORIZED, texts.get(R.string.adapters_openclaw_token_refused))
            res.status == 404 -> AgentStatus(AgentState.UNKNOWN, endpointOff().detail)
            !res.ok -> AgentStatus(if (res.status >= 500 || res.status == 429) AgentState.OFFLINE else AgentState.UNKNOWN, httpError(res).detail)
            list == null -> AgentStatus(AgentState.UNKNOWN, texts.get(R.string.adapters_openclaw_not_gateway))
            s.agent.isNotEmpty() && list.none { ((it as? JsonObject)?.str("id"))?.lowercase() == "openclaw/${agent.lowercase()}" } ->
                AgentStatus(AgentState.UNKNOWN, texts.get(R.string.adapters_openclaw_no_agent, agent))
            else -> AgentStatus(AgentState.READY, texts.get(R.string.adapters_openclaw_ready, agent))
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: AgentException) {
        AgentStatus(if (e.code == ErrorCodes.NOT_CONFIGURED) AgentState.UNCONFIGURED else AgentState.OFFLINE, e.detail)
    } catch (e: Exception) {
        AgentStatus(AgentState.OFFLINE, clip(describe(e), 200))
    }

    override suspend fun runTurn(turn: TurnHandle): TurnResult {
        // Whatever the server says reaches the chat without the token: events, errors and the result.
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
        val base = ready(s)
        val conversation = turn.conversation
        val known = conversation.provider
        // A chat stays with the agent and the session it started with, also when Settings name another agent later:
        // the session key includes the agent.
        val agent = known["agent"]?.takeIf { AGENT_ID.matches(it) } ?: s.agent.ifEmpty { DEFAULT_AGENT }
        val user = known["sessionUser"]?.takeIf { it.isNotEmpty() } ?: "rukoo:${conversation.id.ifEmpty { UUID.randomUUID().toString() }}"
        if (known["agent"] != agent || known["sessionUser"] != user) turn.setProvider(mapOf("agent" to agent, "sessionUser" to user))

        val body = buildJsonObject {
            put("model", "openclaw/$agent")
            put("user", user)
            put("stream", true)
            putJsonArray("messages") {
                if (turn.instructions.isNotEmpty()) {
                    addJsonObject {
                        put("role", "system")
                        put("content", turn.instructions)
                    }
                }
                addJsonObject {
                    put("role", "user")
                    put("content", turn.input)
                }
            }
        }
        val request = Request.Builder()
            .url(base.endpoint("/v1/chat/completions"))
            .header("Accept", "text/event-stream")
            .header("Authorization", "Bearer ${s.key}")
            .apply {
                // The chat's own model, else the model in Settings; without either the agent uses its own.
                val model = turn.model?.trim()?.ifEmpty { null } ?: s.model
                if (model.isNotEmpty()) header("x-openclaw-model", model)
            }
            .post(jsonBody(body))
            .build()
        val call = streamHttp.newCall(request)
        val res = try {
            call.awaitHeaders(timing.headers)
        } catch (e: HeadersTimeout) {
            throw AgentException(ErrorCodes.OFFLINE, texts.get(R.string.adapters_no_answer, base.host, (timing.headers / 1000).toInt()))
        } catch (e: IOException) {
            throw networkError(e, base.host, timing.headers, texts)
        }
        if (!res.isSuccessful) throw failed(res.code, readCapped(call, res, timing.errorBody), s.key)
        // The gateway has the message: the next one isn't a first turn again, even when this one is stopped now.
        turn.accepted()
        return follow(turn, call, res, s.key)
    }

    /** An answer other than the event stream, as an error with the gateway's own text. */
    private fun failed(status: Int, text: String, secret: String): AgentException {
        val answer = HttpAnswer.of(status, text, secret)
        return when (status) {
            // A gateway without the endpoint answers a plain 404 before it looks at the token.
            404 -> endpointOff()
            409 -> AgentException(
                ErrorCodes.UNKNOWN,
                "${errorText(answer.data, secret).ifEmpty { texts.get(R.string.adapters_openclaw_archived) }}. ${texts.get(R.string.adapters_openclaw_restore)}",
            )
            502, 503, 504 -> AgentException(ErrorCodes.OFFLINE, httpError(answer).detail)
            else -> httpError(answer)
        }
    }

    /** [key] is the token, kept out of the error texts the stream reports. */
    private class StreamState(val key: String) {
        var done = false
        var finished = false
        var error: AgentErrorInfo? = null
        var text = false
    }

    /** Reads the event stream into the turn until [DONE], an error, or Stop. */
    private suspend fun follow(turn: TurnHandle, call: okhttp3.Call, res: okhttp3.Response, key: String): TurnResult {
        val state = StreamState(key)
        val outcome = try {
            streamSse(call, res) { frame -> onFrame(turn, state, frame) }
        } catch (e: IOException) {
            throw AgentException(ErrorCodes.OFFLINE, texts.get(R.string.adapters_openclaw_broke_off, clip(describe(e), 160)))
        }
        state.error?.let { error ->
            turn.emit(AdapterEvent.Error(error.code, error.detail))
            return TurnResult(TurnStatus.ERROR, error)
        }
        if (outcome == SseOutcome.ABORTED) return TurnResult.STOPPED
        if (outcome == SseOutcome.IDLE) {
            // Closing the connection cancels the run on the gateway (the read ended the call).
            val minutes = (timing.silence / 60_000.0).roundToInt()
            throw AgentException(ErrorCodes.TIMEOUT, texts.plural(R.plurals.adapters_openclaw_silent, minutes, minutes))
        }
        // A stream that ended after its finish_reason but without [DONE] still finished.
        if (state.done || state.finished) return TurnResult.DONE
        throw AgentException(ErrorCodes.OFFLINE, texts.get(R.string.adapters_openclaw_closed))
    }

    private fun onFrame(turn: TurnHandle, state: StreamState, frame: SseFrame) {
        val raw = frame.data.trim()
        if (raw == "[DONE]") {
            state.done = true
            return
        }
        val data = runCatching { RukooJson.parseToJsonElement(raw) }.getOrNull() as? JsonObject ?: return
        if (data["error"].truthy()) {
            val detail = clip(errorText(data, state.key).ifEmpty { texts.get(R.string.adapters_openclaw_reported_error) }, 200)
            val code = if (HermesWire.RATE_LIMIT.containsMatchIn(detail)) ErrorCodes.RATE_LIMITED else ErrorCodes.UNKNOWN
            // An archived session is reported in the stream once it has started.
            state.error = AgentErrorInfo(code, if (ARCHIVED.containsMatchIn(detail)) "$detail. ${texts.get(R.string.adapters_openclaw_restore)}" else detail)
            return
        }
        val choice = (data["choices"] as? kotlinx.serialization.json.JsonArray)?.firstOrNull() as? JsonObject ?: return
        val delta = ((choice["delta"] as? JsonObject)?.get("content") as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
        if (delta.isNotEmpty()) {
            // The first text of an answer can start with the blank lines that separated it in the model's output.
            val text = if (state.text) delta else delta.trimStart()
            if (text.isNotEmpty()) {
                state.text = true
                turn.emit(AdapterEvent.Text(text))
            }
        }
        if (choice["finish_reason"].truthy()) state.finished = true
    }

    private fun endpointOff() = AgentException(ErrorCodes.NOT_CONFIGURED, texts.get(R.string.adapters_openclaw_endpoint_off))

    private companion object {
        const val TAG = "OpenClaw"
        const val NAME = "OpenClaw"
        const val DEFAULT_AGENT = "default"
        val AGENT_ID = Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
        val ARCHIVED = Regex("archiv", RegexOption.IGNORE_CASE)
    }
}
