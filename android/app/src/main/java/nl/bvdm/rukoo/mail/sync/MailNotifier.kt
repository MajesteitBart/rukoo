package nl.bvdm.rukoo.mail.sync

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.io.File
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import nl.bvdm.rukoo.MainActivity
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.JsonFiles
import nl.bvdm.rukoo.mail.MailStrings
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.ui.Notifications

/**
 * The messages each account's new-mail notification lists, newest first. They are kept in [file], because
 * the notification usually comes from a background sync in a process Android ends soon after: the next
 * sync then adds to it instead of starting over, and the app clears it whichever process posted it.
 */
class WaitingMail(private val file: File? = null) {
    private val byAccount = LinkedHashMap<String, List<MessageSummary>>()

    init {
        val f = file
        if (f != null) byAccount.putAll(runCatching { JsonFiles.read(f, SERIALIZER, emptyMap()) }.getOrDefault(emptyMap()))
    }

    fun of(accountId: String): List<MessageSummary> = byAccount[accountId].orEmpty()

    val accountIds: Set<String> get() = byAccount.keys.toSet()

    val ids: List<String> get() = byAccount.values.flatten().map { it.id }

    /** Adds [fresh]; returns the accounts whose list grew. */
    fun add(fresh: List<MessageSummary>): Set<String> {
        val grown = mutableSetOf<String>()
        for ((accountId, list) in fresh.groupBy { it.accountId }) {
            val before = byAccount[accountId].orEmpty()
            val added = list.filter { m -> before.none { it.id == m.id } }
            if (added.isEmpty()) continue
            byAccount[accountId] = (before + added).distinctBy { it.id }.sortedByDescending { it.date }.take(MAX)
            grown += accountId
        }
        if (grown.isNotEmpty()) save()
        return grown
    }

    /** Drops the messages in [gone] (read, or no longer there); returns the accounts whose list changed. */
    fun drop(gone: Set<String>): Set<String> {
        val changed = mutableSetOf<String>()
        for ((accountId, list) in byAccount.toList()) {
            val kept = list.filter { it.id !in gone }
            if (kept.size == list.size) continue
            changed += accountId
            if (kept.isEmpty()) byAccount.remove(accountId) else byAccount[accountId] = kept
        }
        if (changed.isNotEmpty()) save()
        return changed
    }

    fun forget(accountId: String) {
        if (byAccount.remove(accountId) != null) save()
    }

    fun clear() {
        if (byAccount.isEmpty() && file?.exists() != true) return
        byAccount.clear()
        save()
    }

    private fun save() {
        val f = file ?: return
        runCatching { if (byAccount.isEmpty()) f.delete() else JsonFiles.write(f, SERIALIZER, byAccount.toMap()) }
            .onFailure { AppLog.w(TAG, "could not keep the new-mail list", it) }
    }

    companion object {
        const val FILE_NAME = "notified.json"

        /** The count stays right well past what the expanded notification lists (six). */
        const val MAX = 50
        private const val TAG = "WaitingMail"
        private val SERIALIZER = MapSerializer(String.serializer(), ListSerializer(MessageSummary.serializer()))
    }
}

/**
 * New-mail notifications on the `mail` channel: one per account, summarizing what arrived since the
 * app was last on screen (desktop main.js:192-215 shows up to three, then a count). Nothing is shown
 * while Rukoo is on screen or when the user turned mail notifications off. A tap opens the message
 * (one new) or the account's inbox (several), through MainActivity's extras. The number the launcher badge may show
 * is [badge] of what a notification lists: the mail Inbox shows, without the categories it leaves out.
 */
class MailNotifier(
    private val context: Context,
    private val strings: MailStrings,
    private val enabled: () -> Boolean,
    private val foreground: () -> Boolean,
    private val waiting: WaitingMail = WaitingMail(),
    private val badge: (List<MessageSummary>) -> Int = { it.size },
) {
    private fun allowed(): Boolean {
        if (!enabled() || foreground()) return false
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    // The ids of the mail notifications in the shade now, whichever process posted them.
    private fun shown(): Set<Int> = runCatching {
        context.getSystemService(NotificationManager::class.java)?.activeNotifications.orEmpty().filter { it.tag == TAG }.map { it.id }.toSet()
    }.getOrDefault(emptySet())

    @Synchronized
    fun newMail(messages: List<MessageSummary>, accounts: List<Account>) {
        if (!allowed()) return
        // A notification the user swiped away has done its job: the next one starts over.
        val inShade = shown()
        for (accountId in waiting.accountIds) if (notificationId(accountId) !in inShade) waiting.forget(accountId)
        for (accountId in waiting.add(messages)) {
            val account = accounts.firstOrNull { it.id == accountId } ?: continue
            post(account, waiting.of(accountId), quietly = false)
        }
    }

    /**
     * Messages read or gone since they were announced (read on another device, moved by an agent) leave
     * their notification; one with nothing left goes. [gone] are ids from [waitingIds] that are no longer
     * unread; mail announced while they were looked up stays.
     */
    @Synchronized
    fun prune(gone: Set<String>, accounts: List<Account>) {
        val changed = waiting.drop(gone)
        if (changed.isEmpty()) return
        val manager = NotificationManagerCompat.from(context)
        val inShade = shown()
        for (accountId in changed) {
            val list = waiting.of(accountId)
            val account = accounts.firstOrNull { it.id == accountId }
            if (list.isEmpty() || account == null || notificationId(accountId) !in inShade) {
                manager.cancel(TAG, notificationId(accountId))
                if (list.isNotEmpty()) waiting.forget(accountId)
            } else {
                post(account, list, quietly = true)
            }
        }
    }

    /**
     * The badge's number again, for notifications in the shade whose mail changed category: Show in Inbox turned off
     * for one, or Jev put an email in a category Inbox doesn't show. Nothing makes a sound.
     */
    @Synchronized
    fun recount(accounts: List<Account>) {
        val numbers = runCatching {
            context.getSystemService(NotificationManager::class.java)?.activeNotifications.orEmpty().filter { it.tag == TAG }.associate { it.id to it.notification.number }
        }.getOrDefault(emptyMap())
        for (accountId in waiting.accountIds) {
            val number = numbers[notificationId(accountId)] ?: continue
            val list = waiting.of(accountId)
            val account = accounts.firstOrNull { it.id == accountId } ?: continue
            if (list.isNotEmpty() && badge(list) != number) post(account, list, quietly = true)
        }
    }

    /** What the notifications list, for [prune]. */
    @Synchronized
    fun waitingIds(): List<String> = waiting.ids

    /** The user is looking at Rukoo: every mail notification has done its job, also one an earlier process posted. */
    @Synchronized
    fun clear() {
        val manager = NotificationManagerCompat.from(context)
        for (id in shown()) manager.cancel(TAG, id)
        for (accountId in waiting.accountIds) manager.cancel(TAG, notificationId(accountId))
        waiting.clear()
    }

    @Synchronized
    fun forget(accountId: String) {
        waiting.forget(accountId)
        NotificationManagerCompat.from(context).cancel(TAG, notificationId(accountId))
    }

    private fun post(account: Account, list: List<MessageSummary>, quietly: Boolean) {
        try {
            NotificationManagerCompat.from(context).notify(TAG, notificationId(account.id), build(account, list, quietly))
        } catch (e: SecurityException) {
            // The permission was withdrawn between the check and the post.
        }
    }

    private fun sender(m: MessageSummary) =
        m.from.name.ifBlank { m.from.address }.ifBlank { strings.get(R.string.engine_notifications_unknown_sender) }

    private fun subject(m: MessageSummary) = m.subject.ifBlank { strings.get(R.string.engine_notifications_no_subject) }

    private fun build(account: Account, list: List<MessageSummary>, quietly: Boolean): android.app.Notification {
        val newest = list.first()
        val intent = Intent(context, MainActivity::class.java).apply {
            for ((key, value) in extras(account.id, list)) putExtra(key, value)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            context,
            notificationId(account.id),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = NotificationCompat.Builder(context, Notifications.CHANNEL_MAIL)
            .setSmallIcon(R.drawable.ic_stat_rukoo)
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setWhen(newest.date)
            .setShowWhen(true)
            // The launcher badge counts what Inbox shows; the notification still lists all of it.
            .setNumber(badge(list))
            // Taking a read message off makes no sound; new mail does.
            .setOnlyAlertOnce(quietly)
            .setSilent(quietly)
        if (list.size == 1) {
            // Desktop: title the sender, body subject and preview, cut to 180 characters.
            val body = listOf(subject(newest), newest.preview).filter { it.isNotBlank() }.joinToString("\n").take(180)
            builder.setContentTitle(sender(newest))
                .setContentText(subject(newest))
                .setSubText(account.label.ifBlank { account.email })
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        } else {
            val title = strings.plural(R.plurals.engine_notifications_new_count, list.size, list.size)
            val style = NotificationCompat.InboxStyle().setSummaryText(account.label.ifBlank { account.email })
            list.take(6).forEach { style.addLine("${sender(it)}  ${subject(it)}") }
            builder.setContentTitle(title)
                .setContentText(list.take(3).joinToString(", ") { sender(it) })
                .setSubText(account.label.ifBlank { account.email })
                .setStyle(style)
        }
        return builder.build()
    }

    companion object {
        private const val TAG = "mail"

        fun notificationId(accountId: String) = ("mail:$accountId").hashCode()

        /**
         * What a tap opens, as MainActivity's extras: the message when one arrived, else the account's inbox
         * (MainActivity.handleIntent and NotificationRoute read them).
         */
        fun extras(accountId: String, list: List<MessageSummary>): Map<String, String> = buildMap {
            put(MainActivity.EXTRA_ACCOUNT_ID, accountId)
            if (list.size == 1) put(MainActivity.EXTRA_MESSAGE_ID, list.first().id)
        }
    }
}
