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
import nl.bvdm.rukoo.categories.Categories
import nl.bvdm.rukoo.core.SecretBox
import nl.bvdm.rukoo.mail.google.GoogleAuth
import nl.bvdm.rukoo.mail.google.GoogleClientStore
import nl.bvdm.rukoo.mail.mime.MimeComposer
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MailEvent
import nl.bvdm.rukoo.mail.sync.MailBackground
import nl.bvdm.rukoo.mail.sync.MailNotices
import nl.bvdm.rukoo.mail.sync.MailNotifier
import nl.bvdm.rukoo.mail.sync.WaitingMail
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.settings.SettingsStore
import okhttp3.OkHttpClient

/**
 * Builds the real mail engine with Google sign-in, background sync and new-mail notifications. [categories] are made
 * after the engine, which they read; the notifications ask for them once mail arrives.
 */
@OptIn(FlowPreview::class)
object MailModule {
    private const val PRUNE_DELAY_MS = 1_000L

    /** The engine, and its new-mail notifications that may wait for Jev, which a background sync waits for. */
    class Mail(val engine: RukooMailEngine, val notices: MailNotices)

    fun create(
        context: Context,
        scope: CoroutineScope,
        settings: SettingsStore,
        settingsSnapshot: StateFlow<AppSettings>,
        http: OkHttpClient,
        categories: () -> Categories? = { null },
    ): Mail {
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
        lateinit var engine: RukooMailEngine
        val notifier = MailNotifier(
            app,
            strings,
            enabled = { settingsSnapshot.value.notifyMail },
            foreground = { background.foreground },
            waiting = WaitingMail(File(dir, WaitingMail.FILE_NAME)),
            // The launcher badge leaves out the categories Inbox doesn't show, as desktop's taskbar badge does.
            badge = { list -> categories()?.lookup(engine.accounts.value, list)?.let { lookup -> list.count { !lookup.hidden(it) } } ?: list.size },
        )
        // Muted categories send nothing, and mail Jev is about to sort waits for its category, at most 20 seconds.
        val notices = MailNotices(
            categories = categories,
            show = { list, quiet -> notifier.newMail(list, engine.accounts.value, quiet) },
            scope = CoroutineScope(scope.coroutineContext + Dispatchers.Default),
            // What waited may have been read or moved meanwhile, here or on another device: only unread inbox mail goes.
            current = { list -> list.filter { m -> runCatching { engine.summary(m.id) }.getOrNull()?.let { it.unread && it.role == FolderRole.INBOX } == true } },
        )
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
            onNewMail = notices::add,
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
        // Jev's answers and muting reach waiting notifications. A category leaving Inbox, or mail moving into one that
        // did, changes what the badge counts.
        scope.launch(Dispatchers.Default) {
            val cats = runCatching { categories() }.getOrNull() ?: return@launch
            notices.attach(cats)
            cats.changes.debounce(PRUNE_DELAY_MS).collect { notifier.recount(engine.accounts.value) }
        }
        return Mail(engine, notices)
    }
}
