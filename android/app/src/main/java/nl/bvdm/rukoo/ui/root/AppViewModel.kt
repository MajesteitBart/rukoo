package nl.bvdm.rukoo.ui.root

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.AppServices
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.ui.ComposerState

/**
 * Navigation state for both layouts, above the layout so folding keeps everything (spec 6 §5.6), and
 * the way panes reach the app's services ([services]). Intents are plain calls; the state machine is
 * [NavState]. Saved in the SavedStateHandle so a recreated activity comes back where it was.
 */
class AppViewModel(val services: AppServices, private val saved: SavedStateHandle = SavedStateHandle()) : ViewModel() {
    private val _state = MutableStateFlow(restore())
    val state: StateFlow<NavState> = _state.asStateFlow()

    private val twoPaneFlow = MutableStateFlow(false)

    /** Whether the window shows two panes; RukooRoot reports it from the window width. */
    val twoPane: Boolean get() = twoPaneFlow.value

    /** Set by the chat input on focus, so folding keeps the chat in front. */
    var chatFocused: Boolean = false

    init {
        // The composer can open without the UI: an agent's write_draft calls ComposerController.open.
        viewModelScope.launch {
            services.composer.state.map { it != null }.distinctUntilChanged().collect { open ->
                set { s ->
                    when {
                        open && !s.composerOpen -> s.composerOpened(byUser = false)
                        !open && s.composerOpen -> s.composerClosed()
                        else -> s
                    }
                }
            }
        }
        // What the tools see (get_context, rukoo/hello).
        viewModelScope.launch {
            combine(state, services.composer.state, twoPaneFlow) { nav, composer, two -> Triple(nav, composer, two) }.collect { (nav, composer, two) ->
                services.screen.update {
                    it.copy(
                        view = nav.view,
                        openMessageId = nav.openMessageId,
                        composer = composer,
                        chatConversationId = if (chatVisible(nav, two)) nav.chatConversationId else null,
                    )
                }
            }
        }
        // The chat on screen gets no unread mark when its turn ends.
        viewModelScope.launch {
            combine(state, twoPaneFlow, services.screen.state.map { it.foreground }.distinctUntilChanged()) { nav, two, foreground ->
                if (foreground && chatVisible(nav, two)) nav.chatConversationId else null
            }.distinctUntilChanged().collect { services.agents.watch(it) }
        }
    }

    private fun chatVisible(nav: NavState, two: Boolean): Boolean =
        nav.chatOpen && nav.overlay == null && (if (two) nav.twoPanes().right == Pane.CHAT else nav.top == Pane.CHAT)

    private fun restore(): NavState =
        saved.get<String>(KEY)?.let { runCatching { RukooJson.decodeFromString(NavState.serializer(), it) }.getOrNull() } ?: NavState()

    private fun set(transform: (NavState) -> NavState) {
        val before = _state.value
        val after = transform(before)
        if (after == before) return
        _state.value = after
        saved[KEY] = RukooJson.encodeToString(NavState.serializer(), after)
    }

    /** Called by RukooRoot whenever the window crosses 600dp. */
    fun onLayout(twoPane: Boolean) {
        val was = twoPaneFlow.value
        twoPaneFlow.value = twoPane
        if (was && !twoPane) set { it.folded(services.composer.current()?.dirty == true, chatFocused) }
    }

    fun interacted(pane: Pane) = set { it.interacted(pane) }

    fun selectView(view: MailView) = set { it.selectView(view) }

    fun openMessage(id: String) = set { it.openMessage(id) }

    fun messageGone(id: String) = set { it.messageGone(id) }

    /** Opens a chat: an existing one by id, or a new one about [emailId] (the open email by default). */
    fun openChat(conversationId: String? = null, emailId: String? = null) {
        val email = emailId
            ?: conversationId?.let { services.agents.get(it)?.message?.id }
            ?: if (conversationId == null) _state.value.openMessageId else null
        set { it.openChat(conversationId, email) }
    }

    /** The first message created the conversation of a new chat. */
    fun chatCreated(conversationId: String) = set { it.chatCreated(conversationId) }

    fun closeChat() = set { it.closeChat() }

    fun showList() = set { it.showList(twoPane) }

    fun openComposer(draft: ComposerState = ComposerState()) {
        set { it.composerOpened(byUser = true) }
        services.composer.open(draft)
    }

    /** The chat's draft card: bring the composer the agent filled to the front. */
    fun showComposer() = set { it.showComposer() }

    fun closeComposer() {
        set { it.composerClosed() }
        services.composer.close()
    }

    fun openSettings() = set { it.openOverlay(Overlay.SETTINGS) }

    fun openOnboarding() = set { it.openOverlay(Overlay.ONBOARDING) }

    fun closeOverlay() = set { it.closeOverlay() }

    fun openDrawer() = set { it.copy(drawerOpen = true) }

    fun closeDrawer() = set { it.copy(drawerOpen = false) }

    fun openChatList() = set { it.copy(chatListOpen = true) }

    fun closeChatList() = set { it.copy(chatListOpen = false) }

    fun canGoBack(): Boolean = _state.value.back(twoPane) != null

    /** One step back; false when there was nothing to close. Closing the composer also closes the draft. */
    fun back(): Boolean {
        val next = _state.value.back(twoPane) ?: return false
        val closesComposer = _state.value.composerOpen && !next.composerOpen
        set { next }
        if (closesComposer) services.composer.close()
        return true
    }

    companion object {
        private const val KEY = "nav"

        fun factory(services: AppServices): ViewModelProvider.Factory = viewModelFactory {
            initializer { AppViewModel(services, createSavedStateHandle()) }
        }
    }
}
