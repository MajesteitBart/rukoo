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

    /**
     * Whether the menu offers Block {author} (contract §5.5, desktop chat-view.js): a full member ([myRole]) on a sent
     * message by someone else who is an active full member and isn't blocked yet. Unblocking is the Blocked list's.
     */
    fun canBlock(message: ChatTimeline.Message, me: String?, myRole: String?, author: Member?, blocked: Set<String>): Boolean =
        message.pending == null && message.id != null && me != null && message.actor != me && ChatListModel.isFullMember(myRole) &&
            author != null && author.state == "active" && ChatListModel.isFullMember(author.role) && message.actor !in blocked

    /** The menu's items in their order: Reply in thread, Copy text, Block {author}, Remove message. */
    fun actions(
        message: ChatTimeline.Message,
        me: String?,
        room: Room,
        inThread: Boolean,
        myRole: String?,
        author: Member?,
        blocked: Set<String>,
    ): List<MessageAction> = buildList {
        if (canReply(message, inThread)) add(MessageAction.REPLY)
        if (canCopy(message)) add(MessageAction.COPY)
        if (canBlock(message, me, myRole, author, blocked)) add(MessageAction.BLOCK)
        if (canRemove(message, me, room)) add(MessageAction.REMOVE)
    }

    /** How many characters of a message's first line the menu's title and Remove's question quote. */
    const val QUOTE_CHARS = 80

    /**
     * The first line of a message with text, white space folded, cut to [max] characters with an ellipsis: what the
     * menu's title and Remove's question quote, so the person sees which message they act on. Null without text.
     */
    fun firstLine(text: String?, max: Int = QUOTE_CHARS): String? {
        val line = text.orEmpty().lineSequence().map { it.replace(WHITE, " ").trim() }.firstOrNull { it.isNotEmpty() } ?: return null
        val points = line.codePointCount(0, line.length)
        if (points <= max) return line
        return line.substring(0, line.offsetByCodePoints(0, max)).trimEnd() + "…"
    }

    private val WHITE = Regex("\\s+")

    /** Whether a long press opens the menu at all. */
    fun hasActions(
        message: ChatTimeline.Message,
        me: String?,
        room: Room,
        inThread: Boolean,
        myRole: String?,
        author: Member?,
        blocked: Set<String>,
    ): Boolean = actions(message, me, room, inThread, myRole, author, blocked).isNotEmpty()
}

/** An item of a message's menu. */
enum class MessageAction { REPLY, COPY, BLOCK, REMOVE }

/** Puts [text] on the clipboard, unmarked (android.md: the sensitive flag stays off), and says so. */
internal fun copyText(context: Context, app: AppViewModel, text: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(text.take(40), text))
    app.chatUi.toasts.showToast(app.chatUi.strings.get(R.string.chat_msg_copied))
}

/**
 * The menu of a message (android.md "Conversation", contract §5.5): Reply in thread (in the main timeline), Copy text,
 * Block {author} on someone else's message, which asks first like the member menu's, and Remove message when the
 * person may, which asks first. A long press opens it. It covers the panes, so the timeline reports nothing as read
 * meanwhile.
 */
@Composable
internal fun MessageActionsSheet(
    app: AppViewModel,
    ws: String,
    room: Room,
    message: ChatTimeline.Message,
    me: String?,
    myRole: String?,
    blocked: Set<String>,
    inThread: Boolean,
    where: String,
    author: Member?,
    names: ChatNames,
    onDismiss: () -> Unit,
    /** How many replies the message has: its summary's count in the room, the thread's replies for its first message. */
    replyCount: Int = message.replies?.count ?: 0,
) {
    val context = LocalContext.current
    app.chatUi.Covering()
    val actions = MessageRules.actions(message, me, room, inThread, myRole, author, blocked)
    // The sheet covers the message, so its title says which one it is: the author and the first line.
    val line = if (message.removed) null else MessageRules.firstLine(message.text)
    val title = if (line != null) stringResource(R.string.chat_msg_actions_title, names.display(author), line) else stringResource(R.string.chat_msg_actions)
    RkBottomSheet(onDismissRequest = onDismiss, title = title) {
        val sheet = this
        if (MessageAction.REPLY in actions) {
            SheetRow(stringResource(R.string.chat_msg_reply), icon = ChatIcons.Bubble, onClick = {
                sheet.dismiss()
                app.openThread(message.root ?: message.id!!)
            })
        }
        if (MessageAction.COPY in actions) {
            SheetRow(stringResource(R.string.chat_msg_copy), icon = PanelIcons.named("copy"), onClick = {
                sheet.dismiss()
                copyText(context, app, message.text.orEmpty())
            })
        }
        if (MessageAction.BLOCK in actions) {
            if (MessageAction.REPLY in actions || MessageAction.COPY in actions) SheetDivider()
            val name = names.display(author)
            SheetRow(stringResource(R.string.chat_head_block, name), icon = RukooIcons.Ban, onClick = {
                sheet.dismiss()
                app.chatUi.askBlock(ws, message.actor, name)
            })
        }
        if (MessageAction.REMOVE in actions) {
            if (actions.first() != MessageAction.REMOVE) SheetDivider()
            SheetRow(stringResource(R.string.chat_msg_remove), icon = RukooIcons.Trash, danger = true, onClick = {
                sheet.dismiss()
                val other = if (message.actor == me) null else names.display(author)
                app.chatUi.remove(ws, room.id, message.id!!, where, other, quote = line, replies = replyCount)
            })
        }
    }
}
