package nl.bvdm.rukoo.ui.agent

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.SendRequest
import nl.bvdm.rukoo.agents.model.AssistantStatus
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.Pane

/**
 * The agent chat (track D). Placeholder: one line per transcript item, quick actions for a new chat,
 * and an input that creates the conversation on the first message. [emailId] is the email a new chat is about.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatPane(app: AppViewModel, conversationId: String?, emailId: String?, modifier: Modifier = Modifier) {
    val hub = app.services.agents
    val flow = remember(conversationId) { conversationId?.let { hub.conversation(it) } ?: flowOf(null) }
    val conversation by flow.collectAsStateWithLifecycle(null)
    val agents by hub.agents.collectAsStateWithLifecycle()
    val agentId = conversation?.agent ?: app.services.agentSettings.current().defaultAgent
    val agentName = agents.firstOrNull { it.id == agentId }?.name ?: agentId
    val email by produceState<String?>(null, emailId) { value = emailId?.let { app.services.mail.summary(it)?.subject } }
    val scope = rememberCoroutineScope()
    var text by rememberSaveable(conversationId) { mutableStateOf("") }

    fun send(request: SendRequest) {
        scope.launch {
            val id = conversation?.id ?: run {
                val summary = emailId?.let { app.services.mail.summary(it) }
                val ref = summary?.let { MessageRef(it.id, it.messageId, it.accountId, it.subject, it.from, it.date) }
                hub.create(agentId, ref).id.also(app::chatCreated)
            }
            runCatching { hub.send(id, request) }
        }
    }

    Column(modifier.onFocusChanged { app.chatFocused = it.hasFocus; if (it.hasFocus) app.interacted(Pane.CHAT) }) {
        TopAppBar(
            title = {
                Column {
                    Text(conversation?.title?.ifEmpty { null } ?: stringResource(R.string.scaffold_new_chat), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(agentName, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            navigationIcon = {
                IconButton(onClick = app::closeChat) {
                    if (app.twoPane) Icon(Icons.Default.Close, stringResource(R.string.common_actions_close))
                    else Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.common_actions_back))
                }
            },
            actions = {
                if (app.twoPane) IconButton(onClick = app::showList) { Icon(Icons.AutoMirrored.Filled.List, stringResource(R.string.scaffold_show_list)) }
            },
        )
        email?.let {
            Text(it, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 16.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        val items = conversation?.items.orEmpty()
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(items, key = { it.id }) { ItemLine(it) }
        }
        if (items.isEmpty()) {
            val actions = hub.quickActions().filter { it.applies(emailOpen = emailId != null, unsubscribe = false) && !it.hidden }
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                actions.forEach { action ->
                    AssistChip(onClick = { send(SendRequest(action.prompt, action.action, action.slash)) }, label = { Text(action.slash) })
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(8.dp).imePadding()) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                placeholder = { Text(stringResource(R.string.scaffold_chat_placeholder, agentName)) },
                modifier = Modifier.weight(1f),
            )
            IconButton(
                onClick = {
                    val message = text.trim()
                    if (message.isNotEmpty()) {
                        text = ""
                        send(SendRequest(message))
                    }
                },
            ) { Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.scaffold_send)) }
        }
    }
}

// Status as a symbol, so the placeholder needs no words of its own.
private fun mark(status: Enum<*>): String = when (status.name) {
    "RUNNING", "STREAMING" -> "…"
    "DONE", "APPROVED" -> "✓"
    "ERROR", "FAILED", "DENIED" -> "✗"
    "PENDING" -> "?"
    "PROPOSED" -> "◇"
    "TODO" -> "○"
    else -> "–"
}

/** One transcript item as a line of text: enough to see the order and states. */
@Composable
private fun ItemLine(item: Item) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    when (item) {
        is Item.User -> Text("> ${item.text}", color = MaterialTheme.colorScheme.primary)
        is Item.Assistant -> Text(
            if (item.status == AssistantStatus.DONE) item.text else "${item.text} ${mark(item.status)}",
            fontStyle = if (item.interim) FontStyle.Italic else FontStyle.Normal,
        )
        is Item.Thinking -> Text("${mark(item.status)} ${item.text}", color = muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        is Item.Tool -> Text("${mark(item.status)} ${item.label}  ${item.detail}", color = muted, style = MaterialTheme.typography.bodySmall)
        is Item.Approval -> Text("${mark(item.status)} ${item.title}  (${item.choices.joinToString(" / ") { it.label }})")
        is Item.Notice -> Text("! ${item.text}", color = if (item.tone == Tone.ERROR) MaterialTheme.colorScheme.error else muted)
        is Item.Draft -> Text("✎ ${item.subject}: ${item.summary}", color = muted)
        is Item.Plan -> Text("☰ ${item.title}: " + item.tasks.joinToString(", ") { "${mark(it.status)} ${it.title}" })
        is Item.Sources -> Text("§ ${item.title}: " + item.sources.joinToString(", ") { it.title }, color = muted)
    }
}
