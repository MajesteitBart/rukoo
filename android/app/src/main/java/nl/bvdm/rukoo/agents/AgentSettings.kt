package nl.bvdm.rukoo.agents

import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.core.JsonFiles
import nl.bvdm.rukoo.core.SecretCipher

/** Hermes Agent (Clark): the phone talks to its API server directly. [key] is a secret. */
@Serializable
data class ClarkSettings(
    val enabled: Boolean = true,
    /** Display name; desktop's default is `Hermes`. */
    val name: String = "Hermes",
    val url: String = "",
    val key: String = "",
    val model: String = "",
) {
    val configured: Boolean get() = url.isNotBlank() && key.isNotBlank()

    override fun toString() = "ClarkSettings(enabled=$enabled, name=$name, url=$url, model=$model)"
}

/** An OpenClaw gateway's Chat Completions endpoint. [token] is a secret; [remote] lets OpenClaw use Rukoo on this phone. */
@Serializable
data class OpenClawSettings(
    val enabled: Boolean = true,
    val url: String = "",
    val token: String = "",
    val agentId: String = "",
    val model: String = "",
    val remote: Boolean = false,
) {
    val configured: Boolean get() = url.isNotBlank() && token.isNotBlank()

    override fun toString() = "OpenClawSettings(enabled=$enabled, url=$url, agentId=$agentId, model=$model, remote=$remote)"
}

/**
 * A computer running desktop Rukoo that this phone paired with (spec 3 §7.3). [token] authenticates the
 * phone there; [mcpToken] is the one the phone generated for that computer's forwarded tool calls.
 * Both are secrets. [exportUntil] is when the computer's export window closes, or null.
 */
@Serializable
data class PairedComputer(
    val pairingId: String,
    val name: String,
    val address: String,
    val port: Int = 47800,
    val token: String = "",
    val mcpToken: String = "",
    val claudeEnabled: Boolean = true,
    val codexEnabled: Boolean = true,
    val exportUntil: Long? = null,
    val version: String = "",
    val pairedAt: Long = 0,
    /** When the phone last got an answer from this computer, ms; written at most once a minute. */
    val lastSeenAt: Long? = null,
) {
    val baseUrl: String get() = "http://$address:$port"

    override fun toString() = "PairedComputer(pairingId=$pairingId, name=$name, address=$address, port=$port)"
}

/**
 * Agent connections, agents.json in the app's files (spec 1, design.md "settings"). In memory the
 * secrets are plain; on disk they are SecretBox-encrypted by [AgentSettingsStore]. [shortcuts] keeps
 * desktop's shortcut list as is (null means the defaults).
 */
@Serializable
data class AgentSettings(
    val defaultAgent: String = "clark",
    val autoMailActions: Boolean = false,
    val shortcuts: JsonElement? = null,
    val clark: ClarkSettings = ClarkSettings(),
    val openclaw: OpenClawSettings = OpenClawSettings(),
    val computers: List<PairedComputer> = emptyList(),
) {
    /** The same settings with every secret passed through [f]; empty secrets stay empty. */
    fun mapSecrets(f: (String) -> String): AgentSettings {
        fun s(v: String) = if (v.isEmpty()) v else f(v)
        return copy(
            clark = clark.copy(key = s(clark.key)),
            openclaw = openclaw.copy(token = s(openclaw.token)),
            computers = computers.map { it.copy(token = s(it.token), mcpToken = s(it.mcpToken)) },
        )
    }

    fun computer(pairingId: String): PairedComputer? = computers.firstOrNull { it.pairingId == pairingId }
}

/**
 * Loads and saves [AgentSettings]. Secrets are written as `enc:<SecretBox blob>`; one that can't be
 * decrypted (a restored backup, a reset Keystore) reads as empty, so the user is asked again.
 */
class AgentSettingsStore(private val file: File, private val cipher: SecretCipher) {
    private val mutex = Mutex()
    private val _settings = MutableStateFlow(load())
    val settings: StateFlow<AgentSettings> = _settings.asStateFlow()

    fun current(): AgentSettings = _settings.value

    private fun load(): AgentSettings =
        JsonFiles.read(file, AgentSettings.serializer(), AgentSettings()).mapSecrets { stored ->
            if (stored.startsWith(PREFIX)) cipher.decrypt(stored.removePrefix(PREFIX)).orEmpty() else ""
        }

    suspend fun update(transform: (AgentSettings) -> AgentSettings): AgentSettings = mutex.withLock {
        val next = transform(_settings.value)
        withContext(Dispatchers.IO) {
            JsonFiles.write(file, AgentSettings.serializer(), next.mapSecrets { PREFIX + cipher.encrypt(it) })
        }
        _settings.value = next
        next
    }

    /**
     * Saves [change] made to the shortcuts as they are stored now, so quick changes build on each other instead
     * of on what a page showed. False, with nothing saved, when the result is more than Rukoo keeps.
     */
    suspend fun changeShortcuts(change: (List<QuickAction>) -> List<QuickAction>): Boolean {
        var fits = true
        update { current ->
            val next = QuickActions.store(change(QuickActions.list(current.shortcuts)))
            fits = QuickActions.fits(next)
            if (fits) current.copy(shortcuts = next) else current
        }
        return fits
    }

    companion object {
        const val FILE_NAME = "agents.json"
        private const val PREFIX = "enc:"
    }
}
