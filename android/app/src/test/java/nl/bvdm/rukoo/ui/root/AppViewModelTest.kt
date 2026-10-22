package nl.bvdm.rukoo.ui.root

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.nio.file.Files
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import nl.bvdm.rukoo.AppServices
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.AgentSettingsStore
import nl.bvdm.rukoo.agents.preview.PreviewAgentHub
import nl.bvdm.rukoo.core.SecretCipher
import nl.bvdm.rukoo.desktop.StubDesktopLink
import nl.bvdm.rukoo.mail.demo.PreviewMailEngine
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.mail.model.ViewKind
import nl.bvdm.rukoo.mcp.StubMcpController
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.settings.SettingsStore
import nl.bvdm.rukoo.ui.ComposerController
import nl.bvdm.rukoo.ui.ComposerState
import nl.bvdm.rukoo.ui.ScreenState
import nl.bvdm.rukoo.ui.composer.DraftStore
import nl.bvdm.rukoo.ui.mail.DialogChoice
import nl.bvdm.rukoo.ui.mail.UiStrings
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AppViewModelTest {
    private val main = UnconfinedTestDispatcher()

    @Before
    fun setUp() = Dispatchers.setMain(main)

    @After
    fun tearDown() = Dispatchers.resetMain()

    // Strings as "id|args", so a test can tell which text was chosen.
    private object Fake : UiStrings {
        override fun get(id: Int, vararg args: Any) = (listOf(id) + args).joinToString("|")
        override fun plural(id: Int, count: Int, vararg args: Any) = (listOf(id) + args).joinToString("|")
    }

    private class Services(dir: File, scope: CoroutineScope) : AppServices {
        override val mail = PreviewMailEngine(zone = ZoneId.of("Europe/Amsterdam"))
        override val agents = PreviewAgentHub(scope) { 1761130000000 }
        override val composer = ComposerController()
        override val screen = ScreenState()
        override val settings = SettingsStore(PreferenceDataStoreFactory.create(scope = scope) { File(dir, "settings.preferences_pb") })
        override val settingsSnapshot = MutableStateFlow(AppSettings())
        override val agentSettings = AgentSettingsStore(
            File(dir, "agents.json"),
            object : SecretCipher {
                override fun encrypt(plain: String) = plain
                override fun decrypt(blob: String) = blob
            },
        )
        override val desktop = StubDesktopLink(agentSettings)
        override val mcp = StubMcpController()
        override val drafts = DraftStore(null)
    }

    private fun TestScope.setup(twoPane: Boolean = false): Pair<Services, AppViewModel> {
        val services = Services(Files.createTempDirectory("rukoo-vm").toFile(), backgroundScope)
        val vm = AppViewModel(services)
        vm.mailUi.strings = Fake
        vm.onLayout(twoPane)
        return services to vm
    }

    @Test
    fun openingAnEmailMarksItReadAndTellsTheTools() = runTest(main) {
        val (s, vm) = setup()
        val unread = s.mail.listMessages(MailView.AllInboxes).first { it.unread }
        vm.openMessage(unread.id)
        assertFalse(s.mail.summary(unread.id)!!.unread)
        assertEquals(Pane.READER, vm.state.value.top)
        assertEquals(unread.id, s.screen.current.openMessageId)
        vm.toggleChecked("x")
        assertEquals(listOf("x"), s.screen.current.selectedIds)
    }

    @Test
    fun archivingTheOpenEmailGoesOnToTheNextAndUndoBringsItBack() = runTest(main) {
        val (s, vm) = setup(twoPane = true)
        val list = s.mail.listMessages(MailView.AllInboxes)
        vm.listShown(list.map { it.id })
        vm.openMessage(list[1].id)
        vm.mailUi.archive(listOf(list[1]))
        assertEquals(list[2].id, vm.state.value.openMessageId)
        vm.mailUi.toasts.current!!.onAction!!.invoke()
        // The restored copy has a new id and opens again, as it was open.
        val back = vm.state.value.openMessageId!!
        assertEquals(list[1].messageId, s.mail.summary(back)!!.messageId)
    }

    @Test
    fun backOnAComposerWithWordsAsksAndDontSaveDiscards() = runTest(main) {
        val (s, vm) = setup()
        vm.openComposer(ComposerState(subject = "Plan", body = "Thursday?", dirty = true))
        assertTrue(vm.backAsks())
        assertTrue(vm.back())
        val ask = vm.mailUi.dialog!!
        assertEquals("${R.string.composer_close_title}", ask.title)
        assertTrue(vm.state.value.composerOpen)
        ask.answer(DialogChoice.OTHER)
        assertFalse(vm.state.value.composerOpen)
        assertNull(s.composer.current())
        assertTrue(s.drafts.drafts.value.isEmpty())
    }

    @Test
    fun saveKeepsTheDraftAndACleanReopenStaysInDrafts() = runTest(main) {
        val (s, vm) = setup()
        val key = s.composer.open(ComposerState(to = listOf(Address("", "sanne@example.com")), body = "Notes", dirty = true))
        vm.closeComposer()
        vm.mailUi.dialog!!.answer(DialogChoice.CONFIRM)
        assertNull(s.composer.current())
        assertEquals(key, s.drafts.drafts.value.single().id)
        vm.openLocalDraft(key)
        assertFalse(s.composer.current()!!.dirty)
        vm.closeComposer()
        assertNull(vm.mailUi.dialog)
        assertEquals("${R.string.composer_status_kept}", vm.mailUi.toasts.current!!.message)
        assertEquals(1, s.drafts.drafts.value.size)
    }

    @Test
    fun anAgentsUntouchedDraftStillAsks() = runTest(main) {
        val (s, vm) = setup()
        s.composer.open(ComposerState(subject = "Re: Call", body = "Thursday works.", draftedBy = "Clark"))
        assertTrue(vm.composerAsks())
    }

    @Test
    fun anotherComposerParksTheUnsavedOne() = runTest(main) {
        val (s, vm) = setup()
        val first = s.composer.open(ComposerState(body = "half written", dirty = true))
        vm.openComposer(ComposerState(subject = "New"))
        assertEquals(first, s.drafts.drafts.value.single().id)
        assertEquals("New", s.composer.current()!!.subject)
    }

    @Test
    fun sendNeedsARecipientAsksAboutNoSubjectThenSends() = runTest(main) {
        val (s, vm) = setup()
        vm.newMessage()
        vm.send()
        assertEquals("${R.string.composer_errors_no_recipients}", vm.mailUi.toasts.current!!.message)
        s.composer.update { it.copy(to = listOf(Address("Sanne", "sanne@example.com")), body = "Hi", dirty = true) }
        vm.send()
        vm.mailUi.dialog!!.answer(DialogChoice.CONFIRM)
        assertNull(s.composer.current())
        assertEquals("${R.string.composer_status_sent}", vm.mailUi.toasts.current!!.message)
        assertEquals("Hi", s.mail.listMessages(MailView(ViewKind.SENT)).first().preview)
    }

    @Test
    fun addressesStillBeingTypedGoAlongWithSend() = runTest(main) {
        val (s, vm) = setup()
        val key = s.composer.open(ComposerState(accountId = "demo", to = listOf(Address("Sanne", "sanne@example.com")), subject = "Plan", body = "Hi"))
        vm.pendingRecipients[AppViewModel.pendingKey(key, "cc")] = "joris@example.com"
        vm.send()
        val sent = s.mail.listMessages(MailView(ViewKind.SENT)).first()
        assertEquals(listOf("joris@example.com"), sent.cc.map { it.address })
        assertTrue(vm.pendingRecipients.isEmpty())
    }

    @Test
    fun typedRecipientTextCountsAsUnsavedWords() = runTest(main) {
        val (s, vm) = setup()
        val key = s.composer.open(ComposerState())
        assertFalse(vm.composerAsks())
        vm.pendingRecipients[AppViewModel.pendingKey(key, "to")] = "sanne@exa"
        assertTrue(vm.composerAsks())
    }

    @Test
    fun tappingTheOpenDraftAgainKeepsItsEdits() = runTest(main) {
        val (s, vm) = setup()
        val key = s.composer.open(ComposerState(body = "first", dirty = true))
        vm.saveDraft()
        vm.openLocalDraft(key)
        s.composer.update { it.copy(body = "first and more", dirty = true) }
        vm.openLocalDraft(key)
        assertEquals("first and more", s.composer.current()!!.body)
    }

    @Test
    fun aReplyStartsWithTheReplyFieldsAndAQuote() = runTest(main) {
        val (s, vm) = setup()
        val sanne = s.mail.listMessages(MailView.AllInboxes).first { it.subject == "Call on Thursday" }
        vm.reply(sanne.id, ReplyKind.REPLY_ALL)
        val d = assertNotNullAndGet(s.composer.current())
        assertEquals("Re: Call on Thursday", d.subject)
        assertEquals(listOf("sanne@example.com"), d.to.map { it.address })
        assertEquals(listOf("joris@example.com"), d.cc.map { it.address })
        assertTrue(d.quote.startsWith("${R.string.composer_quote_marker}\n"))
        assertEquals(sanne.messageId, d.inReplyTo)
        assertTrue(vm.state.value.composerOpen)
    }

    private fun <T> assertNotNullAndGet(value: T?): T {
        assertNotNull(value)
        return value!!
    }
}
