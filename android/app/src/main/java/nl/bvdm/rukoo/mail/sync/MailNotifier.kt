package nl.bvdm.rukoo.mail.sync

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import nl.bvdm.rukoo.MainActivity
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.MailStrings
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.ui.Notifications

/**
 * What a new-mail notification opens. MainActivity receives [ACTION_OPEN_MAIL] with the message to
 * open, or only the account when several messages arrived (its inbox).
 */
object MailIntents {
    const val ACTION_OPEN_MAIL = "nl.bvdm.rukoo.action.OPEN_MAIL"
    const val EXTRA_MESSAGE_ID = "nl.bvdm.rukoo.extra.MESSAGE_ID"
    const val EXTRA_ACCOUNT_ID = "nl.bvdm.rukoo.extra.ACCOUNT_ID"
}

/**
 * New-mail notifications on the `mail` channel: one per account, summarizing what arrived since the
 * app was last on screen (desktop main.js:192-215 shows up to three, then a count). Nothing is shown
 * while Rukoo is on screen or when the user turned mail notifications off.
 */
class MailNotifier(
    private val context: Context,
    private val strings: MailStrings,
    private val enabled: () -> Boolean,
    private val foreground: () -> Boolean,
) {
    private val waiting = LinkedHashMap<String, MutableList<MessageSummary>>()

    private fun allowed(): Boolean {
        if (!enabled() || foreground()) return false
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    private fun notificationId(accountId: String) = ("mail:$accountId").hashCode()

    @Synchronized
    fun newMail(messages: List<MessageSummary>, accounts: List<Account>) {
        if (!allowed()) return
        val manager = NotificationManagerCompat.from(context)
        for ((accountId, fresh) in messages.groupBy { it.accountId }) {
            val account = accounts.firstOrNull { it.id == accountId } ?: continue
            val list = waiting.getOrPut(accountId) { mutableListOf() }
            for (m in fresh) if (list.none { it.id == m.id }) list += m
            list.sortByDescending { it.date }
            try {
                manager.notify(TAG, notificationId(accountId), build(account, list))
            } catch (e: SecurityException) {
                // The permission was withdrawn between the check and the post.
            }
        }
    }

    /** The user is looking at Rukoo: the waiting notifications have done their job. */
    @Synchronized
    fun clear() {
        val manager = NotificationManagerCompat.from(context)
        for (accountId in waiting.keys) manager.cancel(TAG, notificationId(accountId))
        waiting.clear()
    }

    @Synchronized
    fun forget(accountId: String) {
        waiting.remove(accountId)
        NotificationManagerCompat.from(context).cancel(TAG, notificationId(accountId))
    }

    private fun sender(m: MessageSummary) =
        m.from.name.ifBlank { m.from.address }.ifBlank { strings.get(R.string.engine_notifications_unknown_sender) }

    private fun subject(m: MessageSummary) = m.subject.ifBlank { strings.get(R.string.engine_notifications_no_subject) }

    private fun build(account: Account, list: List<MessageSummary>): android.app.Notification {
        val newest = list.first()
        val intent = Intent(context, MainActivity::class.java).apply {
            action = MailIntents.ACTION_OPEN_MAIL
            putExtra(MailIntents.EXTRA_ACCOUNT_ID, account.id)
            if (list.size == 1) putExtra(MailIntents.EXTRA_MESSAGE_ID, newest.id)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            context,
            notificationId(account.id),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = NotificationCompat.Builder(context, Notifications.CHANNEL_MAIL)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setWhen(newest.date)
            .setShowWhen(true)
            .setNumber(list.size)
            .setOnlyAlertOnce(false)
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

    private companion object {
        const val TAG = "mail"
    }
}
