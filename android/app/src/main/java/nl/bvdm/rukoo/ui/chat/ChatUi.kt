package nl.bvdm.rukoo.ui.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import java.util.Locale
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.RkToastState
import nl.bvdm.rukoo.ui.icons.IconSpec
import nl.bvdm.rukoo.ui.icons.IconSpecBuilder
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.mail.DialogAnswer
import nl.bvdm.rukoo.ui.mail.DialogChoice
import nl.bvdm.rukoo.ui.mail.DialogRequest
import nl.bvdm.rukoo.ui.mail.ResourceStrings
import nl.bvdm.rukoo.ui.mail.UiStrings
import nl.bvdm.rukoo.workspaces.ChatState
import nl.bvdm.rukoo.workspaces.MadeAgent
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.ResendMode
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind
import nl.bvdm.rukoo.workspaces.RoomMember
import nl.bvdm.rukoo.workspaces.WorkspaceError
import nl.bvdm.rukoo.workspaces.WorkspaceView
import nl.bvdm.rukoo.workspaces.Workspaces

/** What Chat's actions need from navigation. AppViewModel implements it. */
interface ChatUiHost {
    /** Opens a room in the selected workspace, at a seq when one is given. */
    fun openRoom(id: String, at: Long? = null)

    /** Shows another workspace, or none. */
    fun selectWorkspace(id: String?)

    /** Opens the thread of [root] in [room] of [ws], when that workspace is still the one on screen. */
    fun openThread(ws: String, room: String, root: String) {}
}

/**
 * What an error's text names: the account server's [host], the [workspace] it happened in, the person a block names
 * ([member], a display name) and the server of an invitation link for another server ([linkHost]).
 */
data class ErrorContext(val host: String = "", val workspace: String = "", val member: String? = null, val linkHost: String? = null)

/**
 * What a channel's mention list is loaded again by, in [ChatUi.mentionMembers] and the open picker: the room's roster
 * revision ([Room.roster]), which moves with every join and leave, also when one agent replaces another and both
 * counts stay. The counts come with the feed's row and the join or leave with the room's events, which can arrive a
 * run later when the cache was behind; either one changing loads the list again.
 */
data class MentionRoster(val people: Int, val agents: Int, val roster: Long) {
    companion object {
        fun of(room: Room) = MentionRoster(room.members, room.agents, room.roster)
    }
}

/** The texts of contract §3.15 for a [WorkspaceError], and of a failed send's reason (§3.8). Pure, for the tests. */
object ChatErrors {
    // The inputs a `400 invalid` names that are names, which get the name rule's text (§3.16).
    private val NAME_FIELDS = setOf("name", "displayName")

    fun text(e: Throwable, s: UiStrings, ctx: ErrorContext): String {
        if (e !is WorkspaceError) return s.get(R.string.chat_errors_failed)
        return when (e.code) {
            "network" -> s.get(R.string.chat_errors_network, ctx.host)
            "signed_out" -> s.get(R.string.chat_errors_signed_out)
            "upgrade_required" -> s.get(R.string.chat_errors_upgrade, ctx.host)
            "rate_limited" ->
                if (e.limit == "dailyDms") s.get(R.string.chat_errors_daily_dms)
                else (e.retryAfterS ?: 1L).toInt().let { s.plural(R.plurals.chat_errors_rate_limited, it, it) }
            "not_found" -> when (e.scope) {
                "workspace" -> s.get(R.string.chat_errors_gone_workspace)
                "conversation" -> s.get(R.string.chat_errors_gone_conversation)
                else -> s.get(R.string.chat_errors_not_found)
            }
            "forbidden" -> s.get(R.string.chat_errors_forbidden)
            "cosign_required" -> s.get(R.string.chat_channel_add_guest_needs_admin)
            "workspace_limit" -> s.get(R.string.chat_errors_workspace_limit, ctx.host)
            "workspaces_full" -> s.get(R.string.chat_errors_workspaces_full, ctx.host)
            "workspace_account_scope" -> s.get(R.string.chat_errors_account_scope)
            "dm_unavailable" -> s.get(R.string.chat_errors_dm_unavailable)
            "blocked" -> s.get(R.string.chat_errors_blocked, ctx.member.orEmpty())
            "name_taken" -> s.get(R.string.chat_errors_name_taken)
            "last_owner" -> s.get(R.string.chat_errors_last_owner)
            "last_manager" -> s.get(R.string.chat_errors_last_manager)
            "members_remain" -> s.get(R.string.chat_errors_members_remain)
            "archived" -> s.get(R.string.chat_errors_archived)
            "invite_gone" -> s.get(R.string.chat_errors_invite_gone)
            "quota" -> when (e.limit) {
                "members" -> s.get(R.string.chat_errors_quota_members, ctx.workspace)
                "conversations" -> s.get(R.string.chat_errors_quota_conversations, ctx.workspace)
                "invites" -> s.get(R.string.chat_errors_quota_invites, ctx.workspace)
                "bytes" -> s.get(R.string.chat_errors_quota_bytes, ctx.workspace)
                else -> s.get(R.string.chat_errors_quota, ctx.workspace)
            }
            "invalid" -> if (e.field in NAME_FIELDS) s.get(R.string.chat_errors_invalid_name) else s.get(R.string.chat_errors_invalid)
            "agent_limit" -> s.get(R.string.chat_errors_agent_limit, ctx.workspace)
            "agent_in_dm" -> s.get(R.string.chat_errors_agent_in_dm)
            "agent_not_manager" -> s.get(R.string.chat_errors_agent_not_manager)
            "agent_block" -> s.get(R.string.chat_errors_agent_block)
            "agent_role" -> s.get(R.string.chat_errors_agent_role)
            "sponsor_not_in_channel" -> s.get(R.string.chat_errors_agent_sponsor_not_in_channel)
            "bad_link" -> s.get(R.string.chat_join_bad_link)
            "other_server" -> s.get(R.string.chat_join_other_host, ctx.linkHost.orEmpty(), ctx.host)
            "not_saved" -> s.get(R.string.chat_errors_not_saved)
            "paused" -> s.get(R.string.chat_errors_paused, ctx.workspace)
            // `server`, and the engine's own outcomes, which never reach the UI as call errors (§3.15).
            else -> s.get(R.string.chat_errors_failed)
        }
    }

    /** Why a send failed, for "Not sent: {reason}" under a pending row. */
    fun reasonText(reason: String?, s: UiStrings, ctx: ErrorContext): String = when (reason) {
        "conflict" -> s.get(R.string.chat_errors_operation_conflict)
        "archived" -> s.get(R.string.chat_errors_archived)
        "quota" -> s.get(R.string.chat_errors_quota, ctx.workspace)
        "mentions" -> s.get(R.string.chat_errors_mentions)
        "root_removed" -> s.get(R.string.chat_errors_root_removed)
        "invalid" -> s.get(R.string.chat_errors_invalid)
        "no_access" -> s.get(R.string.chat_errors_gone_conversation)
        else -> s.get(R.string.chat_errors_failed)
    }
}

/**
 * Chat's work outside composition, like MailUi for mail: dialogs and confirm prompts, busy flags, error toasts and the
 * error texts of §3.15. It lives in the view model, so an action started in a sheet finishes after the sheet closed.
 * [workspaces] is null until the app has team chat (AppServices.workspaces).
 */
class ChatUi(
    val workspaces: Workspaces?,
    private val scope: CoroutineScope,
    private val host: ChatUiHost,
    val toasts: RkToastState = RkToastState(),
    private val state: () -> ChatState = { ChatState() },
) {
    /** Set by the root from the current resources, so texts follow the language. */
    var strings: UiStrings = object : UiStrings {
        override fun get(id: Int, vararg args: Any) = ""
        override fun plural(id: Int, count: Int, vararg args: Any) = ""
    }

    var dialog: DialogRequest? by mutableStateOf(null)
        private set

    private var covers by mutableIntStateOf(0)

    /**
     * Whether a dialog or sheet covers the panes: the timeline reports nothing as read meanwhile (§3.9). Sheets drawn
     * outside the navigation state count themselves with [Covering].
     */
    val covered: Boolean get() = covers > 0 || dialog != null

    /** Counts the composable calling it as covering the panes while it is on screen. */
    @Composable
    fun Covering() {
        DisposableEffect(this) {
            covers++
            onDispose { covers-- }
        }
    }

    /** Keys of the actions running now, for buttons that show progress. */
    var busy: Set<String> by mutableStateOf(emptySet())
        private set

    fun isBusy(key: String): Boolean = key in busy

    private val leaving = HashSet<String>()

    /**
     * The person is leaving or deleting the room or workspace [id] themself, so its going isn't news: no "You're no
     * longer in" toast when it disappears.
     */
    fun expectGone(id: String) {
        leaving += id
    }

    /** Whether [id] went because the person asked; true once. */
    fun wasExpected(id: String): Boolean = leaving.remove(id)

    /** The error context of [ws] (the selected workspace by default) on the configured server. */
    fun context(ws: String? = null, member: String? = null, linkHost: String? = null): ErrorContext {
        val s = state()
        val id = ws ?: s.selected
        return ErrorContext(host = s.host, workspace = s.workspaces.firstOrNull { it.id == id }?.name.orEmpty(), member = member, linkHost = linkHost)
    }

    fun errorText(e: Throwable, ctx: ErrorContext = context()): String = ChatErrors.text(e, strings, ctx)

    fun reasonText(reason: String?, ctx: ErrorContext = context()): String = ChatErrors.reasonText(reason, strings, ctx)

    fun showError(e: Throwable, ctx: ErrorContext = context()) = toasts.showError(errorText(e, ctx))

    /** Shows [request] and waits for the answer; an earlier open question is cancelled. */
    suspend fun ask(request: DialogRequest): DialogAnswer {
        dialog?.answer(DialogChoice.CANCEL)
        dialog = request
        return try {
            request.answer.await()
        } finally {
            if (dialog === request) dialog = null
        }
    }

    suspend fun confirm(title: String, message: String?, label: String, danger: Boolean = false): Boolean =
        ask(DialogRequest(title, message, label, strings.get(R.string.common_actions_cancel), danger)).choice == DialogChoice.CONFIRM

    /**
     * Runs [block] on the workspaces in the view model's scope, with [key] busy meanwhile (a second run with the same
     * key is ignored). A failure shows its §3.15 text in [ctx] as an error toast. Null when there is no team chat or
     * the key is busy.
     */
    fun launch(key: String? = null, ctx: ErrorContext? = null, block: suspend Workspaces.() -> Unit): Job? {
        val w = workspaces ?: return null
        if (key != null && key in busy) return null
        if (key != null) busy = busy + key
        return scope.launch {
            try {
                w.block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val named = named(w, e, ctx ?: context())
                val member = (e as? WorkspaceError)?.takeIf { it.code == "blocked" }?.member
                val ws = state().selected
                if (member != null && ws != null) {
                    // §3.12: `blocked` offers Unblock, also where the refusal came from outside a sheet, such as a
                    // closed DM's Start a new conversation.
                    val name = named.member.orEmpty()
                    toasts.showToast(errorText(e, named), strings.get(R.string.chat_block_unblock)) { unblockMember(ws, member, name) }
                } else {
                    showError(e, named)
                }
            } finally {
                if (key != null) busy = busy - key
            }
        }
    }

    /**
     * [ctx] with the name of the person a `409 blocked` names (§3.12 "You blocked {name}"), from the selected
     * workspace's directory, when the caller didn't know whom the server would name.
     */
    private suspend fun named(w: Workspaces, e: Exception, ctx: ErrorContext): ErrorContext {
        val member = (e as? WorkspaceError)?.member ?: return ctx
        if (ctx.member != null) return ctx
        val ws = state().selected ?: return ctx
        val view = try {
            withTimeoutOrNull(NAME_WAIT_MS) { w.view(ws).firstOrNull() }
        } catch (e2: CancellationException) {
            throw e2
        } catch (_: Exception) {
            null
        }
        return ctx.copy(member = names().display(view?.members?.firstOrNull { it.id == member }))
    }

    /** Pull to refresh and the status line's sync button: runs the feed of [ws], or of every workspace. */
    fun refresh(ws: String? = null) = launch("refresh:${ws.orEmpty()}") { refresh(ws) }

    /** Start over on a stopped workspace (§3.6). */
    fun reload(ws: String) = launch("reload:$ws", context(ws)) { reload(ws) }

    fun select(ws: String?) = host.selectWorkspace(ws)

    /** The busy key of joining [channel]. */
    fun joinKey(channel: String) = "join:$channel"

    /**
     * Join on a channel opened before joining it (§7.4). The room was already on screen when it had no cache row, so
     * its open did nothing: once joined it opens, for its history, inline events and catching up (§3.7).
     */
    fun join(ws: String, channel: String) = launch(joinKey(channel), context(ws)) {
        joinChannel(ws, channel)
        open(ws, channel)
    }

    /** Members' names in the interface language, for code outside composition. */
    fun names(): ChatNames = chatNames(strings)

    // ---- composers (contract §3.8, §3.17; android.md "Composer with mentions") ----

    // Each room's and thread's composer, kept here so its text survives folding, a thread opened over the room and a
    // new activity. The cache's draft fills it the first time; after the process ends the draft is all that is left.
    private val composers = HashMap<String, MutableState<ComposerValue>>()
    private val draftSaves = HashMap<String, Job>()

    private fun composerKey(ws: String, room: String, root: String?) = "$ws/$room/${root.orEmpty()}"

    /** The busy key of a send from that composer: its field is read-only while the message goes to disk. */
    fun sendKey(ws: String, room: String, root: String?) = "send:" + composerKey(ws, room, root)

    /** The composer of a room ([root] null) or a thread, made from [initial] (the cached draft) the first time. */
    fun composer(ws: String, room: String, root: String?, initial: () -> ComposerValue): MutableState<ComposerValue> =
        composers.getOrPut(composerKey(ws, room, root)) { mutableStateOf(initial()) }

    /**
     * The person changed the composer's text: it is kept as the draft 500 ms after the last change (§3.19
     * `DRAFT_SAVE_DELAY`), in the view model's scope, so a pane that closes meanwhile still saves it.
     */
    fun composerChanged(ws: String, room: String, root: String?, value: ComposerValue) {
        val key = composerKey(ws, room, root)
        composers.getOrPut(key) { mutableStateOf(value) }.value = value
        draftSaves.remove(key)?.cancel()
        val w = workspaces ?: return
        draftSaves[key] = scope.launch {
            delay(DRAFT_SAVE_DELAY_MS)
            quietly { w.saveDraft(ws, room, root, MentionEditing.toDraft(value)) }
        }
    }

    /**
     * Sends what the composer holds (§3.8 "Writing"). Once the message is on disk the composer and its draft empty; when
     * it couldn't be saved, the text stays and the error shows (`not_saved`).
     */
    fun send(ws: String, room: String, root: String?) {
        val key = composerKey(ws, room, root)
        val state = composers[key] ?: return
        val value = state.value
        val wire = MentionEditing.wire(value)
        if (!wire.canSend) return
        launch(sendKey(ws, room, root), context(ws)) {
            send(ws, room, root, wire.text, wire.mentions)
            draftSaves.remove(key)?.cancel()
            if (state.value.text == value.text) state.value = ComposerValue()
            quietly { saveDraft(ws, room, root, null) }
        }
    }

    /** Forgets every composer: the session ended, and its drafts went with the cache (§3.4). */
    fun forgetComposers() {
        draftSaves.values.forEach { it.cancel() }
        draftSaves.clear()
        composers.clear()
        mentionIds.clear()
    }

    // Who can be mentioned in each channel, with the roster it was loaded at: `GET /channels/{c}/members`.
    private val mentionIds = HashMap<String, Pair<MentionRoster, List<String>>>()

    /**
     * The member IDs of [room], for the mention picker; null when they couldn't load (offline). A channel's list is
     * kept while its [MentionRoster] stays, and loaded again when it changes or with [fresh], which the picker asks
     * for each time it opens (§3.17). When that load fails, the kept list stands in.
     */
    suspend fun mentionMembers(ws: String, room: Room, fresh: Boolean = false): List<String>? {
        if (room.kind == RoomKind.DM) return room.participants.orEmpty()
        val key = "$ws/${room.id}"
        val kept = mentionIds[key]
        val roster = MentionRoster.of(room)
        if (!fresh && kept != null && kept.first == roster) return kept.second
        val w = workspaces ?: return kept?.second
        return try {
            w.roomMembers(ws, room.id).map { it.member }.also { mentionIds[key] = roster to it }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            kept?.second
        }
    }

    // ---- sends on their way (§3.8 "Resend modes") and removing messages (§3.14) ----

    /**
     * What the person chose under an unsent message. Send again asks first, because the first one may have arrived.
     * Discard offers Undo, which puts the text back in the composer it came from. [copy] puts text on the clipboard.
     */
    fun pendingAction(ws: String, room: String, row: PendingRow, action: PendingAction, copy: (String) -> Unit) {
        when (action) {
            PendingAction.COPY -> copy(row.text)
            PendingAction.SEND -> launch("pending:${row.local}", context(ws)) { resend(row.local, ResendMode.SEND) }
            PendingAction.RETRY -> launch("pending:${row.local}", context(ws)) { resend(row.local, ResendMode.RETRY) }
            PendingAction.SEND_WITHOUT_MENTIONS -> launch("pending:${row.local}", context(ws)) { resend(row.local, ResendMode.WITHOUT_MENTIONS) }
            PendingAction.SEND_AGAIN -> launch("pending:${row.local}", context(ws)) {
                val ok = confirm(
                    strings.get(R.string.chat_msg_send_again_title),
                    strings.get(R.string.chat_msg_send_again_body),
                    strings.get(R.string.chat_msg_send_again),
                )
                if (ok) resend(row.local, ResendMode.SEND)
            }
            PendingAction.DISCARD -> launch("pending:${row.local}", context(ws)) {
                discard(row.local)
                toasts.showToast(strings.get(R.string.chat_msg_discarded), strings.get(R.string.common_actions_undo)) { restore(ws, room, row) }
            }
        }
    }

    // Undo of Discard: the text and mentions after what the composer holds. A thread reply discarded from the room goes
    // back to a composer that isn't on screen, so its thread opens with the text in it. A room composer this process
    // never showed is only its cached draft, which keeps its text too.
    private fun restore(ws: String, room: String, row: PendingRow) {
        val key = composerKey(ws, room, row.root)
        val root = row.root
        val state = composers[key]
        if (state != null) {
            composerChanged(ws, room, root, MentionEditing.append(state.value, row.text, row.mentions))
            if (root != null) host.openThread(ws, room, root)
            return
        }
        launch(ctx = context(ws)) {
            val kept = withTimeoutOrNull(DRAFT_READ_MS) {
                if (root == null) timeline(ws, room).firstOrNull()?.draft else thread(ws, room, root).firstOrNull()?.draft
            }
            // The composer may have come on screen meanwhile, from the draft as it was.
            val now = composers[key]
            when {
                now != null -> composerChanged(ws, room, root, MentionEditing.append(now.value, row.text, row.mentions))
                // The thread's composer starts from the draft with the text after it, and is kept as the draft.
                root != null -> composerChanged(ws, room, root, MentionEditing.append(MentionEditing.fromDraft(kept), row.text, row.mentions))
                else -> saveDraft(ws, room, root, MentionEditing.appendToDraft(kept, row.text, row.mentions))
            }
            if (root != null) host.openThread(ws, room, root)
        }
    }

    /**
     * Remove a message (§3.14, desktop-ui 6.14): asked first, quoting the message's first line ([quote], when it has
     * text), naming the room ([where]) and, for a manager removing someone else's message, its [author]; a message
     * with [replies] says they stay. The row changes once the server took it.
     */
    fun remove(ws: String, room: String, message: String, where: String, author: String?, quote: String? = null, replies: Int = 0) {
        launch("remove:$message", context(ws)) {
            if (confirm(strings.get(R.string.chat_remove_title), removeBody(where, author, quote, replies), strings.get(R.string.chat_remove_confirm), danger = true)) {
                redact(ws, room, message)
            }
        }
    }

    /** The text of Remove's question: the quoted first line, then what removing does. */
    internal fun removeBody(where: String, author: String?, quote: String?, replies: Int): String {
        val body = if (author == null) strings.get(R.string.chat_remove_body, where) else strings.get(R.string.chat_remove_body_other, where, author)
        val withReplies = if (replies > 0) body + " " + strings.get(R.string.chat_remove_replies) else body
        return if (quote.isNullOrEmpty()) withReplies else strings.get(R.string.chat_remove_quote, quote) + "\n\n" + withReplies
    }

    private suspend fun quietly(block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    // ---- sheets and their questions (android.md "Sheets and dialogs", contract §3.3, §3.12, §5.10) ----

    /**
     * Runs [block] like [launch], but a failure goes to [failed] instead of a toast: a sheet shows it under the field
     * it concerns and stays open (desktop-ui 6). Null when there is no team chat or [key] is busy.
     */
    fun attempt(key: String, failed: (Exception) -> Unit, block: suspend Workspaces.() -> Unit): Job? {
        val w = workspaces ?: return null
        if (key in busy) return null
        busy = busy + key
        return scope.launch {
            try {
                w.block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed(e)
            } finally {
                busy = busy - key
            }
        }
    }

    private fun wsName(ws: String): String = state().workspaces.firstOrNull { it.id == ws }?.name.orEmpty()

    /** Channel and member names in the interface language's order. */
    fun collator(): Comparator<String> {
        val c = java.text.Collator.getInstance(strings.locale).apply { strength = java.text.Collator.PRIMARY }
        return Comparator { a, b -> c.compare(a, b) }
    }

    /**
     * After making or joining [ws] (§3.3): it shows, with its first channel by sidebar order open. The service already
     * selected it and ran its first pass.
     */
    suspend fun arrive(ws: String) {
        val view = workspaces?.let { w -> withTimeoutOrNull(VIEW_WAIT_MS) { w.view(ws).firstOrNull() } }
        host.selectWorkspace(ws)
        SheetRules.firstChannel(view?.rooms.orEmpty(), collator())?.let { host.openRoom(it.id) }
    }

    /**
     * Opens the one-to-one DM with [member]: the open one when there is one, else a new one (§3.12 "New message", the
     * Message item of member menus).
     */
    fun message(ws: String, member: String, rooms: List<Room>, me: String?) = launch("message:$member", context(ws)) {
        val open = SheetRules.openDmFor(rooms, me, listOf(member))
        host.openRoom(open?.id ?: startDm(ws, listOf(member)))
    }

    /** Mute or unmute a room, saying so (§3.10). */
    fun mute(ws: String, room: String, title: String, muted: Boolean) = launch("mute:$room", context(ws)) {
        setMuted(ws, room, muted)
        // The mute toast also says that mentions go quiet, so it stays long enough to read, as on the desktop.
        if (muted) toasts.showToast(strings.get(R.string.chat_mute_done, title), durationMs = 5000L)
        else toasts.showToast(strings.get(R.string.chat_mute_undone, title))
    }

    fun markRead(ws: String, room: String) = launch("markRead:$room", context(ws)) { markAllRead(ws, room) }

    /**
     * A question with a name field, the name selected, that stays open until the name is taken or the person cancels
     * (desktop-ui 6): Save shows progress while [save] runs, and a refusal shows under the field in the error style.
     * [save] gets the trimmed name.
     */
    private suspend fun Workspaces.askName(title: String, hint: String?, current: String, placeholder: String, ws: String, save: suspend Workspaces.(String) -> Unit) {
        val w = this
        lateinit var request: DialogRequest
        request = DialogRequest(
            title,
            hint,
            strings.get(R.string.common_actions_save),
            strings.get(R.string.common_actions_cancel),
            input = current,
            inputPlaceholder = placeholder,
            selectInput = true,
            submit = submit@{ text ->
                val name = text.trim()
                if (!SheetRules.nameOk(name)) {
                    request.error = strings.get(R.string.chat_errors_invalid_name)
                    return@submit
                }
                if (name == current.trim()) return@submit request.answer(DialogChoice.CONFIRM, text)
                request.error = null
                request.busy = true
                scope.launch {
                    try {
                        w.save(name)
                        request.answer(DialogChoice.CONFIRM, text)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // Cancelled meanwhile: the question is gone, so the refusal is a toast.
                        if (request.answer.isCompleted) showError(e, context(ws)) else request.error = errorText(e, context(ws))
                    } finally {
                        request.busy = false
                    }
                }
            },
        )
        ask(request)
    }

    /** Your name in [ws] (desktop-ui 6.16 "You"). */
    fun askRenameMe(ws: String, current: String) = launch("renameMe:$ws", context(ws)) {
        askName(strings.get(R.string.chat_name_title, wsName(ws)), strings.get(R.string.chat_name_hint), current, strings.get(R.string.chat_make_your_name), ws) {
            renameMe(ws, it)
        }
    }

    /** Rename a channel (desktop-ui 6.7): names per §3.16, `name_taken` shows under the field. */
    fun askRenameChannel(ws: String, room: Room) = launch("rename:${room.id}", context(ws)) {
        val name = room.name.orEmpty()
        askName(strings.get(R.string.chat_channel_rename_title, name), null, name, strings.get(R.string.chat_channel_name), ws) {
            renameChannel(ws, room.id, it)
        }
    }

    /** Archive a channel (desktop-ui 6.8); the feed then brings the archived room. */
    fun askArchive(ws: String, room: Room) = launch("archive:${room.id}", context(ws)) {
        val name = room.name.orEmpty()
        val ok = confirm(
            strings.get(R.string.chat_channel_archive_title, name),
            strings.get(R.string.chat_channel_archive_body),
            strings.get(R.string.chat_channel_archive),
            danger = true,
        )
        if (ok) archiveChannel(ws, room.id)
    }

    /** The question in front of the panes that a plain confirmation can't hold; ChatOverlays draws it. */
    var prompt: ChatPrompt? by mutableStateOf(null)
        private set

    /** What went wrong in [prompt]; it stays open (desktop-ui 6). */
    var promptError: String? by mutableStateOf(null)
        private set

    fun dismissPrompt() {
        val p = prompt
        prompt = null
        promptError = null
        // The channel stays, so its going would be news again.
        if (p is ChatPrompt.Successor) wasExpected(p.room.id)
    }

    // The overlays on screen; the first draws, so a pane sliding in beside another shows each question once.
    private val overlays = androidx.compose.runtime.mutableStateListOf<Any>()

    /** Whether [owner] is the overlay that draws the prompts. */
    fun drawsOverlay(owner: Any): Boolean = overlays.firstOrNull() === owner

    fun claimOverlay(owner: Any) {
        if (owner !in overlays) overlays += owner
    }

    fun releaseOverlay(owner: Any) {
        overlays -= owner
    }

    /**
     * Leave a channel (desktop-ui 6.9). The only manager of a channel with others in it picks a successor from its full
     * members ([members] is the directory) in [prompt], without a confirmation first; anyone else is asked, with what
     * leaving means here. When the channel's members don't load, the server's `last_manager` opens the prompt instead.
     */
    fun askLeaveChannel(ws: String, room: Room, members: Map<String, Member>, me: String?) = launch("leave:${room.id}", context(ws)) {
        if (SheetRules.sharedManaged(listOf(room)).isNotEmpty()) {
            val inside = membersOrNull(ws, room.id)
            if (inside != null && SheetRules.soleManager(inside, me, agentIds(members))) {
                expectGone(room.id)
                promptError = null
                prompt = ChatPrompt.Successor(ws, room, SheetRules.successors(inside.map { it.member }, members, me, collator()))
                return@launch
            }
        }
        val name = room.name.orEmpty()
        val body = when (SheetRules.leaveBody(room)) {
            LeaveBody.LAST -> strings.get(R.string.chat_channel_leave_body_last, name)
            LeaveBody.PRIVATE -> strings.get(R.string.chat_channel_leave_body_private)
            LeaveBody.PUBLIC -> strings.get(R.string.chat_channel_leave_body_public)
        }
        if (!confirm(strings.get(R.string.chat_channel_leave_title, name), body, strings.get(R.string.chat_channel_leave), danger = true)) return@launch
        expectGone(room.id)
        try {
            leaveChannel(ws, room.id, null)
        } catch (e: WorkspaceError) {
            if (e.code != "last_manager") {
                wasExpected(room.id)
                throw e
            }
            val asking = ChatPrompt.Successor(ws, room, null)
            promptError = null
            prompt = asking
            try {
                val ids = roomMembers(ws, room.id).map { it.member }
                if (prompt === asking) prompt = asking.copy(people = SheetRules.successors(ids, members, me, collator()))
            } catch (e2: CancellationException) {
                throw e2
            } catch (e2: Exception) {
                if (prompt === asking) {
                    prompt = asking.copy(people = emptyList())
                    promptError = errorText(e2, context(ws))
                }
            }
        }
    }

    /** The successor [prompt]'s submit: leave, handing the channel to [successor]. */
    fun handOver(successor: String) {
        val p = prompt as? ChatPrompt.Successor ?: return
        attempt("leave:${p.room.id}", failed = { e -> if (prompt === p) promptError = errorText(e, context(p.ws)) }) {
            leaveChannel(p.ws, p.room.id, successor)
            if (prompt === p) {
                prompt = null
                promptError = null
            }
        }
    }

    /**
     * Leave a workspace (desktop-ui 6.10). What the app knows decides first, before any confirmation: the only owner
     * is told to make someone else an owner, with [onMembers] to do it, or offered Delete workspace with nobody else
     * left (§5.10); the only manager of channels with others in them picks a successor for each in [prompt], whose
     * button hands them over and leaves. Anyone else confirms. The server's `last_owner` and `last_manager` lead to
     * the same dialogs when the app couldn't tell.
     */
    fun askLeaveWorkspace(ws: String, view: WorkspaceView?, onMembers: () -> Unit) = launch("leaveWs:$ws", context(ws)) {
        val name = wsName(ws)
        if (view != null && SheetRules.onlyOwner(view)) return@launch lastOwner(this, ws, view, onMembers)
        if (view != null && handOverFirst(this, ws, name, view)) return@launch
        if (!confirm(strings.get(R.string.chat_leave_title, name), strings.get(R.string.chat_leave_body), strings.get(R.string.chat_leave_submit), danger = true)) return@launch
        expectGone(ws)
        try {
            leaveWorkspace(ws)
        } catch (e: WorkspaceError) {
            wasExpected(ws)
            when (e.code) {
                "last_manager" -> askHandOver(this, ws, name, e.channels, view)
                "last_owner" -> lastOwner(this, ws, view, onMembers)
                else -> throw e
            }
        }
    }

    /** The only owner can't leave: Members to make someone else an owner, or Delete workspace when nobody else is in it. */
    private suspend fun lastOwner(w: Workspaces, ws: String, view: WorkspaceView?, onMembers: () -> Unit) {
        val alone = view != null && SheetRules.alone(view)
        val text = strings.get(R.string.chat_leave_last_owner) + if (alone) "\n\n" + strings.get(R.string.chat_leave_delete_instead, wsName(ws)) else ""
        val answer = ask(
            DialogRequest(
                strings.get(R.string.chat_workspace_leave),
                text,
                strings.get(if (alone) R.string.chat_workspace_delete else R.string.chat_workspace_members),
                strings.get(R.string.common_actions_close),
                danger = alone,
            ),
        )
        if (answer.choice == DialogChoice.CONFIRM) if (alone) deleteAsked(w, ws) else onMembers()
    }

    /** A channel's members, or null when they don't load; the server's answer to leaving then decides. */
    private suspend fun Workspaces.membersOrNull(ws: String, channel: String): List<RoomMember>? = try {
        roomMembers(ws, channel)
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    /**
     * The hand-over [prompt] for the channels in [view] the person manages with others in them, shown at once with
     * their pickers loading. As each channel's members arrive it gets who can take it over, or goes when someone else
     * manages it too. True when the prompt stays (or the person closed it); false when nothing needs handing over or
     * a channel's members didn't load, and the confirmation (then the server's answer) decides.
     */
    private suspend fun handOverFirst(w: Workspaces, ws: String, name: String, view: WorkspaceView): Boolean {
        val shared = SheetRules.sharedManaged(view.rooms).sortedWith { a, b -> collator().compare(a.name.orEmpty(), b.name.orEmpty()) }
        if (shared.isEmpty()) return false
        var shown = ChatPrompt.HandOver(ws, name, shared.map { HandOverChannel(it.id, it.name.orEmpty(), it.visibility == "private") })
        promptError = null
        prompt = shown
        val directory = view.members.associateBy { it.id }
        val me = view.me.id
        var failed = false
        coroutineScope {
            for (room in shared) {
                this.launch {
                    val inside = w.membersOrNull(ws, room.id)
                    if (prompt !== shown) return@launch
                    // [prompt] keeps the old instance when set to an equal one, so only a real change is set.
                    if (inside == null) {
                        failed = true
                        return@launch
                    }
                    val channels = when {
                        SheetRules.soleManager(inside, me, agentIds(directory)) -> shown.channels.map { ch ->
                            if (ch.id == room.id) ch.copy(people = SheetRules.successors(inside.map { it.member }, directory, me, collator())) else ch
                        }
                        else -> shown.channels.filter { it.id != room.id }
                    }
                    shown = shown.copy(channels = channels)
                    prompt = shown
                }
            }
        }
        if (prompt !== shown) return true
        if (!failed && shown.channels.isNotEmpty()) return true
        prompt = null
        return false
    }

    /** The hand-over [prompt] for the channels a `409 last_manager` named, their people loading after it shows. */
    private suspend fun askHandOver(w: Workspaces, ws: String, name: String, ids: List<String>, view: WorkspaceView?) {
        val asking = ChatPrompt.HandOver(ws, name, SheetRules.handOver(ids, view))
        promptError = null
        prompt = asking
        val directory = view?.members.orEmpty().associateBy { it.id }
        val me = view?.me?.id
        var failed: Exception? = null
        val channels = asking.channels.map { ch ->
            val inside = try {
                w.roomMembers(ws, ch.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed = e
                null
            }
            if (inside == null) ch.copy(people = emptyList(), failed = true)
            else ch.copy(people = SheetRules.successors(inside.map { it.member }, directory, me, collator()))
        }
        if (prompt !== asking) return
        prompt = asking.copy(channels = channels)
        failed?.let { promptError = errorText(it, context(ws)) }
    }

    /**
     * The hand-over [prompt]'s submit (desktop-ui 6.10). Asks the server first, before any role changes: a
     * `last_owner` (the directory was incomplete, so the app couldn't tell) closes the prompt for the only-owner
     * dialog with nobody appointed, and a plain success needs no hand-over anymore. On `last_manager` it makes each
     * pick in [picks] (channel to member) a manager of its channel and leaves; channels the prompt didn't hold are
     * shown instead. [onMembers] is the only-owner dialog's Members.
     */
    fun handOverAndLeave(picks: Map<String, String>, onMembers: () -> Unit) {
        val p = prompt as? ChatPrompt.HandOver ?: return
        if (!SheetRules.handOverReady(p.channels, picks)) return
        attempt("leaveWs:${p.ws}", failed = { e -> if (prompt === p) promptError = errorText(e, context(p.ws)) }) {
            if (leaveOrAsk(this, p, onMembers, picked = false)) return@attempt
            for (ch in p.channels) setChannelRole(p.ws, ch.id, picks.getValue(ch.id), "manager")
            leaveOrAsk(this, p, onMembers, picked = true)
        }
    }

    /**
     * One try at leaving for the hand-over [p]: true when that settled it (left, or another dialog took over), false
     * on a `last_manager` before the picks were made ([picked]), which they answer. After them, a `last_manager`
     * shows the channels still named.
     */
    private suspend fun leaveOrAsk(w: Workspaces, p: ChatPrompt.HandOver, onMembers: () -> Unit, picked: Boolean): Boolean {
        expectGone(p.ws)
        try {
            w.leaveWorkspace(p.ws)
        } catch (e: WorkspaceError) {
            if (e.code == "not_found" && e.scope == "workspace") {
                // The removal the leave caused overtook its own answer: the person is out, as asked. The removal
                // path takes the expectation, so nothing says they were removed.
                if (prompt === p) {
                    prompt = null
                    promptError = null
                }
                return true
            }
            wasExpected(p.ws)
            if (prompt !== p) throw e
            when (e.code) {
                "last_owner" -> {
                    dismissPrompt()
                    val view = withTimeoutOrNull(VIEW_WAIT_MS) { w.view(p.ws).firstOrNull() }
                    lastOwner(w, p.ws, view, onMembers)
                    return true
                }
                "last_manager" -> {
                    if (!picked) return false
                    val view = withTimeoutOrNull(VIEW_WAIT_MS) { w.view(p.ws).firstOrNull() }
                    askHandOver(w, p.ws, p.name, e.channels, view)
                    return true
                }
                else -> throw e
            }
        } catch (e: Exception) {
            wasExpected(p.ws)
            throw e
        }
        if (prompt === p) {
            prompt = null
            promptError = null
        }
        return true
    }

    /** Delete a workspace as its only member (§2.14, desktop-ui 6.16): asked first, then said. */
    fun askDeleteWorkspace(ws: String) = launch("deleteWs:$ws", context(ws)) { deleteAsked(this, ws) }

    private suspend fun deleteAsked(w: Workspaces, ws: String) {
        val name = wsName(ws)
        if (!confirm(strings.get(R.string.chat_delete_title, name), strings.get(R.string.chat_delete_body), strings.get(R.string.chat_delete_submit), danger = true)) return
        expectGone(ws)
        try {
            w.deleteWorkspace(ws)
        } catch (e: Exception) {
            wasExpected(ws)
            throw e
        }
        toasts.showToast(strings.get(R.string.chat_delete_done, name))
    }

    /**
     * Leave a DM (§3.12). An open one closes for everyone in it, so the question says Close and names [others], the
     * other people already joined as the language lists them; a closed one leaves the list, so it says Remove.
     */
    fun askLeaveDm(ws: String, room: Room, others: String) = launch("leaveDm:${room.id}", context(ws)) {
        val ok = if (room.closedReason != null || room.archived) {
            confirmRemoveDm()
        } else {
            confirm(
                strings.get(R.string.chat_leave_dm_title),
                strings.get(R.string.chat_leave_dm_body, others),
                strings.get(R.string.chat_leave_dm_submit),
                danger = true,
            )
        }
        if (!ok) return@launch
        expectGone(room.id)
        try {
            leaveDm(ws, room.id)
        } catch (e: Exception) {
            wasExpected(room.id)
            throw e
        }
    }

    /** Remove from list on a closed DM: the question its bar button and the details row both ask. */
    suspend fun confirmRemoveDm(): Boolean = confirm(
        strings.get(R.string.chat_leave_dm_remove_title),
        strings.get(R.string.chat_leave_dm_body_closed),
        strings.get(R.string.chat_leave_dm_remove_submit),
        danger = false,
    )

    /**
     * Block someone (desktop-ui 6.13): what a block does in this workspace, that the conversations it closes stay
     * closed, and where to undo it; then said.
     */
    fun askBlock(ws: String, member: String, name: String) = launch("block:$member", context(ws, member = name)) {
        val ok = confirm(strings.get(R.string.chat_block_title, name), strings.get(R.string.chat_block_body, name, wsName(ws)), strings.get(R.string.chat_block_confirm), danger = true)
        if (!ok) return@launch
        block(ws, member)
        toasts.showToast(strings.get(R.string.chat_block_done, name))
    }

    /** Unblock: no question; closed DMs stay closed. */
    fun unblockMember(ws: String, member: String, name: String) = launch("block:$member", context(ws, member = name)) {
        unblock(ws, member)
        toasts.showToast(strings.get(R.string.chat_block_unblocked, name))
    }

    /**
     * Change [name]'s workspace role from [before] to [role] (desktop-ui 6.15). Owner and Guest ask first
     * ([SheetRules.roleAsks]); Admin and Member apply at once and say so, with Undo, which sets [before] back.
     */
    fun changeRole(ws: String, member: String, name: String, before: String, role: String) = launch("role:$member", context(ws)) {
        if (SheetRules.roleAsks(role)) {
            val owner = role == "owner"
            val ok = confirm(
                strings.get(if (owner) R.string.chat_members_owner_title else R.string.chat_members_guest_title, name),
                if (owner) strings.get(R.string.chat_members_owner_body, wsName(ws)) else strings.get(R.string.chat_members_guest_body, name),
                strings.get(if (owner) R.string.chat_members_owner_confirm else R.string.chat_members_guest_confirm),
                danger = !owner,
            )
            if (!ok) return@launch
        }
        setRole(ws, member, role)
        if (!SheetRules.roleAsks(role)) {
            val said = strings.get(if (role == "admin") R.string.chat_members_now_admin else R.string.chat_members_now_member, name)
            toasts.showToast(said, strings.get(R.string.common_actions_undo)) { launch("role:$member", context(ws)) { setRole(ws, member, before) } }
        }
    }

    /** Remove someone from the workspace (desktop-ui 6.15), asked first. */
    fun askRemoveMember(ws: String, member: String, name: String) = launch("remove:$member", context(ws)) {
        val ok = confirm(
            strings.get(R.string.chat_members_remove_title, name, wsName(ws)),
            strings.get(R.string.chat_members_remove_body, name),
            strings.get(R.string.chat_members_remove_confirm),
            danger = true,
        )
        if (ok) removeMember(ws, member)
    }

    /**
     * Make [name] a manager or a plain member of [channel] (desktop-ui 6.6): at once, said with Undo, which sets the
     * other role back. [changed] runs after the change and after Undo, for the members list to load again.
     */
    fun changeChannelRole(ws: String, channel: String, member: String, name: String, role: String, changed: () -> Unit = {}) =
        launch("channelRole:$member", context(ws)) {
            try {
                setChannelRole(ws, channel, member, role)
            } finally {
                changed()
            }
            val before = if (role == "manager") "member" else "manager"
            val said = strings.get(if (role == "manager") R.string.chat_channel_now_manager else R.string.chat_channel_now_member, name)
            toasts.showToast(said, strings.get(R.string.common_actions_undo)) {
                launch("channelRole:$member", context(ws)) { setChannelRole(ws, channel, member, before) }?.invokeOnCompletion { changed() }
            }
        }

    // ---- agents in channels ----

    /** The busy key of making a new key for [agent]. */
    fun agentKeyKey(agent: String) = "agentKey:$agent"

    /** A key made from Workspace members, on its way to the Agents sheet, which shows it once. Never saved. */
    private var heldAgentKey: Pair<String, MadeAgent>? = null

    /** Keeps [made], the new key of an agent in workspace [ws], for the Agents sheet to show next. */
    fun holdAgentKey(ws: String, made: MadeAgent) {
        heldAgentKey = ws to made
    }

    /** The key [holdAgentKey] kept for [agent] in [ws], once: it is forgotten either way. */
    fun takeAgentKey(ws: String, agent: String): MadeAgent? {
        val held = heldAgentKey
        heldAgentKey = null
        return held?.takeIf { it.first == ws && it.second.agent.id == agent }?.second
    }

    /**
     * A new key for [agent] (named [name]), asked first, as the old key stops working at once; [onKey] gets the agent
     * and its key, which nothing else shows again.
     */
    fun askNewAgentKey(ws: String, agent: String, name: String, onKey: (MadeAgent) -> Unit) = launch(agentKeyKey(agent), context(ws)) {
        val ok = confirm(
            strings.get(R.string.chat_agents_new_key_title, name),
            strings.get(R.string.chat_agents_new_key_body),
            strings.get(R.string.chat_agents_new_key_confirm),
        )
        if (ok) onKey(newAgentKey(ws, agent))
    }

    /** Remove an agent from the workspace, asked first: its key stops working and it leaves every channel. */
    fun askRemoveAgent(ws: String, agent: String, name: String) = launch("remove:$agent", context(ws)) {
        val ok = confirm(
            strings.get(R.string.chat_agents_remove_title, name),
            strings.get(R.string.chat_agents_remove_body, name),
            strings.get(R.string.chat_agents_remove_confirm),
            danger = true,
        )
        if (!ok) return@launch
        removeAgent(ws, agent)
        toasts.showToast(strings.get(R.string.chat_agents_removed, name))
    }

    /** Remove someone from a channel (desktop-ui 6.6), asked first. */
    fun askRemoveFromChannel(ws: String, channel: Room, member: String, name: String) = launch("channelRemove:$member", context(ws)) {
        val channelName = channel.name.orEmpty()
        val ok = confirm(
            strings.get(R.string.chat_channel_remove_title, name, channelName),
            strings.get(R.string.chat_channel_remove_body, name, channelName),
            strings.get(R.string.chat_members_remove_confirm),
            danger = true,
        )
        if (ok) removeFromChannel(ws, channel.id, member)
    }

    private companion object {
        // §3.19 DRAFT_SAVE_DELAY.
        const val DRAFT_SAVE_DELAY_MS = 500L

        // How long Undo waits for the cached draft; the cache answers at once unless it isn't open.
        const val DRAFT_READ_MS = 5_000L

        // How long a new workspace's view may take to come from the cache after its first pass.
        const val VIEW_WAIT_MS = 5_000L

        // How long an error's toast waits for the directory to name the person it is about.
        const val NAME_WAIT_MS = 2_000L
    }
}

/** Questions [ChatUi] puts in front of the panes that need more than a confirmation; ChatOverlays draws them. */
sealed interface ChatPrompt {
    /**
     * The only manager of [room] picks who manages it next before leaving (desktop-ui 6.9): its active full members
     * other than the person, [people] null while they load.
     */
    data class Successor(val ws: String, val room: Room, val people: List<Member>?) : ChatPrompt

    /**
     * Leaving [ws] (named [name]) as the only manager of [channels]: a successor is picked for each, then one button
     * hands them over and leaves (6.10).
     */
    data class HandOver(val ws: String, val name: String, val channels: List<HandOverChannel>) : ChatPrompt
}

/**
 * A channel the person has to hand over before leaving the workspace, with who can take it over ([people], null while
 * they load; empty and [failed] when they didn't load).
 */
data class HandOverChannel(val id: String, val name: String, val private: Boolean, val people: List<Member>? = null, val failed: Boolean = false)

/** The agents of a directory, which never count as a channel's people (SheetRules.soleManager). */
internal fun agentIds(members: Map<String, Member>): Set<String> = members.values.filter { it.isAgent }.mapTo(HashSet()) { it.id }

/** Members' names as [s] words them: Former member, Deleted member, " and N others" and the language's list. */
fun chatNames(s: UiStrings): ChatNames = ChatNames(
    former = s.get(R.string.chat_log_former_member),
    deleted = s.get(R.string.chat_log_deleted_member),
    others = { n -> s.plural(R.plurals.reader_recipients_others, n, n) },
    list = listFormat(s.locale),
)

/** Joins names as the language lists them ("Sanne, Mila and Olga"), with commas where ICU isn't there (unit tests). */
internal fun listFormat(locale: Locale): (List<String>) -> String = { names ->
    runCatching { android.icu.text.ListFormatter.getInstance(locale).format(names) }.getOrNull() ?: names.joinToString(", ")
}

/** [chatNames] for the current resources. */
@Composable
fun rememberChatNames(): ChatNames {
    val resources = LocalContext.current.resources
    val locale = LocalConfiguration.current.locales[0]
    return remember(resources, locale) { chatNames(ResourceStrings(resources)) }
}

/** The few line icons Chat needs that the app's set doesn't have, drawn like RukooIcons (24 grid, 1.6 strokes). */
internal object ChatIcons {
    private fun icon(name: String, block: IconSpecBuilder.() -> Unit): ImageVector =
        IconSpec(RukooIcons.STROKE, IconSpecBuilder().apply(block).parts).build(name)

    /** desktop icons.js `lock`: a private channel. */
    val Lock: ImageVector by lazy {
        icon("lock") {
            rect(5f, 10.5f, 14f, 10f, 2.5f)
            path("M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5")
            path("M12 14.5v2.5")
        }
    }

    /** A channel visible to the workspace. */
    val Hash: ImageVector by lazy { icon("hash") { path("M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16") } }

    /** A clipboard (Lucide `clipboard`), for Paste. */
    val Clipboard: ImageVector by lazy {
        icon("clipboard") {
            rect(8f, 2.5f, 8f, 4f, 1f)
            path("M16 4.5h1.5A2.5 2.5 0 0 1 20 7v12.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 19.5V7a2.5 2.5 0 0 1 2.5-2.5H8")
        }
    }

    /** A speech bubble, for Chat's empty states. */
    val Bubble: ImageVector by lazy {
        icon("bubble") { path("M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17h-1A.5.5 0 0 1 4 16.5z") }
    }
}
