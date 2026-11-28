package nl.bvdm.rukoo.workspaces

import java.io.File
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import nl.bvdm.rukoo.account.AccountError
import nl.bvdm.rukoo.account.AccountHttp
import nl.bvdm.rukoo.account.AccountStatus
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.JsonFiles
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.settings.AppSettings

/*
 * Push wakes for team chat (server/WORKSPACES.md "Push wakes", docs/android.md "Team chat in the background"). With a
 * push service, a UnifiedPush distributor app such as ntfy or the FCM distributor built into Rukoo, the server posts an
 * encrypted wake to the endpoint the distributor gave Rukoo whenever something comes that notifies, and Rukoo runs
 * ChatSyncWorker's catch-up at once instead of waiting for Android's next 15-minute window. Delivery is best effort:
 * ChatSyncWorker's periodic check stays the fallback.
 *
 * ChatPush keeps three things in step: the distributor Rukoo registered with (UnifiedPush.register, with the server's
 * VAPID key), the endpoint and keys the distributor gave, and the server's copy of them for this session (PUT
 * /v1/push-endpoint). PushPlan decides the steps from what is wanted and what was done, without Android, so it is
 * unit-tested; ChatPush runs them, and RukooPushService hands it what the distributor answers.
 */

/** The registration a distributor gave: its endpoint and the keys the server encrypts with, in base64url. */
@Serializable
data class PushEndpoint(val url: String, val p256dh: String, val auth: String) {
    /** The whole registration, address and keys, hashed: a registration made again with new keys is another. */
    val fingerprint: String
        get() {
            val digest = MessageDigest.getInstance("SHA-256").digest("$url\n$p256dh\n$auth".toByteArray())
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest.copyOf(16))
        }
}

/**
 * How team chat reaches this phone while Rukoo is in the background, for Settings > Notifications. A distributor is
 * named by its package.
 */
sealed interface ChatDelivery {
    /** Signed out, team chat notifications off, or no team chat: nothing to deliver. */
    data object Off : ChatDelivery

    /** The server sends no push wakes; ChatSyncWorker checks every 15 minutes or more. */
    data object ServerWithout : ChatDelivery

    /** No distributor on the phone; ChatSyncWorker checks every 15 minutes or more. */
    data object NoDistributor : ChatDelivery

    /** Registering with [distributor], or telling the server its endpoint. */
    data class Connecting(val distributor: String) : ChatDelivery

    /** Wakes come through [distributor]. */
    data class Instant(val distributor: String) : ChatDelivery

    /**
     * [distributor] couldn't register Rukoo, or the server refused its endpoint. [reason] is UnifiedPush's FailedReason
     * name (INTERNAL_ERROR, NETWORK, ACTION_REQUIRED, VAPID_REQUIRED), [PushPlan.UNAVAILABLE] while its server is down,
     * [PushPlan.NOT_ALLOWED] when the server doesn't post to that push service, or [PushPlan.REFUSED].
     */
    data class Failed(val distributor: String, val reason: String) : ChatDelivery
}

/** What Settings shows: the [delivery], and the distributors on the phone to choose from. */
data class PushState(val delivery: ChatDelivery = ChatDelivery.Off, val distributors: List<String> = emptyList())

/** What Settings and the app's lifecycle reach of ChatPush. */
interface ChatPushControl {
    val state: StateFlow<PushState>

    /**
     * Looks again, for a distributor installed or removed meanwhile. [force]: Rukoo came back to the foreground or the
     * network came back, which is when a registration that failed tries again without waiting out its backoff.
     */
    fun check(force: Boolean = false)

    /** The distributor to receive wakes through, when there are several. */
    fun choose(distributor: String)
}

/** The UnifiedPush distributors on the phone, and registering with one (UnifiedPushDistributors on Android). */
interface PushDistributors {
    /** This app's package: a distributor of that name is the one embedded in Rukoo. */
    val own: String

    /** The distributors installed, as package names. */
    fun installed(): List<String>

    /** Registers with [distributor], which unregisters from the one before; the answer comes to RukooPushService. */
    fun register(distributor: String, vapid: String)

    fun unregister()
}

/** The server's 400 for a registration: [key] is the session and fingerprint, [reason] REFUSED or NOT_ALLOWED. */
@Serializable
internal data class PushRefusal(val key: String, val reason: String, val distributor: String, val server: String, val at: Long)

/** A workspace a wake named: the [seq] of the last wake that named it, when it first did, and catch-ups that missed it. */
@Serializable
internal data class NamedWake(val seq: Long, val at: Long, val tries: Int = 0)

/**
 * Wakes not caught up with yet: [seq] counts every wake, [workspaces] are the ones they named, kept until a catch-up
 * has fetched them or [PushPlan.NAMED_TRIES] catch-ups or a day went by without.
 */
@Serializable
internal data class PendingWake(val seq: Long = 0, val workspaces: Map<String, NamedWake> = emptyMap())

/** What ChatPush keeps between runs (chat-push.json). */
@Serializable
internal data class PushRecord(
    /** The distributor picked in Settings, when there are several. */
    val preferred: String? = null,
    /** The distributor Rukoo registered with, and the VAPID key it gave. */
    val distributor: String? = null,
    val vapid: String? = null,
    /** The distributor's answer: an endpoint, and the failure it reported last, if any. */
    val endpoint: PushEndpoint? = null,
    val failure: String? = null,
    /** Registrations in a row that failed or got no answer, and when the last one was sent: the backoff. */
    val failures: Int = 0,
    val attemptAt: Long = 0,
    /** The session and registration the server took last ([PushPlan.key]), and when. */
    val sentFor: String? = null,
    val sentAt: Long = 0,
    /** The server's 400 for a registration, tried again when anything about it changes, or a day later. */
    val refused: PushRefusal? = null,
    /**
     * The session the server may hold an endpoint for: set before each PUT, since one whose answer got lost may have
     * committed, and cleared only by a DELETE the server confirmed or the end of that session.
     */
    val withdrawFor: String? = null,
    /** PUTs and DELETEs in a row that failed for a reason that passes, and when the next may go: Retry-After or the backoff. */
    val sendFailures: Int = 0,
    val retryAt: Long = 0,
    val wake: PendingWake = PendingWake(),
)

/** The steps from what is wanted to what was done, and what Settings says meanwhile. */
internal object PushPlan {
    /** How long the server's copy of a registration counts as current: once a day it is sent again, in case it got lost. */
    const val RESEND = 24 * 60 * 60 * 1000L

    /** How long a refusal (400) holds before the same registration is sent again. */
    const val RETRY_REFUSED = 24 * 60 * 60 * 1000L

    /** How long a distributor may take to answer a registration before it is sent again. */
    const val ANSWER_TIME = 60 * 1000L

    /** The longest backoff between registrations that fail. */
    const val BACKOFF_MAX = 60 * 60 * 1000L

    /** Returning to Rukoo or the network coming back tries a failed registration again, at most this often. */
    const val FORCE_GAP = 30 * 1000L

    /** Catch-ups a named workspace may miss before its hint goes, and the longest it is kept. */
    const val NAMED_TRIES = 3
    const val NAMED_AGE = 24 * 60 * 60 * 1000L

    /** A failure of the distributor's server, which it says with TEMP_UNAVAILABLE. */
    const val UNAVAILABLE = "TEMP_UNAVAILABLE"

    /** The server refused the endpoint as malformed (400 invalid). */
    const val REFUSED = "REFUSED"

    /** The server doesn't post to that push service (400 push_not_allowed). */
    const val NOT_ALLOWED = "NOT_ALLOWED"

    /** The capability `GET /v1/info` lists while the server sends push wakes, with `workspace.push.vapid`. */
    const val CAPABILITY = "push-wake"

    private val VAPID = Regex("^[A-Za-z0-9_-]{87}$")

    /**
     * [wanted]: signed in, the server has team chat and Team chat notifications are on. [vapid]: the server's key while
     * it sends push wakes. [session]: the session's tag. [installed]: the distributors on the phone, [own] this app's
     * package. [server]: the server's version, a new one of which may take what an older one refused. [attempted]: this
     * process sent a registration, which UnifiedPush asks for at each start; [confirmed]: the distributor answered it
     * with an endpoint. [force]: a moment to try a failed registration again now (ChatPushControl.check).
     */
    data class Inputs(
        val wanted: Boolean,
        val vapid: String?,
        val session: String?,
        val installed: List<String>,
        val own: String,
        val server: String = "",
        val attempted: Boolean = true,
        val confirmed: Boolean = true,
        val force: Boolean = false,
    )

    sealed interface Step {
        data class Register(val distributor: String, val vapid: String) : Step

        data object Unregister : Step

        data class Send(val session: String, val endpoint: PushEndpoint) : Step

        /** DELETE /v1/push-endpoint for the session that has it. */
        data object Withdraw : Step
    }

    /** The server's VAPID key while it offers push wakes, from its saved `GET /v1/info`, or null. */
    fun vapid(status: AccountStatus): String? {
        val info = status.info ?: return null
        val workspace = info.workspace ?: return null
        if (!info.teamChat || CAPABILITY !in workspace.capabilities) return null
        return workspace.push?.vapid?.takeIf { VAPID.matches(it) }
    }

    /** What the server's copy is known by: the session and the whole registration. */
    fun key(session: String, endpoint: PushEndpoint): String = "$session\n${endpoint.fingerprint}"

    /** The wait after [failures] registrations in a row failed: a minute, doubling, at most an hour. */
    fun backoff(failures: Int): Long = if (failures <= 0) ANSWER_TIME else minOf(ANSWER_TIME shl minOf(failures - 1, 6), BACKOFF_MAX)

    /**
     * The distributor to use: the one picked in Settings while installed; else an app the person installed for it, the
     * one registered with first, before the one embedded in Rukoo. So installing ntfy moves Rukoo off Google's FCM,
     * unless the person picked that in Settings.
     */
    fun pick(inputs: Inputs, record: PushRecord): String? {
        val installed = inputs.installed
        return record.preferred?.takeIf { it in installed }
            ?: record.distributor?.takeIf { it in installed && it != inputs.own }
            ?: installed.firstOrNull { it != inputs.own }
            ?: inputs.own.takeIf { it in installed }
    }

    /** Whether the server's refusal still holds for this registration: same session, keys, distributor and server, and less than a day old. */
    fun refusalHolds(inputs: Inputs, record: PushRecord, pick: String, key: String, now: Long): Boolean {
        val r = record.refused ?: return false
        return r.key == key && r.distributor == pick && r.server == inputs.server && now - r.at < RETRY_REFUSED
    }

    /** When a registration that hasn't been answered with an endpoint is due again. */
    fun registerDue(inputs: Inputs, record: PushRecord, now: Long): Boolean = when {
        inputs.confirmed -> false
        !inputs.attempted -> true
        now - record.attemptAt >= backoff(record.failures) -> true
        else -> inputs.force && record.failure != null && now - record.attemptAt >= FORCE_GAP
    }

    fun steps(inputs: Inputs, record: PushRecord, now: Long): List<Step> {
        val pick = if (inputs.wanted && inputs.vapid != null) pick(inputs, record) else null
        if (pick == null) {
            val steps = mutableListOf<Step>()
            if (record.distributor != null) steps += Step.Unregister
            if (withdrawDue(inputs, record) && now >= record.retryAt) steps += Step.Withdraw
            return steps
        }
        val vapid = inputs.vapid!!
        // A new distributor or key: register, and wait for its endpoint.
        if (pick != record.distributor || vapid != record.vapid) return listOf(Step.Register(pick, vapid))
        val steps = mutableListOf<Step>()
        if (registerDue(inputs, record, now)) steps += Step.Register(pick, vapid)
        val endpoint = record.endpoint ?: return steps
        val session = inputs.session ?: return steps
        val key = key(session, endpoint)
        val due = record.sentFor != key || now - record.sentAt >= RESEND
        if (due && now >= record.retryAt && !refusalHolds(inputs, record, pick, key, now)) steps += Step.Send(session, endpoint)
        return steps
    }

    /** Whether this session may hold an endpoint on the server that should go: one it took, or a PUT whose answer was lost. */
    fun withdrawDue(inputs: Inputs, record: PushRecord): Boolean {
        val session = inputs.session ?: return false
        return record.withdrawFor == session || record.sentFor?.startsWith("$session\n") == true
    }

    /**
     * When the retry job should run ChatPush again, or null for none: when a PUT or DELETE that failed may go again,
     * and when a registration waiting for the distributor's answer is due again.
     */
    fun nextRetry(inputs: Inputs, record: PushRecord, now: Long): Long? {
        val times = mutableListOf<Long>()
        if (record.retryAt > now) times += record.retryAt
        if (record.distributor != null && inputs.attempted && !inputs.confirmed) times += record.attemptAt + backoff(record.failures)
        return times.minOrNull()
    }

    fun delivery(inputs: Inputs, record: PushRecord, now: Long): ChatDelivery {
        if (!inputs.wanted) return ChatDelivery.Off
        if (inputs.vapid == null) return ChatDelivery.ServerWithout
        val pick = pick(inputs, record) ?: return ChatDelivery.NoDistributor
        if (pick != record.distributor || inputs.vapid != record.vapid) return ChatDelivery.Connecting(pick)
        record.failure?.let { return ChatDelivery.Failed(pick, it) }
        val endpoint = record.endpoint ?: return ChatDelivery.Connecting(pick)
        val session = inputs.session ?: return ChatDelivery.Connecting(pick)
        val key = key(session, endpoint)
        return when {
            refusalHolds(inputs, record, pick, key, now) -> ChatDelivery.Failed(pick, record.refused!!.reason)
            record.sentFor == key -> ChatDelivery.Instant(pick)
            else -> ChatDelivery.Connecting(pick)
        }
    }

    /**
     * The workspaces a decrypted wake names: `{"t":"wake","w":["w_…"]}`, at most ten valid workspace IDs. An older
     * server's `{"t":"wake"}`, and anything that isn't a wake, name none.
     */
    fun wakeWorkspaces(content: ByteArray): Set<String> = try {
        val obj = RukooJson.parseToJsonElement(content.decodeToString()) as? JsonObject
        val list = obj?.get("w") as? JsonArray
        list.orEmpty()
            .mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull }
            .filter { WorkspaceIds.WORKSPACE.matches(it) }
            .take(10)
            .toSet()
    } catch (e: Exception) {
        emptySet()
    }
}

/**
 * Runs [PushPlan] for the account and Team chat notifications as they are, one run at a time, and keeps its record in
 * [file]. [catchUp] starts ChatSyncWorker's catch-up: a push wake asks for it.
 */
internal class ChatPush(
    private val account: ChatAccount,
    private val settings: StateFlow<AppSettings>,
    private val distributors: PushDistributors,
    private val http: AccountHttp,
    private val file: File,
    private val scope: CoroutineScope,
    private val catchUp: () -> Unit,
    private val clock: Clock = Clock.System,
    /**
     * Runs ChatPush again after a wait in milliseconds, as unique work with a network (PushRetryWorker); null takes back
     * a retry that hasn't started.
     */
    private val retryLater: (Long?) -> Unit = {},
) : ChatPushControl {
    private val lock = Mutex()
    private var record: PushRecord = JsonFiles.read(file, PushRecord.serializer(), PushRecord(), clock)

    // This process sent a registration, and the distributor answered it with an endpoint.
    private var attempted = false
    private var confirmed = false

    // This process planned a retry that may still wait.
    private var retryPlanned = false
    private val _state = MutableStateFlow(PushState())
    override val state: StateFlow<PushState> = _state.asStateFlow()

    /**
     * Follows the account and the notifications switch for as long as [scope] lives. The end of a session takes along
     * what this phone knew of its endpoint on the server: the server removed it, or, after an offline sign-out, there is
     * no session left to remove it with.
     */
    fun start(): Job = scope.launch {
        launch {
            account.sessionEnded.collect {
                lock.withLock { update { it.copy(sentFor = null, sentAt = 0, withdrawFor = null, sendFailures = 0, retryAt = 0) } }
            }
        }
        combine(account.status, settings) { status, s -> Triple(status.signedIn, PushPlan.vapid(status), s.notifyChat) }
            .distinctUntilChanged()
            .collect { run() }
    }

    override fun check(force: Boolean) {
        scope.launch { run(force) }
    }

    override fun choose(distributor: String) {
        scope.launch {
            lock.withLock { update { it.copy(preferred = distributor) } }
            run()
        }
    }

    /**
     * Takes the plan's steps until it has none left. Each pass changes the record, so the passes end: a step that
     * fails stops the run, and the next check tries again. A registration waiting for its answer or its backoff is
     * tried again at the next check after that, which comes with the foreground, a network coming back, a process start
     * and every ChatSyncWorker run.
     */
    suspend fun run(force: Boolean = false) {
        lock.withLock {
            for (pass in 0 until 4) {
                val inputs = inputs(force && pass == 0)
                val steps = PushPlan.steps(inputs, record, clock.now())
                if (steps.isEmpty() || !steps.all { take(it) }) break
            }
            publish()
            val next = PushPlan.nextRetry(inputs(), record, clock.now())
            if (next != null) {
                retryLater((next - clock.now()).coerceAtLeast(0))
                retryPlanned = true
            } else if (retryPlanned) {
                retryLater(null)
                retryPlanned = false
            }
        }
    }

    private fun inputs(force: Boolean = false): PushPlan.Inputs {
        val status = account.status.value
        val session = if (status.signedIn) account.borrowSession() else null
        val installed = runCatching { distributors.installed() }.getOrElse {
            AppLog.w(TAG, "Could not list UnifiedPush distributors", it)
            emptyList()
        }
        return PushPlan.Inputs(
            wanted = session != null && status.info?.teamChat == true && settings.value.notifyChat,
            vapid = PushPlan.vapid(status),
            session = session?.tag,
            installed = installed,
            own = distributors.own,
            server = status.info?.version.orEmpty(),
            attempted = attempted,
            confirmed = confirmed,
            force = force,
        )
    }

    /** Runs one step; false when it failed and the run should stop. */
    private suspend fun take(step: PushPlan.Step): Boolean = when (step) {
        is PushPlan.Step.Register -> {
            val changed = step.distributor != record.distributor || step.vapid != record.vapid
            // A registration sent again without an answer to the last one counts toward the backoff.
            val unanswered = attempted && !confirmed && !changed && record.failure == null
            attempted = true
            confirmed = false
            val now = clock.now()
            try {
                distributors.register(step.distributor, step.vapid)
                update {
                    if (changed) {
                        it.copy(distributor = step.distributor, vapid = step.vapid, endpoint = null, failure = null, failures = 0, attemptAt = now)
                    } else {
                        it.copy(attemptAt = now, failures = it.failures + if (unanswered) 1 else 0)
                    }
                }
                true
            } catch (e: Exception) {
                AppLog.w(TAG, "Could not register with the UnifiedPush distributor", e)
                update {
                    val base = if (changed) it.copy(distributor = step.distributor, vapid = step.vapid, endpoint = null) else it
                    base.copy(failure = "INTERNAL_ERROR", failures = base.failures + 1, attemptAt = now)
                }
                false
            }
        }
        PushPlan.Step.Unregister -> {
            runCatching { distributors.unregister() }.onFailure { AppLog.w(TAG, "Could not unregister from the distributor", it) }
            attempted = false
            confirmed = false
            update { it.copy(distributor = null, vapid = null, endpoint = null, failure = null, failures = 0) }
            true
        }
        is PushPlan.Step.Send -> send(step)
        PushPlan.Step.Withdraw -> withdraw()
    }

    private suspend fun send(step: PushPlan.Step.Send): Boolean {
        val session = account.borrowSession()?.takeIf { it.tag == step.session } ?: return false
        val body = buildJsonObject {
            put("endpoint", JsonPrimitive(step.endpoint.url))
            put("p256dh", JsonPrimitive(step.endpoint.p256dh))
            put("auth", JsonPrimitive(step.endpoint.auth))
        }
        val key = PushPlan.key(step.session, step.endpoint)
        // From here the server may hold it, also when the answer gets lost.
        update { it.copy(withdrawFor = step.session) }
        return try {
            http.request(session.server, "PUT", ENDPOINT_PATH, body, session.token, null)
            update { it.copy(sentFor = key, sentAt = clock.now(), refused = null, sendFailures = 0, retryAt = 0) }
            true
        } catch (e: AccountError) {
            when {
                e.status == 401 -> account.sessionRefused(session)
                // A 400 is about this registration: kept until anything about it changes, or a day passed.
                e.status == 400 -> {
                    val reason = if (e.code == NOT_ALLOWED_CODE) PushPlan.NOT_ALLOWED else PushPlan.REFUSED
                    val server = account.status.value.info?.version.orEmpty()
                    update { it.copy(refused = PushRefusal(key, reason, record.distributor.orEmpty(), server, clock.now())) }
                }
                // 429, 503, no network and the like pass: the retry job tries again after Retry-After or the backoff.
                else -> {
                    AppLog.w(TAG, "The server didn't take the push endpoint now: ${e.code} (${e.status})")
                    failedForNow(e.retryAfter)
                }
            }
            false
        } catch (e: Exception) {
            AppLog.w(TAG, "Could not give the server the push endpoint", e)
            failedForNow(null)
            false
        }
    }

    /** A PUT or DELETE that may work later: the next goes after [retryAfter] seconds, or after the backoff. */
    private fun failedForNow(retryAfter: Long?) {
        val now = clock.now()
        update {
            val failures = it.sendFailures + 1
            it.copy(sendFailures = failures, retryAt = now + (retryAfter?.times(1000) ?: PushPlan.backoff(failures)))
        }
    }

    /**
     * DELETE /v1/push-endpoint. Until the server confirms it, the record keeps [PushRecord.sentFor], so every later run
     * tries again while the same session is signed in.
     */
    private suspend fun withdraw(): Boolean {
        val session = account.borrowSession()
        if (session != null) {
            try {
                http.request(session.server, "DELETE", ENDPOINT_PATH, null, session.token, null)
            } catch (e: AccountError) {
                // 401: the session is gone on the server, and its endpoint with it.
                if (e.status == 401) account.sessionRefused(session)
                else {
                    AppLog.w(TAG, "Could not take the push endpoint back: ${e.code} (${e.status})")
                    failedForNow(e.retryAfter)
                    return false
                }
            } catch (e: Exception) {
                AppLog.w(TAG, "Could not take the push endpoint back", e)
                failedForNow(null)
                return false
            }
        }
        update { it.copy(sentFor = null, sentAt = 0, withdrawFor = null, sendFailures = 0, retryAt = 0) }
        return true
    }

    // ---- What the distributor says (RukooPushService) ----

    fun newEndpoint(endpoint: PushEndpoint) {
        scope.launch {
            lock.withLock {
                confirmed = true
                attempted = true
                update { it.copy(endpoint = endpoint, failure = null, failures = 0) }
            }
            run()
        }
    }

    /**
     * The distributor couldn't register Rukoo. The endpoint it gave before stays, as it may still work; the
     * registration is tried again after the backoff, or sooner when Rukoo returns to the foreground or the network
     * comes back (check with force), as UnifiedPush's specification says for NETWORK and ACTION_REQUIRED.
     */
    fun registrationFailed(reason: String) {
        scope.launch {
            lock.withLock {
                confirmed = false
                update { it.copy(failure = reason, failures = it.failures + 1) }
                publish()
            }
        }
    }

    /** The distributor's server is down; the distributor sends a new endpoint once it is back. */
    fun unavailable() {
        scope.launch {
            lock.withLock {
                update { it.copy(failure = PushPlan.UNAVAILABLE) }
                publish()
            }
        }
    }

    /**
     * The distributor ended the registration, or was uninstalled. The server's copy goes, and the run after registers
     * again, with that distributor while it is still there.
     */
    fun unregistered() {
        scope.launch {
            lock.withLock {
                attempted = false
                confirmed = false
                update { it.copy(distributor = null, vapid = null, endpoint = null, failure = null, failures = 0) }
                val tag = account.borrowSession()?.tag
                if (tag != null && (record.withdrawFor == tag || record.sentFor?.startsWith("$tag\n") == true)) withdraw()
            }
            run()
        }
    }

    /**
     * A push wake, which named [workspaces]: they are kept for the catch-up to take first, the wake is counted, and the
     * catch-up starts. A catch-up already running sees the count change and runs once more ([catchUpRounds]).
     */
    fun message(workspaces: Set<String> = emptySet()) {
        scope.launch {
            lock.withLock {
                val now = clock.now()
                update { r ->
                    val seq = r.wake.seq + 1
                    // A workspace named again is a fresh hint: its misses start over, from when it was first named.
                    val named = r.wake.workspaces + workspaces.associateWith { id -> NamedWake(seq, r.wake.workspaces[id]?.at ?: now) }
                    val newest = named.entries.sortedByDescending { e -> e.value.seq }.take(MAX_PENDING)
                    r.copy(wake = PendingWake(seq, newest.associate { e -> e.key to e.value }))
                }
            }
            catchUp()
        }
    }

    /**
     * Runs [run] with the workspaces the wakes so far named, and again while wakes came in during it, at most [rounds]
     * times. ChatSyncWorker runs its catch-up through this, so a wake that comes while one runs is never lost and never
     * cancels it. [run] answers which of them it caught up with; the others stay for the next catch-ups, until
     * [PushPlan.NAMED_TRIES] missed them or a day went by, as when a workspace just joined isn't listed yet.
     */
    suspend fun catchUpRounds(rounds: Int = 3, run: suspend (Set<String>) -> Set<String>) {
        repeat(rounds) {
            val wake = lock.withLock { record.wake }
            val caught = run(wake.workspaces.keys)
            val more = lock.withLock {
                val now = clock.now()
                update { r ->
                    val kept = r.wake.workspaces.mapNotNull { (id, named) ->
                        when {
                            // Named again, or first, by a wake that came during the run: it waits for the next.
                            named.seq > wake.seq -> id to named
                            id in caught -> null
                            named.tries + 1 >= PushPlan.NAMED_TRIES || now - named.at >= PushPlan.NAMED_AGE -> null
                            else -> id to named.copy(tries = named.tries + 1)
                        }
                    }.toMap()
                    r.copy(wake = r.wake.copy(workspaces = kept))
                }
                record.wake.seq > wake.seq
            }
            if (!more) return
        }
    }

    private fun update(change: (PushRecord) -> PushRecord) {
        val next = change(record)
        if (next == record) return
        record = next
        try {
            JsonFiles.write(file, PushRecord.serializer(), next)
        } catch (e: Exception) {
            AppLog.w(TAG, "Could not save the push record", e)
        }
    }

    private fun publish() {
        val inputs = inputs()
        _state.value = PushState(PushPlan.delivery(inputs, record, clock.now()), inputs.installed)
    }

    companion object {
        private const val TAG = "ChatPush"
        const val ENDPOINT_PATH = "/v1/push-endpoint"
        const val FILE_NAME = "chat-push.json"

        /** The server's error code for an endpoint on a push service it doesn't post to. */
        const val NOT_ALLOWED_CODE = "push_not_allowed"

        /** Workspaces kept for the next catch-up, at most. */
        private const val MAX_PENDING = 50
    }
}
