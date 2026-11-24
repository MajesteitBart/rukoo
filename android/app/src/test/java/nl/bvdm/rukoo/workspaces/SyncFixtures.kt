package nl.bvdm.rukoo.workspaces

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.TestScope
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.account.BorrowedSession
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.RukooJson

// Shared pieces for the feed, history and read tests (contract 8.6): synthetic IDs of the right shapes, builders for
// pages and events, the recorded answers as wire types, and a scripted WorkspaceHttp that answers each request the
// engine makes with a recorded or synthetic answer. Nothing here keeps workspace state the way a server would; the
// events responder only slices a list the test hands it, with the server's paging rules.

object Ids {
    fun id(prefix: String, n: Int, fill: Char = 'A') = prefix + "_" + n.toString().padStart(22, fill)
    val WS = id("w", 1)
    val WS2 = id("w", 2)
    val ME = id("u", 1, 'M')
    val OLGA = id("u", 2, 'O')
    val SAM = id("u", 3, 'S')
    val GENERAL = id("c", 1)
    val RANDOM = id("c", 2)
    val PROJECT = id("c", 3)
    val DM = id("c", 4)
    fun grant(n: Int) = id("g", n)
    fun event(seq: Long, room: Int = 1) = "e_" + room.toString() + "x" + seq.toString().padStart(20, '0')
    const val GEN = "GenerationAAAAAAAAAAAA"
    const val GEN2 = "GenerationBBBBBBBBBBBB"
    const val KEY = "key1"
}

fun room(
    id: String = Ids.GENERAL,
    grant: String = Ids.grant(1),
    head: Long = 10,
    floor: Long = 1,
    read: Long = 0,
    unread: Int = 0,
    mentions: Int = 0,
    name: String = "general",
    removed: List<String> = emptyList(),
    removedMore: Boolean = false,
    dm: Boolean = false,
    closedReason: String? = null,
) = Change(
    conversation = id, kind = if (dm) "dm" else "channel", name = if (dm) null else name,
    visibility = if (dm) "dm" else "workspace", archived = closedReason != null,
    participants = if (dm) listOf(Ids.ME, Ids.OLGA) else null, startedBy = if (dm) Ids.OLGA else null,
    closedReason = closedReason, grant = grant, role = "member", members = 2, head = head, floor = floor,
    lastAt = 1_000L + head, read = read, unread = unread, mentions = mentions, removed = removed, removedMore = removedMore,
)

fun msg(
    seq: Long,
    actor: String = Ids.OLGA,
    text: String = "message $seq",
    mentions: List<Mention> = emptyList(),
    root: String? = null,
    room: Int = 1,
    redacted: Boolean = false,
) = WireEvent(
    seq = seq, id = Ids.event(seq, room), kind = WireEvent.MESSAGE_POSTED, actor = actor, at = 1_000L + seq, root = root,
    text = if (redacted) null else text, mentions = if (redacted) emptyList() else mentions, redacted = redacted,
)

fun redaction(seq: Long, target: String, targetSeq: Long, room: Int = 1) = WireEvent(
    seq = seq, id = Ids.event(seq, room), kind = WireEvent.MESSAGE_REDACTED, actor = Ids.OLGA, at = 1_000L + seq,
    target = target, targetSeq = targetSeq,
)

/** [member] coming into the room at [seq], added by Olga. */
fun joined(seq: Long, member: String, room: Int = 1) = WireEvent(
    seq = seq, id = Ids.event(seq, room), kind = "member.joined", actor = Ids.OLGA, at = 1_000L + seq, member = member,
)

/** [member] leaving the room at [seq], taken out by Olga. */
fun left(seq: Long, member: String, room: Int = 1) = WireEvent(
    seq = seq, id = Ids.event(seq, room), kind = "member.left", actor = Ids.OLGA, at = 1_000L + seq, member = member,
)

/** A mention of [who] over the first [bytes] bytes. */
fun mention(who: String = Ids.ME, bytes: Int = 4) = Mention(who, 0, bytes)

fun feed(
    vararg rooms: Change,
    evictions: List<String> = emptyList(),
    inline: List<WireEvent> = emptyList(),
    directory: Directory = Directory(),
    next: String = "cursor1",
    more: Boolean = false,
) = FeedPage(rooms.toList(), evictions, inline, directory, next, more)

/** The real server's recorded answer [name] as a wire type. */
internal inline fun <reified T> recorded(name: String): T = decodeWire(WorkspaceVectors.exchange(name).responseBody!!)

fun details(ws: String = Ids.WS, generation: String = Ids.GEN, keyId: String? = Ids.KEY, time: Long = TestDb.NOW, me: String = Ids.ME, role: String = "member") =
    WorkspaceDetails(
        WorkspaceInfo(id = ws, name = "Team", generation = generation, keyId = keyId, time = time),
        Member(id = me, name = "Me", role = role, state = "active"),
    )

fun refusal(status: Int, code: String, scope: String? = null, retryAfter: String? = null): WorkspaceError =
    WorkspaceError.fromAnswer(status, buildJsonObject {
        put("error", code)
        if (scope != null) put("scope", scope)
    }, retryAfter)

fun <T> ok(serializer: KSerializer<T>, value: T, status: Int = 200) = WorkspaceAnswer(status, RukooJson.encodeToJsonElement(serializer, value))

/**
 * A [WorkspaceHttp] answering from a script. [on] answers every request to a route, [once] the next one only (and
 * goes first). The route is the path below `/v1/workspaces/{ws}` without its query. An answer can suspend, to hold a
 * request in flight, and can throw a [WorkspaceError] as a refusal. A request with no answer fails the test through
 * [problems] and gets `server`.
 */
class ScriptedHttp : WorkspaceHttp {
    class Call(val method: String, val path: String, val body: JsonElement?) {
        val route: String get() = path.substringBefore('?')
        fun query(name: String): String? =
            path.substringAfter('?', "").split('&').firstOrNull { it.startsWith("$name=") }?.substringAfter('=')

        override fun toString() = "$method $path"
    }

    private class Handler(val method: String, val path: String, val answer: suspend (Call) -> WorkspaceAnswer, val once: Boolean)

    val calls = CopyOnWriteArrayList<Call>()
    val problems = CopyOnWriteArrayList<String>()
    private val handlers = CopyOnWriteArrayList<Handler>()

    fun on(method: String, path: String, answer: suspend (Call) -> WorkspaceAnswer) {
        handlers += Handler(method, path, answer, once = false)
    }

    fun once(method: String, path: String, answer: suspend (Call) -> WorkspaceAnswer) {
        handlers.add(0, Handler(method, path, answer, once = true))
    }

    fun calls(method: String, route: String): List<Call> = calls.filter { it.method == method && it.route == route }

    override suspend fun request(server: String, method: String, path: String, body: JsonElement?, token: String): WorkspaceAnswer {
        val call = Call(method, path, body)
        calls += call
        val h = handlers.firstOrNull { it.method == method && it.path == call.route }
        if (h == null) {
            problems += "nothing answers $call"
            throw WorkspaceError("server", 500, message = "unscripted")
        }
        if (h.once) handlers.remove(h)
        return h.answer(call)
    }

    fun verify() {
        if (problems.isNotEmpty()) throw AssertionError(problems.joinToString("\n"))
    }
}

/**
 * An events route over [events], with the server's rules (server/src/workspace.js `#events`): `before` gives the newest
 * [limit] below it, `after` the oldest above it, oldest first, and `more` says whether the page left any out.
 */
class EventsRoute(var events: List<WireEvent>, var head: Long = events.maxOfOrNull { it.seq } ?: 0, var floor: Long = 1) {
    fun answer(call: ScriptedHttp.Call): WorkspaceAnswer {
        val limit = call.query("limit")!!.toInt()
        val before = call.query("before")?.toLong()
        val after = call.query("after")?.toLong() ?: 0
        val kept = events.filter { it.seq >= floor }
        val rows = if (before != null) kept.filter { it.seq < before }.sortedByDescending { it.seq } else kept.filter { it.seq > after }.sortedBy { it.seq }
        val page = rows.take(limit).let { if (before != null) it.reversed() else it }
        return ok(EventPage.serializer(), EventPage(page, head, floor, more = rows.size > limit))
    }
}

/**
 * A [WorkspaceSync] for workspace [Ids.WS] on a real chat cache, with [http] scripted and [clock] on the test's virtual
 * time, so the runner's gaps and backoff are exact. [seed] writes the workspace row as a finished first pass with a
 * cursor, so a run goes straight to `/changes`.
 */
internal class SyncHarness(val scope: TestScope, val db: TestDb, val timing: SyncTiming = SyncTiming()) {
    val http = ScriptedHttp()
    val clock = Clock { TestDb.NOW + scope.testScheduler.currentTime }
    val refused = CopyOnWriteArrayList<BorrowedSession>()
    private val ref = Any()
    val client = WorkspaceClient(http, { BorrowedSession("http://127.0.0.1:1", "token", "tag", ref) }, { refused += it })
    val events = RecordingEvents()
    lateinit var store: WorkspaceStore
    lateinit var sync: WorkspaceSync

    suspend fun start(seed: Boolean = true, background: CoroutineScope = scope.backgroundScope): SyncHarness {
        store = db.store(clock::now)
        if (seed) seedWs()
        sync = WorkspaceSync(Ids.WS, store, client, background, clock, events, timing)
        return this
    }

    /** A new sync on the same file, as after a restart. */
    suspend fun restart(): SyncHarness {
        sync.close()
        store.close()
        store = db.store(clock::now)
        sync = WorkspaceSync(Ids.WS, store, client, scope.backgroundScope, clock, events, timing)
        return this
    }

    suspend fun seedWs(cursor: String? = "cursor0", passing: Boolean = false, fresh: Boolean = false, role: String = "member") {
        store.tx {
            insertWs(
                WsRow(
                    id = Ids.WS, name = "Team", role = role, me = Ids.ME, myName = "Me", generation = Ids.GEN, keyId = Ids.KEY,
                    cursor = cursor, passing = passing, fresh = fresh, membersStale = false, channelsStale = false, blocksStale = false,
                ),
            )
        }
    }

    suspend fun ws(): WsRow = store.read { getWs(Ids.WS)!! }
    suspend fun room(id: String = Ids.GENERAL): RoomRow? = store.read { getRoom(Ids.WS, id) }
    suspend fun events(id: String = Ids.GENERAL): List<Event> = store.read { eventsFrom(Ids.WS, id, 0, 10_000) }

    /** `GET /changes` answers [pages] one after another. */
    fun feedPages(vararg pages: FeedPage) {
        for (p in pages.reversed()) http.once("GET", "/v1/workspaces/${Ids.WS}/changes") { ok(FeedPage.serializer(), p) }
    }

    fun route(rest: String = "") = "/v1/workspaces/${Ids.WS}$rest"
}

/** The hooks a sync called, in order. */
class RecordingEvents : SyncEvents {
    val log = CopyOnWriteArrayList<String>()
    val pages = CopyOnWriteArrayList<PageResult>()
    val runs = CopyOnWriteArrayList<RunOutcome>()
    val reads = CopyOnWriteArrayList<Pair<String, Long>>()

    override suspend fun page(ws: String, result: PageResult) {
        pages += result
        log += "page"
    }

    override suspend fun ran(ws: String, outcome: RunOutcome) {
        runs += outcome
        log += "ran"
    }

    override suspend fun restored(ws: String) {
        log += "restored"
    }

    override suspend fun quarantined(ws: String) {
        log += "quarantined"
    }

    override suspend fun parked(ws: String) {
        log += "parked"
    }

    override suspend fun removed(ws: String) {
        log += "removed"
    }

    override suspend fun read(ws: String, room: String, readLocal: Long) {
        reads += room to readLocal
        log += "read"
    }
}

/** The JSON object a recorded exchange's request carried. */
fun recordedBody(name: String): JsonObject = WorkspaceVectors.exchange(name).requestBody as JsonObject
