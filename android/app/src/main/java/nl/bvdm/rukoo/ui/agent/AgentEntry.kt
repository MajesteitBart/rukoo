package nl.bvdm.rukoo.ui.agent

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.HubEvent
import nl.bvdm.rukoo.agents.model.ConversationRow
import nl.bvdm.rukoo.agents.model.Unread
import nl.bvdm.rukoo.ui.components.LocalRkToast
import nl.bvdm.rukoo.ui.components.NewsTone
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.theme.Rk

/** Chats with news the user hasn't seen: an answer, or an approval waiting. [tone] is WAITING when any chat waits. */
data class AgentNews(val count: Int, val tone: NewsTone?)

/** News = chats with an unseen answer or a waiting approval that aren't on screen (panel.js news()). */
fun agentNews(rows: List<ConversationRow>, onScreen: String?): AgentNews {
    val news = rows.filter { (it.unread != Unread.NONE || it.waiting) && it.id != onScreen }
    val tone = when {
        news.isEmpty() -> null
        news.any { it.waiting } -> NewsTone.WAITING
        else -> NewsTone.UNREAD
    }
    return AgentNews(news.size, tone)
}

@Composable
fun rememberAgentNews(app: AppViewModel): AgentNews {
    val rows by app.services.agents.conversations.collectAsStateWithLifecycle()
    val screen by app.services.screen.state.collectAsStateWithLifecycle()
    return agentNews(rows, screen.chatConversationId)
}

/**
 * The agent entry point for the list's top bar and the reader's bottom bar (spec 6 §5.4): Rukoo's sparkle,
 * "Chat with an agent", with the 7dp news dot ringed in [ring], the bar's color. It opens the chat about
 * [emailId], or a chat without an email.
 */
@Composable
fun AgentEntryButton(app: AppViewModel, emailId: String?, modifier: Modifier = Modifier, ring: Color = Rk.colors.panel) {
    val news = rememberAgentNews(app)
    RkIconButton(
        RukooIcons.Sparkle,
        stringResource(R.string.agentui_panel_entry),
        onClick = { app.openChat(emailId = emailId) },
        modifier = modifier,
        news = news.tone,
        newsRing = ring,
    )
}

/**
 * The bell that opens the chat list, for the list's top bar: plain without news, a pill with the count when
 * chats have news (blue answers, orange approvals).
 */
@Composable
fun ChatListButton(app: AppViewModel) {
    val news = rememberAgentNews(app)
    BellButton(news.count, news.tone, app::openChatList)
}

/**
 * In-app notice for agents working off screen (panel.js onItem): "An agent is waiting for your approval" with
 * Show. Put it once at the root, inside the toast host's scope.
 */
@Composable
fun AgentToasts(app: AppViewModel) {
    val toast = LocalRkToast.current
    val context = LocalContext.current
    LaunchedEffect(app) {
        app.services.agents.events.collect { event ->
            if (event !is HubEvent.ApprovalWaiting) return@collect
            val screen = app.services.screen.state.value
            if (screen.foreground && screen.chatConversationId == event.conversationId) return@collect
            toast.showToast(
                context.getString(R.string.agentui_panel_needs_you),
                context.getString(R.string.agentui_panel_show),
            ) { app.openChat(event.conversationId) }
        }
    }
}
