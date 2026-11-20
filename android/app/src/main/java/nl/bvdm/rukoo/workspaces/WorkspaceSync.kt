package nl.bvdm.rukoo.workspaces

import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import nl.bvdm.rukoo.core.Clock

/** The shared numbers of contract §3.19 the feed, the history and reads use, in milliseconds where they are times. */
data class SyncTiming(
    /** `FEED_LIMIT`: rooms per `GET /changes` page. */
    val feedLimit: Int = 64,
    /** `PAGES_PER_RUN`: a run stops after this many pages and the next follows after [moreAfterMs]. */
    val pagesPerRun: Int = 50,
    /** `MIN_FETCH_GAP`: between the starts of two runs. */
    val minFetchGapMs: Long = 500,
    val moreAfterMs: Long = 1_000,
    /** `SYNC_BACKOFF`: after a run fails with network, a 5xx or a malformed answer; the last step repeats. */
    val syncBackoffMs: List<Long> = listOf(5_000, 15_000, 30_000, 60_000, 120_000),
    /** `EVENTS_NEWEST`: the newest page and older pages. */
    val eventsNewest: Int = 50,
    /** `EVENTS_PAGE`: forward pages and backfill. */
    val eventsPage: Int = 100,
    /** `FORWARD_GAP_MAX`: a room further behind than this reloads its newest page. */
    val forwardGapMax: Long = 300,
    /** `BACKFILL_PAGES`: pages back towards a seq or a thread's root per request. */
    val backfillPages: Int = 10,
    /** `ROOM_CACHE_MAX`. */
    val roomCacheMax: Int = WorkspaceStore.ROOM_CACHE_MAX,
    /** `READ_FLUSH`: at most one `POST /read` per room this often. */
    val readFlushMs: Long = 5_000,
    /** `TOMBSTONE_DAYS`. */
    val tombstoneMs: Long = WorkspaceStore.TOMBSTONE_MS,
)

/**
 * How one run of the feed ended. A run that got through has neither flag nor [error]. [more] means it stopped after
 * `PAGES_PER_RUN` pages and another follows; [skipped] that the workspace wasn't `ok` (or the sync closed);
 * [quarantined], [gone] and [upgrade] that the workspace stopped, went, or waits for a newer Rukoo.
 */
data class RunOutcome(
    val changed: Set<String> = emptySet(),
    val pass: Boolean = false,
    val more: Boolean = false,
    val skipped: Boolean = false,
    val quarantined: Boolean = false,
    val gone: Boolean = false,
    val upgrade: Boolean = false,
    val error: WorkspaceError? = null,
) {
    val ok: Boolean get() = error == null && !skipped && !quarantined && !gone && !upgrade
}

/** The runner as the UI shows it: a run in progress, and the §3.15 code of the last failed run, null after a good one. */
data class RunnerState(val running: Boolean = false, val error: String? = null, val failures: Int = 0)

/**
 * What the sync tells the service (A6), which closes sockets, takes alerts back, kicks the outbox and lists the
 * workspaces again. A failing hook doesn't stop the feed. The UI needs none of this: it reads the cache, whose
 * [ChatDb.changes] tell it what changed.
 */
interface SyncEvents {
    /** After each feed page's transaction, and after a 410's reset. */
    suspend fun page(ws: String, result: PageResult) {}

    /** At the end of a run that got through, after `syncedAt` was set: alerts, then the outbox (§3.6). */
    suspend fun ran(ws: String, outcome: RunOutcome) {}

    /** `GET /` found a new generation: unsent messages of the old one wait for a lookup. */
    suspend fun restored(ws: String) {}

    /** `409 history_regressed` stopped the workspace: close its socket. */
    suspend fun quarantined(ws: String) {}

    /** `426 upgrade_required` parked the workspace: close its socket. */
    suspend fun parked(ws: String) {}

    /** A `404` with `scope: workspace` deleted the workspace's row: close its socket, drop its alerts, list again. */
    suspend fun removed(ws: String) {}

    /** This phone read further in a room: take back alerts up to [readLocal]. */
    suspend fun read(ws: String, room: String, readLocal: Long) {}

    companion object {
        val None: SyncEvents = object : SyncEvents {}
    }
}

/**
 * One feed loop for one workspace (§3.6): single flight, runs at least `MIN_FETCH_GAP` apart. A [request] during a run
 * causes exactly one more run after it. A run that stopped after `PAGES_PER_RUN` pages is followed by another after a
 * second; a failed run by the `SYNC_BACKOFF` steps, a 429 by its `Retry-After`. A wake, focus, resume or the
 * person's own refresh resets the backoff; the catch-up timer passes `reset = false` and waits it out. A good run
 * schedules nothing: the service's timers and the socket ask for the next.
 */
class FeedRunner(
    private val scope: CoroutineScope,
    private val clock: Clock,
    private val timing: SyncTiming = SyncTiming(),
    private val work: suspend () -> RunOutcome,
) {
    private val lock = Any()
    private var running = false
    private var again = false
    private var timer: Job? = null
    private var due = 0L
    private var lastStart: Long? = null
    private var notBefore = 0L
    private var backoffUntil = 0L
    private var failures = 0
    private var stopped = false
    private val waiters = ArrayList<CompletableDeferred<RunOutcome>>()

    private val _state = MutableStateFlow(RunnerState())
    val state: StateFlow<RunnerState> = _state.asStateFlow()

    /** Asks for a run as soon as the gap allows; during a run, for one more after it. */
    fun request(reset: Boolean = true) {
        synchronized(lock) {
            if (reset) clearBackoff()
            schedule(0)
        }
    }

    /**
     * Asks for a run and waits for the first run that starts after this call, for pull-to-refresh and the worker. When
     * the run in progress ends the feed (quarantine, upgrade, a skip, an ending error), no run follows and this returns
     * that run's outcome.
     */
    suspend fun now(reset: Boolean = true): RunOutcome {
        val waiter = CompletableDeferred<RunOutcome>()
        synchronized(lock) {
            if (stopped) return RunOutcome(skipped = true)
            waiters += waiter
            if (reset) clearBackoff()
            schedule(0)
        }
        return waiter.await()
    }

    /** No more runs: a pending one is dropped and its waiters hear `skipped`. A run in progress finishes. */
    fun stop() {
        val left: List<CompletableDeferred<RunOutcome>>
        synchronized(lock) {
            stopped = true
            timer?.cancel()
            timer = null
            left = waiters.toList()
            waiters.clear()
        }
        for (w in left) w.complete(RunOutcome(skipped = true))
    }

    private fun clearBackoff() {
        failures = 0
        backoffUntil = 0
    }

    // Under lock. A run after delayMs, or sooner when one is due sooner already.
    private fun schedule(delayMs: Long) {
        if (stopped) return
        if (running) {
            if (delayMs == 0L) again = true
            return
        }
        val now = clock.now()
        val at = maxOf(now + delayMs, lastStart?.let { it + timing.minFetchGapMs } ?: now, notBefore, backoffUntil)
        val current = timer
        if (current != null && due <= at) return
        current?.cancel()
        due = at
        // Started only once it is the timer, so it finds itself there on any dispatcher.
        val job = scope.launch(start = CoroutineStart.LAZY) {
            val wait = at - clock.now()
            if (wait > 0) delay(wait)
            fire(coroutineContext.job)
        }
        timer = job
        job.start()
    }

    private suspend fun fire(job: Job) {
        val taken: List<CompletableDeferred<RunOutcome>>
        synchronized(lock) {
            if (timer !== job || stopped || running) return
            timer = null
            running = true
            again = false
            lastStart = clock.now()
            taken = waiters.toList()
            waiters.clear()
        }
        _state.update { it.copy(running = true) }
        val outcome = try {
            work()
        } catch (e: CancellationException) {
            // Only the scope's end cancels a run, and no run starts after it: every waiter hears skipped.
            val late = synchronized(lock) {
                running = false
                waiters.toList().also { waiters.clear() }
            }
            _state.update { it.copy(running = false) }
            for (w in taken + late) w.complete(RunOutcome(skipped = true))
            throw e
        } catch (e: WorkspaceError) {
            RunOutcome(error = e)
        } catch (e: Exception) {
            RunOutcome(error = WorkspaceError("server", message = e.message, cause = e))
        }
        val late: List<CompletableDeferred<RunOutcome>>
        synchronized(lock) {
            running = false
            val e = outcome.error
            val now = clock.now()
            when {
                e == null -> clearBackoff()
                e.code == "rate_limited" -> notBefore = now + (e.retryAfterS ?: 1) * 1000
                ends(e) -> Unit
                else -> {
                    failures += 1
                    val steps = timing.syncBackoffMs
                    backoffUntil = now + steps[minOf(failures - 1, steps.size - 1)]
                }
            }
            _state.value = RunnerState(running = false, error = e?.let { if (it.internal) "server" else it.code }, failures = failures)
            val halt = stopped || outcome.skipped || outcome.quarantined || outcome.gone || outcome.upgrade || (e != null && ends(e))
            if (halt) {
                // No run follows for the now() calls that came during this one: they hear why.
                late = waiters.toList()
                waiters.clear()
            } else {
                late = emptyList()
                when {
                    again -> schedule(0)
                    outcome.more -> schedule(timing.moreAfterMs)
                    e != null -> schedule(0)
                }
            }
        }
        for (w in taken + late) w.complete(outcome)
    }

    // Failures no timer fixes: the session ended, the workspace went or waits for a newer Rukoo.
    private fun ends(e: WorkspaceError) =
        e.code == "signed_out" || e.code == "upgrade_required" || e.code == "paused" || (e.code == "not_found" && e.scope == "workspace")
}

/**
 * The feed, the history and reads of one workspace (contract §3.6, §3.7, §3.9), for the workspace service (A6). It
 * reaches the network only through [WorkspaceClient] and SQLite only through [WorkspaceStore]; [FeedApplier] holds the
 * writes.
 *
 * - [runner] runs [runFeed], the feed loop, single flight.
 * - [loader] opens rooms, pages older history and backfills threads.
 * - [reads] keeps this phone's read positions and reports them.
 *
 * Every call that answers `404` with `scope: workspace` runs the removal path ([removed]); a `426` parks the
 * workspace. After [close] nothing more touches the cache: an answer that arrives later is dropped.
 */
class WorkspaceSync(
    val ws: String,
    val store: WorkspaceStore,
    private val client: WorkspaceClient,
    scope: CoroutineScope,
    val clock: Clock = Clock.System,
    internal val events: SyncEvents = SyncEvents.None,
    val timing: SyncTiming = SyncTiming(),
) {
    private val job = SupervisorJob(scope.coroutineContext[Job])
    internal val scope: CoroutineScope = CoroutineScope(scope.coroutineContext + job)

    val applier = FeedApplier(store, clock, timing)
    val runner = FeedRunner(this.scope, clock, timing) { runFeed() }
    val loader = RoomLoader(this)
    val reads = ReadFlusher(this)

    @Volatile private var detailsDue = false

    // Whether this sync cut every room but the open one back to ROOM_CACHE_MAX: once, at its first run.
    @Volatile private var trimmed = false

    @Volatile var closed = false
        private set

    /** The local time of the last request to this workspace that got an answer, for the socket's lease (§3.11). */
    @Volatile var lastOkAt: Long? = null
        private set

    /** A run as soon as the gap allows (a wake, focus, resume, a change the person made). */
    fun request(reset: Boolean = true) = runner.request(reset)

    /** A run, waited for. */
    suspend fun now(reset: Boolean = true): RunOutcome = runner.now(reset)

    /** Stops the runner, the read timers and every job of this sync. Later answers are dropped. */
    fun close() {
        if (closed) return
        closed = true
        runner.stop()
        reads.stop()
        job.cancel()
    }

    /**
     * Start over (§3.6, `reload`): back to `ok` with a pass from the start, the cached events and notice rows dropped
     * and every unsent message marked for a lookup, all in one transaction; the alerts hear it as a reset. Then a run
     * that loads `GET /` first, and whose end loads the open room again.
     */
    suspend fun reload() {
        val result = applier.startOver(ws)
        loader.onReset()
        hook { events.page(ws, result.dropped) }
        detailsDue = true
        runner.request()
    }

    /**
     * `GET /`: name, role, generation, key, limits, retention and the clock. A new generation runs the restore path
     * (§3.6), a new key a pass; before either, the cached events and alerts go. Outside a run ([inRun] false) a new key asks
     * for a run, so the pass and the open room's reload don't wait for the catch-up timer.
     */
    suspend fun details(inRun: Boolean = false): WorkspaceDetails {
        val t0 = clock.now()
        val answer = call { get(ws) }
        val t1 = clock.now()
        FeedApplier.check(answer, ws)
        val result = applier.restore(ws, answer, t0, t1)
        guard()
        if (result.restored || result.keyChanged) loader.onReset()
        result.dropped?.let { hook { events.page(ws, it) } }
        if (result.restored) hook { events.restored(ws) }
        if (result.keyChanged && !inRun) runner.request()
        return answer
    }

    /**
     * One run (§3.6 "A run"): `GET /` when the generation isn't known, then `GET /changes` page by page, each applied
     * in one transaction with its cursor; then the stale directories, due reads, the open room's catch-up, `syncedAt`
     * and the service's hooks. Throws [WorkspaceError] for the runner's backoff.
     */
    suspend fun runFeed(): RunOutcome = try {
        runInner()
    } catch (e: WorkspaceError) {
        when {
            e.code == "not_found" && e.scope == "workspace" -> RunOutcome(gone = true)
            e.code == "upgrade_required" -> RunOutcome(upgrade = true)
            else -> throw e
        }
    }

    private suspend fun runInner(): RunOutcome {
        var row = store.read { getWs(ws) } ?: return RunOutcome(skipped = true)
        if (closed) return RunOutcome(skipped = true)
        // Before any request, so a start without a network trims too.
        if (!trimmed) trimmed = loader.trimIdle()
        if (row.state != FeedApplier.STATE_OK) return RunOutcome(skipped = true)
        if (row.generation == null || detailsDue) {
            detailsDue = false
            try {
                details(inRun = true)
            } catch (e: WorkspaceError) {
                detailsDue = true
                throw e
            }
        }
        val changed = LinkedHashSet<String>()
        var installed = false
        var resets = 0
        var pages = 0
        while (true) {
            row = store.read { getWs(ws) } ?: return RunOutcome(changed = changed, gone = true)
            if (row.state != FeedApplier.STATE_OK) return RunOutcome(changed = changed, skipped = true)
            if (pages >= timing.pagesPerRun) return RunOutcome(changed = changed, pass = installed, more = true)
            val sent = row.cursor
            val active = if (row.passing) null else loader.activeQuery()
            val page = try {
                call { changes(ws, after = sent, limit = timing.feedLimit, active = active?.room, roomAfter = active?.after) }
            } catch (e: WorkspaceError) {
                when (e.code) {
                    "reset_required" -> {
                        if (resets++ > 0) throw WorkspaceError("server", 410, message = "The feed asked for a second reset in one run.")
                        val result = applier.reset(ws)
                        guard()
                        loader.onReset()
                        changed += result.changed
                        hook { events.page(ws, result) }
                        details(inRun = true)
                        continue
                    }
                    "history_regressed" -> {
                        applier.quarantine(ws)
                        guard()
                        loader.onReset()
                        hook { events.quarantined(ws) }
                        return RunOutcome(changed = changed, quarantined = true)
                    }
                    else -> throw e
                }
            }
            FeedApplier.check(page)
            pages += 1
            // Null when the cursor moved meanwhile (Start over, a restore): the loop starts from the new one.
            val result = applier.apply(ws, page, sent, active?.room) ?: continue
            guard()
            changed += result.changed
            if (result.pass) installed = true
            if (result.evicted.isNotEmpty()) loader.onEvicted(result.evicted)
            if (result.cacheDropped.isNotEmpty()) loader.onCacheDropped(result.cacheDropped)
            hook { events.page(ws, result) }
            if (!page.more) break
        }
        directory()
        reads.flushDue()
        loader.afterRun()
        guard()
        store.tx { updateWs(ws, mapOf("syncedAt" to clock.now())) }
        val outcome = RunOutcome(changed = changed, pass = installed)
        hook { events.ran(ws, outcome) }
        return outcome
    }

    /**
     * The directories the feed marked stale (§3.6 "Directory"): `GET /members`, `GET /channels` (full members only:
     * a guest has none), `GET /blocks`. Each answer replaces the workspace's rows in one transaction and clears its
     * flag; a failure leaves the flag for the next run. A server from before blocks (`404` without a scope) has none.
     * Each flag reads the row afresh, as the desktop does: the members reload can change my role and mark the
     * channels stale, and the channels load must follow the role it just wrote. Returns whether anything was replaced.
     */
    suspend fun directory(): Boolean {
        var changed = false
        if (store.read { getWs(ws) }?.membersStale == true) {
            changed = load {
                val page = call { members(ws) }
                store.tx { if (getWs(ws) != null) replaceMembers(ws, page.members, page.more) }
            } || changed
        }
        val row = store.read { getWs(ws) } ?: return changed
        if (row.channelsStale) {
            changed = load {
                val list = if (row.role == "guest") emptyList() else call { channels(ws) }
                store.tx { if (getWs(ws) != null) replaceChannels(ws, list) }
            } || changed
        }
        if (store.read { getWs(ws) }?.blocksStale == true) {
            changed = load {
                val list = try {
                    call { blocks(ws) }
                } catch (e: WorkspaceError) {
                    if (e.code == "not_found" && e.scope == null) emptyList() else throw e
                }
                store.tx { if (getWs(ws) != null) replaceBlocks(ws, list) }
            } || changed
        }
        return changed
    }

    private suspend fun load(block: suspend () -> Unit): Boolean = try {
        block()
        true
    } catch (e: WorkspaceError) {
        if (e.code == "signed_out" || e.code == "upgrade_required" || (e.code == "not_found" && e.scope == "workspace")) throw e
        false
    }

    /**
     * The removal path (§3.6): the workspace row goes with everything under it, the runner and read timers stop, and
     * the service hears [SyncEvents.removed], where it may [close] this sync. The service also sends its own calls'
     * `404 scope: workspace` here.
     */
    suspend fun removed() {
        val gone = applier.removeWorkspace(ws)
        runner.stop()
        reads.stop()
        loader.onGone()
        if (!gone) return
        try {
            events.removed(ws)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The service's concern; the row is gone either way.
        }
    }

    /**
     * A request to this workspace through [client]. A `404` with `scope: workspace` runs the removal path and a `426`
     * parks the workspace before the error goes on. An answer that arrives after [close] is dropped.
     */
    internal suspend fun <T> call(block: suspend WorkspaceClient.() -> T): T {
        guard()
        val value = try {
            client.block()
        } catch (e: WorkspaceError) {
            guard()
            when {
                e.code == "not_found" && e.scope == "workspace" -> removed()
                e.code == "upgrade_required" -> if (applier.park(ws)) hook { events.parked(ws) }
            }
            throw e
        }
        guard()
        lastOkAt = clock.now()
        return value
    }

    internal fun guard() {
        if (closed) throw CancellationException("This workspace's sync was closed.")
    }

    // Another module's hook. Its failure doesn't stop the feed.
    internal suspend fun hook(block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The hook's own concern; the cache is already right.
        }
        guard()
    }

    /** A paused or parked workspace makes no history requests: `paused` and `upgrade_required` say why. */
    internal suspend fun requireUsable() {
        val row = store.read { getWs(ws) } ?: throw WorkspaceError("not_found", scope = "workspace")
        when (row.state) {
            FeedApplier.STATE_QUARANTINED -> throw WorkspaceError("paused")
            FeedApplier.STATE_UPGRADE -> throw WorkspaceError("upgrade_required", 426)
        }
    }

    internal suspend fun usable(): Boolean = store.read { getWs(ws)?.state == FeedApplier.STATE_OK }
}

/** The open room's part of a `/changes` query outside a pass: `active` and, when it is cached, `roomAfter`. */
data class ActiveQuery(val room: String, val after: Long?)

/**
 * What the loader knows of a room on screen, beyond the cache: the read position when it opened (for the New
 * divider, kept until the person leaves the room or its cache is dropped), whether a load runs, whether an open at a
 * seq got there, and whether an older page found nothing more.
 */
data class RoomLoad(
    val readAtOpen: Long = 0,
    val loading: Boolean = false,
    val complete: Boolean = true,
    val olderDone: Boolean = false,
    /** The §3.15 code of the last failed load, or null. */
    val error: String? = null,
)

data class ThreadKey(val room: String, val root: String)

/** A thread's backfill: [complete] false when the pages ran out before the root, [expired] when the root is gone with retention. */
data class ThreadLoad(val loading: Boolean = false, val complete: Boolean = true, val expired: Boolean = false, val error: String? = null)

/**
 * Room history (§3.7). Each room caches one contiguous range `[lo, hi]`, and an open room's range ends at `head` once
 * it has loaded, which makes the reply counts of every root it shows complete.
 *
 * - [open]: no cache loads the newest page; a little behind pages forward; far behind drops the range and loads the
 *   newest page. With `at`, it then pages back until the range reaches that seq, at most `BACKFILL_PAGES`.
 * - [older]: one page before `lo`, until the floor.
 * - [ensureThread] and [loadThread]: back towards a thread's root, `BACKFILL_PAGES` at a time.
 *
 * Every page goes through [FeedApplier.applyHistory], which discards a page whose request started under another grant
 * and keeps a removed message removed. The open room's range only grows while it is open. It goes back to
 * `ROOM_CACHE_MAX` when the room leaves the screen: on [close], when [open] switches to another room, and, for a room
 * that was open when the process died, at the first run of the next sync ([trimIdle]). One load runs at a time per
 * workspace.
 */
class RoomLoader internal constructor(private val sync: WorkspaceSync) {
    private val ws get() = sync.ws
    private val store get() = sync.store
    private val timing get() = sync.timing
    private val mutex = Mutex()

    /** The room on screen, whose new events the feed asks for inline. */
    @Volatile var openRoom: String? = null
        private set

    private val _rooms = MutableStateFlow<Map<String, RoomLoad>>(emptyMap())
    val rooms: StateFlow<Map<String, RoomLoad>> = _rooms.asStateFlow()

    private val _threads = MutableStateFlow<Map<ThreadKey, ThreadLoad>>(emptyMap())
    val threads: StateFlow<Map<ThreadKey, ThreadLoad>> = _threads.asStateFlow()

    /** Whether older messages can still load: the range stops above the floor and no older page came back empty. */
    fun hasOlder(row: RoomRow): Boolean = row.lo != null && row.lo > row.floor && _rooms.value[row.id]?.olderDone != true

    /** The open room for the next `/changes` request, or null. */
    suspend fun activeQuery(): ActiveQuery? {
        val room = openRoom ?: return null
        val row = store.read { getRoom(ws, room) } ?: return null
        return ActiveQuery(room, row.hi)
    }

    /**
     * Opens [room]: the cache answers at once (the UI reads it), and this catches the range up to `head`. With [at],
     * it then pages back until the range reaches that seq; after `BACKFILL_PAGES` pages without it, [RoomLoad.complete]
     * is false and the room shows from its oldest loaded event. A failed load is kept in [RoomLoad.error]: the
     * cache still answers, and the next run catches up. Opening another room than the open one closes that one.
     */
    suspend fun open(room: String, at: Long? = null) {
        val row = store.read { getRoom(ws, room) } ?: return
        val previous = openRoom
        val again = previous == room
        openRoom = room
        _rooms.update { m ->
            val before = m[room]
            m + (room to ((if (again && before != null) before else RoomLoad(readAtOpen = row.readLocal)).copy(loading = true, error = null)))
        }
        try {
            // The UI may switch rooms without closing the last one.
            if (previous != null && !again) close(previous)
            if (!sync.usable()) return
            mutex.withLock {
                catchUp(room)
                if (at != null) reach(room, at)
            }
        } catch (e: WorkspaceError) {
            failed(room, e)
        } finally {
            _rooms.update { m -> m[room]?.let { m + (room to it.copy(loading = false)) } ?: m }
        }
    }

    /** The room left the screen: the feed stops asking for it, the New divider resets, and the range is cut back. */
    suspend fun close(room: String) {
        if (openRoom == room) openRoom = null
        _rooms.update { it - room }
        _threads.update { m -> m.filterKeys { it.room != room } }
        mutex.withLock {
            try {
                store.tx { trimRoom(ws, room, timing.roomCacheMax) }
            } catch (e: WorkspaceError) {
                // The cache is closed or the disk is full; the next close or append cuts it.
            }
        }
    }

    /**
     * Cuts every room but the open one back to `ROOM_CACHE_MAX`, in one transaction. A process Android ended never ran
     * [close], so the room open then may still hold more. Returns false when the cache refused, for another try.
     */
    internal suspend fun trimIdle(): Boolean {
        val cut = try {
            mutex.withLock {
                store.tx {
                    val open = openRoom
                    listRooms(ws).filter { it.id != open && trimRoom(ws, it.id, timing.roomCacheMax) > 0 }.map { it.id }
                }
            }
        } catch (e: WorkspaceError) {
            return false
        }
        // A cut range may have more above the floor again.
        if (cut.isNotEmpty()) _rooms.update { m -> m.mapValues { (id, load) -> if (id in cut) load.copy(olderDone = false) else load } }
        return true
    }

    /**
     * Loads one older page before `lo` (§3.7 "Older messages"). [hasOlder] turns false when the page's first seq is at
     * or below the floor, or the page is empty. Throws for the UI.
     */
    suspend fun older(room: String) {
        sync.requireUsable()
        setLoading(room, true)
        try {
            mutex.withLock {
                val row = store.read { getRoom(ws, room) } ?: throw WorkspaceError("not_found", scope = "conversation")
                if (row.lo == null) {
                    catchUp(room)
                    return
                }
                if (row.lo <= row.floor) {
                    olderDone(room)
                    return
                }
                val page = backward(room, row, timing.eventsNewest) ?: return
                val first = page.events.firstOrNull()?.seq
                if (first == null || first <= maxOf(row.floor, page.floor) || !page.more) olderDone(room)
            }
        } catch (e: WorkspaceError) {
            failed(room, e)
            throw e
        } finally {
            setLoading(room, false)
        }
    }

    /**
     * Makes sure a thread's root is in the cache, paging back from `lo` at most `BACKFILL_PAGES` (§3.7 "Threads").
     * Replies come from the cache. A failure is kept in [ThreadLoad.error].
     */
    suspend fun ensureThread(room: String, root: String) {
        try {
            backfillThread(room, root)
        } catch (e: WorkspaceError) {
            // Kept in the thread's state.
        }
    }

    /** Load earlier: `BACKFILL_PAGES` more pages towards the root. Throws for the UI. */
    suspend fun loadThread(room: String, root: String) {
        sync.requireUsable()
        backfillThread(room, root)
    }

    private suspend fun backfillThread(room: String, root: String) {
        val key = ThreadKey(room, root)
        _threads.update { m -> m + (key to (m[key] ?: ThreadLoad()).copy(loading = true, error = null)) }
        var state = ThreadLoad()
        try {
            if (!sync.usable()) {
                state = ThreadLoad(complete = hasRoot(room, root))
                return
            }
            mutex.withLock {
                if (hasRoot(room, root)) return
                var row = store.read { getRoom(ws, room) } ?: throw WorkspaceError("not_found", scope = "conversation")
                if (row.lo == null) catchUp(room)
                var pages = 0
                while (!hasRoot(room, root)) {
                    row = store.read { getRoom(ws, room) } ?: return
                    val lo = row.lo
                    if (lo == null || lo <= row.floor) {
                        state = ThreadLoad(expired = true)
                        return
                    }
                    if (pages >= timing.backfillPages) {
                        state = ThreadLoad(complete = false)
                        return
                    }
                    val page = backward(room, row, timing.eventsPage) ?: return
                    pages += 1
                    if (page.events.isEmpty()) {
                        state = ThreadLoad(expired = true)
                        return
                    }
                }
            }
        } catch (e: WorkspaceError) {
            state = ThreadLoad(complete = hasRoot(room, root), error = if (e.internal) "server" else e.code)
            throw e
        } finally {
            _threads.update { m -> m + (key to state.copy(loading = false)) }
        }
    }

    private suspend fun hasRoot(room: String, root: String): Boolean = store.read { roomOfEvent(ws, root) == room }

    /** After a run: the open room catches up to its head. A failure waits for the next run. */
    internal suspend fun afterRun() {
        val room = openRoom ?: return
        if (!sync.usable()) return
        try {
            mutex.withLock { catchUp(room) }
        } catch (e: WorkspaceError) {
            failed(room, e)
        }
    }

    /** The workspace's cached events went (a reset, a restore, quarantine, Start over): what the loader knew is stale. */
    internal fun onReset() {
        _rooms.update { m -> m.mapValues { it.value.copy(complete = true, olderDone = false) } }
        _threads.value = emptyMap()
    }

    /**
     * These rooms' cached events went whole: a new grant (the person left and joined again) or `removedMore`. What the
     * loader knew of them belongs to the old range: a room on screen starts over as if just opened, with its read
     * position from the new row, and the end of the run catches the open room up again.
     */
    internal suspend fun onCacheDropped(rooms: Collection<String>) {
        val ids = rooms.toSet()
        val rows = store.read { ids.mapNotNull { getRoom(ws, it) } }.associateBy { it.id }
        _rooms.update { m ->
            m.mapValues { (id, load) ->
                val row = rows[id] ?: return@mapValues load
                load.copy(readAtOpen = row.readLocal, complete = true, olderDone = false)
            }
        }
        _threads.update { m -> m.filterKeys { it.room !in ids } }
    }

    internal fun onEvicted(rooms: Collection<String>) {
        if (openRoom in rooms) openRoom = null
        _rooms.update { it - rooms.toSet() }
        _threads.update { m -> m.filterKeys { it.room !in rooms } }
    }

    internal fun onGone() {
        openRoom = null
        _rooms.value = emptyMap()
        _threads.value = emptyMap()
    }

    // ---- paging ----

    // Brings the range up to head: the newest page when there is no cache or it is further behind than
    // FORWARD_GAP_MAX, else forward pages.
    private suspend fun catchUp(room: String) {
        repeat(CATCH_UP_PAGES) {
            val row = store.read { getRoom(ws, room) } ?: return
            val hi = row.hi
            when {
                hi == null || row.lo == null -> {
                    if (row.head < 1) return
                    val page = page(room, row, HistoryMode.NEWEST) ?: return
                    if (page.events.isEmpty()) return
                }
                hi >= row.head -> return
                row.head - hi > timing.forwardGapMax -> {
                    val page = page(room, row, HistoryMode.NEWEST) ?: return
                    if (page.events.isEmpty()) return
                }
                else -> {
                    val page = page(room, row, HistoryMode.FORWARD) ?: return
                    if (page.events.none { it.seq > hi }) return
                }
            }
        }
    }

    // Back from lo until it reaches at or the floor, at most BACKFILL_PAGES.
    private suspend fun reach(room: String, at: Long) {
        var pages = 0
        var complete = true
        while (true) {
            val row = store.read { getRoom(ws, room) } ?: break
            val lo = row.lo ?: break
            if (lo <= at || lo <= row.floor) break
            if (pages >= timing.backfillPages) {
                complete = false
                break
            }
            val page = backward(room, row, timing.eventsPage) ?: break
            pages += 1
            if (page.events.isEmpty()) {
                olderDone(room)
                break
            }
        }
        _rooms.update { m -> m[room]?.let { m + (room to it.copy(complete = complete)) } ?: m }
    }

    private suspend fun backward(room: String, row: RoomRow, limit: Int): EventPage? = page(room, row, HistoryMode.BACKWARD, limit)

    // One events page and its transaction. Null when the page was discarded: another grant, or a range that moved.
    private suspend fun page(room: String, row: RoomRow, mode: HistoryMode, limit: Int = 0): EventPage? {
        val page = try {
            sync.call {
                when (mode) {
                    HistoryMode.NEWEST -> events(ws, room, before = row.head + 1, limit = timing.eventsNewest)
                    HistoryMode.FORWARD -> events(ws, room, after = row.hi, limit = timing.eventsPage)
                    HistoryMode.BACKWARD -> events(ws, room, before = row.lo, limit = limit)
                }
            }
        } catch (e: WorkspaceError) {
            // The room went: the feed's eviction deletes it.
            if (e.code == "not_found" && e.scope == "conversation") sync.request()
            throw e
        }
        FeedApplier.check(page)
        val max = if (room == openRoom) Int.MAX_VALUE else timing.roomCacheMax
        sync.applier.applyHistory(ws, room, row.grantId, page, mode, max) ?: return null
        sync.guard()
        return page
    }

    private fun olderDone(room: String) {
        _rooms.update { m -> m + (room to (m[room] ?: RoomLoad()).copy(olderDone = true)) }
    }

    private fun setLoading(room: String, loading: Boolean) {
        _rooms.update { m -> m + (room to (m[room] ?: RoomLoad()).copy(loading = loading)) }
    }

    private fun failed(room: String, e: WorkspaceError) {
        if (e.code == "signed_out") return
        _rooms.update { m -> m + (room to (m[room] ?: RoomLoad()).copy(error = if (e.internal) "server" else e.code)) }
    }

    private companion object {
        // Forward pages in one catch-up: FORWARD_GAP_MAX / EVENTS_PAGE and a few for what arrives meanwhile. The next
        // run continues where this stops.
        const val CATCH_UP_PAGES = 10
    }
}

/**
 * This phone's read positions (§3.9). [mark] raises `readLocal` on disk and recounts the badges at once; the server
 * hears `POST /read { seq: readLocal }` at most once per `READ_FLUSH` per room: at once when the room's last report
 * started that long ago, else from one timer per room. A failed report waits for the end of the next run, which
 * reports every room with `readLocal > readSent`. A quit loses nothing: `readLocal` is on disk.
 */
class ReadFlusher internal constructor(private val sync: WorkspaceSync) {
    private val ws get() = sync.ws
    private val store get() = sync.store
    private val lock = Any()
    private val lastPost = HashMap<String, Long>()
    private val timers = HashMap<String, Job>()
    private val inFlight = HashSet<String>()
    private var stopped = false

    /** [mark] without waiting, for the UI's reports. */
    fun markRead(room: String, seq: Long) {
        sync.scope.launch {
            try {
                mark(room, seq)
            } catch (e: WorkspaceError) {
                // Not on disk: the next report covers it.
            }
        }
    }

    /**
     * Reads [room] up to [seq], capped at `head`. A position at or below `readLocal` changes nothing, so it never goes
     * back. Returns whether it rose.
     */
    suspend fun mark(room: String, seq: Long): Boolean {
        val raised = store.tx {
            val r = getRoom(ws, room) ?: return@tx null
            val s = minOf(seq, r.head)
            if (s <= r.readLocal) return@tx null
            setRoomFields(ws, room, mapOf("readLocal" to s))
            recount(ws, room)
            s
        } ?: return false
        sync.hook { sync.events.read(ws, room, raised) }
        schedule(room)
        return true
    }

    /** Mark as read: everything up to the room's head. */
    suspend fun markAll(room: String): Boolean = mark(room, Long.MAX_VALUE)

    /** At the end of a run: reports every room read further than the server confirmed, each within its gap. */
    internal suspend fun flushDue() {
        val rooms = store.read {
            if (getWs(ws)?.state != FeedApplier.STATE_OK) emptyList() else listRooms(ws).filter { it.readLocal > it.readSent }.map { it.id }
        }
        for (room in rooms) {
            try {
                flush(room)
            } catch (e: WorkspaceError) {
                if (e.code == "signed_out" || (e.code == "not_found" && e.scope == "workspace")) throw e
            }
        }
    }

    internal fun stop() {
        synchronized(lock) {
            stopped = true
            for (t in timers.values) t.cancel()
            timers.clear()
        }
    }

    private fun schedule(room: String) {
        synchronized(lock) {
            if (stopped || room in inFlight || timers[room]?.isActive == true) return
            val wait = (lastPost[room]?.plus(sync.timing.readFlushMs) ?: 0L) - sync.clock.now()
            timers[room] = sync.scope.launch {
                if (wait > 0) delay(wait)
                synchronized(lock) { timers.remove(room) }
                try {
                    flush(room)
                } catch (e: WorkspaceError) {
                    // The end of the next run tries again.
                }
            }
        }
    }

    // One POST /read for the room when its gap has passed; else a timer for when it has.
    private suspend fun flush(room: String): Boolean {
        val row = store.read { if (getWs(ws)?.state == FeedApplier.STATE_OK) getRoom(ws, room) else null } ?: return false
        if (row.readLocal <= row.readSent) return false
        synchronized(lock) {
            if (stopped || room in inFlight) return false
            val last = lastPost[room]
            if (last != null && sync.clock.now() - last < sync.timing.readFlushMs) {
                schedule(room)
                return false
            }
            inFlight += room
            lastPost[room] = sync.clock.now()
        }
        try {
            val ack = sync.call { read(ws, room, row.readLocal) }
            store.tx {
                val r = getRoom(ws, room) ?: return@tx
                setRoomFields(ws, room, mapOf("readSent" to maxOf(r.readSent, ack.read), "read" to maxOf(r.read, ack.read)))
                recount(ws, room)
            }
        } finally {
            synchronized(lock) { inFlight -= room }
        }
        // Read further while the report was on its way: the next report waits out the gap.
        val after = store.read { getRoom(ws, room) }
        if (after != null && after.readLocal > after.readSent) schedule(room)
        return true
    }
}
