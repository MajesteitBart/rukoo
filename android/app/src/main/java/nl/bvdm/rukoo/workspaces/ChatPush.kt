package nl.bvdm.rukoo.workspaces

import java.io.File
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
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import nl.bvdm.rukoo.account.AccountError
import nl.bvdm.rukoo.account.AccountHttp
import nl.bvdm.rukoo.account.AccountStatus
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.JsonFiles
import nl.bvdm.rukoo.settings.AppSettings

/*
 * Push wakes for team chat (server/WORKSPACES.md "Push wakes", docs/android.md "Team chat in the background"). With a
 * UnifiedPush distributor on the phone, such as ntfy, the server posts an encrypted wake to the endpoint the
 * distributor gave Rukoo whenever something comes that notifies, and Rukoo runs ChatSyncWorker's catch-up at once
 * instead of waiting for Android's next 15-minute window. Without a distributor, or with a server that sends no wakes,
 * ChatSyncWorker's periodic check is the only way, and it stays the fallback either way.
 *
 * ChatPush keeps three things in step: the distributor Rukoo registered with (UnifiedPush.register, with the server's
 * VAPID key), the endpoint the distributor gave, and the server's copy of that endpoint for this session (PUT
 * /v1/push-endpoint). PushPlan decides the steps from what is wanted and what was done, without Android, so it is
 * unit-tested; ChatPush runs them, and RukooPushService hands it what the distributor answers.
 */

/** The registration a distributor gave: its endpoint and the keys the server encrypts with, in base64url. */
@Serializable
data class PushEndpoint(val url: String, val p256dh: String, val auth: String)

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
     * or [PushPlan.REFUSED].
     */
    data class Failed(val distributor: String, val reason: String) : ChatDelivery
}

/** What Settings shows: the [delivery], and the distributors on the phone to choose from. */
data class PushState(val delivery: ChatDelivery = ChatDelivery.Off, val distributors: List<String> = emptyList())

/** What Settings reaches of ChatPush. */
interface ChatPushControl {
    val state: StateFlow<PushState>

    /** Looks again, for a distributor installed or removed meanwhile. */
    fun check()

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

/** What ChatPush keeps between runs (chat-push.json). */
@Serializable
internal data class PushRecord(
    /** The distributor picked in Settings, when there are several. */
    val preferred: String? = null,
    /** The distributor Rukoo registered with, and the VAPID key it gave. */
    val distributor: String? = null,
    val vapid: String? = null,
    /** The distributor's answer: an endpoint, or a failure. */
    val endpoint: PushEndpoint? = null,
    val failure: String? = null,
    /** The session tag and endpoint the server took last ([PushPlan.key]), and when. */
    val sentFor: String? = null,
    val sentAt: Long = 0,
    /** The key the server refused with 400: an endpoint it won't post to, such as one on a private network. */
    val refused: String? = null,
)

/** The steps from what is wanted to what was done, and what Settings says meanwhile. */
internal object PushPlan {
    /** How long the server's copy of an endpoint counts as current: once a day it is sent again, in case it got lost. */
    const val RESEND = 24 * 60 * 60 * 1000L

    /** A failure of the distributor's server, which it says with TEMP_UNAVAILABLE. */
    const val UNAVAILABLE = "TEMP_UNAVAILABLE"

    /** The server refused the endpoint (400): not public https, or its host doesn't lead to a public address. */
    const val REFUSED = "REFUSED"

    /** The capability `GET /v1/info` lists while the server sends push wakes, with `workspace.push.vapid`. */
    const val CAPABILITY = "push-wake"

    private val VAPID = Regex("^[A-Za-z0-9_-]{87}$")

    /**
     * [wanted]: signed in, the server has team chat and Team chat notifications are on. [vapid]: the server's key while
     * it sends push wakes. [session]: the session's tag. [installed]: the distributors on the phone, [own] this app's
     * package. [registered]: this process registered once already, which UnifiedPush asks apps to do at each start.
     */
    data class Inputs(
        val wanted: Boolean,
        val vapid: String?,
        val session: String?,
        val installed: List<String>,
        val own: String,
        val registered: Boolean,
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

    fun key(session: String, endpoint: PushEndpoint): String = "$session\n${endpoint.url}"

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

    fun steps(inputs: Inputs, record: PushRecord, now: Long): List<Step> {
        val pick = if (inputs.wanted && inputs.vapid != null) pick(inputs, record) else null
        if (pick == null) {
            val steps = mutableListOf<Step>()
            if (record.distributor != null) steps += Step.Unregister
            val session = inputs.session
            if (session != null && record.sentFor?.startsWith("$session\n") == true) steps += Step.Withdraw
            return steps
        }
        val vapid = inputs.vapid!!
        // A new distributor or key: register, and wait for its endpoint.
        if (pick != record.distributor || vapid != record.vapid) return listOf(Step.Register(pick, vapid))
        val steps = mutableListOf<Step>()
        if (!inputs.registered) steps += Step.Register(pick, vapid)
        val endpoint = record.endpoint ?: return steps
        val session = inputs.session ?: return steps
        val key = key(session, endpoint)
        if (record.refused != key && (record.sentFor != key || now - record.sentAt >= RESEND)) steps += Step.Send(session, endpoint)
        return steps
    }

    fun delivery(inputs: Inputs, record: PushRecord): ChatDelivery {
        if (!inputs.wanted) return ChatDelivery.Off
        if (inputs.vapid == null) return ChatDelivery.ServerWithout
        val pick = pick(inputs, record) ?: return ChatDelivery.NoDistributor
        if (pick != record.distributor || inputs.vapid != record.vapid) return ChatDelivery.Connecting(pick)
        record.failure?.let { return ChatDelivery.Failed(pick, it) }
        val endpoint = record.endpoint ?: return ChatDelivery.Connecting(pick)
        val session = inputs.session ?: return ChatDelivery.Connecting(pick)
        return when (key(session, endpoint)) {
            record.refused -> ChatDelivery.Failed(pick, REFUSED)
            record.sentFor -> ChatDelivery.Instant(pick)
            else -> ChatDelivery.Connecting(pick)
        }
    }
}

/**
 * Runs [PushPlan] for the account and Team chat notifications as they are, one run at a time, and keeps its record in
 * [file]. [catchUp] runs ChatSyncWorker's catch-up at once: a push wake asks for it.
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
) : ChatPushControl {
    private val lock = Mutex()
    private var record: PushRecord = JsonFiles.read(file, PushRecord.serializer(), PushRecord(), clock)
    private var registered = false
    private val _state = MutableStateFlow(PushState())
    override val state: StateFlow<PushState> = _state.asStateFlow()

    /** Follows the account and the notifications switch for as long as [scope] lives. */
    fun start(): Job = scope.launch {
        combine(account.status, settings) { status, s -> Triple(status.signedIn, PushPlan.vapid(status), s.notifyChat) }
            .distinctUntilChanged()
            .collect { run() }
    }

    override fun check() {
        scope.launch { run() }
    }

    override fun choose(distributor: String) {
        scope.launch {
            lock.withLock { update { it.copy(preferred = distributor) } }
            run()
        }
    }

    /**
     * Takes the plan's steps until it has none left. Each pass changes the record, so the passes end: a step that
     * fails stops the run, and the next check tries again.
     */
    suspend fun run() {
        lock.withLock {
            for (pass in 0 until 4) {
                val inputs = inputs()
                val steps = PushPlan.steps(inputs, record, clock.now())
                if (steps.isEmpty() || !steps.all { take(it) }) break
            }
            publish()
        }
    }

    private fun inputs(): PushPlan.Inputs {
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
            registered = registered,
        )
    }

    /** Runs one step; false when it failed and the run should stop. */
    private suspend fun take(step: PushPlan.Step): Boolean = when (step) {
        is PushPlan.Step.Register -> {
            val changed = step.distributor != record.distributor || step.vapid != record.vapid
            registered = true
            try {
                distributors.register(step.distributor, step.vapid)
                if (changed) update { it.copy(distributor = step.distributor, vapid = step.vapid, endpoint = null, failure = null, refused = null) }
                true
            } catch (e: Exception) {
                AppLog.w(TAG, "Could not register with the UnifiedPush distributor", e)
                update { it.copy(distributor = step.distributor, vapid = step.vapid, endpoint = null, failure = "INTERNAL_ERROR") }
                false
            }
        }
        PushPlan.Step.Unregister -> {
            runCatching { distributors.unregister() }.onFailure { AppLog.w(TAG, "Could not unregister from the distributor", it) }
            registered = false
            update { it.copy(distributor = null, vapid = null, endpoint = null, failure = null) }
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
        return try {
            http.request(session.server, "PUT", ENDPOINT_PATH, body, session.token, null)
            update { it.copy(sentFor = key, sentAt = clock.now(), refused = null) }
            true
        } catch (e: AccountError) {
            when (e.status) {
                401 -> account.sessionRefused(session)
                400 -> update { it.copy(refused = key) }
                else -> AppLog.w(TAG, "The server didn't take the push endpoint: ${e.code} (${e.status})")
            }
            false
        } catch (e: Exception) {
            AppLog.w(TAG, "Could not give the server the push endpoint", e)
            false
        }
    }

    private suspend fun withdraw(): Boolean {
        val session = account.borrowSession()
        if (session != null) {
            try {
                http.request(session.server, "DELETE", ENDPOINT_PATH, null, session.token, null)
            } catch (e: AccountError) {
                // 401: the session is gone, and its endpoint with it. 404: a server without push wakes keeps none.
                if (e.status == 401) account.sessionRefused(session)
                else if (e.status != 404) {
                    AppLog.w(TAG, "Could not take the push endpoint back: ${e.code} (${e.status})")
                    return false
                }
            } catch (e: Exception) {
                AppLog.w(TAG, "Could not take the push endpoint back", e)
                return false
            }
        }
        update { it.copy(sentFor = null, sentAt = 0) }
        return true
    }

    // ---- What the distributor says (RukooPushService) ----

    fun newEndpoint(endpoint: PushEndpoint) {
        scope.launch {
            lock.withLock { update { it.copy(endpoint = endpoint, failure = null) } }
            run()
        }
    }

    fun registrationFailed(reason: String) {
        scope.launch {
            lock.withLock {
                update { it.copy(endpoint = null, failure = reason) }
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
                registered = false
                update { it.copy(distributor = null, vapid = null, endpoint = null, failure = null) }
                val tag = account.borrowSession()?.tag
                if (tag != null && record.sentFor?.startsWith("$tag\n") == true) withdraw()
            }
            run()
        }
    }

    /** A push wake: the catch-up runs now. */
    fun message() {
        catchUp()
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
        _state.value = PushState(PushPlan.delivery(inputs, record), inputs.installed)
    }

    companion object {
        private const val TAG = "ChatPush"
        const val ENDPOINT_PATH = "/v1/push-endpoint"
        const val FILE_NAME = "chat-push.json"
    }
}
