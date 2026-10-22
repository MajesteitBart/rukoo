package nl.bvdm.rukoo.mail

import android.content.Context
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.core.SecretBox
import nl.bvdm.rukoo.mail.google.GoogleAuth
import nl.bvdm.rukoo.mail.google.GoogleClientStore
import nl.bvdm.rukoo.mail.mime.MimeComposer
import nl.bvdm.rukoo.mail.model.MailEvent
import nl.bvdm.rukoo.mail.sync.MailBackground
import nl.bvdm.rukoo.mail.sync.MailNotifier
import nl.bvdm.rukoo.mail.sync.WaitingMail
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.settings.SettingsStore
import okhttp3.OkHttpClient

/** Builds the real mail engine with Google sign-in, background sync and new-mail notifications. */
@OptIn(FlowPreview::class)
object MailModule {
    private const val PRUNE_DELAY_MS = 1_000L

    fun create(
        context: Context,
        scope: CoroutineScope,
        settings: SettingsStore,
        settingsSnapshot: StateFlow<AppSettings>,
        http: OkHttpClient,
    ): RukooMailEngine {
        val app = context.applicationContext
        MimeComposer.ensureMailcap()
        // Resources are read at use, so the texts follow the app's language as it changes.
        val strings = object : MailStrings {
            override fun get(id: Int, vararg args: Any): String = MailStrings.of(app.resources).get(id, *args)

            override fun plural(id: Int, count: Int, vararg args: Any): String = MailStrings.of(app.resources).plural(id, count, *args)
        }
        val dir = File(app.filesDir, "mail")
        val google = GoogleAuth(GoogleClientStore(File(dir, "google-client.json"), SecretBox), http, strings)
        val background = MailBackground(app, scope, settingsSnapshot)
        val notifier = MailNotifier(
            app,
            strings,
            enabled = { settingsSnapshot.value.notifyMail },
            foreground = { background.foreground },
            waiting = WaitingMail(File(dir, WaitingMail.FILE_NAME)),
        )
        lateinit var engine: RukooMailEngine
        engine = RukooMailEngine(
            dir = dir,
            attachmentsDir = File(app.cacheDir, "attachments"),
            scope = scope,
            cipher = SecretBox,
            strings = strings,
            http = http,
            googleAuth = google,
            onAccountAdded = { id -> settings.update { s -> if (s.defaultAccountId == null) s.copy(defaultAccountId = id) else s } },
            onAccountRemoved = { id, first -> settings.update { s -> if (s.defaultAccountId == id) s.copy(defaultAccountId = first) else s } },
            onNewMail = { list -> notifier.newMail(list, engine.accounts.value) },
            onAccountsChanged = { list -> background.schedule(list.isNotEmpty()) },
        )
        background.start(engine) { notifier.clear() }
        scope.launch {
            engine.events.collect { if (it is MailEvent.AccountRemoved) notifier.forget(it.accountId) }
        }
        // Mail read or moved since it was announced (on another device, by an agent) leaves the notification,
        // after the sync or change that showed it settled.
        scope.launch(Dispatchers.Default) {
            engine.folders.drop(1).debounce(PRUNE_DELAY_MS).collect {
                val ids = notifier.waitingIds()
                if (ids.isEmpty()) return@collect
                val gone = ids.filter { id -> runCatching { engine.summary(id)?.unread != true }.getOrDefault(false) }.toSet()
                if (gone.isNotEmpty()) notifier.prune(gone, engine.accounts.value)
            }
        }
        return engine
    }
}
