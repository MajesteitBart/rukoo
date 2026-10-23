package nl.bvdm.rukoo.ui.agent

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.model.ConversationRow
import nl.bvdm.rukoo.agents.model.ConversationStatus
import nl.bvdm.rukoo.agents.model.Unread
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.ui.components.DotTone
import nl.bvdm.rukoo.ui.components.LocalRkToast
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.components.Spinner
import nl.bvdm.rukoo.ui.components.StatusDot
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.tabular

/** What a chat is doing, in the order it matters to the user (panel.js chatState). */
enum class ChatState { WAITING, RUNNING, ERROR, UNREAD, NONE }

fun chatState(row: ConversationRow): ChatState = when {
    row.waiting -> ChatState.WAITING
    row.status == ConversationStatus.RUNNING -> ChatState.RUNNING
    row.unread == Unread.ERROR -> ChatState.ERROR
    row.unread == Unread.REPLY -> ChatState.UNREAD
    else -> ChatState.NONE
}

/**
 * Every chat, newest message first (the bell's list): a status mark (orange waiting, spinner working, red
 * stopped with an error, blue reply ready), the title, its time, and the agent with what the chat is doing or
 * the start of the last answer. Picking a chat opens it with its newest email.
 */
@Composable
fun ChatListSheet(app: AppViewModel, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val hub = app.services.agents
    val rows by hub.conversations.collectAsStateWithLifecycle()
    val agents by hub.agents.collectAsStateWithLifecycle()
    val nav by app.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val toast = LocalRkToast.current
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    RkBottomSheet(onDismissRequest = onDismiss, modifier = modifier, title = stringResource(R.string.agentui_panel_history)) {
        if (rows.isEmpty()) {
            SheetRow(stringResource(R.string.agentui_panel_no_history), onClick = {}, enabled = false)
        } else {
            val now = System.currentTimeMillis()
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp)) {
                items(rows, key = { it.id }) { row ->
                    val agent = agents.firstOrNull { it.id == row.agent }?.name ?: hub.agentName(row.agent)
                    ChatRow(
                        row,
                        agent = agent,
                        time = ChatFormat.listTime(row.lastAt.takeIf { it > 0 } ?: row.updatedAt, now, locale),
                        checked = nav.chatOpen && nav.chatConversationId == row.id,
                    ) {
                        scope.launch {
                            val email = newestEmail(app, row.id)
                            if (email == null && hub.get(row.id)?.message != null) toast.showToast(context.getString(R.string.agentui_panel_source_gone))
                            app.openChat(row.id, email)
                        }
                    }
                }
            }
        }
    }
}

/** The newest email a chat has that is still in Rukoo: a continued one first, then its own (found again by Message-ID). */
private suspend fun newestEmail(app: AppViewModel, conversationId: String): String? {
    val conversation = app.services.agents.get(conversationId) ?: return null
    val refs = conversation.continued.reversed().map { it.ref() } + listOfNotNull(conversation.message)
    for (ref in refs) locate(app.services.mail, ref.id, ref.messageId, ref.accountId)?.let { return it }
    return null
}

private suspend fun locate(mail: MailEngine, id: String, header: String?, accountId: String?): String? = try {
    mail.summary(id)?.id ?: header?.takeIf { it.isNotBlank() }?.let { mail.findByMessageId(it, accountId).firstOrNull()?.id }
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    null
}

@Composable
private fun ChatRow(row: ConversationRow, agent: String, time: String, checked: Boolean, onClick: () -> Unit) {
    val c = Rk.colors
    val state = chatState(row)
    val what = when (state) {
        ChatState.WAITING -> stringResource(R.string.agentui_items_waiting)
        ChatState.RUNNING -> stringResource(R.string.agentui_panel_chat_working)
        ChatState.UNREAD -> stringResource(R.string.agentui_panel_chat_ready)
        ChatState.ERROR -> stringResource(R.string.agentui_panel_chat_failed)
        ChatState.NONE -> ChatFormat.plainPreview(row.preview)
    }
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .rkClickable(RectangleShape, onClick = onClick)
            .semantics { selected = checked }
            .padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(12.dp), contentAlignment = Alignment.Center) {
            when (state) {
                ChatState.RUNNING -> Spinner(size = 12.dp)
                ChatState.WAITING -> StatusDot(DotTone.BUSY, size = 7.dp)
                ChatState.ERROR -> StatusDot(DotTone.OFFLINE, size = 7.dp)
                ChatState.UNREAD -> StatusDot(DotTone.UNREAD, size = 7.dp)
                ChatState.NONE -> StatusDot(DotTone.NONE, size = 7.dp)
            }
        }
        Column(Modifier.weight(1f)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    row.title.ifBlank { stringResource(R.string.agentui_panel_new_chat) },
                    style = Rk.type.text13.medium,
                    color = c.text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(time, style = Rk.type.text11.tabular, color = c.text3, maxLines = 1)
            }
            Text(
                if (what.isBlank()) agent else "$agent · $what",
                style = Rk.type.text11_5,
                color = c.text3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 1.dp),
            )
        }
        if (checked) RkIcon(RukooIcons.Check, null, size = 16.dp, tint = c.text2)
    }
}
