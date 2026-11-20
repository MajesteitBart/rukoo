package nl.bvdm.rukoo.ui.root

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.nio.file.Files
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import nl.bvdm.rukoo.AppServices
import nl.bvdm.rukoo.NotificationRoute
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.AgentSettingsStore
import nl.bvdm.rukoo.agents.preview.PreviewAgentHub
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.core.SecretCipher
import nl.bvdm.rukoo.desktop.StubDesktopLink
import nl.bvdm.rukoo.mail.demo.PreviewMailEngine
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.ViewKind
import nl.bvdm.rukoo.mcp.StubMcpController
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.settings.SettingsStore
import nl.bvdm.rukoo.ui.ComposerController
import nl.bvdm.rukoo.ui.ScreenState
import nl.bvdm.rukoo.ui.chat.ChatFilter
import nl.bvdm.rukoo.ui.chat.ChatListModel
import nl.bvdm.rukoo.ui.composer.DraftStore
import nl.bvdm.rukoo.ui.mail.UiStrings
import nl.bvdm.rukoo.workspaces.ChatState
import nl.bvdm.rukoo.workspaces.Draft
import nl.bvdm.rukoo.workspaces.Invite
import nl.bvdm.rukoo.workspaces.InviteLink
import nl.bvdm.rukoo.workspaces.InvitePreview
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.Mention
import nl.bvdm.rukoo.workspaces.ResendMode
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind
import nl.bvdm.rukoo.workspaces.RoomMember
import nl.bvdm.rukoo.workspaces.RoomTimeline
import nl.bvdm.rukoo.workspaces.ThreadTimeline
import nl.bvdm.rukoo.workspaces.WorkspaceStatus
import nl.bvdm.rukoo.workspaces.WorkspaceSummary
import nl.bvdm.rukoo.workspaces.WorkspaceView
import nl.bvdm.rukoo.workspaces.Workspaces
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Chat's navigation (android.md "Where Chat lives"): the pure functions on NavState, then the view model's watchers. */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatNavTest {
    private val start = NavState()
    private val inChat = start.setMode(AppMode.CHAT).selectWorkspace("w1")

    // ---- pure functions ----

    @Test
    fun `setMode switches and closes the drawer and sheets, and keeps what each mode had open`() {
        val chat = start.openMessage("m1").copy(drawerOpen = true).setMode(AppMode.CHAT)
        assertEquals(AppMode.CHAT, chat.mode)
        assertFalse(chat.drawerOpen)
        assertEquals("m1", chat.openMessageId)
        val roomOpen = chat.selectWorkspace("w1").openRoom("c1").openChatSheet(ChatSheet.DETAILS, "c1")
        val mail = roomOpen.setMode(AppMode.MAIL)
        assertEquals(AppMode.MAIL, mail.mode)
        assertNull("sheets belong to the mode that showed them", mail.chat.sheet)
        assertEquals("c1", mail.chat.roomId)
        assertEquals("m1", mail.openMessageId)
        // Coming back shows the room again.
        assertEquals(ChatPane.ROOM, mail.setMode(AppMode.CHAT).chat.top)
        // The mode on screen changes nothing.
        assertSame(mail, mail.setMode(AppMode.MAIL))
    }

    @Test
    fun `selectWorkspace starts the new workspace at its list, and the same one only closes the drawer`() {
        val busy = inChat.openRoom("c1").openThread("e1").setChatFilter(ChatFilter.UNREAD).copy(drawerOpen = true)
        val other = busy.selectWorkspace("w2")
        assertEquals("w2", other.chat.workspaceId)
        assertNull(other.chat.roomId)
        assertNull(other.chat.threadRoot)
        assertEquals(listOf(ChatPane.HOME), other.chat.stack)
        assertEquals(ChatFilter.ALL, other.chat.filter)
        assertFalse(other.drawerOpen)
        val same = busy.selectWorkspace("w1")
        assertEquals("c1", same.chat.roomId)
        assertEquals("e1", same.chat.threadRoot)
        assertFalse(same.drawerOpen)
    }

    @Test
    fun `openRoom pushes the room over the list and closes a thread and a sheet`() {
        val s = inChat.openRoom("c1").openThread("e1").openChatSheet(ChatSheet.MEMBERS, "c1").openRoom("c2")
        assertEquals("c2", s.chat.roomId)
        assertNull(s.chat.threadRoot)
        assertEquals(listOf(ChatPane.HOME, ChatPane.ROOM), s.chat.stack)
        assertEquals(ChatPane.ROOM, s.chat.lastInteracted)
        assertNull(s.chat.sheet)
    }

    @Test
    fun `openThread needs a room and pushes the thread, closeThread pops it`() {
        assertSame(inChat, inChat.openThread("e1"))
        val thread = inChat.openRoom("c1").openThread("e1")
        assertEquals("e1", thread.chat.threadRoot)
        assertEquals(listOf(ChatPane.HOME, ChatPane.ROOM, ChatPane.THREAD), thread.chat.stack)
        assertEquals(ChatPane.THREAD, thread.chat.lastInteracted)
        val closed = thread.closeThread()
        assertNull(closed.chat.threadRoot)
        assertEquals(listOf(ChatPane.HOME, ChatPane.ROOM), closed.chat.stack)
        assertEquals(ChatPane.ROOM, closed.chat.lastInteracted)
        assertEquals("c1", closed.chat.roomId)
        assertSame(closed, closed.closeThread())
    }

    @Test
    fun `roomGone goes back to the list, and closes a sheet about that room`() {
        val s = inChat.openRoom("c1").openThread("e1")
        val gone = s.roomGone("c1")
        assertNull(gone.chat.roomId)
        assertNull(gone.chat.threadRoot)
        assertEquals(listOf(ChatPane.HOME), gone.chat.stack)
        assertEquals("w1", gone.chat.workspaceId)
        // Another room going changes nothing here, except a sheet that was about it.
        assertSame(s, s.roomGone("c9"))
        val sheet = s.openChatSheet(ChatSheet.DETAILS, "c9").roomGone("c9")
        assertNull(sheet.chat.sheet)
        assertEquals("c1", sheet.chat.roomId)
    }

    @Test
    fun `workspaceGone clears what was open in it`() {
        val s = inChat.openRoom("c1").openChatSheet(ChatSheet.INVITE)
        val gone = s.workspaceGone("w1")
        assertEquals(ChatNav(), gone.chat)
        assertEquals(AppMode.CHAT, gone.mode)
        assertSame(s, s.workspaceGone("w2"))
    }

    @Test
    fun `Back on one pane walks thread, room and list, then lands in Mail`() {
        val s = inChat.openRoom("c1").openThread("e1")
        val room = s.back(twoPane = false)!!
        assertEquals(ChatPane.ROOM, room.chat.top)
        val list = room.back(twoPane = false)!!
        assertEquals(ChatPane.HOME, list.chat.top)
        // The room stays selected, so unfolding shows it next to the list.
        assertEquals("c1", list.chat.roomId)
        val mail = list.back(twoPane = false)!!
        assertEquals(AppMode.MAIL, mail.mode)
        // In Mail, Back behaves as before: at the root the system leaves the app.
        assertNull(mail.back(twoPane = false))
    }

    @Test
    fun `Back on two panes closes the thread, then lands in Mail`() {
        val s = inChat.openRoom("c1").openThread("e1")
        val noThread = s.back(twoPane = true)!!
        assertNull(noThread.chat.threadRoot)
        assertEquals(AppMode.CHAT, noThread.mode)
        val mail = noThread.back(twoPane = true)!!
        assertEquals(AppMode.MAIL, mail.mode)
        assertEquals("c1", mail.chat.roomId)
        assertNull(mail.back(twoPane = true))
    }

    @Test
    fun `Back closes a sheet, the drawer and an overlay before any pane`() {
        val s = inChat.openRoom("c1").openChatSheet(ChatSheet.DETAILS, "c1").copy(drawerOpen = true)
        val noSheet = s.back(twoPane = false)!!
        assertNull(noSheet.chat.sheet)
        assertTrue(noSheet.drawerOpen)
        val noDrawer = noSheet.back(twoPane = false)!!
        assertFalse(noDrawer.drawerOpen)
        assertEquals(ChatPane.ROOM, noDrawer.chat.top)
        val settings = noDrawer.openOverlay(Overlay.SETTINGS)
        assertNull(settings.back(twoPane = true)!!.overlay)
        assertEquals(AppMode.CHAT, settings.back(twoPane = true)!!.mode)
    }

    @Test
    fun `chatTwoPanes shows the list and the room, or the room and its thread`() {
        assertEquals(ChatLayout(ChatPane.HOME, ChatPane.ROOM), inChat.chatTwoPanes())
        assertEquals(ChatLayout(ChatPane.HOME, ChatPane.ROOM), inChat.openRoom("c1").chatTwoPanes())
        assertEquals(ChatLayout(ChatPane.ROOM, ChatPane.THREAD), inChat.openRoom("c1").openThread("e1").chatTwoPanes())
    }

    @Test
    fun `chatFolded brings the pane touched last to the front, and a focused composer wins`() {
        val thread = inChat.openRoom("c1").openThread("e1")
        assertEquals(listOf(ChatPane.HOME, ChatPane.ROOM, ChatPane.THREAD), thread.chatFolded().chat.stack)
        assertEquals(ChatPane.ROOM, thread.chatInteracted(ChatPane.ROOM).chatFolded().chat.top)
        assertEquals(listOf(ChatPane.HOME), inChat.openRoom("c1").chatInteracted(ChatPane.HOME).chatFolded().chat.stack)
        // The room's composer has focus while the list was touched last.
        assertEquals(ChatPane.ROOM, inChat.openRoom("c1").chatInteracted(ChatPane.HOME).chatFolded(composer = ChatPane.ROOM).chat.top)
        assertEquals(ChatPane.THREAD, thread.chatInteracted(ChatPane.ROOM).chatFolded(composer = ChatPane.THREAD).chat.top)
        // A pane that isn't open can't come forward.
        assertEquals(ChatPane.HOME, inChat.chatInteracted(ChatPane.ROOM).chatFolded(composer = ChatPane.THREAD).chat.top)
        // folded() in Chat mode folds Chat's panes and leaves mail's stack alone.
        val both = inChat.openRoom("c1").chatInteracted(ChatPane.ROOM)
        val folded = both.folded(composerDirty = false, chatFocused = false)
        assertEquals(ChatPane.ROOM, folded.chat.top)
        assertEquals(both.stack, folded.stack)
    }

    @Test
    fun `the chat fields survive saved state, and an older saved state reads as Mail`() {
        val s = inChat.openRoom("c1").openThread("e1").openChatSheet(ChatSheet.DETAILS, "c1").setChatFilter(ChatFilter.UNREAD)
        assertEquals(s, RukooJson.decodeFromString(NavState.serializer(), RukooJson.encodeToString(NavState.serializer(), s)))
        val old = RukooJson.encodeToString(NavState.serializer(), start.openMessage("m1"))
            .replace(Regex(",?\"mode\":\"[A-Z]+\""), "").replace(Regex(",?\"chat\":\\{[^}]*\\}"), "")
        val read = RukooJson.decodeFromString(NavState.serializer(), old)
        assertEquals(AppMode.MAIL, read.mode)
        assertEquals(ChatNav(), read.chat)
        assertEquals("m1", read.openMessageId)
    }

    @Test
    fun `shown reads Chat as Mail while team chat isn't there, and Back from it moves through Mail`() {
        val s = start.openMessage("m1").setMode(AppMode.CHAT).selectWorkspace("w1").openRoom("c1")
        assertSame(s, s.shown(chatAvailable = true))
        assertSame(start, start.shown(chatAvailable = false))
        val shown = s.shown(chatAvailable = false)
        assertEquals(AppMode.MAIL, shown.mode)
        assertEquals("c1", shown.chat.roomId)
        val back = shown.back(twoPane = false)!!
        assertEquals(AppMode.MAIL, back.mode)
        assertEquals(Pane.LIST, back.top)
    }

    @Test
    fun `only two panes have a room beside the list, so one pane's Unread drops the room read last`() {
        // Read on one pane and back to the list: the room stays selected for unfolding.
        val read = inChat.openRoom("c1").back(twoPane = false)!!
        assertEquals("c1", read.chat.roomId)
        assertNull(read.chatRoomBesideList(twoPane = false))
        assertEquals("c1", read.chatRoomBesideList(twoPane = true))
        val wasRead = room("c1")
        assertFalse(ChatListModel.matches(wasRead, ChatFilter.UNREAD, read.chatRoomBesideList(twoPane = false)))
        assertTrue(ChatListModel.matches(wasRead, ChatFilter.UNREAD, read.chatRoomBesideList(twoPane = true)))
    }

    @Test
    fun `mail navigation is unchanged in Mail mode`() {
        val s = start.openMessage("m1").openChat("c_1", "m1")
        assertEquals(PaneLayout(Pane.READER, Pane.CHAT), s.twoPanes())
        assertEquals(Pane.READER, s.back(twoPane = false)!!.top)
        assertEquals(ViewKind.SENT, s.selectView(MailView(ViewKind.SENT)).view.kind)
        assertEquals(Pane.CHAT, s.folded(composerDirty = false, chatFocused = false).top)
    }

    // ---- the view model ----

    private val main = UnconfinedTestDispatcher()

    @Before
    fun setUp() = Dispatchers.setMain(main)

    @After
    fun tearDown() = Dispatchers.resetMain()

    private object Fake : UiStrings {
        override fun get(id: Int, vararg args: Any) = (listOf(id) + args).joinToString("|")
        override fun plural(id: Int, count: Int, vararg args: Any) = (listOf(id) + args).joinToString("|")
    }

    private class Services(dir: File, scope: CoroutineScope, override val workspaces: Workspaces?) : AppServices {
        override val mail = PreviewMailEngine(zone = ZoneId.of("Europe/Amsterdam"))
        override val drafts = DraftStore(null)
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
    }

    private fun TestScope.vm(workspaces: Workspaces?, saved: androidx.lifecycle.SavedStateHandle = androidx.lifecycle.SavedStateHandle()): Pair<Services, AppViewModel> {
        val services = Services(Files.createTempDirectory("rukoo-chatnav").toFile(), backgroundScope, workspaces)
        val vm = AppViewModel(services, saved)
        vm.mailUi.strings = Fake
        vm.chatUi.strings = Fake
        return services to vm
    }

    @Test
    fun `without team chat Mail stays as it is and Chat can't open`() = runTest(main) {
        val saved = androidx.lifecycle.SavedStateHandle()
        saved["nav"] = RukooJson.encodeToString(NavState.serializer(), start.setMode(AppMode.CHAT).selectWorkspace("w1"))
        val (_, vm) = vm(null, saved)
        assertEquals("a Chat mode saved before has nothing to come back to", AppMode.MAIL, vm.state.value.mode)
        assertFalse(vm.chatState.value.available)
        vm.setMode(AppMode.CHAT)
        assertEquals(AppMode.MAIL, vm.state.value.mode)
        assertNull(vm.chatView.value)
    }

    @Test
    fun `Chat picks the workspace the service selected and opens the room on screen`() = runTest(main) {
        val w = FakeWorkspaces()
        w.state.value = ready(listOf(summary("w1"), summary("w2")), selected = "w2")
        w.views["w2"] = MutableStateFlow(view("w2", room("c1"), room("c2")))
        val (s, vm) = vm(w)
        s.screen.setForeground(true)
        vm.onLayout(twoPane = false)
        vm.setMode(AppMode.CHAT)
        assertEquals("w2", vm.state.value.chat.workspaceId)
        assertEquals(Triple("w2", null, null), w.shown.last())
        assertEquals("w2", vm.chatView.value?.ws?.id)
        vm.openRoom("c1")
        assertEquals(listOf("w2/c1/null"), w.opened)
        assertEquals(Triple("w2", "c1", null), w.shown.last())
        vm.openThread("e1")
        assertEquals(Triple("w2", "c1", "e1"), w.shown.last())
        // Back to the room and the list: the room isn't on screen on one pane, and opens again next time.
        vm.back()
        vm.back()
        assertEquals(Triple("w2", null, null), w.shown.last())
        vm.openRoom("c1")
        assertEquals(listOf("w2/c1/null", "w2/c1/null"), w.opened)
        // A notification opens at a seq, once.
        vm.back()
        vm.openRoom("c2", at = 41)
        assertEquals("w2/c2/41", w.opened.last())
        assertEquals(3, w.opened.size)
        // Mail reports nothing on screen.
        vm.setMode(AppMode.MAIL)
        assertNull(w.shown.last().first)
        assertNull(vm.chatView.value)
    }

    @Test
    fun `losing team chat while in Chat lands in Mail`() = runTest(main) {
        val w = FakeWorkspaces()
        w.state.value = ready(listOf(summary("w1")))
        val (_, vm) = vm(w)
        vm.setMode(AppMode.CHAT)
        assertEquals(AppMode.CHAT, vm.state.value.mode)
        // The server turned team chat off and the service let go of its workspaces: Mail, and no "no longer in" toast.
        w.state.value = w.state.value.copy(available = false, workspaces = emptyList())
        assertEquals(AppMode.MAIL, vm.state.value.mode)
        assertNull(vm.mailUi.toasts.current)
        // Signing out empties the list too, without a toast; the selection waits for the next sign-in.
        w.state.value = ready(listOf(summary("w1")))
        vm.setMode(AppMode.CHAT)
        w.state.value = w.state.value.copy(signedIn = false, workspaces = emptyList())
        assertNull(vm.mailUi.toasts.current)
        assertEquals("w1", vm.state.value.chat.workspaceId)
        // A pick from the drawer closes it; a pick the view model makes in the background leaves an open drawer open.
        vm.setMode(AppMode.MAIL)
        vm.openDrawer()
        w.state.value = ready(listOf(summary("w2")))
        assertTrue(vm.state.value.drawerOpen)
        assertEquals("w2", vm.state.value.chat.workspaceId)
    }

    @Test
    fun `a Chat mode restored before the service answers waits for it, and Back meanwhile moves through Mail`() = runTest(main) {
        val saved = androidx.lifecycle.SavedStateHandle()
        saved["nav"] = RukooJson.encodeToString(NavState.serializer(), start.setMode(AppMode.CHAT).selectWorkspace("w1").openRoom("c1"))
        // The service starts from ChatState() and reads the saved server answer after that.
        val w = FakeWorkspaces()
        val (_, vm) = vm(w, saved)
        assertEquals("the service's first state isn't team chat going away", AppMode.CHAT, vm.state.value.mode)
        assertTrue("nothing opens while team chat isn't there", w.opened.isEmpty())
        assertNull(vm.roomOpening.value)
        w.state.value = ready(listOf(summary("w1")))
        assertEquals(AppMode.CHAT, vm.state.value.mode)
        assertEquals(listOf("w1/c1/null"), w.opened)
        // Losing it after that lands in Mail.
        w.state.value = w.state.value.copy(available = false, workspaces = emptyList())
        assertEquals(AppMode.MAIL, vm.state.value.mode)
        assertNull(vm.roomOpening.value)

        // Restored once more, with a server that no longer has team chat: the screen shows Mail, and Back acts on it.
        val again = androidx.lifecycle.SavedStateHandle()
        again["nav"] = RukooJson.encodeToString(NavState.serializer(), start.openMessage("m1").setMode(AppMode.CHAT).selectWorkspace("w1").openRoom("c1"))
        val (_, stale) = vm(FakeWorkspaces(), again)
        assertEquals(AppMode.CHAT, stale.state.value.mode)
        assertTrue(stale.canGoBack())
        assertTrue(stale.back())
        assertEquals(AppMode.MAIL, stale.state.value.mode)
        assertEquals(Pane.LIST, stale.state.value.top)
    }

    @Test
    fun `each opening of a room has its own count, kept by threads and folding, and new after the process went`() = runTest(main) {
        val w = FakeWorkspaces()
        w.state.value = ready(listOf(summary("w1")))
        w.views["w1"] = MutableStateFlow(view("w1", room("c1"), room("c2")))
        val saved = androidx.lifecycle.SavedStateHandle()
        val (_, vm) = vm(w, saved)
        vm.onLayout(twoPane = false)
        vm.setMode(AppMode.CHAT)
        assertNull(vm.roomOpening.value)
        vm.openRoom("c1")
        val first = vm.roomOpening.value!!
        assertEquals("w1" to "c1", first.ws to first.room)
        // A thread over the room and back to it is the same opening.
        vm.openThread("e1")
        vm.back()
        assertEquals(first, vm.roomOpening.value)
        // So is unfolding and folding with the room in front.
        vm.onLayout(twoPane = true)
        vm.chatInteracted(ChatPane.ROOM)
        vm.onLayout(twoPane = false)
        assertEquals(first, vm.roomOpening.value)
        // Back to the list ends it, and the room's next opening counts up, as does Mail and back.
        vm.back()
        assertNull(vm.roomOpening.value)
        vm.openRoom("c1")
        val second = vm.roomOpening.value!!
        assertTrue(second.count > first.count)
        vm.setMode(AppMode.MAIL)
        assertNull(vm.roomOpening.value)
        vm.setMode(AppMode.CHAT)
        val third = vm.roomOpening.value!!
        assertTrue(third.count > second.count)
        assertEquals(List(3) { "w1/c1/null" }, w.opened)
        // On the list with the room still selected, unfolding puts the room beside it: an opening that folding keeps
        // when the room was touched last, without a moment where the room looks closed.
        vm.back()
        vm.onLayout(twoPane = true)
        val beside = vm.roomOpening.value!!
        assertTrue(beside.count > third.count)
        vm.chatInteracted(ChatPane.ROOM)
        vm.onLayout(twoPane = false)
        assertEquals(ChatPane.ROOM, vm.state.value.chat.top)
        assertEquals(beside, vm.roomOpening.value)
        assertEquals(4, w.opened.size)
        // A notification for the room on screen opens it again at its seq.
        vm.openRoom("c1", at = 9)
        val notified = vm.roomOpening.value!!
        assertTrue(notified.count > beside.count)
        // After the process went, the restored room opens with a count no saved pane state carries.
        val (_, after) = vm(w, saved)
        assertTrue(after.roomOpening.value!!.count > notified.count)
    }

    @Test
    fun `a workspace that goes while open says so and moves on, unless the person left it`() = runTest(main) {
        val w = FakeWorkspaces()
        w.state.value = ready(listOf(summary("w1", "Acme"), summary("w2", "Beta")), selected = "w1")
        val (_, vm) = vm(w)
        vm.setMode(AppMode.CHAT)
        vm.openRoom("c1")
        w.state.value = ready(listOf(summary("w2", "Beta")))
        assertEquals("${R.string.chat_gone_workspace_title}|Acme", vm.mailUi.toasts.current?.message)
        assertEquals("w2", vm.state.value.chat.workspaceId)
        assertNull(vm.state.value.chat.roomId)
        // Left on purpose: no toast.
        vm.mailUi.toasts.dismiss()
        w.state.value = ready(listOf(summary("w2", "Beta"), summary("w3", "Gamma")))
        vm.selectWorkspace("w3")
        vm.chatUi.expectGone("w3")
        w.state.value = ready(listOf(summary("w2", "Beta")))
        assertNull(vm.mailUi.toasts.current)
        assertEquals("w2", vm.state.value.chat.workspaceId)
    }

    @Test
    fun `a room that goes while open says so and returns to the list`() = runTest(main) {
        val w = FakeWorkspaces()
        w.state.value = ready(listOf(summary("w1")))
        val flow = MutableStateFlow(view("w1", room("c1", name = "plans"), room("c2")))
        w.views["w1"] = flow
        val (_, vm) = vm(w)
        vm.setMode(AppMode.CHAT)
        vm.openRoom("c1")
        flow.value = view("w1", room("c2"))
        assertEquals("${R.string.chat_gone_conversation_title}|#plans", vm.mailUi.toasts.current?.message)
        assertNull(vm.state.value.chat.roomId)
        assertEquals(listOf(ChatPane.HOME), vm.state.value.chat.stack)
        // Leaving one yourself goes quietly.
        vm.mailUi.toasts.dismiss()
        vm.openRoom("c2")
        vm.chatUi.expectGone("c2")
        flow.value = view("w1")
        assertNull(vm.mailUi.toasts.current)
        assertNull(vm.state.value.chat.roomId)
    }

    @Test
    fun `unsent messages a broken cache took are told once, in the app toast`() = runTest(main) {
        val w = FakeWorkspaces()
        w.state.value = ready(listOf(summary("w1"))).copy(lostUnsent = 2)
        val (_, vm) = vm(w)
        assertNull("the view model doesn't take the count before the root gave it its strings", vm.mailUi.toasts.current)
        assertEquals(0, w.takes)
        vm.noticeLostUnsent()
        assertEquals("${R.plurals.chat_lost_unsent}|2", vm.mailUi.toasts.current?.message)
        assertEquals("an error toast's 5 seconds", 5000L, vm.mailUi.toasts.current?.durationMs)
        assertEquals("taken, so the state no longer carries it", 0, w.state.value.lostUnsent)
        // Asked again, by the same view model or one made again after a rotation: nothing more to say.
        vm.mailUi.toasts.dismiss()
        vm.noticeLostUnsent()
        assertNull(vm.mailUi.toasts.current)
        val (_, again) = vm(w)
        again.noticeLostUnsent()
        assertNull(again.mailUi.toasts.current)
        // A later broken cache in the session reports its own count, once more.
        w.state.value = w.state.value.copy(lostUnsent = 1)
        vm.noticeLostUnsent()
        assertEquals("${R.plurals.chat_lost_unsent}|1", vm.mailUi.toasts.current?.message)
        // Without team chat there is no service and no toast.
        val (_, none) = vm(null)
        none.noticeLostUnsent()
        assertNull(none.mailUi.toasts.current)
    }

    @Test
    fun `a mail notification or a new email brings Mail back`() = runTest(main) {
        val w = FakeWorkspaces()
        w.state.value = ready(listOf(summary("w1")))
        val (s, vm) = vm(w)
        vm.setMode(AppMode.CHAT)
        vm.openRoute(NotificationRoute.Message(s.mail.listMessages(MailView.AllInboxes).first().id))
        assertEquals(AppMode.MAIL, vm.state.value.mode)
        vm.setMode(AppMode.CHAT)
        vm.newMessage()
        assertEquals(AppMode.MAIL, vm.state.value.mode)
        assertTrue(vm.state.value.composerOpen)
    }

    // ---- fakes ----

    private fun ready(list: List<WorkspaceSummary>, selected: String? = null) =
        ChatState(available = true, signedIn = true, host = "chat.test", selected = selected, workspaces = list)

    private fun summary(id: String, name: String = id) = WorkspaceSummary(id, name, "member", status = WorkspaceStatus.OK)

    private fun room(id: String, name: String = id) = Room(
        id = id, kind = RoomKind.CHANNEL, name = name, visibility = "workspace", archived = false, closedReason = null,
        participants = null, startedBy = null, role = "member", members = 2, head = 1, floor = 1, lastAt = null, read = 0,
        unread = 0, mentions = 0, attention = 0, muted = false, hasCache = false,
    )

    private fun view(ws: String, vararg rooms: Room): WorkspaceView {
        val me = Member("u_me", name = "Me", role = "member", state = "active")
        return WorkspaceView(summary(ws), me, rooms.toList(), listOf(me), false, emptyList(), emptyList())
    }

    /** The interface with a state, views and records of what the UI told it; the rest isn't used here. */
    private class FakeWorkspaces : Workspaces {
        override val state = MutableStateFlow(ChatState())
        val views = HashMap<String, MutableStateFlow<WorkspaceView>>()
        val shown = ArrayList<Triple<String?, String?, String?>>()
        val opened = ArrayList<String>()

        override fun view(ws: String): Flow<WorkspaceView> = views[ws] ?: MutableStateFlow(WorkspaceView(
            WorkspaceSummary(ws, ws, "member"), Member("u_me", name = "Me", role = "member", state = "active"),
            emptyList(), emptyList(), false, emptyList(), emptyList(),
        ))
        override fun timeline(ws: String, room: String): Flow<RoomTimeline> = emptyFlow()
        override fun thread(ws: String, room: String, root: String): Flow<ThreadTimeline> = emptyFlow()
        override suspend fun select(ws: String?) {}
        override fun onScreen(ws: String?, room: String?, thread: String?) {
            shown += Triple(ws, room, thread)
        }
        override suspend fun refresh(ws: String?) {}
        override suspend fun reload(ws: String) {}
        override suspend fun open(ws: String, room: String, at: Long?) {
            opened += "$ws/$room/$at"
        }
        override suspend fun loadOlder(ws: String, room: String) {}
        override suspend fun loadThread(ws: String, room: String, root: String) {}
        override suspend fun roomMembers(ws: String, room: String): List<RoomMember> = emptyList()
        override fun markRead(ws: String, room: String, seq: Long) {}
        override suspend fun markAllRead(ws: String, room: String) {}
        override suspend fun setMuted(ws: String, room: String, muted: Boolean) {}
        override suspend fun saveDraft(ws: String, room: String, root: String?, draft: Draft?) {}
        override suspend fun send(ws: String, room: String, root: String?, text: String, mentions: List<Mention>): String = no()
        override suspend fun resend(localId: String, mode: ResendMode) {}
        override suspend fun discard(localId: String) {}
        override suspend fun redact(ws: String, room: String, message: String) {}
        override suspend fun createWorkspace(name: String, displayName: String): String = no()
        override suspend fun previewInvite(link: InviteLink): InvitePreview = no()
        override suspend fun join(link: InviteLink, displayName: String): String = no()
        override fun rememberJoin(link: InviteLink) {}
        override fun takePendingJoin(): InviteLink? = null
        var takes = 0
        override fun takeLostUnsent(): Int {
            takes += 1
            val lost = state.value.lostUnsent
            if (lost != 0) state.value = state.value.copy(lostUnsent = 0)
            return lost
        }
        override suspend fun leaveWorkspace(ws: String) {}
        override suspend fun deleteWorkspace(ws: String) {}
        override suspend fun renameMe(ws: String, name: String) {}
        override suspend fun setRole(ws: String, member: String, role: String) {}
        override suspend fun removeMember(ws: String, member: String) {}
        override suspend fun invites(ws: String): List<Invite> = emptyList()
        override suspend fun createInvite(ws: String, role: String, channels: List<String>, expiresIn: Long): String = no()
        override suspend fun withdrawInvite(ws: String, invite: String) {}
        override suspend fun createChannel(ws: String, name: String, visibility: String): String = no()
        override suspend fun renameChannel(ws: String, channel: String, name: String) {}
        override suspend fun archiveChannel(ws: String, channel: String) {}
        override suspend fun joinChannel(ws: String, channel: String) {}
        override suspend fun addToChannel(ws: String, channel: String, member: String) {}
        override suspend fun setChannelRole(ws: String, channel: String, member: String, role: String) {}
        override suspend fun removeFromChannel(ws: String, channel: String, member: String) {}
        override suspend fun leaveChannel(ws: String, channel: String, successor: String?) {}
        override suspend fun startDm(ws: String, members: List<String>): String = no()
        override suspend fun leaveDm(ws: String, room: String) {}
        override suspend fun block(ws: String, member: String) {}
        override suspend fun unblock(ws: String, member: String) {}

        private fun no(): Nothing = throw UnsupportedOperationException()
    }
}
