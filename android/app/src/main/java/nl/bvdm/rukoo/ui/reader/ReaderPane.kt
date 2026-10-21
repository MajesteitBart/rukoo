package nl.bvdm.rukoo.ui.reader

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.ui.ComposerState
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.Pane

/** The reader (track B). Placeholder: subject, sender and plain text of [messageId], Reply and the agent entry. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReaderPane(app: AppViewModel, messageId: String?, modifier: Modifier = Modifier) {
    if (messageId == null) {
        Box(modifier, contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.scaffold_reader_empty), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    val message by produceState<FullMessage?>(null, messageId) {
        value = runCatching { app.services.mail.fullMessage(messageId) }.getOrNull()
    }
    Column(modifier) {
        TopAppBar(
            title = {},
            navigationIcon = {
                if (!app.twoPane) {
                    IconButton(onClick = { app.back() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.common_actions_back))
                    }
                }
            },
            actions = {
                IconButton(onClick = { app.openChat(emailId = messageId) }) {
                    Icon(Icons.Default.AutoAwesome, stringResource(R.string.scaffold_chat_with_agent))
                }
            },
        )
        val m = message
        if (m == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(stringResource(R.string.scaffold_loading)) }
            return@Column
        }
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(m.subject.ifEmpty { stringResource(R.string.scaffold_no_subject) }, style = MaterialTheme.typography.titleLarge)
            Text(m.from.display(), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (m.attachments.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    m.attachments.forEach { AssistChip(onClick = {}, label = { Text(it.filename) }) }
                }
            }
            HorizontalDivider()
            Text(m.text, style = MaterialTheme.typography.bodyMedium)
        }
        Row(Modifier.padding(8.dp)) {
            TextButton(
                onClick = {
                    app.interacted(Pane.READER)
                    app.openComposer(
                        ComposerState(
                            accountId = m.accountId,
                            to = listOf(m.from),
                            subject = if (m.subject.startsWith("Re:", ignoreCase = true)) m.subject else "Re: ${m.subject}",
                            replyKind = ReplyKind.REPLY,
                            sourceMessageId = m.id,
                            inReplyTo = m.messageId,
                            references = m.references + listOfNotNull(m.messageId),
                        ),
                    )
                },
            ) {
                Icon(Icons.AutoMirrored.Filled.Reply, null)
                Text(stringResource(R.string.scaffold_reply), Modifier.padding(start = 8.dp))
            }
        }
    }
}
