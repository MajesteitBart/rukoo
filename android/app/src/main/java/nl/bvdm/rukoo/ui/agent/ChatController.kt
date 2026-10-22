package nl.bvdm.rukoo.ui.agent

import android.content.res.Resources
import androidx.compose.runtime.MutableState
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import kotlin.coroutines.cancellation.CancellationException
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.AgentException
import nl.bvdm.rukoo.agents.Hub
import nl.bvdm.rukoo.agents.SendRequest
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.ConversationStatus
import nl.bvdm.rukoo.agents.model.ErrorCodes
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.agents.model.RelatedChat
import nl.bvdm.rukoo.agents.model.SourceRef
import nl.bvdm.rukoo.core.Change
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.ui.ComposerState
import nl.bvdm.rukoo.ui.Mailto
import nl.bvdm.rukoo.ui.components.RkToastState
import nl.bvdm.rukoo.ui.mail.DialogChoice
import nl.bvdm.rukoo.ui.mail.DialogRequest
import nl.bvdm.rukoo.ui.root.AppViewModel

/**
 * What the chat pane keeps across fold and unfold and process death (panel.js's `P`): the agent, model and
 * effort picked for a chat that hasn't started, the email left out of it, the email the chat opened itself
 * (a source, a draft), and the email last matched to its chat.
 */
@Serializable
data class ChatLocal(
    val agent: String? = null,
    val model: String? = null,
    val effort: String? = null,
    /** The email the user left out of the chat that hasn't started; another email ends it. */
    val detachedFor: String? = null,
    /** An email opened from the chat (a source, a draft): the chat stays as it is. */
    val keepFor: String? = null,
    /** The email whose own chat was last looked up, so New chat doesn't jump straight back to it. */
    val lookedUpFor: String? = null,
    /** Emails added with "Add to chat" for the next message. Like the text in the input, they stay when another chat opens. */
    val emails: List<PendingEmail> = emptyList(),
)

/** The latest of what the pane shows, handed to [ChatController] on every composition. */
data class ChatSnapshot(
    val conversation: Conversation? = null,
    val emailId: String? = null,
    /** The email [emailId] names, once loaded. */
    val email: MessageRef? = null,
    val agent: String = "",
    val agentName: String = "",
    val blocked: Boolean = false,
    val models: ModelOptions? = null,
    val openMessageId: String? = null,
)

/**
 * The chat's behavior (desktop panel.js): sending, quick actions and skills, the model and effort, sources,
 * drafts and agent switching. Composables call it; it reaches the hub and the app through [app]. Plain fields
 * hold the latest state ([snapshot]); the saved state lives in [local] and the input in [input].
 */
class ChatController(
    private val app: AppViewModel,
    private val scope: CoroutineScope,
    private val toast: RkToastState,
    private val resources: () -> Resources,
    val local: MutableState<ChatLocal>,
    val input: MutableState<TextFieldValue>,
    private val openExternal: (String) -> Unit,
) {
    private val hub get() = app.services.agents
    private val mail: MailEngine get() = app.services.mail
    var snapshot = ChatSnapshot()
    /** Called after a message went out, so the transcript follows it to the bottom. */
    var onSent: () -> Unit = {}
    private var sending = false

    private fun say(text: Txt) = toast.showToast(text.resolve(resources()))

    private fun sayError(e: Throwable) {
        val code = (e as? AgentException)?.code ?: ErrorCodes.UNKNOWN
        toast.showError(AgentText.error(code, snapshot.agentName).resolve(resources()))
    }

    /**
     * The email the chat is about: its own once it started (none for a chat that started without one), else the
     * open one unless the user left it out.
     */
    fun contextEmail(): MessageRef? {
        val conversation = snapshot.conversation
        if (conversation != null) return conversation.message
        return snapshot.email?.takeIf { !detached() }
    }

    fun detached(): Boolean = snapshot.conversation == null && local.value.detachedFor != null && local.value.detachedFor == snapshot.emailId

    fun quickActions(): List<QuickAction> = hub.quickActions()

    fun commands(): List<SlashCommand> {
        val email = contextEmail()
        return ChatInputLogic.commands(hub.quickActions(), hub.skills(), email != null, email?.unsubscribe == true)
    }

    // ---------- sending ----------

    /** Enter or Send. A message that is just one of the offered commands runs it; added emails alone are a message too. false: nothing went out. */
    fun submit(): Boolean {
        val text = input.value.text.trim()
        if ((text.isEmpty() && local.value.emails.isEmpty()) || snapshot.blocked) return false
        ChatInputLogic.wholeCommand(text, commands())?.let { command ->
            if (!runCommand(command)) return false
            clearInput()
            return true
        }
        val restore = input.value.text
        if (!send(SendRequest(text = text), restore)) return false
        clearInput()
        return true
    }

    fun runCommand(command: SlashCommand): Boolean =
        command.action?.let { runAction(it) } ?: send(SendRequest(skill = command.name), restore = null)

    /** A quick action or shortcut: its English prompt goes to the agent, its label shows in the chat. */
    fun runAction(action: QuickAction): Boolean {
        val needsEmail = action.needsEmail && !(action.custom && action.always)
        if (needsEmail && contextEmail() == null) {
            say(Txt.Res(R.string.agentui_panel_needs_email))
            return false
        }
        val label = AgentText.actionLabel(action).resolve(resources())
        return send(SendRequest(text = action.prompt, action = action.action, display = label), restore = null)
    }

    // The added emails go along with whatever is sent; taken here, before anything waits, so they are the ones on screen.
    private fun send(request: SendRequest, restore: String?): Boolean {
        if (sending || snapshot.blocked) return false
        sending = true
        val attached = local.value.emails
        if (attached.isNotEmpty()) local.value = local.value.copy(emails = emptyList())
        scope.launch {
            try {
                val conversation = ensureConversation()
                hub.send(conversation.id, request.copy(emails = attached.map { it.id }))
                onSent()
            } catch (e: CancellationException) {
                local.value = local.value.copy(emails = ChatAttachments.restore(attached, local.value.emails, emptySet()))
                throw e
            } catch (e: Exception) {
                // Not sent: the emails come back, without any the hub says are gone; so does the text, unless the
                // user typed something new meanwhile.
                val gone = ChatAttachments.missing(e)
                local.value = local.value.copy(emails = ChatAttachments.restore(attached, local.value.emails, gone.orEmpty()))
                if (restore != null && input.value.text.isEmpty()) input.value = TextFieldValue(restore, TextRange(restore.length))
                if (gone != null) toast.showToast(Txt.Res(R.string.agentui_files_email_gone).resolve(resources()), durationMs = 6000L) else sayError(e)
            } finally {
                sending = false
            }
        }
        return true
    }

    /**
     * "Add to chat" (panel.js addEmails): the emails go with the next message, up to [Hub.MAX_EMAILS]. One the chat
     * has already, or the message has, isn't added twice; when none was new, the user hears they are there already.
     */
    fun addEmails(ids: List<String>) {
        if (ids.isEmpty()) return
        scope.launch {
            val offered = ids.distinct().mapNotNull { id ->
                val m = try {
                    mail.summary(id)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    null
                } ?: return@mapNotNull null
                PendingEmail(m.id, m.messageId, m.subject, m.from)
            }
            val s = snapshot
            val result = ChatAttachments.add(local.value.emails, offered, Hub.MAX_EMAILS) { e ->
                ChatAttachments.inChat(e, s.conversation, s.emailId, s.email, detached())
            }
            local.value = local.value.copy(emails = result.emails)
            when {
                result.full -> toast.showToast(Txt.Res(R.string.agentui_files_too_many_emails, listOf(Hub.MAX_EMAILS)).resolve(resources()), durationMs = 6000L)
                result.added == 0 && result.had > 0 -> say(Txt.Plural(R.plurals.agentui_panel_in_chat_already, result.had))
            }
        }
    }

    fun removeEmail(id: String) {
        local.value = local.value.copy(emails = local.value.emails.filter { it.id != id })
    }

    /** Another chat came on screen: added emails it has itself go (the hub would leave them out anyway). */
    fun dropEmailsInChat() {
        val s = snapshot
        val kept = local.value.emails.filterNot { ChatAttachments.inChat(it, s.conversation, s.emailId, s.email, detached()) }
        if (kept.size != local.value.emails.size) local.value = local.value.copy(emails = kept)
    }

    /** The chat is created with its first message, about the email in the chip (none when it was left out). */
    private suspend fun ensureConversation(): Conversation {
        snapshot.conversation?.let { return it }
        val l = local.value
        val ref = if (detached()) null else snapshot.email
        val created = hub.create(snapshot.agent, ref, l.model, l.effort)
        local.value = local.value.copy(model = null, effort = null)
        app.chatCreated(created.id)
        return created
    }

    private fun clearInput() {
        input.value = TextFieldValue()
    }

    fun stop() {
        val id = snapshot.conversation?.id ?: return
        scope.launch { attempt { hub.stop(id) } }
    }

    // ---------- the transcript ----------

    /** Answers an approval card; [onFailed] gives the card its buttons back when the hub refused. */
    fun decide(itemId: String, choiceId: String, onFailed: () -> Unit = {}) {
        val id = snapshot.conversation?.id ?: return
        scope.launch { if (attempt { hub.decide(id, itemId, choiceId) } == null) onFailed() }
    }

    /** The Undo of a notice; [onFailed] gives the notice its Undo back when the hub refused. */
    fun undoNotice(itemId: String, onFailed: () -> Unit = {}) {
        val id = snapshot.conversation?.id ?: return
        scope.launch { if (attempt { hub.undo(id, itemId) } == null) onFailed() }
    }

    /** An email source opens in the reader (found again by its Message-ID if it moved); the chat stays. */
    fun openSource(source: SourceRef) {
        if (source.messageId != null) {
            scope.launch {
                val id = attempt { locate(source.messageId, source.messageHeader, source.accountId) }
                if (id == null) say(Txt.Res(R.string.agentui_panel_source_gone)) else openEmailFromChat(id)
            }
            return
        }
        source.url?.let { openLink(it) }
    }

    private fun openEmailFromChat(id: String) {
        local.value = local.value.copy(keepFor = id)
        app.openMessage(id)
    }

    /** The email by its Rukoo id, else by its Message-ID header: emails get a new id when they move. */
    private suspend fun locate(id: String?, header: String?, accountId: String?): String? {
        if (id != null) mail.summary(id)?.let { return it.id }
        if (!header.isNullOrBlank()) mail.findByMessageId(header, accountId).firstOrNull()?.let { return it.id }
        return null
    }

    /**
     * Links in answers, plans and sources. A mailto link opens Rukoo's composer; while the user is writing an email
     * it says so and leaves that email alone (handing the link to the system would bring it back to Rukoo's own
     * composer and replace the draft).
     */
    fun openLink(url: String) {
        if (Mailto.isMailto(url)) {
            if (app.services.composer.current()?.dirty == true) {
                say(Txt.Res(R.string.agentui_panel_composer_busy))
            } else {
                app.openComposer(Mailto.parse(url).toComposer())
            }
            return
        }
        if (ChatFormat.openableLink(url)) openExternal(url)
    }

    // ---------- drafts ----------

    /** The composer a draft card's write went into, while it is still open. */
    fun composerFor(item: Item.Draft, composer: ComposerState?): ComposerState? = DraftCards.composerFor(item, composer)

    fun showDraft(item: Item.Draft) {
        if (composerFor(item, app.services.composer.current()) != null) {
            app.showComposer()
            return
        }
        val ref = item.messageRef
        if (ref != null) {
            scope.launch {
                val id = attempt { locate(ref, null, null) }
                if (id == null) say(Txt.Res(R.string.agentui_draft_gone)) else openEmailFromChat(id)
            }
            return
        }
        say(Txt.Res(R.string.agentui_draft_gone))
    }

    /**
     * Undo takes the agent's text back out of the composer, as the composer's own Undo does (composer.js undoAgent):
     * what the composer held before the agent wrote comes back, and the cards of the writes it took back say so.
     * After the user's own edits the composer's Undo asks first, so the card hands over to it.
     */
    fun undoDraft(item: Item.Draft) {
        val composer = app.services.composer
        val open = composer.current()
        if (!DraftCards.canUndo(item, open)) {
            say(Txt.Res(R.string.agentui_draft_gone))
            return
        }
        val edited = open!!.editedAgent
        if (edited != null) {
            // After the user's own edits the composer's Undo asks first (composer.js undoAgent), in its words. Run in
            // the view model's scope: the answer may come after this pane left the screen.
            app.viewModelScope.launch {
                val r = resources()
                val answer = app.mailUi.ask(
                    DialogRequest(
                        r.getString(R.string.composer_agent_undo_title, edited),
                        r.getString(R.string.composer_agent_undo_help),
                        r.getString(R.string.composer_agent_undo),
                        r.getString(R.string.common_actions_cancel),
                    ),
                )
                if (answer.choice != DialogChoice.CONFIRM) return@launch
                // The composer can change while the question is open (sent, closed, written again).
                if (composer.current()?.id != open.id || !composer.undoAgentDraft()) {
                    say(Txt.Res(R.string.agentui_draft_gone))
                    return@launch
                }
                attempt { DraftCards.markUndone(hub, open.id) }
            }
            return
        }
        if (!composer.undoAgentDraft()) {
            say(Txt.Res(R.string.agentui_draft_gone))
            return
        }
        scope.launch { attempt { DraftCards.markUndone(hub, open.id) } }
    }

    // ---------- the chat itself ----------

    fun newChat() {
        local.value = local.value.copy(detachedFor = null, model = null, effort = null, lookedUpFor = snapshot.openMessageId)
        app.openChat(null, null)
    }

    /** Before the chat starts, the x leaves the email out; the dashed chip puts it back. */
    fun detach() {
        if (snapshot.conversation != null) return
        local.value = local.value.copy(detachedFor = snapshot.emailId)
    }

    fun attach() {
        local.value = local.value.copy(detachedFor = null)
    }

    /**
     * A chat stays with its agent; picking another one starts a new chat about the same email. A chat that started
     * without an email gives a new one without it too, even while an email is open.
     */
    fun pickAgent(id: String) {
        val conversation = snapshot.conversation
        local.value = if (id != snapshot.agent) local.value.copy(agent = id, model = null, effort = null) else local.value.copy(agent = id)
        if (conversation == null || conversation.agent == id) return
        val email = conversation.message?.id
        app.openChat(null, email)
        // Without an email of its own, openChat falls back to the open email: leave that one out.
        val shown = app.state.value.chatEmailId
        local.value = local.value.copy(lookedUpFor = shown, detachedFor = if (email == null) shown else null)
    }

    /** The model or effort for this chat; a started chat uses it from its next turn. */
    fun pickChoice(model: Change<String?>?, effort: Change<String?>?) {
        val conversation = snapshot.conversation
        val current = if (conversation != null) conversation.model to conversation.effort else local.value.model to local.value.effort
        val (nextModel, nextEffort) = ModelMenus.nextChoice(current, model, effort, snapshot.models)
        if (conversation == null) {
            local.value = local.value.copy(model = nextModel, effort = nextEffort)
            return
        }
        scope.launch { attempt { hub.setChoice(conversation.id, Change(nextModel), Change(nextEffort)) } }
    }

    fun continueChat(offer: RelatedChat) {
        val emailId = snapshot.emailId ?: return
        scope.launch {
            val continued = attempt { hub.continueFrom(offer.id, emailId) } ?: return@launch
            local.value = local.value.copy(model = null, effort = null, detachedFor = null, lookedUpFor = emailId)
            app.openChat(continued.id, emailId)
        }
    }

    fun running(): Boolean = snapshot.conversation?.status == ConversationStatus.RUNNING

    private suspend fun <T> attempt(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        sayError(e)
        null
    }
}

/** The model and effort menus' rules (panel.js modelItems, effortItems, refreshPickers). */
object ModelMenus {
    /** The efforts on offer for a model (null: the default model). Without a list there are none to go by. */
    fun effortsOf(list: ModelOptions?, model: String?): List<String> {
        if (list == null) return emptyList()
        if (model == null) return list.efforts
        return list.models.firstOrNull { it.id == model }?.efforts ?: list.custom
    }

    /** Hermes names a model of another provider "provider::model"; the menus show the model. */
    fun modelName(list: ModelOptions?, id: String): String =
        list?.models?.firstOrNull { it.id == id }?.label ?: id.substringAfterLast("::")

    /** What the chat uses: its own model, else the default in Settings, else the list's default. */
    fun shownModel(list: ModelOptions?, model: String?): String? =
        model ?: list?.defaultModel?.takeIf { it.isNotBlank() } ?: list?.models?.firstOrNull { it.isDefault }?.id

    /**
     * The model and effort after a pick (panel.js pickChoice): a key left out keeps its value, null is the default,
     * and an effort the new model doesn't offer goes back to the default (when the list loaded).
     */
    fun nextChoice(current: Pair<String?, String?>, model: Change<String?>?, effort: Change<String?>?, list: ModelOptions?): Pair<String?, String?> {
        val nextModel = if (model != null) model.value else current.first
        var nextEffort = if (effort != null) effort.value else current.second
        if (model != null && nextEffort != null && list != null && list.error == null && nextEffort !in effortsOf(list, nextModel)) nextEffort = null
        return nextModel to nextEffort
    }

    /** The effort Default comes down to, where the agent says so (Codex, per model). */
    fun defaultEffort(list: ModelOptions?, model: String?): String? {
        val id = model ?: list?.defaultModel?.takeIf { it.isNotBlank() } ?: return null
        return list?.models?.firstOrNull { it.id == id }?.defaultEffort?.takeIf { it.isNotBlank() }
    }
}
