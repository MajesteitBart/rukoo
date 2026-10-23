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
                // Android's "compose an email" intent may carry the fields as extras instead of in the URI.
                val fields = Mailto.withExtras(
                    Mailto.parse(data.toString()),
                    to = intent.getStringArrayExtra(Intent.EXTRA_EMAIL),
                    cc = intent.getStringArrayExtra(Intent.EXTRA_CC),
                    bcc = intent.getStringArrayExtra(Intent.EXTRA_BCC),
                    subject = intent.getStringExtra(Intent.EXTRA_SUBJECT),
                    text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(),
                )
                app.newMessage(fields)
                return
            }
            OAUTH_SCHEME -> {
                container.oauthReturns.tryEmit(data)
                return
            }
        }
        NotificationRoute.of(intent::getStringExtra) { intent.getBooleanExtra(it, false) }?.let(app::openRoute)
    }

    companion object {
        /** The OAuth return deep link, `rukoo-oauth:/oauth?...` (a fixed scheme: applicationId has dots). */
        const val OAUTH_SCHEME = "rukoo-oauth"

        // The extras every notification uses to open a screen: the mail notifier and the agent notifier put
        // these, NotificationRoute reads them. They are the only definition of the keys.

        /** The chat to open. */
        const val EXTRA_CONVERSATION_ID = "nl.bvdm.rukoo.conversation"

        /** The email to open: a new-mail notification's message, or the email a chat is about. */
        const val EXTRA_MESSAGE_ID = "nl.bvdm.rukoo.message"

        /** New mail in one account: its inbox. */
        const val EXTRA_ACCOUNT_ID = "nl.bvdm.rukoo.account"

        /** "<Agent> wrote a draft": the composer to the front (a boolean). */
        const val EXTRA_SHOW_COMPOSER = "nl.bvdm.rukoo.composer"
    }
}

/** Where a notification tap goes, read from MainActivity's extras. */
sealed interface NotificationRoute {
    /** The agent's draft in the composer; its chat when the composer has closed since. */
    data class Composer(val chat: Chat?) : NotificationRoute

    /** A chat, next to its email when it has one. */
    data class Chat(val conversationId: String, val messageId: String?) : NotificationRoute

    /** One new email. */
    data class Message(val messageId: String) : NotificationRoute

    /** Several new emails in one account: its inbox. */
    data class Inbox(val accountId: String) : NotificationRoute

    companion object {
        /** The route of an intent's extras; a chat comes before its email, the composer before both. */
        fun of(string: (String) -> String?, flag: (String) -> Boolean): NotificationRoute? {
            val conversation = string(MainActivity.EXTRA_CONVERSATION_ID)
            val message = string(MainActivity.EXTRA_MESSAGE_ID)
            val account = string(MainActivity.EXTRA_ACCOUNT_ID)
            val chat = conversation?.let { Chat(it, message) }
            return when {
                flag(MainActivity.EXTRA_SHOW_COMPOSER) -> Composer(chat)
                chat != null -> chat
                message != null -> Message(message)
                account != null -> Inbox(account)
                else -> null
            }
        }
    }
}
