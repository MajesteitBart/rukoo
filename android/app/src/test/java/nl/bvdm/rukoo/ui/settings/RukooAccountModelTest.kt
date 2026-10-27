package nl.bvdm.rukoo.ui.settings

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import nl.bvdm.rukoo.AppServices
import nl.bvdm.rukoo.account.AccountService
import nl.bvdm.rukoo.account.FakeAccountServer
import nl.bvdm.rukoo.account.OkHttpAccountHttp
import nl.bvdm.rukoo.account.PlainSecrets
import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.AgentSettingsStore
import nl.bvdm.rukoo.agents.preview.PreviewAgentHub
import nl.bvdm.rukoo.desktop.DesktopLink
import nl.bvdm.rukoo.desktop.StubDesktopLink
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.demo.PreviewMailEngine
import nl.bvdm.rukoo.mcp.McpController
import nl.bvdm.rukoo.mcp.StubMcpController
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.settings.SettingsStore
import nl.bvdm.rukoo.ui.ComposerController
import nl.bvdm.rukoo.ui.ScreenState
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/** Settings > Rukoo account's model: after an action, the page shows what the server has now. */
@OptIn(ExperimentalCoroutinesApi::class)
class RukooAccountModelTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dir: File = Files.createTempDirectory("rukoo-account-model").toFile().apply { deleteOnExit() }
    private val server = FakeAccountServer()
    private val okhttp = OkHttpClient()

    private fun device(name: String) =
        AccountService(File(dir, name), PlainSecrets, server.url, name, OkHttpAccountHttp(okhttp), scope, devHosts = true, pushAfterMs = 60_000)

    private inner class Services(override val account: AccountService) : AppServices {
        override val mail: MailEngine = PreviewMailEngine()
        override val agents: AgentHub = PreviewAgentHub(scope)
        override val composer = ComposerController()
        override val screen = ScreenState()
        override val settings = SettingsStore(PreferenceDataStoreFactory.create(scope = scope) { File(dir, "s.preferences_pb") })
        override val settingsSnapshot: StateFlow<AppSettings> = MutableStateFlow(AppSettings())
        override val agentSettings = AgentSettingsStore(File(dir, "agents.json"), PlainSecrets)
        override val desktop: DesktopLink = StubDesktopLink(agentSettings)
        override val mcp: McpController = StubMcpController()
    }

    @Before
    fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        scope.cancel()
        server.close()
    }

    @Test
    fun `signing another device out takes it off the list at once`() = runBlocking {
        val phone = device("phone")
        phone.signUp("model@example.com", "a long enough password")
        val tablet = device("tablet")
        tablet.signIn("model@example.com", "a long enough password")
        val model = RukooAccountModel(Services(phone))
        model.fill(SettingsRoutes.RUKOO)
        withTimeout(10_000) { while (model.ui.value.details?.devices?.size != 2) delay(20) }

        val id = model.ui.value.details!!.devices.first { it.name == "tablet" }.id
        var failure: String? = null
        model.run({ it.removeDevice(id) }, failed = { failure = it })
        withTimeout(10_000) { while (model.ui.value.details?.devices?.size != 1) delay(20) }
        assertEquals(null, failure)
        assertEquals(listOf("phone"), model.ui.value.details!!.devices.map { it.name })
    }
}
