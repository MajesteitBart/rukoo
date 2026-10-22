package nl.bvdm.rukoo.ui.root

import android.content.Context
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.AppServices
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.mail.model.QuickFilter as ListFilter
import nl.bvdm.rukoo.ui.ComposerState
import nl.bvdm.rukoo.ui.MailtoFields
import nl.bvdm.rukoo.ui.composer.ComposerFiles
import nl.bvdm.rukoo.ui.composer.LocalReplyBuilder
import nl.bvdm.rukoo.ui.composer.QuoteLabels
import nl.bvdm.rukoo.ui.composer.Recipients
import nl.bvdm.rukoo.ui.composer.ReplyBuilder
import nl.bvdm.rukoo.ui.mail.DialogChoice
import nl.bvdm.rukoo.ui.mail.DialogRequest
import nl.bvdm.rukoo.ui.mail.ListModel
import nl.bvdm.rukoo.ui.mail.MailDates
import nl.bvdm.rukoo.ui.mail.MailUi
import nl.bvdm.rukoo.ui.mail.MailUiHost

/** Things the root does with a Context: open a link in a Custom Tab. */
sealed interface UiEffect {
    data class OpenUrl(val url: String) : UiEffect
}

/**
 * Navigation state for both layouts, above the layout so folding keeps everything (spec 6 §5.6), and
 * the way panes reach the app's services ([services]). Intents are plain calls; the state machine is
 * [NavState]. Saved in the SavedStateHandle so a recreated activity comes back where it was. Mail
 * actions ([mailUi]) and the composer's actions run in the view model's scope, so they finish when the
 * pane that started them leaves the screen.
 */
class AppViewModel(
    val services: AppServices,
    private val saved: SavedStateHandle = SavedStateHandle(),
    /** Track A's builders replace the local port here. */
    private val replies: ReplyBuilder = LocalReplyBuilder,
) : ViewModel(), MailUiHost {
    private val _state = MutableStateFlow(restore())
    val state: StateFlow<NavState> = _state.asStateFlow()

    private val twoPaneFlow = MutableStateFlow(false)

    /** Whether the window shows two panes; RukooRoot reports it from the window width. */
    val twoPane: Boolean get() = twoPaneFlow.value

    /** Set by the chat input on focus, so folding keeps the chat in front. */
    var chatFocused: Boolean = false

    val mailUi = MailUi(services.mail, viewModelScope, this)

    private val _effects = MutableSharedFlow<UiEffect>(extraBufferCapacity = 8)
    val effects: SharedFlow<UiEffect> = _effects

    /** True while Send runs. */
    var sending by mutableStateOf(false)
        private set

    // The rows the list shows, in order, as the list last reported them: Previous and Next walk them, and a
    // moved message hands the reader to the next one.
    private var shownIds: List<String> = emptyList()

    private val _chatEmails = MutableStateFlow<List<String>>(emptyList())

    /**
     * Emails "Add to chat" asked for that the chat input hasn't taken yet (track D's ChatPane takes them with
     * [takeChatEmails]); the first is also the chat's email when a new chat opens.
     */
    val chatEmails: StateFlow<List<String>> = _chatEmails.asStateFlow()

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
                        selectedIds = nav.checked,
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

    /** Whether the chat is on screen right now (the list's news dot leaves it out). */
    fun chatOnScreen(nav: NavState = _state.value): Boolean = chatVisible(nav, twoPane)

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

    fun selectView(view: MailView) {
        set { it.selectView(view) }
        val account = view.accountId
        val folder = view.folder
        if (account != null && folder != null) viewModelScope.launch { runCatching { services.mail.openFolder(account, folder) } }
    }

    /** Opens [id] in the reader and marks it read, as desktop's openMessage does (drafts stay as they are). */
    fun openMessage(id: String) {
        set { it.openMessage(id) }
        viewModelScope.launch {
            val m = runCatching { services.mail.summary(id) }.getOrNull() ?: return@launch
            if (m.unread && m.role != FolderRole.DRAFTS) runCatching { services.mail.setFlags(listOf(id), unread = false) }
        }
    }

    fun messageGone(id: String) = set { it.messageGone(id) }

    /** The list tells which rows it shows, in order. */
    fun listShown(ids: List<String>) {
        shownIds = ids
    }

    // Where each list (view, folder, search) was scrolled to, so going back to a folder finds the same place
    // (spec 6 §5.6). The list on screen also keeps its own place across recreation (rememberSaveable).
    private val listPositions = HashMap<String, Pair<Int, Int>>()

    fun listPosition(key: String): Pair<Int, Int>? = listPositions[key]

    fun keepListPosition(key: String, index: Int, offset: Int) {
        listPositions[key] = index to offset
    }

    /** The email above or below the open one in the list; null at either end. */
    fun neighbour(id: String, step: Int): String? {
        val i = shownIds.indexOf(id)
        if (i < 0) return null
        return shownIds.getOrNull(i + step)
    }

    // List state

    fun setFilter(filter: ListFilter) = set { it.setFilter(filter) }

    fun openSearch() = set { it.openSearch() }

    fun setQuery(text: String) = set { it.setQuery(text) }

    fun setSearchAll(all: Boolean) = set { it.setSearchAll(all) }

    fun closeSearch() = set { it.closeSearch() }

    fun toggleChecked(id: String) = set { it.toggleChecked(id) }

    fun setChecked(ids: List<String>) = set { it.setChecked(ids) }

    fun clearChecked() = set { it.clearChecked() }

    fun toggleStack(key: String) = set { it.toggleStack(key) }

    fun setSort(sort: nl.bvdm.rukoo.mail.model.SortOrder) {
        viewModelScope.launch { services.settings.update { it.copy(sort = sort) } }
    }

    fun setDensity(density: nl.bvdm.rukoo.settings.Density) {
        viewModelScope.launch { services.settings.update { it.copy(density = density) } }
    }

    // MailUiHost

    override fun detach(ids: Collection<String>): Boolean {
        val nav = _state.value
        val open = nav.openMessageId
        val wasOpen = open != null && open in ids
        set { it.copy(checked = it.checked - ids.toSet()) }
        if (wasOpen) {
            val next = ListModel.nextAfter(shownIds, open, ids)
            // The reader goes on to the next email like desktop's detach; from the list, the email just leaves.
            if (next != null && (twoPane || nav.top == Pane.READER)) openMessage(next) else messageGone(open!!)
        }
        shownIds = shownIds - ids.toSet()
        return wasOpen
    }

    override fun reopen(id: String) = openMessage(id)

    override fun openUrl(url: String) {
        _effects.tryEmit(UiEffect.OpenUrl(url))
    }

    override fun composeMailto(fields: MailtoFields) = openComposer(fields.toComposer())

    override fun showFolder(accountId: String, path: String) = selectView(MailView.folder(accountId, path))

    // Chat

    /** Opens a chat: an existing one by id, or a new one about [emailId] (the open email by default). */
    fun openChat(conversationId: String? = null, emailId: String? = null) {
        val email = emailId
            ?: conversationId?.let { services.agents.get(it)?.message?.id }
            ?: if (conversationId == null) _state.value.openMessageId else null
        set { it.openChat(conversationId, email) }
    }

    /**
     * "Add to chat" (desktop addToChatItem): the open chat gets the emails, else a new chat about the first.
     * The chat input takes them from [chatEmails].
     */
    fun addToChat(ids: List<String>) {
        if (ids.isEmpty()) return
        _chatEmails.value = ids.distinct()
        val nav = _state.value
        set { it.clearChecked() }
        openChat(if (nav.chatOpen) nav.chatConversationId else null, ids.first())
    }

    /** The chat input took the emails [chatEmails] offered. */
    fun takeChatEmails(): List<String> = _chatEmails.value.also { _chatEmails.value = emptyList() }

    /** The first message created the conversation of a new chat. */
    fun chatCreated(conversationId: String) = set { it.chatCreated(conversationId) }

    fun closeChat() = set { it.closeChat() }

    fun showList() = set { it.showList(twoPane) }

    // Composer

    /**
     * Text typed in To, Cc or Bcc that isn't a chip yet, by [pendingKey]. It lives here rather than in the field
     * so Send can take it along (desktop flushInputs) and folding doesn't lose it.
     */
    val pendingRecipients = mutableStateMapOf<String, String>()

    /** Turns typed recipient text into recipients of the open draft, as leaving the field does. */
    private fun flushRecipients() {
        val d = services.composer.current() ?: return
        val typed = listOf("to", "cc", "bcc").associateWith { pendingRecipients[pendingKey(d.id, it)].orEmpty() }
        if (typed.values.all { it.isBlank() }) return
        services.composer.update { s ->
            s.copy(
                to = Recipients.merge(s.to, Recipients.parse(typed.getValue("to"))),
                cc = Recipients.merge(s.cc, Recipients.parse(typed.getValue("cc"))),
                bcc = Recipients.merge(s.bcc, Recipients.parse(typed.getValue("bcc"))),
                dirty = true,
            )
        }
        typed.keys.forEach { pendingRecipients.remove(pendingKey(d.id, it)) }
    }

    /** Files picked for the draft [composerId], copied in this scope so folding during a large copy loses nothing. */
    fun attachFiles(context: Context, uris: List<Uri>, composerId: String) {
        viewModelScope.launch {
            for (uri in uris) {
                val added = withContext(Dispatchers.IO) { runCatching { ComposerFiles.copyIn(context, uri, composerId) }.getOrNull() }
                if (added == null) {
                    mailUi.toasts.showError(mailUi.strings.get(R.string.composer_attachments_failed, uri.lastPathSegment.orEmpty()))
                    continue
                }
                services.composer.update { if (it.id == composerId) it.copy(attachments = it.attachments + added, dirty = true) else it }
            }
        }
    }

    private fun hasWords(d: ComposerState): Boolean =
        d.body.isNotBlank() || d.subject.isNotBlank() || d.to.isNotEmpty() || d.cc.isNotEmpty() || d.bcc.isNotEmpty() || d.attachments.isNotEmpty()

    private fun saveFailed() = mailUi.toasts.showError(mailUi.strings.get(R.string.composer_errors_save_local))

    /**
     * Opens [draft] in front. An open draft with unsaved words is kept in Drafts first, as desktop saves on
     * leaving; when that save fails, the open draft stays and the new one doesn't open.
     */
    fun openComposer(draft: ComposerState = ComposerState()) {
        val open = services.composer.current()
        if (open != null && open.id != draft.id && open.dirty && hasWords(open)) {
            viewModelScope.launch {
                flushRecipients()
                val parked = services.composer.current() ?: open
                if (!services.drafts.save(parked)) return@launch saveFailed()
                mailUi.toasts.showToast(mailUi.strings.get(R.string.composer_status_saved_closed))
                showNewComposer(draft)
            }
            return
        }
        showNewComposer(draft)
    }

    private fun showNewComposer(draft: ComposerState) {
        set { it.composerOpened(byUser = true) }
        services.composer.open(draft)
    }

    private fun account(id: String?) = services.mail.accounts.value.let { list -> list.firstOrNull { it.id == id } ?: list.firstOrNull() }

    private fun defaultAccountId(): String? =
        _state.value.view.accountId ?: services.settingsSnapshot.value.defaultAccountId?.takeIf { id -> services.mail.accounts.value.any { it.id == id } }
            ?: services.mail.accounts.value.firstOrNull()?.id

    /** The From an account sends with by default: its chosen address, else its own. */
    fun defaultFrom(accountId: String): Address? {
        val ids = services.mail.identities(accountId)
        val preferred = account(accountId)?.defaultFrom
        val identity = ids.firstOrNull { preferred != null && it.address.equals(preferred, ignoreCase = true) } ?: ids.firstOrNull { it.primary } ?: ids.firstOrNull()
        return identity?.let { Address(it.name, it.address) }
    }

    private fun signatureOf(accountId: String): String? = account(accountId)?.signature?.takeIf { it.isNotBlank() }

    /** "New message": the current account's default From and signature. */
    fun newMessage() {
        val accountId = defaultAccountId()
        if (accountId == null) {
            mailUi.toasts.showError(mailUi.strings.get(R.string.composer_errors_no_account))
            return
        }
        openComposer(ComposerState(accountId = accountId, from = defaultFrom(accountId), body = signatureOf(accountId)?.let { "\n\n$it" } ?: ""))
    }

    /** Reply, reply all or forward [messageId], through [replies]. */
    fun reply(messageId: String, kind: ReplyKind) {
        viewModelScope.launch {
            try {
                val full = services.mail.fullMessage(messageId)
                val s = mailUi.strings
                val dates = MailDates(s.locale)
                val labels = QuoteLabels(
                    marker = s.get(R.string.composer_quote_marker),
                    from = { s.get(R.string.composer_quote_from, it) },
                    date = { s.get(R.string.composer_quote_date, it) },
                    to = { s.get(R.string.composer_quote_to, it) },
                    subject = { s.get(R.string.composer_quote_subject, it) },
                    formatDate = dates::quoteDate,
                )
                val draft = replies.reply(full, kind, services.mail.identities(full.accountId), defaultFrom(full.accountId), signatureOf(full.accountId), labels)
                openComposer(draft)
            } catch (e: Exception) {
                mailUi.toasts.showError(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    /** A draft kept on this phone, opened again. The one that is open already just comes to the front, edits and all. */
    fun openLocalDraft(id: String) {
        if (services.composer.current()?.id == id) return showComposer()
        val draft = services.drafts.get(id) ?: return
        openComposer(draft.copy(dirty = false))
    }

    /** The chat's draft card: bring the composer the agent filled to the front. */
    fun showComposer() = set { it.showComposer() }

    /**
     * Whether closing the composer now would ask "Save draft?" first: unsaved words, which includes an agent's
     * draft the user hasn't touched (write_draft may open it clean), and recipient text not yet turned into chips.
     */
    fun composerAsks(): Boolean {
        val d = services.composer.current() ?: return false
        val typed = listOf("to", "cc", "bcc").any { !pendingRecipients[pendingKey(d.id, it)].isNullOrBlank() }
        return typed || (hasWords(d) && (d.dirty || d.draftedBy != null || d.editedAgent != null))
    }

    /**
     * Close (X) or Back on the composer. Unsaved words ask Save, Don't save or Cancel (composer.js:1046-1063);
     * a reopened draft that wasn't changed stays in Drafts. Nothing closes while Send runs.
     */
    fun closeComposer() {
        if (sending) return
        val d = services.composer.current() ?: return set { it.composerClosed() }
        if (!composerAsks()) {
            if (services.drafts.contains(d.id)) mailUi.toasts.showToast(mailUi.strings.get(R.string.composer_status_kept))
            closeComposerNow()
            return
        }
        viewModelScope.launch {
            val s = mailUi.strings
            val answer = mailUi.ask(
                DialogRequest(
                    title = s.get(R.string.composer_close_title),
                    message = s.get(R.string.composer_close_help),
                    confirmLabel = s.get(R.string.common_actions_save),
                    cancelLabel = s.get(R.string.common_actions_cancel),
                    otherLabel = s.get(R.string.composer_close_discard),
                ),
            )
            when (answer.choice) {
                DialogChoice.CONFIRM -> {
                    flushRecipients()
                    val now = services.composer.current() ?: return@launch
                    // The composer (and its own copy on disk) closes only once the draft is safely kept.
                    if (!services.drafts.save(now)) return@launch saveFailed()
                    mailUi.toasts.showToast(s.get(R.string.composer_status_saved_closed))
                    closeComposerNow()
                }
                DialogChoice.OTHER -> {
                    val now = services.composer.current() ?: return@launch
                    if (services.drafts.contains(now.id)) {
                        if (!services.drafts.remove(now.id)) return@launch saveFailed()
                        mailUi.toasts.showToast(s.get(R.string.composer_status_deleted))
                    }
                    closeComposerNow()
                }
                DialogChoice.CANCEL -> Unit
            }
        }
    }

    private fun closeComposerNow() {
        services.composer.current()?.let { d -> listOf("to", "cc", "bcc").forEach { pendingRecipients.remove(pendingKey(d.id, it)) } }
        set { it.composerClosed() }
        services.composer.close()
    }

    /** "Delete draft": asks, then throws the draft away, here and in Drafts. */
    fun discardDraft() {
        if (sending) return
        val d = services.composer.current() ?: return
        val kept = services.drafts.contains(d.id)
        if (!kept && !hasWords(d)) return closeComposerNow()
        viewModelScope.launch {
            val s = mailUi.strings
            val answer = mailUi.ask(
                DialogRequest(
                    title = s.get(R.string.composer_discard_title),
                    message = s.get(if (kept) R.string.composer_discard_saved_help else R.string.composer_discard_unsaved_help),
                    confirmLabel = s.get(R.string.common_actions_delete),
                    cancelLabel = s.get(R.string.common_actions_cancel),
                    danger = true,
                ),
            )
            if (answer.choice != DialogChoice.CONFIRM) return@launch
            if (!services.drafts.remove(d.id)) return@launch saveFailed()
            closeComposerNow()
            if (kept) mailUi.toasts.showToast(s.get(R.string.composer_status_deleted))
        }
    }

    /** "Save to Drafts" from the composer's menu: keeps it and closes, like desktop's Ctrl+S then Close. */
    fun saveDraft() {
        if (sending) return
        viewModelScope.launch {
            flushRecipients()
            val d = services.composer.current() ?: return@launch
            if (!services.drafts.save(d)) return@launch saveFailed()
            mailUi.toasts.showToast(mailUi.strings.get(R.string.composer_status_saved_to_drafts))
            closeComposerNow()
        }
    }

    /** What stops [d] from being sent, as a message for the user, or null. */
    private fun sendProblem(d: ComposerState): String? {
        val s = mailUi.strings
        val all = d.to + d.cc + d.bcc
        if (all.isEmpty()) return s.get(R.string.composer_errors_no_recipients)
        all.firstOrNull { !Recipients.isValid(it.address) }?.let { return s.get(R.string.common_errors_invalid_email_value, it.address) }
        val accountId = sendAccount(d) ?: return s.get(R.string.composer_errors_no_account)
        if (d.from == null && defaultFrom(accountId) == null) return s.get(R.string.composer_errors_no_account)
        return null
    }

    private fun sendAccount(d: ComposerState): String? = d.accountId?.takeIf { id -> services.mail.accounts.value.any { it.id == id } } ?: defaultAccountId()

    // The parts of a draft that make up the mail; dirty and the save time don't.
    private fun ComposerState.content() = copy(dirty = false, savedAt = 0, draftedBy = null, editedAgent = null)

    /**
     * Send (composer.js:976-985): typed recipient text joins first, then it needs a valid recipient and asks
     * about an empty subject. While it runs the composer is read-only. If the draft changed anyway (an agent
     * wrote into it), it stays open with the newer text instead of closing.
     */
    fun send() {
        if (sending) return
        flushRecipients()
        val d = services.composer.current() ?: return
        val s = mailUi.strings
        sendProblem(d)?.let { return mailUi.toasts.showError(it) }
        viewModelScope.launch {
            if (d.subject.isBlank()) {
                val answer = mailUi.ask(
                    DialogRequest(
                        s.get(R.string.composer_send_no_subject_title),
                        s.get(R.string.composer_send_no_subject_help),
                        s.get(R.string.composer_actions_send),
                        s.get(R.string.common_actions_cancel),
                    ),
                )
                if (answer.choice != DialogChoice.CONFIRM) return@launch
            }
            val current = services.composer.current()?.takeIf { it.id == d.id } ?: return@launch
            sendProblem(current)?.let { return@launch mailUi.toasts.showError(it) }
            val accountId = sendAccount(current) ?: return@launch
            val from = current.from ?: defaultFrom(accountId) ?: return@launch
            sending = true
            mailUi.toasts.showToast(s.get(R.string.composer_status_sending))
            try {
                val originalHtml = current.sourceMessageId?.takeIf { current.quote.isNotBlank() && !current.quoteExcluded }?.let { id ->
                    runCatching { services.mail.fullMessage(id).html }.getOrNull()?.takeIf { it.isNotBlank() }
                }
                services.mail.send(replies.outgoing(current, accountId, from, originalHtml))
                services.drafts.remove(current.id)
                val after = services.composer.current()
                if (after?.id == current.id && after.content() == current.content()) closeComposerNow()
                mailUi.toasts.showToast(s.get(R.string.composer_status_sent))
            } catch (e: Exception) {
                mailUi.toasts.showError(e.message?.let { s.get(R.string.composer_errors_send_reason, it) } ?: s.get(R.string.composer_errors_send))
            } finally {
                sending = false
            }
        }
    }

    /** "Drafted by {name} · Undo": asks, then puts back what was there and marks the chat's draft card undone. */
    fun undoAgentDraft() {
        val d = services.composer.current() ?: return
        val name = d.draftedBy ?: d.editedAgent ?: mailUi.strings.get(R.string.composer_agent_someone)
        viewModelScope.launch {
            val s = mailUi.strings
            val answer = mailUi.ask(
                DialogRequest(
                    s.get(R.string.composer_agent_undo_title, name),
                    s.get(R.string.composer_agent_undo_help),
                    s.get(R.string.composer_agent_undo),
                    s.get(R.string.common_actions_cancel),
                ),
            )
            if (answer.choice != DialogChoice.CONFIRM) return@launch
            if (!services.composer.undoAgentDraft()) return@launch
            val hub = services.agents
            for (row in hub.conversations.value) {
                val item = hub.get(row.id)?.items?.lastOrNull { it is Item.Draft && it.composerKey == d.id && !it.undone } ?: continue
                runCatching { hub.patchDraft(row.id, item.id, undone = true) }
                break
            }
        }
    }

    fun openSettings() = set { it.openOverlay(Overlay.SETTINGS) }

    fun openOnboarding() = set { it.openOverlay(Overlay.ONBOARDING) }

    fun closeOverlay() = set { it.closeOverlay() }

    fun openDrawer() = set { it.copy(drawerOpen = true) }

    fun closeDrawer() = set { it.copy(drawerOpen = false) }

    fun openChatList() = set { it.copy(chatListOpen = true) }

    fun closeChatList() = set { it.copy(chatListOpen = false) }

    fun canGoBack(): Boolean = _state.value.back(twoPane) != null

    /** Whether Back would stop at the composer's "Save draft?" instead of moving. */
    fun backAsks(): Boolean {
        val now = _state.value
        val next = now.back(twoPane) ?: return false
        return now.composerOpen && !next.composerOpen && composerAsks()
    }

    /** One step back; false when there was nothing to close. Closing the composer goes through [closeComposer]. */
    fun back(): Boolean {
        val now = _state.value
        val next = now.back(twoPane) ?: return false
        if (now.composerOpen && !next.composerOpen) {
            closeComposer()
            return true
        }
        set { next }
        return true
    }

    companion object {
        private const val KEY = "nav"

        /** The [pendingRecipients] key of one field ("to", "cc", "bcc") of one composer. */
        fun pendingKey(composerId: String, field: String) = "$composerId|$field"

        fun factory(services: AppServices): ViewModelProvider.Factory = viewModelFactory {
            initializer { AppViewModel(services, createSavedStateHandle()) }
        }
    }
}
