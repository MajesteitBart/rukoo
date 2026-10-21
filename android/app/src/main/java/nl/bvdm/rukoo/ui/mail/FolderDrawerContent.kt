package nl.bvdm.rukoo.ui.mail

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.ViewKind
import nl.bvdm.rukoo.ui.root.AppViewModel

/** The folder drawer (track B). Placeholder: the unified views, then each account's own folders. */
@Composable
fun FolderDrawerContent(app: AppViewModel, modifier: Modifier = Modifier) {
    val nav by app.state.collectAsStateWithLifecycle()
    val accounts by app.services.mail.accounts.collectAsStateWithLifecycle()
    val folders by app.services.mail.folders.collectAsStateWithLifecycle()

    Column(modifier.verticalScroll(rememberScrollState()).padding(12.dp)) {
        Text(
            accounts.joinToString(", ") { it.email },
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
        )
        val views = listOf(ViewKind.INBOX, ViewKind.STARRED, ViewKind.DRAFTS, ViewKind.SENT, ViewKind.ARCHIVE, ViewKind.JUNK, ViewKind.TRASH)
        for (kind in views) {
            val view = MailView(kind)
            NavigationDrawerItem(
                label = { Text(viewTitle(view)) },
                selected = nav.view == view,
                onClick = { app.selectView(view) },
            )
        }
        for (account in accounts) {
            val own = folders[account.id].orEmpty().filter { it.role == FolderRole.NONE }
            if (own.isEmpty()) continue
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Text(
                stringResource(R.string.scaffold_folders),
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            for (folder in own) {
                val view = MailView.folder(account.id, folder.path)
                NavigationDrawerItem(
                    label = { Text(folder.name) },
                    badge = { if (folder.unread > 0) Text(folder.unread.toString()) },
                    selected = nav.view == view,
                    onClick = { app.selectView(view) },
                )
            }
        }
        HorizontalDivider(Modifier.padding(vertical = 8.dp))
        NavigationDrawerItem(
            label = { Text(stringResource(R.string.scaffold_settings)) },
            selected = false,
            onClick = {
                app.closeDrawer()
                app.openSettings()
            },
        )
    }
}
