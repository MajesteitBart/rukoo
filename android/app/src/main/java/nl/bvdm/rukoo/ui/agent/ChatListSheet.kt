package nl.bvdm.rukoo.ui.agent

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.model.ConversationStatus
import nl.bvdm.rukoo.agents.model.Unread
import nl.bvdm.rukoo.ui.root.AppViewModel

/** Recent chats (track D), as a bottom sheet. Placeholder: title, preview and a status mark per chat. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListSheet(app: AppViewModel, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val rows by app.services.agents.conversations.collectAsStateWithLifecycle()
    ModalBottomSheet(onDismissRequest = onDismiss, modifier = modifier) {
        Text(stringResource(R.string.scaffold_recent_chats), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(16.dp))
        if (rows.isEmpty()) {
            Text(stringResource(R.string.scaffold_no_chats), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LazyColumn {
            items(rows, key = { it.id }) { row ->
                val mark = when {
                    row.status == ConversationStatus.RUNNING -> "…"
                    row.waiting -> "?"
                    row.unread == Unread.ERROR -> "✗"
                    row.unread == Unread.REPLY -> "●"
                    else -> ""
                }
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clickable { app.openChat(row.id) }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                ) {
                    Text("$mark ${row.title}".trim(), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(row.preview, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}
