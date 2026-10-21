package nl.bvdm.rukoo

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nl.bvdm.rukoo.settings.ThemeMode
import nl.bvdm.rukoo.ui.Mailto
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.RukooRoot

class MainActivity : ComponentActivity() {
    private val container: AppContainer get() = appContainer

    private val app: AppViewModel by viewModels { AppViewModel.factory(container) }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // A restored activity already handled the intent that started it.
        if (savedInstanceState == null) handleIntent(intent)
        setContent {
            val settings by container.settingsSnapshot.collectAsStateWithLifecycle()
            val dark = when (settings.theme) {
                ThemeMode.SYSTEM -> isSystemInDarkTheme()
                ThemeMode.LIGHT -> false
                ThemeMode.DARK -> true
            }
            // Plain Material until the Rukoo theme lands; then RukooTheme(settings.theme) wraps the root.
            MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
                Surface(color = MaterialTheme.colorScheme.background) { RukooRoot(app) }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        container.screen.setForeground(true)
    }

    override fun onStop() {
        container.screen.setForeground(false)
        super.onStop()
    }

    override fun onUserInteraction() {
        super.onUserInteraction()
        container.screen.touched()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val data = intent?.data ?: return
        when (data.scheme?.lowercase()) {
            "mailto" -> if (intent.action == Intent.ACTION_VIEW || intent.action == Intent.ACTION_SENDTO) {
                app.openComposer(Mailto.parse(data.toString()).toComposer())
            }
            OAUTH_SCHEME -> container.oauthReturns.tryEmit(data)
        }
    }

    companion object {
        /** The OAuth return deep link, `rukoo-oauth:/oauth?...` (a fixed scheme: applicationId has dots). */
        const val OAUTH_SCHEME = "rukoo-oauth"
    }
}
