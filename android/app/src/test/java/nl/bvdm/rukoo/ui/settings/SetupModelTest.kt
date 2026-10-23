package nl.bvdm.rukoo.ui.settings

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import nl.bvdm.rukoo.AppServices
import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.AgentSettingsStore
import nl.bvdm.rukoo.agents.ClarkSettings
import nl.bvdm.rukoo.agents.PairedComputer
import nl.bvdm.rukoo.agents.preview.PreviewAgentHub
import nl.bvdm.rukoo.core.SecretCipher
import nl.bvdm.rukoo.desktop.DesktopLink
import nl.bvdm.rukoo.desktop.ExportBundle
import nl.bvdm.rukoo.desktop.HelloResponse
import nl.bvdm.rukoo.desktop.StubDesktopLink
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.demo.PreviewMailEngine
import nl.bvdm.rukoo.mcp.McpController
import nl.bvdm.rukoo.mcp.StubMcpController
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.settings.SettingsStore
import nl.bvdm.rukoo.ui.ComposerController
import nl.bvdm.rukoo.ui.ScreenState
import nl.bvdm.rukoo.ui.settings.SetupModel.PairStep
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SetupModelTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private val gates = mutableMapOf<String, CompletableDeferred<HelloResponse>>()

    private val plain = object : SecretCipher {
        override fun encrypt(plain: String) = plain
        override fun decrypt(blob: String) = blob
    }

    private val dir: File = Files.createTempDirectory("rukoo-setup").toFile().apply { deleteOnExit() }
    private val store = AgentSettingsStore(File(dir, "agents.json"), plain)

    private val pairGates = mutableMapOf<String, CompletableDeferred<PairedComputer>>()

    /** hello() and pair() wait until the test answers for that computer or address. */
    private inner class GatedLink : DesktopLink by StubDesktopLink(store) {
        override suspend fun hello(pairingId: String): HelloResponse = gates.getOrPut(pairingId) { CompletableDeferred() }.await()

        override suspend fun pair(address: String, code: String): PairedComputer = pairGates.getOrPut(address) { CompletableDeferred() }.await()

        override suspend fun export(pairingId: String): ExportBundle = ExportBundle()
    }

    private inner class Services : AppServices {
        override val mail: MailEngine = PreviewMailEngine()
        override val agents: AgentHub = PreviewAgentHub(scope)
        override val composer = ComposerController()
        override val screen = ScreenState()
        override val settings = SettingsStore(PreferenceDataStoreFactory.create(scope = scope) { File(dir, "s.preferences_pb") })
        override val settingsSnapshot: StateFlow<AppSettings> = MutableStateFlow(AppSettings())
        override val agentSettings = store
        override val desktop: DesktopLink = GatedLink()
        override val mcp: McpController = StubMcpController()
    }

    @Before
    fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        scope.cancel()
    }

    private fun computer(id: String, export: Long? = null) = PairedComputer(id, "desktop-$id", "100.64.0.${id.length}", exportUntil = export)

    @Test
    fun aLateAnswerDoesntOverwriteTheNextComputer() {
        val model = SetupModel(Services())
        val a = computer("ph_aaaaaaaaaa")
        val b = computer("ph_bbbbbbbbbb")
        model.offerImport(a)
        model.resetPair()
        model.offerImport(b)
        gates.getValue(b.pairingId).complete(HelloResponse(pairingId = b.pairingId, exportUntil = 1L))
        assertEquals(b, model.pair.value.computer)
        assertTrue(model.pair.value.exportOpen)

        // A's check answers after the user moved on: closed, which would hide B's import.
        gates.getValue(a.pairingId).complete(HelloResponse(pairingId = a.pairingId, exportUntil = null))
        assertEquals(b, model.pair.value.computer)
        assertEquals(PairStep.PAIRED, model.pair.value.step)
        assertTrue(model.pair.value.exportOpen)
        // The answer still counts for A's row in Settings.
        assertEquals(null, model.hellos.value.getValue(a.pairingId).hello!!.exportUntil)
    }

    @Test
    fun resetLeavesTheFormEmpty() {
        val model = SetupModel(Services())
        val a = computer("ph_aaaaaaaaaa", export = 5L)
        model.offerImport(a)
        model.resetPair()
        gates.getValue(a.pairingId).complete(HelloResponse(pairingId = a.pairingId, exportUntil = 5L))
        assertEquals(PairStep.FORM, model.pair.value.step)
        assertEquals(null, model.pair.value.computer)
    }

    @Test
    fun aFirstRunImportMovesOnToSettings() {
        val model = SetupModel(Services())
        assertFalse(model.importLeavesSettings)
        model.continueImportInSettings()
        assertTrue(model.importLeavesSettings)
        assertEquals(listOf(SettingsRoutes.IMPORT), model.settingsStack.value)
        model.settingsClosed()
        assertFalse(model.importLeavesSettings)
        assertTrue(model.settingsStack.value.isEmpty())
    }

    @Test
    fun draftsLastUntilSettingsCloses() {
        val model = SetupModel(Services())
        model.drafts[SetupModel.DRAFT_IMAP + "other:password"] = "secret"
        model.drafts[SetupModel.DRAFT_AGENT + "clark:url:1"] = "http://100.64.0.1:8642"
        model.clearDrafts(SetupModel.DRAFT_IMAP)
        assertEquals(setOf(SetupModel.DRAFT_AGENT + "clark:url:1"), model.drafts.keys)
        model.settingsClosed()
        assertTrue(model.drafts.isEmpty())
    }

    @Test
    fun aNewStoredConfigurationDropsTheCardsDrafts() {
        val model = SetupModel(Services())
        val k = SetupModel.DRAFT_AGENT + "clark:"
        // Two URLs with the same String.hashCode(): only equals tells them apart.
        val a = ClarkSettings(url = "http://an.example:8642")
        val b = ClarkSettings(url = "http://c0.example:8642")
        assertEquals("an".hashCode(), "c0".hashCode())
        model.rebaseDrafts(k, a)
        model.drafts[k + "key"] = "typed for a"
        model.rebaseDrafts(k, a)
        assertEquals("typed for a", model.drafts[k + "key"])
        model.rebaseDrafts(k, b)
        assertFalse(k + "key" in model.drafts)
    }

    @Test
    fun anImportDropsAgentDraftsEvenWithTheCardClosed() {
        val services = Services()
        val model = SetupModel(services)
        model.drafts[SetupModel.DRAFT_AGENT + "clark:key"] = "typed before the import"
        model.offerImport(computer("ph_aaaaaaaaaa", export = 5L))
        gates.getValue("ph_aaaaaaaaaa").complete(HelloResponse(pairingId = "ph_aaaaaaaaaa", exportUntil = 5L))
        model.importFrom()
        val deadline = System.currentTimeMillis() + 5_000
        while (model.pair.value.step != PairStep.DONE && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertEquals(model.pair.value.error?.toString(), PairStep.DONE, model.pair.value.step)
        assertTrue(model.drafts.keys.none { it.startsWith(SetupModel.DRAFT_AGENT) })
    }

    @Test
    fun resettingThePairingDropsItsCode() {
        val model = SetupModel(Services())
        model.drafts[SetupModel.DRAFT_PAIR + "code"] = "K7QM-2XPA"
        model.drafts[SetupModel.DRAFT_IMAP + "other:email"] = "me@example.nl"
        model.resetPair()
        assertEquals(setOf(SetupModel.DRAFT_IMAP + "other:email"), model.drafts.keys)
    }

    @Test
    fun aStalePairingKeepsTheNewerFlowsFields() {
        val model = SetupModel(Services())
        model.pair("100.64.0.1", "K7QM-2XPA")
        model.resetPair()
        // The user starts again for another computer and types into the form.
        model.drafts[SetupModel.DRAFT_PAIR + "address"] = "100.64.0.2"
        pairGates.getValue("100.64.0.1").complete(computer("ph_aaaaaaaaaa"))
        assertEquals("100.64.0.2", model.drafts[SetupModel.DRAFT_PAIR + "address"])
        assertEquals(PairStep.FORM, model.pair.value.step)
    }
}
