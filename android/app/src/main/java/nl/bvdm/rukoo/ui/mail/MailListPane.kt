package nl.bvdm.rukoo.ui.mail

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.model.ViewKind
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.Pane

/** The message list (track B). Placeholder: the view's subjects from the engine, tap to open. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MailListPane(app: AppViewModel, modifier: Modifier = Modifier) {
    val nav by app.state.collectAsStateWithLifecycle()
    val flow = remember(nav.view) { app.services.mail.messages(nav.view) }
    val messages by flow.collectAsStateWithLifecycle(emptyList())
    val unread by app.services.mail.unreadCount.collectAsStateWithLifecycle()

    Box(modifier) {
        Column(Modifier.fillMaxSize()) {
            TopAppBar(
                title = {
                    Column {
                        Text(viewTitle(nav.view), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            stringResource(R.string.scaffold_unread_count, unread),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = app::openDrawer) { Icon(Icons.Default.Menu, stringResource(R.string.scaffold_folders)) }
                },
                actions = {
                    IconButton(onClick = app::openChatList) { Icon(Icons.Default.Notifications, stringResource(R.string.scaffold_recent_chats)) }
                    IconButton(onClick = { app.openChat() }) { Icon(Icons.Default.AutoAwesome, stringResource(R.string.scaffold_chat_with_agent)) }
                    IconButton(onClick = app::openSettings) { Icon(Icons.Default.Settings, stringResource(R.string.scaffold_settings)) }
                },
            )
            if (messages.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(stringResource(R.string.scaffold_empty_folder), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(messages, key = { it.id }) { m ->
                        MessageRow(m, selected = m.id == nav.openMessageId) {
                            app.interacted(Pane.LIST)
                            app.openMessage(m.id)
                        }
                        HorizontalDivider()
                    }
                }
            }
        }
        ExtendedFloatingActionButton(
            onClick = { app.openComposer() },
            icon = { Icon(Icons.Default.Edit, null) },
            text = { Text(stringResource(R.string.scaffold_new_message)) },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }
}

@Composable
private fun MessageRow(m: MessageSummary, selected: Boolean, onClick: () -> Unit) {
    val bg = if (selected) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface
    Column(
        Modifier
            .fillMaxWidth()
            .background(bg)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        val weight = if (m.unread) FontWeight.SemiBold else FontWeight.Normal
        Text(
            m.from.name.ifEmpty { m.from.address }.ifEmpty { stringResource(R.string.scaffold_unknown_sender) },
            fontWeight = weight, maxLines = 1, overflow = TextOverflow.Ellipsis,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
        )
        Text(m.subject.ifEmpty { stringResource(R.string.scaffold_no_subject) }, fontWeight = weight, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(m.preview, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** The title of a view; folders show their name. */
@Composable
internal fun viewTitle(view: MailView): String = when (view.kind) {
    ViewKind.INBOX -> stringResource(R.string.scaffold_view_inbox)
    ViewKind.UNREAD -> stringResource(R.string.scaffold_view_unread)
    ViewKind.VIP -> stringResource(R.string.scaffold_view_vip)
    ViewKind.STARRED -> stringResource(R.string.scaffold_view_starred)
    ViewKind.DRAFTS -> stringResource(R.string.scaffold_view_drafts)
    ViewKind.SENT -> stringResource(R.string.scaffold_view_sent)
    ViewKind.ARCHIVE -> stringResource(R.string.scaffold_view_archive)
    ViewKind.JUNK -> stringResource(R.string.scaffold_view_junk)
    ViewKind.TRASH -> stringResource(R.string.scaffold_view_trash)
    ViewKind.EVERYTHING -> stringResource(R.string.scaffold_view_everything)
    ViewKind.FOLDER -> view.folder.orEmpty()
}
