package nl.bvdm.rukoo.desktop

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import nl.bvdm.rukoo.agents.AgentSettings
import nl.bvdm.rukoo.agents.AgentSettingsStore
import nl.bvdm.rukoo.agents.ClarkSettings
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.ComputerProgram
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.core.SecretCipher
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.MailException
import nl.bvdm.rukoo.mail.demo.PreviewMailEngine
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.GoogleClient
import nl.bvdm.rukoo.mail.model.ImportedAccount
import nl.bvdm.rukoo.mail.model.MailPrefs
import nl.bvdm.rukoo.mail.model.SortOrder
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.settings.Density
import nl.bvdm.rukoo.settings.Language
import nl.bvdm.rukoo.settings.SettingsStore
import nl.bvdm.rukoo.settings.ThemeMode
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DesktopImportTest {
    private val bundle = RukooJson.decodeFromString(ExportBundle.serializer(), ExportFixtures.BUNDLE)
    private val pairing = "ph_k3j9x0m2qa"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @After
    fun tearDown() = scope.cancel()

    @Test
    fun accountsWithoutASecretAreReportedNotAdded() {
        val (accounts, skipped) = DesktopImport.accounts(bundle)
        assertEquals(listOf("bart@example.nl", "bart@gmail.com"), accounts.map { it.email })
        assertEquals(listOf(SkippedAccount("old@yahoo.com", SkipReason.NO_SECRET)), skipped)
    }

    @Test
    fun theDemoAccountStaysOnTheComputer() {
        val demo = ImportedAccount(id = "demo", type = nl.bvdm.rukoo.mail.model.AccountType.DEMO, auth = nl.bvdm.rukoo.mail.model.AuthKind.NONE, email = "demo@example.com")
        val (accounts, skipped) = DesktopImport.accounts(bundle.copy(accounts = listOf(demo)))
        assertTrue(accounts.isEmpty())
        assertTrue(skipped.isEmpty())
    }

    @Test
    fun accountsOnTheGeneralSignatureStayOnIt() {
        val (accounts, _) = DesktopImport.accounts(bundle)
        // The engine keeps the general signature, so an account without its own keeps using it.
        assertNull(accounts[0].signature)
        assertNull(accounts[0].signatureHtml)
        assertEquals("Groet, Bart", accounts[1].signature)
    }

    @Test
    fun mailPrefsJoinThePhonesAndTakeTheGeneralSignature() {
        val exported = bundle.settings.copy(vips = listOf("Sanne@Example.nl", "anna@example.nl"), spam = listOf("deals@shop.example"))
        val phone = MailPrefs(vips = listOf("anna@example.nl"), spam = emptyList(), signature = "Old", signatureHtml = "")
        val next = DesktopImport.prefs(exported, phone)
        assertEquals(listOf("anna@example.nl", "sanne@example.nl"), next.vips)
        assertEquals(listOf("deals@shop.example"), next.spam)
        assertEquals("Bart van der Meeren", next.signature)
        assertEquals("", next.signatureHtml)
        // A computer without a general signature leaves the phone's.
        assertEquals("Old", DesktopImport.prefs(exported.copy(signature = "", signatureHtml = null), phone).signature)
    }

    @Test
    fun agentsComeOverWhenThePhoneCanReachThem() {
        val result = DesktopImport.agents(bundle, AgentSettings(), pairing)
        val clark = result.settings.clark
        assertTrue(result.clark)
        assertEquals("Clark", clark.name)
        assertEquals("http://100.91.52.84:8642", clark.url)
        assertEquals("hermes-key", clark.key)
        // OpenClaw sits on the computer's loopback with no token: desktop's default, not something to report.
        assertFalse(result.openclaw)
        assertTrue(result.localOnly.isEmpty())
        assertEquals(AgentIds.computer(pairing, ComputerProgram.CLAUDE), result.settings.defaultAgent)
        assertTrue(result.settings.autoMailActions)
    }

    @Test
    fun aLoopbackAgentWithATokenIsNamed() {
        val withToken = bundle.copy(agents = bundle.agents.copy(openclaw = bundle.agents.openclaw!!.copy(key = "gw")))
        val result = DesktopImport.agents(withToken, AgentSettings(), pairing)
        assertFalse(result.openclaw)
        assertEquals(listOf("OpenClaw"), result.localOnly)
    }

    @Test
    fun anEmptyKeyKeepsThePhonesKeyForTheSameServer() {
        val noKey = bundle.copy(agents = bundle.agents.copy(clark = bundle.agents.clark!!.copy(key = "")))
        val current = AgentSettings(clark = ClarkSettings(name = "Clark", url = "http://100.91.52.84:8642", key = "phone-key"))
        assertEquals("phone-key", DesktopImport.agents(noKey, current, pairing).settings.clark.key)
        val elsewhere = current.copy(clark = current.clark.copy(url = "http://100.1.2.3:8642"))
        assertEquals("", DesktopImport.agents(noKey, elsewhere, pairing).settings.clark.key)
    }

    @Test
    fun theOpenClawPhoneSwitchStaysThePhones() {
        val remote = bundle.copy(agents = bundle.agents.copy(openclaw = ExportedOpenClaw(url = "http://100.64.0.9:18789", key = "gw", agent = "main")))
        val current = AgentSettings(openclaw = nl.bvdm.rukoo.agents.OpenClawSettings(remote = true))
        val result = DesktopImport.agents(remote, current, pairing)
        assertTrue(result.openclaw)
        assertEquals("gw", result.settings.openclaw.token)
        assertEquals("main", result.settings.openclaw.agentId)
        assertTrue(result.settings.openclaw.remote)
    }

    @Test
    fun appSettingsFollowTheComputer() {
        val next = DesktopImport.appSettings(bundle.settings, AppSettings(), "en", mapOf("acc-google" to "phone-google"))
        assertEquals(ThemeMode.DARK, next.theme)
        assertEquals(Language.NL, next.language)
        assertFalse(next.darkEmails)
        assertFalse(next.swipeActions)
        assertTrue(next.notifyMail)
        assertEquals(15, next.syncMinutes)
        assertEquals(Density.COMPACT, next.density)
        assertEquals(SortOrder.UNREAD, next.sort)
        assertEquals("phone-google", next.defaultAccountId)
    }

    @Test
    fun theLanguageOnlyComesOverWhileThePhoneFollowsTheSystem() {
        // Dutch on a Dutch phone: the phone keeps following the system.
        assertEquals(Language.SYSTEM, DesktopImport.appSettings(bundle.settings, AppSettings(), "nl", emptyMap()).language)
        // A language the user chose on the phone stays.
        assertEquals(Language.EN, DesktopImport.appSettings(bundle.settings, AppSettings(language = Language.EN), "en", emptyMap()).language)
        // An unknown default account leaves the phone's.
        assertEquals("mine", DesktopImport.appSettings(bundle.settings, AppSettings(defaultAccountId = "mine"), "en", emptyMap()).defaultAccountId)
    }

    // ---------- apply ----------

    private class FakeMail : MailEngine by PreviewMailEngine() {
        val list = MutableStateFlow<List<Account>>(emptyList())
        override val accounts: StateFlow<List<Account>> get() = list
        var imported: List<ImportedAccount>? = null
        var importClient: GoogleClient? = null
        var client: GoogleClient? = null
        var failure: MailException? = null

        override suspend fun importAccounts(imported: List<ImportedAccount>, googleClient: GoogleClient?): List<Account> {
            failure?.let { throw it }
            this.imported = imported
            importClient = googleClient
            val added = imported.filter { i -> list.value.none { it.email.equals(i.email, ignoreCase = true) } }.map {
                Account(id = "phone-${it.id}", type = it.type, provider = it.provider, auth = it.auth, email = it.email, name = it.name)
            }
            list.value = list.value + added
            return added
        }

        override suspend fun setGoogleClient(client: GoogleClient) {
            this.client = client
        }

        var mailPrefs = MailPrefs()
        var refuseHtml = false

        // As the real engine: an HTML signature it can't keep fails the whole update.
        override suspend fun updatePrefs(transform: (MailPrefs) -> MailPrefs): MailPrefs {
            val next = transform(mailPrefs)
            if (refuseHtml && next.signatureHtml.isNotEmpty()) throw MailException("The signature is too large.", code = "signature")
            mailPrefs = next
            return next
        }
    }

    private val identity = object : SecretCipher {
        override fun encrypt(plain: String) = plain
        override fun decrypt(blob: String) = blob
    }

    private fun stores(): Pair<AgentSettingsStore, SettingsStore> {
        val dir: File = Files.createTempDirectory("rukoo-import").toFile().apply { deleteOnExit() }
        val agents = AgentSettingsStore(File(dir, "agents.json"), identity)
        val settings = SettingsStore(PreferenceDataStoreFactory.create(scope = scope) { File(dir, "settings.preferences_pb") })
        return agents to settings
    }

    @Test
    fun applyBringsEverythingOver() = runBlocking {
        val mail = FakeMail()
        val (agents, settings) = stores()
        val result = DesktopImport.apply(bundle, pairing, mail, agents, settings, systemLanguage = "en")

        assertEquals(listOf("bart@example.nl", "bart@gmail.com"), result.added.map { it.email })
        assertEquals(0, result.alreadyHere)
        assertEquals(1, result.skipped.size)
        assertTrue(result.clark)
        assertTrue(result.googleClient)
        assertNull(result.accountError)
        assertEquals("client-id.apps.googleusercontent.com", mail.client!!.clientId)
        assertEquals(mail.client, mail.importClient)
        assertEquals("hermes-key", agents.current().clark.key)
        val app = settings.current()
        assertEquals("phone-acc-google", app.defaultAccountId)
        assertEquals(Language.NL, app.language)
        // The general signature went to the engine, not onto the accounts.
        assertEquals("Bart van der Meeren", mail.mailPrefs.signature)
        assertNull(mail.imported!!.first { it.email == "bart@example.nl" }.signature)
    }

    @Test
    fun aSignatureTheEngineRefusesLeavesTheListsAndItsText() = runBlocking {
        val mail = FakeMail().apply { refuseHtml = true }
        val (agents, settings) = stores()
        val html = bundle.copy(settings = bundle.settings.copy(signatureHtml = "<p>Bart</p>", vips = listOf("sanne@example.nl")))
        val result = DesktopImport.apply(html, pairing, mail, agents, settings, systemLanguage = "en")
        assertEquals(listOf("sanne@example.nl"), mail.mailPrefs.vips)
        assertEquals("Bart van der Meeren", mail.mailPrefs.signature)
        assertEquals("", mail.mailPrefs.signatureHtml)
        assertEquals(2, result.added.size)
    }

    @Test
    fun accountsAlreadyHereAreCounted() = runBlocking {
        val mail = FakeMail()
        mail.list.value = listOf(Account(id = "mine", type = nl.bvdm.rukoo.mail.model.AccountType.IMAP, provider = "google", auth = nl.bvdm.rukoo.mail.model.AuthKind.OAUTH2, email = "Bart@Gmail.com", name = "Bart"))
        val (agents, settings) = stores()
        val result = DesktopImport.apply(bundle, pairing, mail, agents, settings, systemLanguage = "en")
        assertEquals(listOf("bart@example.nl"), result.added.map { it.email })
        assertEquals(1, result.alreadyHere)
        assertEquals("mine", settings.current().defaultAccountId)
    }

    @Test
    fun aMailFailureLeavesTheRestImported() = runBlocking {
        val mail = FakeMail().apply { failure = MailException("Sign-in failed.") }
        val (agents, settings) = stores()
        val result = DesktopImport.apply(bundle, pairing, mail, agents, settings, systemLanguage = "en")
        assertEquals("Sign-in failed.", result.accountError!!.message)
        assertTrue(result.added.isEmpty())
        assertEquals("http://100.91.52.84:8642", agents.current().clark.url)
        assertEquals(ThemeMode.DARK, settings.current().theme)
    }
}
