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
import kotlinx.coroutines.withTimeoutOrNull
import nl.bvdm.rukoo.AppServices
import nl.bvdm.rukoo.R
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
import nl.bvdm.rukoo.ui.settings.RukooAccountModel.Form
import nl.bvdm.rukoo.ui.settings.RukooAccountModel.FormError
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * Settings > Rukoo account's model: after an action, the page shows what the server has now; an unlock code step
 * doesn't stop a sign-in once the lock is over; and folding keeps a form's code step, its Locked offer and a code on
 * its way, which leaving the form drops.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RukooAccountModelTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dir: File = Files.createTempDirectory("rukoo-account-model").toFile().apply { deleteOnExit() }
    private val server = FakeAccountServer(codes = true)
    private val okhttp = OkHttpClient()

    private fun device(name: String, at: String = server.url) =
        AccountService(File(dir, name), PlainSecrets, at, name, OkHttpAccountHttp(okhttp), scope, devHosts = true, pushAfterMs = 60_000)

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

    private suspend fun until(check: () -> Boolean) = withTimeout(10_000) { while (!check()) delay(20) }

    // A model on the Sign in form of an account that ten wrong passwords locked, showing the Locked offer.
    private suspend fun lockedSignIn(email: String): Pair<RukooAccountModel, AccountService> {
        val first = device("first-$email")
        first.signUp(email, PASSWORD)
        first.signOut()
        server.lock(email)
        val phone = device("phone-$email")
        phone.serverInfo()
        val model = RukooAccountModel(Services(phone))
        model.entered(Form.SIGN_IN)
        model.fields["email"] = email
        model.fields["password"] = PASSWORD
        model.submit(Form.SIGN_IN) {}
        until { model.ui.value.formError == FormError.Locked && !model.ui.value.working }
        return model to phone
    }

    private fun logins() = server.calls.count { it.route == "POST /v1/login" }

    @Test
    fun `an unlock code step lets an empty code go, so the sign-in works once the lock is over`() = runBlocking<Unit> {
        val (model, phone) = lockedSignIn("later@example.com")
        model.sendCode(Form.SIGN_IN, "en")
        until { model.ui.value.code != null && !model.ui.value.working }
        // Still locked: the empty field goes to the server, which says so, and the form asks for the code.
        val before = logins()
        model.submit(Form.SIGN_IN) {}
        until { model.ui.value.formError == FormError.Text(R.string.settings_rukoo_code_missing) && !model.ui.value.working }
        assertEquals(before + 1, logins())
        assertNotNull(model.ui.value.code)
        // The 15 minutes are over: the same empty field signs in.
        server.unlock("later@example.com")
        model.submit(Form.SIGN_IN) {}
        until { phone.signedIn && !model.ui.value.working }
        assertNull(model.ui.value.code)
    }

    @Test
    fun `folding keeps the Locked offer, a code on its way and the code step, and leaving drops the unlock step`() = runBlocking<Unit> {
        val (model, _) = lockedSignIn("fold@example.com")
        // A fold composes the page again in the other layout: the same visit.
        model.entered(Form.SIGN_IN)
        assertEquals(FormError.Locked, model.ui.value.formError)

        val gate = server.holdNext("POST /v1/email-code")
        model.sendCode(Form.SIGN_IN, "en")
        withTimeout(10_000) { while (server.calls.none { it.route == "POST /v1/email-code" }) delay(10) }
        model.entered(Form.SIGN_IN)
        gate.countDown()
        until { model.ui.value.code?.form == Form.SIGN_IN && !model.ui.value.working }
        model.fields["emailCode"] = "12"
        model.entered(Form.SIGN_IN)
        assertEquals("fold@example.com", model.ui.value.code?.email)
        assertEquals("12", model.fields["emailCode"])

        // Going back ends the visit: the unlock step goes, and the next visit starts without an error.
        model.left(Form.SIGN_IN)
        assertNull(model.ui.value.code)
        assertNull(model.fields["emailCode"])
        model.entered(Form.SIGN_IN)
        assertNull(model.ui.value.formError)
    }

    @Test
    fun `a code on its way for one form changes nothing once another form opens`() = runBlocking<Unit> {
        val (model, _) = lockedSignIn("switch@example.com")
        val gate = server.holdNext("POST /v1/email-code")
        model.sendCode(Form.SIGN_IN, "en")
        withTimeout(10_000) { while (server.calls.none { it.route == "POST /v1/email-code" }) delay(10) }
        model.entered(Form.RECOVER)
        gate.countDown()
        until { !model.ui.value.working }
        assertNull(model.ui.value.code)
    }

    // Waits for a code step to show, or for 2 seconds: an answer that should change nothing gets the time to arrive.
    private suspend fun stepAfterAWhile(model: RukooAccountModel) =
        withTimeoutOrNull(2_000) { while (model.ui.value.code == null) delay(20) }.let { model.ui.value.code }

    @Test
    fun `a sign-up code step goes when the server changes, also one still on its way`() = runBlocking<Unit> {
        val a = FakeAccountServer(signups = "verified", codes = true)
        val b = FakeAccountServer(signups = "verified", codes = true)
        try {
            val phone = device("servers", a.url)
            phone.serverInfo()
            val model = RukooAccountModel(Services(phone))
            fun changeServer(url: String) {
                var failure: String? = null
                model.setServer(url, failed = { failure = it }) {}
                assertNull(failure)
            }
            model.entered(Form.SIGN_UP)
            model.fields["email"] = "alice@example.com"
            model.sendCode(Form.SIGN_UP, "en")
            until { model.ui.value.code != null && !model.ui.value.working }
            assertEquals(1, a.calls.count { it.route == "POST /v1/email-code" })

            // Back to Rukoo account, which keeps a sign-up's step, then another server and Create account again.
            model.left(Form.SIGN_UP)
            changeServer(b.url)
            model.entered(Form.SIGN_UP)
            assertNull(model.ui.value.code)

            // The submit asks this server for a code, and its code signs up here.
            model.fields["password"] = PASSWORD
            model.fields["repeat"] = PASSWORD
            model.fields["understand"] = "on"
            model.submit(Form.SIGN_UP) {}
            until { model.ui.value.code != null && !model.ui.value.working }
            assertEquals(1, b.calls.count { it.route == "POST /v1/email-code" })

            // A request on its way while the server changes: its answer doesn't show a step for the server before.
            model.left(Form.SIGN_UP)
            changeServer(a.url)
            model.entered(Form.SIGN_UP)
            assertNull(model.ui.value.code)
            val gate = a.holdNext("POST /v1/email-code")
            model.sendCode(Form.SIGN_UP, "en")
            withTimeout(10_000) { while (a.calls.count { it.route == "POST /v1/email-code" } < 2) delay(10) }
            changeServer(b.url)
            gate.countDown()
            assertNull(stepAfterAWhile(model))

            model.sendCode(Form.SIGN_UP, "en")
            until { model.ui.value.code != null && !model.ui.value.working }
            model.fields["emailCode"] = b.codeFor("alice@example.com")!!
            model.submit(Form.SIGN_UP) {}
            until { phone.signedIn && !model.ui.value.working }
            assertEquals(b.url, phone.server)
        } finally {
            a.close()
            b.close()
        }
    }

    private companion object {
        const val PASSWORD = "a long enough password"
    }
}
