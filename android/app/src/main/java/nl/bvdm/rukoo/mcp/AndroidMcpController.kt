package nl.bvdm.rukoo.mcp

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ProcessLifecycleOwner
import java.io.File
import java.time.ZoneId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.AppContainer
import nl.bvdm.rukoo.BuildConfig
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.AgentSettings
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.Tailnet
import nl.bvdm.rukoo.mcp.tools.ChatFileReader
import nl.bvdm.rukoo.mcp.tools.DraftTexts
import nl.bvdm.rukoo.mcp.tools.HubSkillSource
import nl.bvdm.rukoo.mcp.tools.McpTools
import nl.bvdm.rukoo.mcp.tools.ToolDeps
import nl.bvdm.rukoo.mcp.tools.UnsubscribeOpener
import nl.bvdm.rukoo.ui.Notifications
import nl.bvdm.rukoo.ui.ScreenState

/**
 * Runs [RukooMcpService] to match "Let agents use Rukoo on this phone" and its port, and reports where it listens.
 * Android only lets a foreground service start while Rukoo is on screen (or right after boot), so a refused start
 * is retried when the app comes to the foreground.
 */
class AndroidMcpController(private val container: AppContainer) : McpController {
    private val context: Context = container.appContext
    private val _status = MutableStateFlow(McpStatus(error = McpStatus.ERROR_DISABLED))
    override val status: StateFlow<McpStatus> = _status.asStateFlow()

    @Volatile private var refused = false
    @Volatile private var runningPort = 0

    init {
        val scope = container.appScope
        scope.launch {
            container.settingsSnapshot.map { it.mcpEnabled to it.mcpPort }.distinctUntilChanged().collect { (on, port) ->
                when {
                    !on -> stop()
                    // A new port needs a new socket.
                    runningPort != 0 && runningPort != port -> restart()
                    else -> start()
                }
            }
        }
        scope.launch {
            container.agentSettings.settings.map(::agentNames).distinctUntilChanged().collect { names -> _status.update { it.copy(agents = names) } }
        }
        scope.launch(Dispatchers.Main) {
            ProcessLifecycleOwner.get().lifecycle.addObserver(
                LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_START) ensureRunning() },
            )
        }
    }

    fun wanted(): Boolean = container.settingsSnapshot.value.mcpEnabled

    fun port(): Int = container.settingsSnapshot.value.mcpPort

    override fun start() {
        if (!wanted()) return
        refused = !RukooMcpService.start(context)
    }

    override fun stop() {
        RukooMcpService.stop(context)
        runningPort = 0
        _status.update { McpStatus(error = McpStatus.ERROR_DISABLED, agents = it.agents) }
    }

    /** Opens a new socket, for a new port or a new debug address. */
    fun restart() {
        if (!wanted()) return
        refused = !RukooMcpService.start(context, restart = true)
    }

    // Called when Rukoo comes on screen: Android lets a service start from the foreground, so retry then.
    private fun ensureRunning() {
        if (wanted() && (refused || !_status.value.running)) start()
    }

    internal fun backgroundRefused() {
        refused = true
    }

    /** The server with the app's mail, hub, screen and composer behind it. */
    internal fun runtime(port: Int): McpRuntime {
        val c = container
        val tools = McpTools(
            ToolDeps(
                mail = c.mail,
                hub = c.agents,
                screen = c.screen,
                composer = c.composer,
                agentSettings = { c.agentSettings.current() },
                skills = HubSkillSource(c.agents),
                scope = c.appScope,
                // The hub and the composer belong to the main thread, like desktop's single-threaded hub.
                hubContext = Dispatchers.Main.immediate,
                defaultAccountId = { c.settingsSnapshot.value.defaultAccountId },
                chatFiles = ChatFileReader { _, f -> File(f.file).let { if (it.isAbsolute) it else File(context.filesDir, f.file) }.readBytes() },
                opener = PageOpener(context, c.screen),
                texts = ResourceDraftTexts(context),
                zone = { ZoneId.systemDefault() },
                clock = c.clock,
            ),
        )
        return McpRuntime(
            port = port,
            policy = TailnetPolicy(debug = BuildConfig.DEBUG, advertised = { McpDebug.advertised(context) }),
            secrets = { McpSetup.secrets(wanted(), c.agentSettings.current()) },
            tools = tools,
            version = BuildConfig.VERSION_NAME,
            deviceName = ::deviceName,
            log = { what, e -> AppLog.w(TAG, what, e) },
        )
    }

    internal fun listening(port: Int) {
        refused = false
        runningPort = port
        _status.update { it.copy(running = true, port = port, error = null, detail = null) }
        refreshAddress()
    }

    internal fun failed(code: String, port: Int, detail: String?) {
        runningPort = 0
        _status.update { it.copy(running = false, port = port, address = null, error = code, detail = detail) }
    }

    internal fun stopped() {
        runningPort = 0
        _status.update { if (it.running) it.copy(running = false, error = if (wanted()) it.error else McpStatus.ERROR_DISABLED) else it }
    }

    /** Where agents reach this phone now; "no-tailnet" while Tailscale is off. */
    internal fun refreshAddress() {
        val address = Tailnet.ownAddress()?.hostAddress
        val advertised = McpDebug.advertised(context)
        _status.update {
            if (!it.running) it else it.copy(address = address, advertised = advertised, error = if (address == null && advertised == null) McpStatus.ERROR_NO_TAILNET else null)
        }
    }

    override fun openClawSetup(): String? {
        val url = _status.value.url ?: Tailnet.ownAddress()?.hostAddress?.let { "http://$it:${port()}/mcp" } ?: return null
        return McpSetup.openClaw(url, container.agentSettings.current().openclaw.token)
    }

    override fun hermesNote(): String {
        val name = container.agentSettings.current().clark.name.ifBlank { "Hermes" }
        val url = _status.value.url ?: Tailnet.ownAddress()?.hostAddress?.let { "http://$it:${port()}/mcp" }
        return if (url != null) context.getString(R.string.mcp_hermes_note, name, url) else context.getString(R.string.mcp_hermes_note_no_address, name)
    }

    private fun agentNames(s: AgentSettings): List<String> = buildList {
        if (s.clark.key.isNotBlank()) add(s.clark.name.ifBlank { "Hermes" })
        if (s.openclaw.remote && s.openclaw.token.isNotBlank()) add("OpenClaw")
        for (computer in s.computers) if (computer.mcpToken.isNotEmpty()) add(context.getString(R.string.mcp_agents_computer, computer.name))
    }

    // The name the user gave the phone, for rukoo/hello; the bridge only shows it in logs.
    private fun deviceName(): String =
        runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()?.takeIf { it.isNotBlank() } ?: Build.MODEL

    companion object {
        private const val TAG = "Mcp"
    }
}

/** The texts of phone tools for Settings and the service notification. */
object McpTexts {
    fun status(context: Context, status: McpStatus): String? = when (status.error) {
        null -> null
        McpStatus.ERROR_DISABLED -> context.getString(R.string.mcp_status_disabled)
        McpStatus.ERROR_NO_TAILNET -> context.getString(R.string.mcp_status_no_tailnet)
        McpStatus.ERROR_PORT_IN_USE -> context.getString(R.string.mcp_status_port_in_use, status.port)
        else -> context.getString(R.string.mcp_status_failed)
    }

    fun notification(context: Context, status: McpStatus): String {
        val at = status.advertised ?: status.address?.let { "$it:${status.port}" }
            ?: return context.getString(R.string.mcp_notification_no_tailnet)
        return if (status.agents.isEmpty()) {
            context.getString(R.string.mcp_notification_no_agents, at)
        } else {
            context.getString(R.string.mcp_notification_listening, at, status.agents.joinToString(", "))
        }
    }
}

/** The quote header lines from the string resources, so a reply an agent wrote reads in the user's language. */
class ResourceDraftTexts(private val context: Context) : DraftTexts {
    override fun marker() = context.getString(R.string.mcp_quote_marker)
    override fun from(sender: String) = context.getString(R.string.mcp_quote_from, sender)
    override fun date(date: String) = context.getString(R.string.mcp_quote_date, date)
    override fun to(recipients: String) = context.getString(R.string.mcp_quote_to, recipients)
    override fun subject(subject: String) = context.getString(R.string.mcp_quote_subject, subject)
    override fun datePattern(): String = context.getString(R.string.mcp_quote_date_pattern)
}

/**
 * Opens an unsubscribe page for mail_action. Android blocks activity starts from the background without an error,
 * so while Rukoo is not on screen the page waits in a notification the user taps.
 */
class PageOpener(private val context: Context, private val screen: ScreenState) : UnsubscribeOpener {
    override fun openPage(url: String): Boolean {
        val uri = Uri.parse(url)
        if (uri.scheme?.lowercase() !in setOf("https", "http")) return false
        val intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (screen.current.foreground) {
            return runCatching { context.startActivity(intent) }.isSuccess
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        val id = NOTIFY_BASE + (url.hashCode() and 0xffff)
        val notification = NotificationCompat.Builder(context, Notifications.CHANNEL_AGENTS)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(context.getString(R.string.mcp_unsubscribe_title))
            .setContentText(context.getString(R.string.mcp_unsubscribe_text))
            .setContentIntent(PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setAutoCancel(true)
            .build()
        return runCatching { context.getSystemService(NotificationManager::class.java)?.notify(id, notification) }.isSuccess
    }

    private companion object {
        const val NOTIFY_BASE = 0x5200_0000
    }
}

/**
 * Debug-only settings for testing on an emulator: the emulator has no Tailscale address, so another `host:port`
 * can stand in for it (adb forward plus a relay on a computer's Tailscale address). Release builds ignore them.
 */
object McpDebug {
    private const val PREFS = "mcp_debug"
    private const val ADVERTISED = "advertised"
    private val HOST_PORT = Regex("^[A-Za-z0-9.-]+:\\d{2,5}$")

    fun advertised(context: Context): String? {
        if (!BuildConfig.DEBUG) return null
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(ADVERTISED, null)?.takeIf { HOST_PORT.matches(it) }
    }

    fun setAdvertised(context: Context, value: String?) {
        if (!BuildConfig.DEBUG) return
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
            if (value.isNullOrBlank() || !HOST_PORT.matches(value)) remove(ADVERTISED) else putString(ADVERTISED, value.lowercase())
        }.apply()
    }
}
