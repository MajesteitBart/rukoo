package nl.bvdm.rukoo.ui.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.root.AppViewModel

/** First run and adding accounts (track G). Placeholder: the demo account. */
@Composable
fun OnboardingScreen(app: AppViewModel, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    Column(
        modifier.padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(stringResource(R.string.scaffold_setup_title), style = MaterialTheme.typography.headlineSmall)
        Button(
            onClick = {
                scope.launch {
                    runCatching { app.services.mail.addDemoAccount() }
                    app.closeOverlay()
                }
            },
        ) { Text(stringResource(R.string.scaffold_setup_demo)) }
    }
}
