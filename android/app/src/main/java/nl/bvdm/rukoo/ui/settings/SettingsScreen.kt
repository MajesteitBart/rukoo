package nl.bvdm.rukoo.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.settings.Language
import nl.bvdm.rukoo.settings.ThemeMode
import nl.bvdm.rukoo.ui.root.AppViewModel

/** Settings (track G). Placeholder: theme and language, enough to check both take effect. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(app: AppViewModel, modifier: Modifier = Modifier) {
    val settings by app.services.settingsSnapshot.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    Column(modifier) {
        TopAppBar(
            title = { Text(stringResource(R.string.scaffold_settings)) },
            navigationIcon = {
                IconButton(onClick = app::closeOverlay) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.common_actions_back)) }
            },
        )
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
            Text(stringResource(R.string.scaffold_theme), style = MaterialTheme.typography.titleSmall)
            val themes = listOf(
                ThemeMode.SYSTEM to R.string.scaffold_theme_system,
                ThemeMode.LIGHT to R.string.scaffold_theme_light,
                ThemeMode.DARK to R.string.scaffold_theme_dark,
            )
            for ((mode, label) in themes) {
                Choice(stringResource(label), settings.theme == mode) { scope.launch { app.services.settings.update { it.copy(theme = mode) } } }
            }
            Text(stringResource(R.string.scaffold_language), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 16.dp))
            val languages = listOf(
                Language.SYSTEM to R.string.scaffold_language_system,
                Language.EN to R.string.scaffold_language_en,
                Language.NL to R.string.scaffold_language_nl,
            )
            for ((language, label) in languages) {
                Choice(stringResource(label), settings.language == language) { scope.launch { app.services.settings.update { it.copy(language = language) } } }
            }
        }
    }
}

@Composable
private fun Choice(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().selectable(selected, role = Role.RadioButton, onClick = onClick).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Text(label, modifier = Modifier.padding(start = 12.dp))
    }
}
