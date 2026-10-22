package nl.bvdm.rukoo

import android.content.Context
import android.net.Uri
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.AgentSettingsStore
import nl.bvdm.rukoo.agents.preview.PreviewAgentHub
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.SecretBox
import nl.bvdm.rukoo.desktop.DesktopLink
import nl.bvdm.rukoo.desktop.StubDesktopLink
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.demo.PreviewMailEngine
import nl.bvdm.rukoo.mcp.AndroidMcpController
import nl.bvdm.rukoo.mcp.McpController
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.settings.Locales
import nl.bvdm.rukoo.settings.SettingsStore
import nl.bvdm.rukoo.ui.ComposerController
import nl.bvdm.rukoo.ui.ScreenState
import okhttp3.OkHttpClient

/** What the UI reaches through AppViewModel. AppContainer implements it; tests pass fakes. */
interface AppServices {
    val mail: MailEngine
    val agents: AgentHub
    val composer: ComposerController
    val screen: ScreenState
    val settings: SettingsStore
    val settingsSnapshot: StateFlow<AppSettings>
    val agentSettings: AgentSettingsStore
    val desktop: DesktopLink
    val mcp: McpController
}

/**
 * Process-wide singletons, wired by hand (no DI framework). Mail, agents, MCP and the composer live
 * here rather than in a screen, so turns, approvals and drafts carry on while the activity is gone.
 */
class AppContainer(context: Context) : AppServices {
    val appContext: Context = context.applicationContext

    /** Work that outlives every screen: agent turns, sync, the MCP server. */
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    val clock: Clock = Clock.System

    override val settings = SettingsStore(appContext)

    /** The latest settings for code that can't suspend. */
    override val settingsSnapshot: StateFlow<AppSettings> = settings.flow.stateIn(appScope, SharingStarted.Eagerly, AppSettings())

    override val agentSettings: AgentSettingsStore by lazy {
        AgentSettingsStore(File(appContext.filesDir, AgentSettingsStore.FILE_NAME), SecretBox)
    }

    /** Shared HTTP client; adapters derive their own timeouts with newBuilder(). */
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        // Hermes and the computer host send keepalives every 10-15 s, so a long read timeout only trips on a dead link.
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    override val screen = ScreenState(clock)

    override val composer = ComposerController(File(appContext.filesDir, ComposerController.FILE_NAME), appScope)

    // The preview engine and hub stand in until the real ones land (tracks A and C swap them in here).
    override val mail: MailEngine by lazy {
        if (BuildConfig.USE_PREVIEW_MAIL) PreviewMailEngine(clock, appContext.cacheDir, resources = appContext.resources) else error("no mail engine yet")
    }

    override val agents: AgentHub by lazy {
        if (BuildConfig.USE_PREVIEW_AGENTS) PreviewAgentHub(appScope, clock) else error("no agent hub yet")
    }

    // Made with the container, not lazily: it starts Rukoo's tools as soon as the app (or the boot receiver) runs.
    override val mcp: McpController = AndroidMcpController(this)

    override val desktop: DesktopLink by lazy { StubDesktopLink(agentSettings) }

    /** OAuth returns that arrive as `rukoo-oauth:` deep links; the sign-in flow collects them. */
    val oauthReturns = MutableSharedFlow<Uri>(extraBufferCapacity = 1)

    init {
        // The language the user picks in Rukoo; LocaleManager keeps it, so only changes are applied.
        appScope.launch {
            settings.flow.map { it.language }.distinctUntilChanged().drop(1).collect { Locales.apply(appContext, it) }
        }
    }
}
