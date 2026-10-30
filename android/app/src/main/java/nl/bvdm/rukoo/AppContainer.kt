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
import kotlinx.serialization.json.JsonObject
import nl.bvdm.rukoo.account.AccountBackground
import nl.bvdm.rukoo.account.AccountService
import nl.bvdm.rukoo.account.OkHttpAccountHttp
import nl.bvdm.rukoo.agents.AdapterDeps
import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.AgentNotifier
import nl.bvdm.rukoo.agents.AgentSettingsStore
import nl.bvdm.rukoo.agents.AndroidHubStrings
import nl.bvdm.rukoo.agents.ComposerUnsubscribeOpener
import nl.bvdm.rukoo.agents.Hub
import nl.bvdm.rukoo.agents.RukooSkills
import nl.bvdm.rukoo.agents.adapters.DefaultAdapterFactory
import nl.bvdm.rukoo.agents.adapters.FakeTools
import nl.bvdm.rukoo.agents.preview.PreviewAgentHub
import nl.bvdm.rukoo.categories.Categories
import nl.bvdm.rukoo.categories.EngineCategoryMail
import nl.bvdm.rukoo.categories.Jev
import nl.bvdm.rukoo.categories.ResourceCategoryTexts
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.SecretBox
import nl.bvdm.rukoo.desktop.DesktopDevice
import nl.bvdm.rukoo.desktop.DesktopLink
import nl.bvdm.rukoo.desktop.HttpDesktopLink
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.demo.PreviewMailEngine
import nl.bvdm.rukoo.mcp.AndroidMcpController
import nl.bvdm.rukoo.mcp.McpController
import nl.bvdm.rukoo.mcp.PageOpener
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.settings.Locales
import nl.bvdm.rukoo.settings.SettingsStore
import nl.bvdm.rukoo.ui.ComposerController
import nl.bvdm.rukoo.ui.ScreenState
import nl.bvdm.rukoo.ui.composer.DraftStore
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

    /** Drafts kept on this phone ("Save draft"); fakes get a shared in-memory store. */
    val drafts: DraftStore get() = DraftStore.InMemory

    /** The Rukoo account (account/); null in fakes, which then show no account. */
    val account: AccountService? get() = null

    /** Inbox categories (categories/); null in fakes, which then show no categories. */
    val categories: Categories? get() = null
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

    override val composer = ComposerController(File(appContext.filesDir, ComposerController.FILE_NAME), appScope, clock = clock)

    override val drafts = DraftStore(File(appContext.filesDir, DraftStore.FILE_NAME))

    // The preview engine and hub stand in until the real ones land (tracks A and C swap them in here).
    override val mail: MailEngine by lazy {
        if (BuildConfig.USE_PREVIEW_MAIL) {
            PreviewMailEngine(clock, appContext.cacheDir, resources = appContext.resources)
        } else {
            // The categories read the engine, so the notifications ask for them only once mail arrives.
            nl.bvdm.rukoo.mail.MailModule.create(appContext, appScope, settings, settingsSnapshot, http, categories = { categories })
        }
    }

    override val agents: AgentHub by lazy {
        if (BuildConfig.USE_PREVIEW_AGENTS) {
            PreviewAgentHub(appScope, clock)
        } else {
            lateinit var hub: Hub
            hub = Hub(
                scope = appScope,
                mail = mail,
                screen = screen,
                settings = agentSettings,
                factory = DefaultAdapterFactory(
                    AdapterDeps(appContext, agentSettings, desktop, http, clock, appContext.filesDir, appScope),
                    // Both are read during turns, after the hub exists.
                    hub = { hub },
                    // The debug fake agent runs the same tools as a real one, through the phone's MCP tool handler.
                    fakeTools = FakeTools { identity, name, args -> mcp.tools.callTool(identity, name, args, JsonObject(emptyMap())) },
                ),
                dataDir = appContext.filesDir,
                rukooSkills = RukooSkills.forApp(appContext.assets, appContext.filesDir),
                alerts = AgentNotifier(appContext, settingsSnapshot, screen) { hub.agentName(it) },
                strings = AndroidHubStrings(appContext),
                mcpUrl = { mcp.status.value.url },
                // An approved unsubscribe that needs the user: the sender's page in the browser (or a notification while
                // Rukoo is in the background), or its email in the composer when nothing else is in it.
                unsubscribe = ComposerUnsubscribeOpener(mail, composer, PageOpener(appContext, screen)::open, Dispatchers.Main.immediate),
                clock = clock,
                includeFake = BuildConfig.DEBUG,
            )
            hub
        }
    }

    // Made with the container, not lazily: it starts Rukoo's tools as soon as the app (or the boot receiver) runs.
    override val mcp: AndroidMcpController = AndroidMcpController(this)

    override val desktop: DesktopLink by lazy { HttpDesktopLink(agentSettings, http, { DesktopDevice.info(appContext) }, clock) }

    /**
     * The Rukoo account, with its records in files/account. Debug builds may also use a server over plain http on
     * this phone or the emulator's host (10.0.2.2), for `wrangler dev`.
     */
    override val account: AccountService by lazy {
        AccountService(
            dir = File(appContext.filesDir, "account"),
            secrets = SecretBox,
            defaultServer = BuildConfig.ACCOUNT_SERVER,
            deviceName = DesktopDevice.info(appContext).name,
            http = OkHttpAccountHttp(http),
            scope = appScope,
            devHosts = BuildConfig.DEBUG,
        )
    }

    override val categories: Categories by lazy {
        Categories(
            account = account,
            mail = EngineCategoryMail(mail, appScope),
            secrets = SecretBox,
            dir = File(appContext.filesDir, "account"),
            jev = Jev(http),
            texts = ResourceCategoryTexts(appContext),
            scope = appScope,
        )
    }

    /** OAuth returns that arrive as `rukoo-oauth:` deep links; the sign-in flow collects them. */
    val oauthReturns = MutableSharedFlow<Uri>(extraBufferCapacity = 1)

    init {
        // The account and the categories load their files off the main thread, and the account syncs on its schedule.
        if (!BuildConfig.USE_PREVIEW_MAIL) {
            appScope.launch(Dispatchers.IO) { categories }
            AccountBackground(appScope, { account }, { mail }).start()
        }
        // The language the user picks in Rukoo; LocaleManager keeps it, so only changes are applied.
        appScope.launch {
            settings.flow.map { it.language }.distinctUntilChanged().drop(1).collect { Locales.apply(appContext, it) }
        }
    }
}
