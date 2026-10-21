package nl.bvdm.rukoo.ui.composer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.Pane

/** The composer (track B). Placeholder: the shared ComposerController's fields, editable, and Close. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComposerPane(app: AppViewModel, modifier: Modifier = Modifier) {
    val draft by app.services.composer.state.collectAsStateWithLifecycle()
    val d = draft ?: return
    Column(modifier) {
        TopAppBar(
            title = {
                Text(
                    stringResource(
                        when (d.replyKind) {
                            ReplyKind.REPLY -> R.string.scaffold_reply
                            ReplyKind.REPLY_ALL -> R.string.scaffold_reply_all
                            ReplyKind.FORWARD -> R.string.scaffold_forward
                            ReplyKind.DRAFT, ReplyKind.NEW -> R.string.scaffold_new_message
                        },
                    ),
                )
            },
            navigationIcon = {
                IconButton(onClick = app::closeComposer) { Icon(Icons.Default.Close, stringResource(R.string.common_actions_close)) }
            },
        )
        Column(
            Modifier.padding(horizontal = 16.dp).onFocusChanged { if (it.hasFocus) app.interacted(Pane.COMPOSER) },
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            d.draftedBy?.let {
                Text(stringResource(R.string.scaffold_drafted_by, it), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            }
            OutlinedTextField(
                value = d.to.joinToString(", ") { it.display() },
                onValueChange = {},
                readOnly = true,
                label = { Text(stringResource(R.string.scaffold_composer_to)) },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = d.subject,
                onValueChange = { v -> app.services.composer.update { it.copy(subject = v, dirty = true) } },
                label = { Text(stringResource(R.string.scaffold_composer_subject)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = d.body,
                onValueChange = { v -> app.services.composer.update { it.copy(body = v, dirty = true, draftedBy = null) } },
                label = { Text(stringResource(R.string.scaffold_composer_body)) },
                minLines = 8,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
