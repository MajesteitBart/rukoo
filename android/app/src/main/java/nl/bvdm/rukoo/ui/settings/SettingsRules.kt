package nl.bvdm.rukoo.ui.settings

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.desktop.UrlHosts
import nl.bvdm.rukoo.mail.model.GoogleClient

/** Rules for the addresses typed into the agent cards. */
object AgentUrls {
    /** What gets saved: trimmed, without trailing slashes. */
    fun normalize(raw: String): String = raw.trim().trimEnd('/')

    /** Empty (not set up) or an http(s) URL with a host. */
    fun isValid(raw: String): Boolean {
        val url = normalize(raw)
        if (url.isEmpty()) return true
        val scheme = url.substringBefore("://", "").lowercase()
        return (scheme == "http" || scheme == "https") && UrlHosts.host(url) != null && url.none { it.isWhitespace() }
    }

    /**
     * True for an `http://` address outside the tailnet, where the API key would travel in clear text.
     * Inside the tailnet WireGuard encrypts it. Port of dudan's isInsecureRemote (SettingsScreen.kt:834-844):
     * loopback and the emulator's host are fine, and so are MagicDNS names (`*.ts.net`, or a name without a
     * dot), Tailscale's 100.64.0.0/10 and its fd7a:115c:a1e0::/48 IPv6 range.
     */
    fun isInsecureRemote(raw: String): Boolean {
        val url = normalize(raw)
        if (!url.lowercase().startsWith("http://")) return false
        val host = UrlHosts.host(url) ?: return false
        if (host == "localhost" || host == "10.0.2.2" || UrlHosts.isLoopback(url)) return false
        if (':' in host) return !host.startsWith("fd7a:115c:a1e0:")
        if (host.endsWith(".ts.net") || !host.contains('.')) return false
        val parts = host.split('.').map { it.toIntOrNull() }
        if (parts.size == 4 && parts.all { it != null && it in 0..255 } && parts[0] == 100 && parts[1]!! in 64..127) return false
        return true
    }

    /** OpenClaw's agent id as the gateway takes it in `openclaw/<agentId>` (config.js OPENCLAW_AGENT); empty is the default agent. */
    fun isValidOpenClawAgent(raw: String): Boolean = raw.isEmpty() || Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$").matches(raw)
}

/** A Google OAuth client file as Google Cloud downloads it (spec 4 §4.2). */
object GoogleClientFile {
    class Invalid : Exception("This file does not contain a Google OAuth client.")

    /** `{installed: {...}}`, `{web: {...}}` or flat `{client_id, client_secret}`; both fields are required. */
    fun parse(text: String): GoogleClient? {
        val root = runCatching { RukooJson.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
        val section = (root["installed"] as? JsonObject) ?: (root["web"] as? JsonObject) ?: root
        fun field(name: String) = (section[name] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim().orEmpty()
        val id = field("client_id")
        val secret = field("client_secret")
        if (id.isEmpty() || secret.isEmpty()) return null
        return GoogleClient(id, secret)
    }
}
