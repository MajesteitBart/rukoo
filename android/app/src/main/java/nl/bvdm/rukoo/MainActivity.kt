package nl.bvdm.rukoo

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.ViewKind
import nl.bvdm.rukoo.ui.Mailto
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.RukooRoot
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooTheme

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
            RukooTheme(settings.theme) {
                Surface(color = Rk.colors.bg) { RukooRoot(app) }
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
        intent ?: return
        val data = intent.data
        when (data?.scheme?.lowercase()) {
            "mailto" -> if (intent.action == Intent.ACTION_VIEW || intent.action == Intent.ACTION_SENDTO) {
                app.openComposer(Mailto.parse(data.toString()).toComposer())
                return
            }
            OAUTH_SCHEME -> {
                container.oauthReturns.tryEmit(data)
                return
            }
        }
        // Notification taps (new mail, an agent's reply, approval or draft). A chat comes before its email.
        val conversation = intent.getStringExtra(EXTRA_CONVERSATION_ID)
        val message = intent.getStringExtra(EXTRA_MESSAGE_ID)
        val account = intent.getStringExtra(EXTRA_ACCOUNT_ID)
        when {
            intent.getBooleanExtra(EXTRA_SHOW_COMPOSER, false) && container.composer.isOpen -> app.showComposer()
            conversation != null -> app.openChat(conversation, message)
            message != null -> app.openMessage(message)
            account != null -> app.selectView(MailView(ViewKind.INBOX, account.takeIf { id -> container.mail.accounts.value.size > 1 && container.mail.accounts.value.any { it.id == id } }))
        }
    }

    companion object {
        /** The OAuth return deep link, `rukoo-oauth:/oauth?...` (a fixed scheme: applicationId has dots). */
        const val OAUTH_SCHEME = "rukoo-oauth"

        /** Intent extras notifications use to open a screen; the agents track posts the same keys. */
        const val EXTRA_CONVERSATION_ID = "nl.bvdm.rukoo.conversation"
        const val EXTRA_MESSAGE_ID = "nl.bvdm.rukoo.message"

        /** New mail in one account: its inbox. */
        const val EXTRA_ACCOUNT_ID = "nl.bvdm.rukoo.account"

        /** "<Agent> wrote a draft": the composer to the front. */
        const val EXTRA_SHOW_COMPOSER = "nl.bvdm.rukoo.composer"
    }
}
