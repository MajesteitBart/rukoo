package nl.bvdm.rukoo.mail.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Desktop's account `type`: a real IMAP/SMTP account or the built-in demo. */
@Serializable
enum class AccountType {
    @SerialName("imap") IMAP,
    @SerialName("demo") DEMO,
}

/** How the account signs in. Desktop stores `oauth2` or nothing (password); its public view adds `none` for demo. */
@Serializable
enum class AuthKind {
    @SerialName("password") PASSWORD,
    @SerialName("oauth2") OAUTH2,
    @SerialName("none") NONE,
}

/** IMAP or SMTP server settings, desktop's `{host, port, secure, user, allowInvalidCert?}`. */
@Serializable
data class ServerConfig(
    val host: String,
    val port: Int,
    /** Implicit TLS (993/465). False means STARTTLS. */
    val secure: Boolean = true,
    val user: String = "",
    val allowInvalidCert: Boolean = false,
)

/** An extra send-as address of an account (lower-cased address). */
@Serializable
data class Alias(val address: String, val name: String = "")

/** An address the user can send from: the account itself (primary) or an alias. */
data class Identity(val address: String, val name: String, val primary: Boolean)

/**
 * One mail account, desktop's accounts.json record (spec 4 §1.2) without the secret. The password or
 * Google refresh token is stored separately, encrypted with SecretBox, and never sits in this object.
 */
@Serializable
data class Account(
    val id: String,
    val type: AccountType,
    /** Preset used at creation: `google`, `yahoo`, `outlook`, `exchange`, `office365`, `other` or `demo`. */
    val provider: String,
    val auth: AuthKind,
    val email: String,
    val name: String,
    val label: String = email,
    val color: String = COLORS[0],
    /** Null (with no [signatureHtml]) means "use the general signature". */
    val signature: String? = null,
    val signatureHtml: String? = null,
    val imap: ServerConfig? = null,
    val smtp: ServerConfig? = null,
    /** Granted Google scopes, de-duplicated and sorted; empty for password accounts. */
    val scopes: List<String> = emptyList(),
    val aliases: List<Alias> = emptyList(),
    /** Preferred From address, lower case; null means the account's own address. */
    val defaultFrom: String? = null,
    /** Set once Gmail's send-as aliases were fetched; sync only fetches them while this is null. */
    val aliasesFetchedAt: Long? = null,
    val createdAt: Long = 0,
) {
    companion object {
        /** Desktop's account colors (engine.js:18): the n-th account gets COLORS[n % size]. */
        val COLORS = listOf("#2fd6c0", "#4a7dff", "#ff8a3d", "#c56cf0", "#f5c542", "#ff5d73", "#5ec2ff")

        const val DEMO_EMAIL = "demo@example.com"
    }
}
