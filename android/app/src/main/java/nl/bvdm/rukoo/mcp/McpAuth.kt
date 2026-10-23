package nl.bvdm.rukoo.mcp

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Who called, by the bearer token they showed. A paired computer forwards Claude Code's and Codex's calls. */
sealed interface McpCaller {
    /** Clark's Hermes bridge, with the token derived from the Hermes API key. */
    data object Clark : McpCaller

    /** An OpenClaw gateway on another device, with the remote token derived from its gateway token. */
    data object OpenClaw : McpCaller

    /** Desktop Rukoo on a paired computer, forwarding a phone chat's tool call with the token this phone gave it. */
    data class Computer(val pairingId: String) : McpCaller
}

/**
 * The secrets the tokens come from, read per request so a changed key or a switch turned off applies at once.
 * [toolsOn] is "Let agents use Rukoo on this phone"; nothing is accepted without it.
 */
data class AuthSecrets(
    val toolsOn: Boolean = false,
    val clarkKey: String = "",
    val openClawToken: String = "",
    val openClawRemote: Boolean = false,
    /** Paired computers: pairing id to the token this phone generated for that computer's forwarded calls. */
    val computers: List<Pair<String, String>> = emptyList(),
) {
    override fun toString() = "AuthSecrets(toolsOn=$toolsOn, clark=${clarkKey.isNotEmpty()}, openClawRemote=$openClawRemote, computers=${computers.size})"
}

/**
 * Desktop Rukoo's token rules (config.js:47-57, hub.js:1932-1953), with the same formulas so the same Hermes key
 * opens Rukoo on every device: tokens are HMAC-SHA256 over a fixed label, keyed with the secret, in base64url
 * without padding.
 */
object McpTokens {
    private const val CLARK_LABEL = "rukoo-mcp-v1"
    private const val OPENCLAW_REMOTE_LABEL = "rukoo-mcp-openclaw-remote-v1"
    private val B64 = Base64.getUrlEncoder().withoutPadding()

    fun hmac(key: ByteArray, message: String): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(message.toByteArray(Charsets.UTF_8))
    }

    fun sha256(text: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))

    private fun derive(secret: String, label: String): String =
        if (secret.isEmpty()) "" else B64.encodeToString(hmac(secret.toByteArray(Charsets.UTF_8), label))

    /** Clark's token: the bridge derives the same from RUKOO_KEY (rukoo_bridge.py:62). */
    fun clark(hermesKey: String): String = derive(hermesKey.trim(), CLARK_LABEL)

    /** The token an OpenClaw gateway on another device uses (config.js:358-361). */
    fun openClawRemote(gatewayToken: String): String = derive(gatewayToken.trim(), OPENCLAW_REMOTE_LABEL)

    /**
     * The answer to the bridge's challenge (hub.js:1950-1953): keyed with the token's hash, so it never gives the
     * token away, and covering the address the connection came in on, so a relay elsewhere gets a proof for this
     * address, not its own.
     */
    fun proof(token: String, endpoint: String, challenge: String): String =
        B64.encodeToString(hmac(sha256(token), "rukoo-proof:$endpoint:$challenge"))
}

class McpAuth(private val secrets: () -> AuthSecrets) {
    /**
     * The caller a bearer token belongs to, or null. Digests are compared in constant time and every entry is
     * checked, so timing doesn't tell which one matched; later entries win, as on desktop.
     */
    fun identify(token: String): McpCaller? {
        if (token.isEmpty() || token.length > TOKEN_MAX) return null
        val s = secrets()
        if (!s.toolsOn) return null
        val hash = McpTokens.sha256(token)
        var found: McpCaller? = null
        for ((pairingId, mcpToken) in s.computers) {
            if (mcpToken.isNotEmpty() && MessageDigest.isEqual(McpTokens.sha256(mcpToken), hash)) found = McpCaller.Computer(pairingId)
        }
        val clark = McpTokens.clark(s.clarkKey)
        if (clark.isNotEmpty() && MessageDigest.isEqual(McpTokens.sha256(clark), hash)) found = McpCaller.Clark
        val openClaw = if (s.openClawRemote) McpTokens.openClawRemote(s.openClawToken) else ""
        if (openClaw.isNotEmpty() && MessageDigest.isEqual(McpTokens.sha256(openClaw), hash)) found = McpCaller.OpenClaw
        return found
    }

    /** The proof for Clark's bridge, or "" without a Hermes key or with phone tools off (the header then says `none`). */
    fun proof(challenge: String, endpoint: String): String {
        val s = secrets()
        val token = McpTokens.clark(s.clarkKey)
        if (!s.toolsOn || token.isEmpty() || endpoint.isEmpty()) return ""
        return McpTokens.proof(token, endpoint, challenge)
    }

    companion object {
        const val TOKEN_MAX = 512
    }
}
