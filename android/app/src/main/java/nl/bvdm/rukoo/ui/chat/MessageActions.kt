package nl.bvdm.rukoo.ui.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.SheetDivider
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.Mention
import nl.bvdm.rukoo.workspaces.PendingState
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind

/** What the person can do with a message that isn't sent (contract §3.8 "Answers" and "Resend modes"). */
enum class PendingAction { SEND, SEND_AGAIN, RETRY, SEND_WITHOUT_MENTIONS, COPY, DISCARD }

/** An unsent message as its actions need it: the outbox row's handle, its thread and what it says. */
data class PendingRow(val local: String, val root: String?, val text: String, val mentions: List<Mention>)

/** Which messages offer what (contract §3.8, §3.14, desktop chat-view.js), pure for the tests. */
object MessageRules {
    /**
     * The actions under an unsent message, by its state and reason: a held stale grant is sent again with Send, an
     * unknown outcome with Send again (asked first), a refused quota with Try again, refused mentions without them, and
     * a conflict or a closed room offers to copy the text. Every held or failed row can be discarded; a row still on
     * its way offers nothing.
     */
    fun pendingActions(state: PendingState, reason: String?): List<PendingAction> = when (state) {
        PendingState.HELD -> if (reason == "stale_grant") listOf(PendingAction.SEND, PendingAction.DISCARD) else listOf(PendingAction.SEND_AGAIN, PendingAction.DISCARD)
        PendingState.FAILED -> when (reason) {
            "quota" -> listOf(PendingAction.RETRY, PendingAction.DISCARD)
            "mentions" -> listOf(PendingAction.SEND_WITHOUT_MENTIONS, PendingAction.DISCARD)
            "conflict", "archived" -> listOf(PendingAction.COPY, PendingAction.DISCARD)
            else -> listOf(PendingAction.DISCARD)
        }
        PendingState.QUEUED, PendingState.SENDING, PendingState.WAITING -> emptyList()
    }

    /**
     * Whether [me] may remove [message] in [room] (§3.14): their own messages anywhere, open or closed, and any message
     * in a channel they manage. Removed and unsent messages can't be.
     */
    fun canRemove(message: ChatTimeline.Message, me: String?, room: Room): Boolean {
        if (message.removed || message.pending != null || message.id == null || me == null) return false
        return message.actor == me || (room.kind == RoomKind.CHANNEL && room.role == "manager")
    }

    /** Whether the message menu offers Reply in thread: outside a thread, for a message whose thread can be read. */
    fun canReply(message: ChatTimeline.Message, inThread: Boolean): Boolean =
        !inThread && message.pending == null && message.id != null && (!message.removed || message.root != null || (message.replies?.count ?: 0) > 0)

    /** Whether the menu offers Copy text. */
    fun canCopy(message: ChatTimeline.Message): Boolean = !message.removed && !message.text.isNullOrEmpty()

    /** Whether a long press opens the menu at all. */
    fun hasActions(message: ChatTimeline.Message, me: String?, room: Room, inThread: Boolean): Boolean =
        canReply(message, inThread) || canCopy(message) || canRemove(message, me, room)
}

/** Puts [text] on the clipboard, unmarked (android.md: the sensitive flag stays off), and says so. */
internal fun copyText(context: Context, app: AppViewModel, text: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(text.take(40), text))
    app.chatUi.toasts.showToast(app.chatUi.strings.get(R.string.chat_msg_copied))
}

/**
 * The menu of a message (android.md "Conversation", contract §5.5): Reply in thread (in the main timeline), Copy text,
 * and Remove message when the person may, which asks first. A long press opens it. It covers the panes, so the
 * timeline reports nothing as read meanwhile.
 */
@Composable
internal fun MessageActionsSheet(
    app: AppViewModel,
    ws: String,
    room: Room,
    message: ChatTimeline.Message,
    me: String?,
    inThread: Boolean,
    where: String,
    author: Member?,
    names: ChatNames,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    app.chatUi.Covering()
    RkBottomSheet(onDismissRequest = onDismiss, title = stringResource(R.string.chat_msg_actions)) {
        val sheet = this
        if (MessageRules.canReply(message, inThread)) {
            SheetRow(stringResource(R.string.chat_msg_reply), icon = ChatIcons.Bubble, onClick = {
                sheet.dismiss()
                app.openThread(message.root ?: message.id!!)
            })
        }
        if (MessageRules.canCopy(message)) {
            SheetRow(stringResource(R.string.chat_msg_copy), icon = PanelIcons.named("copy"), onClick = {
                sheet.dismiss()
                copyText(context, app, message.text.orEmpty())
            })
        }
        if (MessageRules.canRemove(message, me, room)) {
            if (MessageRules.canReply(message, inThread) || MessageRules.canCopy(message)) SheetDivider()
            SheetRow(stringResource(R.string.chat_msg_remove), icon = RukooIcons.Trash, danger = true, onClick = {
                sheet.dismiss()
                val other = if (message.actor == me) null else names.display(author)
                app.chatUi.remove(ws, room.id, message.id!!, where, other)
            })
        }
    }
}
