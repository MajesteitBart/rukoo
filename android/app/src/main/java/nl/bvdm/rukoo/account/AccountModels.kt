package nl.bvdm.rukoo.account

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/** Who runs an account server (`GET /v1/info`, `operator`). */
@Serializable
data class ServerOperator(val name: String? = null, val url: String? = null, val contact: String? = null, val privacy: String? = null)

/** Where an account server runs (`hosting`); [jurisdiction] is `eu`, `us`, `fedramp` or null. */
@Serializable
data class ServerHosting(val provider: String? = null, val company: String? = null, val country: String? = null, val jurisdiction: String? = null)

/** What `GET /v1/info` says: who runs the server and where it keeps data, shown before anyone signs up. */
@Serializable
data class ServerInfo(
    val protocol: Int = 0,
    val version: String = "",
    val operator: ServerOperator? = null,
    val hosting: ServerHosting? = null,
    /** `open`, `invite` or `closed`. */
    val signups: String = "open",
)

@Serializable
data class AccountUsage(val records: Long = 0, val bytes: Long = 0)

/** A device signed in to the account; [current] is this phone. */
@Serializable
data class AccountDevice(
    val id: String,
    val name: String = "",
    val platform: String = "",
    val createdAt: Long = 0,
    val lastSeenAt: Long? = null,
    val current: Boolean = false,
)

/** `GET /v1/account`: the account's address, its usage and its devices. */
@Serializable
data class AccountDetails(
    val email: String = "",
    val createdAt: Long = 0,
    val usage: AccountUsage? = null,
    val devices: List<AccountDevice> = emptyList(),
)

/** The server info kept for the server it came from, so Settings shows it without a network. */
@Serializable
data class StoredInfo(val server: String, val data: ServerInfo, val at: Long = 0)

/**
 * account.json: the server, its info, and the session while signed in. [token] and [dataKey] are encrypted with the
 * Keystore box, like mail passwords; the rest isn't secret.
 */
@Serializable
data class AccountState(
    val server: String? = null,
    val info: StoredInfo? = null,
    val error: String? = null,
    val email: String? = null,
    val token: String? = null,
    val dataKey: String? = null,
    val cursor: Long = 0,
    val lastSync: Long? = null,
)

/**
 * One record on this phone (account-records.json). The fields after [t] are the sync's bookkeeping: [dirty] waits
 * to go up, [ifAbsent] goes up as a first write, [first] is a first write no other device's copy has replaced yet,
 * [id] and [seq] are its name and place on the server, [tooLarge] stays here. Mutable on purpose: like desktop, the sync tells a record
 * that changed while it was on its way by identity.
 */
@Serializable
class AccountEntry(
    val c: String,
    val k: String,
    var v: JsonElement = JsonNull,
    var t: Long = 0,
    var deleted: Boolean = false,
    var dirty: Boolean = false,
    var ifAbsent: Boolean = false,
    var first: Boolean = false,
    var id: String? = null,
    var seq: Long? = null,
    /** Too large for the server once sealed: it stays on this phone and doesn't go up. */
    var tooLarge: Boolean = false,
)

@Serializable
data class StoredEntries(val entries: List<AccountEntry> = emptyList())

/** The account as Settings shows it (desktop status()). [error] is an [AccountError] code. */
data class AccountStatus(
    val server: String = "",
    val defaultServer: String = "",
    val signedIn: Boolean = false,
    val email: String? = null,
    val lastSync: Long? = null,
    val syncing: Boolean = false,
    val error: String? = null,
    val info: ServerInfo? = null,
    val pending: Int = 0,
    /** Live records per collection, for the privacy page. */
    val counts: Map<String, Int> = emptyMap(),
)

/** What a sign-up returns: the recovery key, shown once. */
data class SignUpResult(val recoveryKey: String, val account: AccountDetails?)
