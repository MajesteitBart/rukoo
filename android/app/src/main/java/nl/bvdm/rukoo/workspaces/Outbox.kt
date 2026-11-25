package nl.bvdm.rukoo.workspaces

import java.security.SecureRandom
import java.util.Base64
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import nl.bvdm.rukoo.core.AppLog

/**
 * Sending messages and removing them (contract §3.8 and §3.14).
 *
 * A message is a row in the cache's `outbox` before anything goes out: [enqueue] writes it in one transaction, or
 * throws `not_saved` and writes nothing, so the composer keeps the text and nothing shows as pending that isn't on
 * disk. The row's operation ID is saved with `state = 'sending'` in its own transaction before the first POST, and
 * every attempt sends the same bytes, so an answer lost on the way back is answered from the server's replay.
 *
 * The queue sends one message per room at a time, at most [Timing.roomsInFlight] rooms at once, oldest first. A
 * `held` or `failed` row holds back the later rows of its room. A workspace sends nothing until [synced] says its
 * first sync in this process succeeded, nor while it isn't `ok`.
 *
 * Every refusal becomes an outcome on the row, never a call error: the UI reads it from [pending] and offers what
 * §3.8 lists. Rukoo never makes a new operation ID for a message that might have arrived without asking first, so a
 * `409 submission_expired` and a restore go through a lookup (`GET …/operations/{op}`), and only [resend] with
 * [ResendMode.SEND] on a `held/unknown` row takes a new one.
 *
 * [hooks] are how the outbox asks the service for what the feed owns: the restore path, the removal path and the
 * upgrade state. [now] and [newId] are injected for tests.
 */
class Outbox(
    private val store: WorkspaceStore,
    private val client: WorkspaceClient,
    private val scope: CoroutineScope,
    private val hooks: Hooks = object : Hooks {},
    private val timing: Timing = Timing(),
    private val now: () -> Long = System::currentTimeMillis,
    private val newId: (Long) -> String = Uuid7::next,
    /**
     * Whether sends may start (§3.11, §7.5): the app in the foreground or ChatSyncWorker's window open. Outside it a
     * send already on its way finishes, and the rest, retry timers included, wait for the next resume or worker.
     */
    private val automatic: () -> Boolean = { true },
) {
    /** What the outbox asks of the service. Every hook has a default that does nothing. */
    interface Hooks {
        /**
         * `GET /` answered a generation other than the cached one: the service runs the restore path of §3.6, whose
         * transaction stores [details]' generation and marks the rows of the old one for lookup.
         */
        suspend fun restored(ws: String, details: WorkspaceDetails) {}

        /** A `404` with `scope: workspace`: the service runs the removal path, which deletes the workspace's rows. */
        fun removed(ws: String) {}

        /** A `426`: the outbox set the workspace's state to `upgrade`; the service parks its socket. */
        fun upgrade(ws: String) {}
    }

    /** The waits of §3.19, in milliseconds. Tests make them short. */
    data class Timing(
        /** After a network failure: 2, 5, 15, 30, 60 s, then every 60 s. */
        val sendBackoff: List<Long> = SEND_BACKOFF,
        /** A clock older than this is measured again before an operation ID is made. */
        val clockMaxAge: Long = CLOCK_MAX_AGE,
        /** Rooms sending at once; one message per room. */
        val roomsInFlight: Int = 2,
        /** A `429` without `Retry-After` waits this long. */
        val rateLimited: Long = 60_000,
    )

    /** A message the server took: [local] became [messageId] at [seq]. */
    data class Sent(val ws: String, val room: String, val local: String, val messageId: String, val seq: Long)

    private val lock = Any()
    private val inFlight = HashSet<String>()
    private val synced = HashSet<String>()
    private val busy = MutableStateFlow(0)
    private var wakeJob: Job? = null

    @Volatile
    private var closed = false

    private val _sent = MutableSharedFlow<Sent>(extraBufferCapacity = 64)

    /** Each message the server took, after its row went and its event was cached. */
    val sent: SharedFlow<Sent> = _sent.asSharedFlow()

    // ---- the person's calls ----

    /**
     * Writes a message to send and returns its local ID once the row is on disk (§3.8 "Writing"). [text] and
     * [mentions] go on the wire exactly as given; mentions are UTF-8 byte offsets. Throws `invalid` for input the
     * server would refuse, `not_found`, `archived`, `paused` or `upgrade_required` for a room that can't take it, and
     * `not_saved` when the write failed, in which case no row exists.
     */
    suspend fun enqueue(ws: String, room: String, root: String?, text: String, mentions: List<Mention>): String {
        validate(text, mentions, root)
        val local = newLocal()
        try {
            store.tx {
                val w = getWs(ws) ?: throw WorkspaceError("not_found", scope = "workspace")
                when (w.state) {
                    "quarantined" -> throw WorkspaceError("paused")
                    "upgrade" -> throw WorkspaceError("upgrade_required")
                }
                val me = w.me
                val generation = w.generation
                // GET / hasn't answered yet, so the phone doesn't know who it is here or which generation it writes in.
                if (me == null || generation == null) throw WorkspaceError("network", message = "The workspace hasn't loaded yet.")
                val r = getRoom(ws, room) ?: throw WorkspaceError("not_found", scope = "conversation")
                if (r.archived) throw WorkspaceError("archived")
                // Strictly later than the room's last row, so two sends in one millisecond keep their order.
                val last = sql.long("SELECT COALESCE(MAX(createdAt), 0) FROM outbox WHERE ws = ? AND room = ?", ws, room)
                insertOutbox(
                    OutboxRow(
                        local = local, ws = ws, room = room, actor = me, grantId = r.grantId, generation = generation,
                        text = text, mentions = mentions, root = root, createdAt = maxOf(now(), last + 1),
                    ),
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: WorkspaceError) {
            throw e
        } catch (e: Exception) {
            throw WorkspaceError("not_saved", message = "Rukoo couldn't save this message on the phone.", cause = e)
        }
        kick(ws)
        return local
    }

    /**
     * Answers a held or failed row (§3.8 "Resend modes"). [ResendMode.SEND] on `held/stale_grant` takes the room's
     * current grant and keeps the operation ID, because the server checks duplicates before grants; on `held/unknown`,
     * after the UI asked, it takes a new ID with the current grant and generation. [ResendMode.RETRY] sends
     * `failed/quota` again with the same ID. [ResendMode.WITHOUT_MENTIONS] clears a `failed/mentions` row's mentions
     * and takes a new ID. Any other pairing throws `invalid` with `field = "mode"`.
     */
    suspend fun resend(local: String, mode: ResendMode) {
        val row = store.tx {
            val r = getOutbox(local) ?: throw WorkspaceError("not_found")
            val fields: Map<String, Any?> = when {
                mode == ResendMode.SEND && r.state == HELD && r.reason == "stale_grant" -> {
                    val room = getRoom(r.ws, r.room) ?: throw WorkspaceError("not_found", scope = "conversation")
                    mapOf("grantId" to room.grantId)
                }
                mode == ResendMode.SEND && r.state == HELD && r.reason == "unknown" -> {
                    val room = getRoom(r.ws, r.room) ?: throw WorkspaceError("not_found", scope = "conversation")
                    val w = getWs(r.ws) ?: throw WorkspaceError("not_found", scope = "workspace")
                    mapOf("operationId" to null, "grantId" to room.grantId, "generation" to (w.generation ?: r.generation))
                }
                mode == ResendMode.RETRY && r.state == FAILED && r.reason == "quota" -> emptyMap()
                mode == ResendMode.WITHOUT_MENTIONS && r.state == FAILED && r.reason == "mentions" ->
                    mapOf("mentions" to emptyList<Mention>(), "operationId" to null)
                else -> throw WorkspaceError("invalid", field = "mode", message = "$mode doesn't answer ${r.state}/${r.reason}")
            }
            updateOutbox(local, fields + mapOf("state" to QUEUED, "reason" to null, "attempts" to 0, "nextAt" to 0L))
            deleteMeta(limitKey(local))
            r
        }
        kick(row.ws)
    }

    /**
     * Deletes the row: the message won't be sent. A row that is gone already is fine. A held or failed row held back
     * the later rows of its room, so the queue runs for them now.
     */
    suspend fun discard(local: String) {
        val ws = store.tx {
            val r = getOutbox(local)
            deleteOutbox(local)
            deleteMeta(limitKey(local))
            r?.ws
        }
        if (ws != null) kick(ws)
    }

    /**
     * Removes a message (§3.14): `POST …/redact`, then, after its `200`, marks the cached event removed and leaves a
     * tombstone in one transaction, so the row changes at once and a slow history page can't bring the text back.
     * Refusals throw as call errors.
     */
    suspend fun redact(ws: String, room: String, message: String) {
        try {
            client.redact(ws, room, message)
        } catch (e: WorkspaceError) {
            workspaceAnswer(ws, e)
            throw e
        }
        store.tx {
            addTombstones(ws, listOf(message))
            redact(ws, listOf(message))
        }
    }

    // ---- the queue ----

    /**
     * At start, before anything sends: a row left `sending` by a process that ended mid-attempt goes back to
     * `queued` with its operation ID, so the next attempt sends the same one. A `429`'s hold on a row that is gone
     * goes too.
     */
    suspend fun start() {
        store.tx {
            for (local in sql.query("SELECT local FROM outbox WHERE state = 'sending'") { it.text(0) }) {
                updateOutbox(local, mapOf("state" to QUEUED))
            }
            sql.exec(
                "DELETE FROM meta WHERE key LIKE ? AND substr(key, ?) NOT IN (SELECT local FROM outbox)",
                "$LIMITED%", LIMITED.length + 1,
            )
        }
    }

    /** The workspace's first sync in this process succeeded, so its queue may run (§3.8). */
    fun synced(ws: String) {
        synchronized(lock) { synced += ws }
        kick(ws)
    }

    /** The workspace went or its session ended: it sends nothing until [synced] again. */
    fun forget(ws: String) {
        synchronized(lock) { synced -= ws }
    }

    /**
     * Sends what is due. With [retryNow], rows waiting out a network backoff go at once: a wake, focus, resume or a
     * socket that opened (§3.8). A `429` still waits its `Retry-After`. [ws] limits [retryNow] to one workspace.
     */
    fun kick(ws: String? = null, retryNow: Boolean = false) {
        if (closed) return
        scope.launch {
            if (retryNow) runCatching { retryNow(ws) }
            pump()
        }
    }

    /**
     * Runs the queue until nothing is due or [budgetMs] ran out, for the background worker. True when no message is
     * left `queued` or `sending`; held and failed rows wait for the person and don't count.
     */
    suspend fun flush(budgetMs: Long): Boolean {
        withTimeoutOrNull(budgetMs) {
            while (!closed && automatic()) {
                pump()
                busy.first { it == 0 }
                val ready = synchronized(lock) { synced.toSet() }
                if (store.read { nextDue(now(), DUE_LIMIT) }.none { it.ws in ready }) break
            }
        }
        return store.read { sql.long("SELECT COUNT(*) FROM outbox WHERE state IN ('queued', 'sending')") } == 0L
    }

    /** How many messages wait to be sent, for `ChatState.unsent` and the sign-out dialog. */
    suspend fun unsent(): Int = store.read { countUnsent() }

    /** Stops the queue: nothing new starts, and an answer that comes later is dropped. */
    fun close() {
        closed = true
        synchronized(lock) {
            wakeJob?.cancel()
            wakeJob = null
        }
    }

    // A row a 429 holds keeps its wait: the hold is on disk, so it outlasts the process as its Retry-After does.
    private suspend fun retryNow(ws: String?) {
        store.tx {
            val rows = sql.query(
                "SELECT local FROM outbox WHERE state = 'queued' AND nextAt > ?${if (ws != null) " AND ws = ?" else ""}",
                *(if (ws != null) arrayOf<Any?>(now(), ws) else arrayOf<Any?>(now())),
            ) { it.text(0) }
            for (local in rows) {
                val held = getMeta(limitKey(local))?.toLongOrNull()
                if (held != null && held > now()) continue
                updateOutbox(local, mapOf("nextAt" to 0L))
            }
        }
    }

    private suspend fun pump() {
        // In the background without the worker's window nothing starts, a backoff's timer included: the next resume
        // kicks the queue with retryNow, and the worker's flush runs it.
        if (closed || !automatic()) return
        val due = try {
            store.read { nextDue(now(), DUE_LIMIT) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return
        }
        synchronized(lock) {
            for (row in due) {
                if (closed || inFlight.size >= timing.roomsInFlight) break
                if (row.ws !in synced) continue
                val key = "${row.ws}/${row.room}"
                if (!inFlight.add(key)) continue
                busy.update { it + 1 }
                scope.launch {
                    try {
                        attempt(row.local)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // A cache that failed under the attempt, or a hook that threw. A row left `sending` would
                        // block its room until the next start, so it goes back to the queue with the next backoff.
                        // When even that write fails (a full disk), the room waits one backoff step here, so the
                        // next pump doesn't find the same row due and run it again at once.
                        AppLog.w(TAG, "A send stopped", e)
                        if (!unstick(row.local)) delay(backoff(1))
                    } finally {
                        synchronized(lock) { inFlight -= key }
                        busy.update { it - 1 }
                        if (!closed) scope.launch { pump() }
                    }
                }
            }
        }
        scheduleWake()
    }

    /**
     * After an attempt stopped on something other than an answer: a row it left `sending` or `queued` gets the next
     * backoff step as `queued`, keeping its operation ID, reason and bytes, so an attempt that throws before it
     * changed the row doesn't run again at once. The attempt still holds the room, so nothing else sends this row
     * meanwhile. False when the cache couldn't take even this; [start] repairs a `sending` row at the next start.
     */
    private suspend fun unstick(local: String): Boolean {
        if (closed) return true
        return try {
            store.tx {
                val r = getOutbox(local) ?: return@tx
                if (r.state == SENDING || r.state == QUEUED) {
                    updateOutbox(local, mapOf("state" to QUEUED, "attempts" to r.attempts + 1, "nextAt" to now() + backoff(r.attempts + 1)))
                }
            }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            AppLog.w(TAG, "A stopped send stays as it was until the next start", e)
            false
        }
    }

    /** One timer for the earliest row that waits out a backoff or a `Retry-After`. */
    private suspend fun scheduleWake() {
        val at = try {
            store.read {
                sql.one(
                    """SELECT MIN(o.nextAt) FROM outbox o JOIN ws w ON w.id = o.ws
                       WHERE w.state = 'ok' AND o.state = 'queued' AND o.nextAt > ?
                         AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.ws = o.ws AND p.room = o.room
                                         AND (p.createdAt < o.createdAt OR (p.createdAt = o.createdAt AND p.local < o.local)))""",
                    now(),
                ) { it.longOrNull(0) }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        synchronized(lock) {
            wakeJob?.cancel()
            wakeJob = null
            if (at == null || closed) return
            val wait = at - now()
            if (wait > 0) wakeJob = scope.launch {
                delay(wait)
                pump()
            }
        }
    }

    // ---- one attempt ----

    private suspend fun attempt(local: String) {
        var row = store.read { getOutbox(local) } ?: return
        if (closed || row.state != QUEUED || row.nextAt > now()) return
        if (row.reason == LOOKUP && row.operationId != null) {
            lookup(row)
            return
        }
        if (row.reason == LOOKUP) {
            // Marked for lookup before it ever got an ID: it never went out, so there is nothing to look up. It takes
            // the generation the workspace has now.
            val marked = row
            row = store.tx {
                val r = getOutbox(local)
                if (r == null || r.state != QUEUED || r.reason != LOOKUP || r.operationId != null) return@tx null
                val gen = getWs(marked.ws)?.generation ?: marked.generation
                updateOutbox(local, mapOf("reason" to null, "generation" to gen))
                getOutbox(local)
            } ?: return
        }
        if (row.operationId == null) {
            val offset = clock(row, force = false) ?: return
            val id = newId(now() + offset)
            row = claim(row, mapOf("operationId" to id)) ?: return
        } else {
            row = claim(row, emptyMap()) ?: return
        }
        post(row, clockRetried = false)
    }

    /**
     * Saves the row as `sending`, with [fields], before the POST. Null, and the row left alone, when it isn't [row] any
     * more (discarded, answered, or marked for lookup by a restore meanwhile) or its workspace stopped being `ok`
     * while the clock was measured: a parked workspace sends nothing (§3.6, §3.8).
     */
    private suspend fun claim(row: OutboxRow, fields: Map<String, Any?>): OutboxRow? = store.tx {
        val r = getOutbox(row.local)
        if (r == null || r.state != row.state || r.operationId != row.operationId || r.reason != row.reason) return@tx null
        if (r.state != QUEUED && r.state != SENDING) return@tx null
        if (getWs(row.ws)?.state != "ok") return@tx null
        updateOutbox(row.local, fields + ("state" to SENDING))
        getOutbox(row.local)
    }

    private suspend fun post(row: OutboxRow, clockRetried: Boolean) {
        val body = SendBody(row.operationId!!, row.grantId, row.generation, row.text, row.mentions, row.root)
        val ack = try {
            client.post(row.ws, row.room, body)
        } catch (e: WorkspaceError) {
            if (closed) return
            refused(row, e, clockRetried)
            return
        }
        if (closed) return
        // A 2xx that doesn't name an event the way the feed would is no proof the message landed: the row keeps its ID
        // and goes again after the backoff, and the replay answers properly.
        if (!acked(ack.messageId, ack.seq)) {
            waitOrPark(row, WorkspaceError("server", message = "the send answer isn't one"), reason = null)
            return
        }
        delivered(row, ack.messageId, ack.seq, visible = true)
    }

    private suspend fun refused(row: OutboxRow, e: WorkspaceError, clockRetried: Boolean) {
        when (e.code) {
            "stale_grant" -> settle(row, HELD, "stale_grant")
            "submission_expired" -> lookup(row)
            "stale_generation" -> staleGeneration(row)
            "operation_conflict" -> {
                // The same ID with other bytes: a bug or a damaged row.
                AppLog.w(TAG, "The server refused an operation ID it had seen with another message")
                settle(row, FAILED, "conflict")
            }
            "archived" -> settle(row, FAILED, "archived")
            "quota" -> settle(row, FAILED, "quota")
            "forbidden" -> settle(row, FAILED, "no_access")
            "invalid" -> when (e.field) {
                "mentions" -> settle(row, FAILED, "mentions")
                // A reply's root the server refused: the app replies only to top-level messages, so it was removed.
                "root" -> settle(row, FAILED, "root_removed")
                // Ahead of the server's clock. A 400 means the ID never committed, since the server checks duplicates
                // first, so a new one from a measured clock is safe, once.
                "operationId" -> if (clockRetried) settle(row, FAILED, "invalid") else {
                    val offset = clock(row, force = true) ?: run {
                        // No new clock now. The refused ID never committed, so the next attempt makes a new one.
                        store.tx { if (still(row) != null) updateOutbox(row.local, mapOf("operationId" to null, "state" to QUEUED)) }
                        return
                    }
                    val again = claim(row, mapOf("operationId" to newId(now() + offset))) ?: return
                    post(again, clockRetried = true)
                }
                else -> settle(row, FAILED, "invalid")
            }
            // A 4xx the table doesn't list won't change by sending the same bytes again, and a row that waits for it
            // forever blocks its room without offering Discard. §3.8 retries only network failures, timeouts and 5xx.
            else -> if (permanent(e)) settle(row, FAILED, if (e.status == 403) "no_access" else "invalid") else waitOrPark(row, e, reason = null)
        }
    }

    /**
     * A refusal that sending again can't change: a 4xx other than the ones [waitOrPark] handles (`401`, `404`, `426`,
     * `429`) and a proxy's `408` timeout.
     */
    private fun permanent(e: WorkspaceError): Boolean = e.status in 400..499 && e.status !in RETRIED_4XX

    /**
     * What any call of an attempt does for the answers that aren't about the message: the removal path, the upgrade
     * state, `Retry-After`, and for a network failure, a 5xx or anything unknown, the row back to `queued` with the
     * next backoff step. [reason] is what the row keeps: null, or `lookup` for a lookup that still has to run.
     * [asked] is what a request for a `queued` row went out under (see [still]).
     */
    private suspend fun waitOrPark(row: OutboxRow, e: WorkspaceError, reason: String?, asked: Asked? = null) {
        when {
            e.code == "not_found" && e.scope == "workspace" -> {
                requeue(row, reason, nextAt = now() + backoff(row.attempts + 1), attempts = row.attempts + 1, asked = asked)
                hooks.removed(row.ws)
            }
            e.code == "not_found" -> settle(row, FAILED, "no_access", asked)
            e.code == "upgrade_required" -> {
                requeue(row, reason, nextAt = row.nextAt, attempts = row.attempts, asked = asked)
                workspaceAnswer(row.ws, e)
            }
            e.code == "rate_limited" -> {
                val until = now() + (e.retryAfterS?.times(1000) ?: timing.rateLimited)
                requeue(row, reason, nextAt = until, attempts = row.attempts, asked = asked, limited = true)
            }
            else -> requeue(row, reason, nextAt = now() + backoff(row.attempts + 1), attempts = row.attempts + 1, asked = asked)
        }
    }

    /** The workspace-wide meaning of an answer: `426` sets the upgrade state, a `404` for it runs the removal path. */
    private suspend fun workspaceAnswer(ws: String, e: WorkspaceError) {
        when {
            e.code == "upgrade_required" -> {
                // As the feed parks it: the revision goes up in the same transaction, so a history page or another
                // answer already on its way to the parked cache is dropped.
                FeedApplier(store).park(ws)
                hooks.upgrade(ws)
            }
            e.code == "not_found" && e.scope == "workspace" -> hooks.removed(ws)
        }
    }

    /**
     * `GET …/operations/{op}` for a row whose fate is unknown (§3.8 "Lookup"): found means sent; none means
     * `held/unknown`, and the person decides whether to send it again. A workspace that isn't `ok` asks nothing: a row
     * a `submission_expired` left `sending` waits as a lookup for when it is again.
     */
    private suspend fun lookup(row: OutboxRow) {
        val op = row.operationId ?: return
        val ws = store.read { getWs(row.ws) }
        if (ws?.state != "ok") {
            if (row.state == SENDING) {
                store.tx { if (still(row) != null) updateOutbox(row.local, mapOf("state" to QUEUED, "reason" to LOOKUP, "nextAt" to 0L)) }
            }
            return
        }
        // The answer belongs to the cache revision the lookup started under (§3.6), as well as to its generation: a
        // reset, Start over or park meanwhile keeps the generation but leaves the row to a lookup of its own.
        val asked = store.read { Asked(getWs(row.ws)?.generation, revision(row.ws)) }
        val found = try {
            client.operation(row.ws, row.room, op)
        } catch (e: WorkspaceError) {
            if (closed) return
            when {
                e.code == "not_found" && e.scope == "conversation" -> settle(row, FAILED, "no_access", asked)
                e.status == 403 -> settle(row, FAILED, "no_access", asked)
                // The lookup can't tell, now or later: the person decides, as for an operation the server doesn't know.
                permanent(e) -> settle(row, HELD, "unknown", asked)
                else -> waitOrPark(row, e, LOOKUP, asked)
            }
            relook(row, asked)
            return
        }
        if (closed) return
        when {
            found == null -> settle(row, HELD, "unknown", asked)
            !acked(found.messageId, found.seq) ->
                waitOrPark(row, WorkspaceError("server", message = "the lookup answer isn't one"), LOOKUP, asked)
            else -> delivered(row, found.messageId, found.seq, found.visible, asked)
        }
        relook(row, asked)
    }

    /**
     * After a lookup whose answer was dropped because the revision moved: a row a `submission_expired` left `sending`
     * waits as a lookup, so a new one decides it instead of the room staying blocked until the next start. A `queued`
     * row is a lookup already. Nothing happens when the answer was applied: the row isn't the one the lookup left.
     */
    private suspend fun relook(row: OutboxRow, asked: Asked) {
        if (row.state != SENDING) return
        store.tx {
            if (revision(row.ws) != asked.revision && still(row) != null) {
                updateOutbox(row.local, mapOf("state" to QUEUED, "reason" to LOOKUP, "nextAt" to 0L))
            }
        }
    }

    /**
     * `409 stale_generation`: `GET /` measures the clock and finds the new generation, the service's restore path
     * runs, and the row is looked up. It never committed under this request, but an earlier attempt with its ID
     * might have, before the restore. A row the restore marked already is left as it marked it.
     */
    private suspend fun staleGeneration(row: OutboxRow) {
        val details = try {
            measure(row.ws)
        } catch (e: WorkspaceError) {
            if (closed) return
            waitOrPark(row, e, LOOKUP)
            return
        }
        if (closed) return
        if (details.workspace.generation != store.read { getWs(row.ws)?.generation }) hooks.restored(row.ws, details)
        store.tx { if (still(row) != null) updateOutbox(row.local, mapOf("state" to QUEUED, "reason" to LOOKUP, "nextAt" to 0L)) }
    }

    /**
     * The server's clock minus this phone's, measured with `GET /` when unknown, older than [Timing.clockMaxAge] or
     * [force]d. Null when the measurement failed, after the row got what that failure means; also null when `GET /`
     * found a new generation, after the restore hook ran, so the attempt starts over from the row as it is now.
     */
    private suspend fun clock(row: OutboxRow, force: Boolean): Long? {
        if (!force) {
            val known = store.read {
                val at = getMeta(CLOCK_AT)?.toLongOrNull()
                val offset = getMeta(CLOCK_OFFSET)?.toLongOrNull()
                if (at != null && offset != null && now() - at in 0..timing.clockMaxAge) offset else null
            }
            if (known != null) return known
        }
        val asked = store.read { Asked(getWs(row.ws)?.generation) }
        val details = try {
            measure(row.ws)
        } catch (e: WorkspaceError) {
            if (!closed) {
                // The row was never sent with this attempt: it stays queued with its reason.
                waitOrPark(row, e, row.reason, asked)
            }
            return null
        }
        if (closed) return null
        val stored = store.read { getWs(row.ws)?.generation }
        if (stored != null && details.workspace.generation != stored) {
            hooks.restored(row.ws, details)
            store.tx { if (row.state == SENDING && still(row) != null) updateOutbox(row.local, mapOf("state" to QUEUED)) }
            return null
        }
        return store.read { getMeta(CLOCK_OFFSET)?.toLongOrNull() }
    }

    /** `GET /`, with the clock offset `workspace.time − (t0 + t1) / 2` saved in `meta`. */
    private suspend fun measure(ws: String): WorkspaceDetails {
        val t0 = now()
        val details = client.get(ws)
        val t1 = now()
        store.tx {
            setMeta(CLOCK_OFFSET, (details.workspace.time - (t0 + t1) / 2).toString())
            setMeta(CLOCK_AT, t1.toString())
        }
        return details
    }

    // ---- outcomes ----

    /**
     * What a request went out under: the workspace's [generation], and for a lookup the cache [revision] (§3.6), or
     * null where the revision isn't checked.
     */
    private class Asked(val generation: String?, val revision: Long? = null)

    /**
     * The row as it stands, when it is still the one the request left: the same state and operation ID, and for a
     * `queued` row (a lookup, or the clock's `GET /` before a claim) the same reason and the workspace generation
     * [asked] that request went out under. With [Asked.revision], also the same cache revision, whatever the row's
     * state. Null when a restore, Start over, reset, park or the person changed it meanwhile: the late answer then
     * changes nothing, and a lookup of the row's own decides (§3.6, §3.8).
     */
    private fun WorkspaceStore.StoreTx.still(row: OutboxRow, asked: Asked? = null): OutboxRow? {
        val r = getOutbox(row.local) ?: return null
        if (r.state != row.state || r.operationId != row.operationId) return null
        if (r.state == QUEUED && (r.reason != row.reason || getWs(row.ws)?.generation != asked?.generation)) return null
        if (asked?.revision != null && revision(row.ws) != asked.revision) return null
        return r
    }

    /**
     * The server has the message: one transaction deletes the row, caches the event when it follows the cached range
     * directly, and raises the read positions to at least its seq, as the server did. Then [sent] hears it. Nothing
     * happens when the row isn't the one the request left any more ([still]).
     */
    private suspend fun delivered(row: OutboxRow, messageId: String, seq: Long, visible: Boolean, asked: Asked? = null) {
        val done = store.tx {
            if (still(row, asked) == null) return@tx false
            deleteOutbox(row.local)
            deleteMeta(limitKey(row.local))
            val room = getRoom(row.ws, row.room) ?: return@tx true
            if (room.hi != null && seq == room.hi + 1) {
                val at = now() + (getMeta(CLOCK_OFFSET)?.toLongOrNull() ?: 0L)
                appendEvents(
                    row.ws, row.room,
                    listOf(WireEvent(seq, messageId, WireEvent.MESSAGE_POSTED, row.actor, at, row.root, row.text, row.mentions, redacted = !visible)),
                )
            }
            val head = maxOf(room.head, seq)
            val readLocal = maxOf(room.readLocal, seq)
            val fields = mutableMapOf<String, Any?>(
                "head" to head,
                "read" to maxOf(room.read, seq),
                "readLocal" to readLocal,
                "readSent" to maxOf(room.readSent, seq),
            )
            if (readLocal >= head) {
                fields["unread"] = 0
                fields["mentions"] = 0
            }
            setRoomFields(row.ws, row.room, fields)
            true
        }
        if (done) _sent.tryEmit(Sent(row.ws, row.room, row.local, messageId, seq))
    }

    /** `held` or `failed` with [reason]; the operation ID stays. Only for the row the request left ([still]). */
    private suspend fun settle(row: OutboxRow, state: String, reason: String, asked: Asked? = null) {
        store.tx {
            if (still(row, asked) != null) {
                updateOutbox(row.local, mapOf("state" to state, "reason" to reason))
                deleteMeta(limitKey(row.local))
            }
        }
    }

    /**
     * Back to `queued` until [nextAt]; only for the row the request left ([still]). A [limited] wait is a `429`'s, kept
     * on disk so a wake or a restart doesn't send the row before its `Retry-After`.
     */
    private suspend fun requeue(row: OutboxRow, reason: String?, nextAt: Long, attempts: Int, asked: Asked? = null, limited: Boolean = false) {
        store.tx {
            if (still(row, asked) != null) {
                updateOutbox(row.local, mapOf("state" to QUEUED, "reason" to reason, "nextAt" to nextAt, "attempts" to attempts))
                if (limited) setMeta(limitKey(row.local), nextAt.toString()) else deleteMeta(limitKey(row.local))
            }
        }
    }

    /** An answer that names where the message landed as the feed would: an event ID and a seq from 1. */
    private fun acked(messageId: String, seq: Long): Boolean = WorkspaceIds.isEvent(messageId) && seq >= 1

    /** The wait after the [attempts]th failure in a row: 2, 5, 15, 30, 60 s, then 60 s each time. */
    private fun backoff(attempts: Int): Long = sendDelay(attempts, timing.sendBackoff)

    private fun validate(text: String, mentions: List<Mention>, root: String?) {
        if (text.isBlank()) throw WorkspaceError("invalid", field = "text", message = "A message needs text.")
        // A lone surrogate would go out as '?', one byte where the mentions counted three; desktop refuses it too.
        if (!Utf8Offsets.isWellFormed(text)) throw WorkspaceError("invalid", field = "text", message = "The message has a broken character.")
        if (Utf8Offsets.utf8Length(text) > TEXT_BYTES) throw WorkspaceError("invalid", field = "text", message = "The message is too long.")
        if (!Utf8Offsets.isValid(text, mentions)) throw WorkspaceError("invalid", field = "mentions")
        if (root != null && !WorkspaceIds.isEvent(root)) throw WorkspaceError("invalid", field = "root")
    }

    companion object {
        private const val TAG = "Outbox"

        const val QUEUED = "queued"
        const val SENDING = "sending"
        const val HELD = "held"
        const val FAILED = "failed"

        /** The reason of a queued row whose operation is looked up before anything else. */
        const val LOOKUP = "lookup"

        /** `meta` keys: server time minus local time in ms, and the local time it was measured. */
        const val CLOCK_OFFSET = "clockOffset"
        const val CLOCK_AT = "clockAt"

        /** The `meta` key prefix of a `429`'s hold on a row: until when, in local ms. */
        private const val LIMITED = "outboxLimited:"

        private fun limitKey(local: String) = LIMITED + local

        /** §3.19 `SEND_BACKOFF`. */
        val SEND_BACKOFF: List<Long> = listOf(2_000L, 5_000L, 15_000L, 30_000L, 60_000L)

        /** §3.19 `CLOCK_MAX_AGE`: 6 hours. */
        const val CLOCK_MAX_AGE = 6L * 60 * 60 * 1000

        private const val DUE_LIMIT = 64

        /** The 4xx answers an attempt waits out instead of settling: signed out, gone, timeout, update, rate limit. */
        private val RETRIED_4XX = setOf(401, 404, 408, 426, 429)

        private val random = SecureRandom()

        /** A row's local ID: 16 random bytes in base64url, the UI's handle (§3.5). */
        fun newLocal(): String = ByteArray(16).also(random::nextBytes).let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }

        /** The wait after the [attempts]th failure in a row, from [table], whose last step repeats. */
        fun sendDelay(attempts: Int, table: List<Long> = SEND_BACKOFF): Long = table[(attempts - 1).coerceIn(0, table.size - 1)]

        /**
         * Outbox rows as the UI shows them, oldest first. A `held` or `failed` row holds back the later rows of its
         * room, which show as [PendingState.WAITING] (§3.8).
         */
        fun pending(rows: List<OutboxRow>): List<Pending> {
            val stopped = HashSet<String>()
            return rows.sortedWith(compareBy({ it.createdAt }, { it.local })).map { r ->
                val key = "${r.ws}/${r.room}"
                val state = when {
                    key in stopped -> PendingState.WAITING
                    r.state == HELD -> PendingState.HELD
                    r.state == FAILED -> PendingState.FAILED
                    r.state == SENDING -> PendingState.SENDING
                    else -> PendingState.QUEUED
                }
                if (r.state == HELD || r.state == FAILED) stopped += key
                Pending(r.local, r.ws, r.room, r.root, r.text, r.mentions, state, r.reason, r.nextAt, r.createdAt)
            }
        }
    }
}
