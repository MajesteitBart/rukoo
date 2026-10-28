package nl.bvdm.rukoo.desktop

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import nl.bvdm.rukoo.agents.model.AgentErrorInfo
import nl.bvdm.rukoo.mail.model.GoogleClient
import nl.bvdm.rukoo.mail.model.ImportedAccount

// The phone <-> computer wire format, spec 3 §7 exactly. Field names are the JSON names.

@Serializable
data class DeviceInfo(val name: String, val platform: String = "android", val model: String = "", val appVersion: String = "")

/** `POST /phone/v1/pair` body. */
@Serializable
data class PairRequest(val code: String, val device: DeviceInfo)

@Serializable
data class DesktopInfo(val name: String = "", val version: String = "", val address: String = "", val port: Int = 47800)

/** `POST /phone/v1/pair` answer. [token] is the phone's bearer token there. */
@Serializable
data class PairResponse(val pairingId: String, val token: String, val desktop: DesktopInfo = DesktopInfo(), val exportUntil: Long? = null) {
    override fun toString() = "PairResponse(pairingId=$pairingId, desktop=$desktop, exportUntil=$exportUntil)"
}

/** One computer agent in `/hello`: whether it is on there, its desktop status, model and access mode. */
@Serializable
data class HostAgentInfo(
    val enabled: Boolean = false,
    val state: String = "unknown",
    val detail: String = "",
    val model: String? = null,
    val access: String? = null,
)

/** `GET /phone/v1/hello`. */
@Serializable
data class HelloResponse(
    val desktop: DesktopInfo = DesktopInfo(),
    val pairingId: String = "",
    val exportUntil: Long? = null,
    val agents: Map<String, HostAgentInfo> = emptyMap(),
)

/** The `settings` part of the export bundle (spec 3 §7.10). */
@Serializable
data class ExportedSettings(
    val defaultAccountId: String? = null,
    val language: String? = null,
    /** `system`, `light` or `dark`; the desktop sends it next to the spec's fields (wave0-api.md F). */
    val theme: String? = null,
    val signature: String? = null,
    val signatureHtml: String? = null,
    val vips: List<String> = emptyList(),
    val spam: List<String> = emptyList(),
    val syncInterval: Int? = null,
    val hiddenViews: List<String> = emptyList(),
    val darkEmails: Boolean? = null,
    val swipeActions: Boolean? = null,
    val swipeRight: String? = null,
    val swipeLeft: String? = null,
    val notifications: Boolean? = null,
    val sort: String? = null,
    val density: String? = null,
)

@Serializable
data class ExportedClark(val enabled: Boolean = true, val name: String = "Hermes", val url: String = "", val key: String = "", val model: String = "") {
    override fun toString() = "ExportedClark(enabled=$enabled, name=$name, url=$url, model=$model)"
}

@Serializable
data class ExportedOpenClaw(val enabled: Boolean = true, val url: String = "", val key: String = "", val agent: String = "", val model: String = "") {
    override fun toString() = "ExportedOpenClaw(enabled=$enabled, url=$url, agent=$agent, model=$model)"
}

@Serializable
data class ExportedLocalAgent(val enabled: Boolean = true, val model: String = "", val access: String = "")

@Serializable
data class ExportedMcp(val port: Int = 47800)

@Serializable
data class ExportedAgents(
    val defaultAgent: String = "clark",
    val autoMailActions: Boolean = false,
    val shortcuts: JsonElement? = null,
    val clark: ExportedClark? = null,
    val openclaw: ExportedOpenClaw? = null,
    val claude: ExportedLocalAgent? = null,
    val codex: ExportedLocalAgent? = null,
    val mcp: ExportedMcp? = null,
)

/** `GET /phone/v1/export`: accounts with their secrets, the Google client and agent settings, once per window. */
@Serializable
data class ExportBundle(
    val version: Int = 1,
    val exportedAt: Long = 0,
    val desktop: DesktopInfo = DesktopInfo(),
    val google: GoogleClient? = null,
    val accounts: List<ImportedAccount> = emptyList(),
    val settings: ExportedSettings = ExportedSettings(),
    val agents: ExportedAgents = ExportedAgents(),
) {
    override fun toString() = "ExportBundle(accounts=${accounts.size}, desktop=$desktop)"
}

@Serializable
data class HostConversation(val id: String, val title: String = "", val provider: Map<String, String> = emptyMap())

/** An image sent with a computer-hosted turn: base64 [data], at most 3.75 MiB decoded. */
@Serializable
data class HostFile(val id: String, val name: String, val type: String, val kind: String = "image", val size: Long, val data: String) {
    override fun toString() = "HostFile(id=$id, name=$name, size=$size)"
}

@Serializable
data class HostMcp(val url: String, val token: String) {
    override fun toString() = "HostMcp(url=$url)"
}

@Serializable
data class HostSkill(val name: String)

/**
 * `POST /phone/v1/turns` body (spec 3 §7.6). [agent] is `claude` or `codex`. Without [mcp] the agent runs
 * without Rukoo's tools, as the desktop allows when the phone has no MCP address.
 */
@Serializable
data class HostTurnRequest(
    val agent: String,
    val conversation: HostConversation,
    val input: String,
    val text: String,
    val instructions: String? = null,
    val action: String? = null,
    val skills: List<HostSkill> = emptyList(),
    val firstTurn: Boolean = false,
    val model: String? = null,
    val effort: String? = null,
    val files: List<HostFile> = emptyList(),
    val emails: List<String> = emptyList(),
    /** The phone's MCP endpoint and the token for this computer; null (left out) when the phone serves no tools now. */
    val mcp: HostMcp? = null,
)

@Serializable
data class ChoiceBody(val choice: String)

@Serializable
data class StartOverBody(val input: String)

@Serializable
data class ForgetBody(val agent: String, val conversationId: String)

/** The error body of every route: `{error, detail}`. */
@Serializable
data class HostErrorBody(val error: String = "unknown", val detail: String = "") {
    fun info() = AgentErrorInfo(error, detail)
}
