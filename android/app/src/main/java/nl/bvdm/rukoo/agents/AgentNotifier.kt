package nl.bvdm.rukoo.agents

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.StateFlow
import nl.bvdm.rukoo.MainActivity
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.DraftMode
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.TurnStatus
import nl.bvdm.rukoo.core.Unsafe
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.ui.Notifications
import nl.bvdm.rukoo.ui.ScreenState

/**
 * When to tell the user with a notification, with agent notifications on. An answer is posted whenever
 * its chat isn't on screen (the hub only reports those), also while the user reads mail in Rukoo. An
 * approval or a draft only while Rukoo is in the background: inside the app the chat's toast and the
 * composer show them (spec 6 §5.4, design.md "write_draft while the app is in the background").
 */
object AlertRules {
    enum class Kind { REPLY, APPROVAL, DRAFT }

    fun shouldPost(settings: AppSettings, foreground: Boolean, kind: Kind): Boolean =
        settings.notifyAgents && (kind == Kind.REPLY || !foreground)

    /** The notification's text for an answer: the last thing the agent said, on one line, at most 400 characters. */
    fun replyText(conversation: Conversation): String? = conversation.items
        .lastOrNull { it is Item.Assistant && !it.interim && it.text.isNotBlank() }
        ?.let { jsOneLine(Unsafe.untag((it as Item.Assistant).text)).take(400) }

    /** One notification per chat and kind, replaced by the next one rather than stacked. */
    fun notificationId(conversationId: String, kind: String): Int = "$kind:$conversationId".hashCode()
}

/**
 * Posts the hub's alerts on the `agents` channel. Tapping one opens MainActivity with
 * [AgentIntents.EXTRA_CONVERSATION_ID] and, when the chat has an email, [AgentIntents.EXTRA_MESSAGE_ID].
 */
class AgentNotifier(
    context: Context,
    private val settings: StateFlow<AppSettings>,
    private val screen: ScreenState,
    private val names: (String) -> String,
) : AgentAlerts {
    private val context = context.applicationContext

    private fun allowed(kind: AlertRules.Kind): Boolean {
        if (!AlertRules.shouldPost(settings.value, screen.current.foreground, kind)) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    override fun replyReady(conversation: Conversation, status: TurnStatus) {
        if (!allowed(AlertRules.Kind.REPLY)) return
        val text = if (status == TurnStatus.ERROR) {
            context.getString(R.string.agents_notify_failed)
        } else {
            AlertRules.replyText(conversation) ?: context.getString(R.string.agents_notify_reply)
        }
        post(conversation, KIND_REPLY, names(conversation.agent), text, openComposer = false)
    }

    override fun approvalWaiting(conversation: Conversation, item: Item.Approval) {
        if (!allowed(AlertRules.Kind.APPROVAL)) return
        post(conversation, KIND_APPROVAL, context.getString(R.string.agents_notify_approval), jsOneLine(Unsafe.untag(item.title)), openComposer = false)
    }

    override fun draftWritten(conversation: Conversation, item: Item.Draft) {
        if (!allowed(AlertRules.Kind.DRAFT)) return
        val kind = context.getString(
            when (item.mode) {
                DraftMode.REPLY -> R.string.agents_draft_reply
                DraftMode.REPLY_ALL -> R.string.agents_draft_reply_all
                DraftMode.FORWARD -> R.string.agents_draft_forward
                DraftMode.NEW -> R.string.agents_draft_new
            },
        )
        val subject = jsOneLine(Unsafe.untag(item.subject))
        post(conversation, KIND_DRAFT, names(conversation.agent), if (subject.isEmpty()) kind else "$kind: $subject", openComposer = true)
    }

    override fun seen(conversationId: String) {
        val manager = NotificationManagerCompat.from(context)
        for (kind in listOf(KIND_REPLY, KIND_APPROVAL, KIND_DRAFT)) manager.cancel(AlertRules.notificationId(conversationId, kind))
    }

    private fun post(conversation: Conversation, kind: String, title: String, text: String, openComposer: Boolean) {
        val id = AlertRules.notificationId(conversation.id, kind)
        val open = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(AgentIntents.EXTRA_CONVERSATION_ID, conversation.id)
        conversation.message?.id?.let { open.putExtra(AgentIntents.EXTRA_MESSAGE_ID, it) }
        if (openComposer) open.putExtra(AgentIntents.EXTRA_OPEN_COMPOSER, true)
        val pending = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val builder = NotificationCompat.Builder(context, Notifications.CHANNEL_AGENTS)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(if (kind == KIND_REPLY) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_REMINDER)
        conversation.title.takeIf { it.isNotEmpty() }?.let { builder.setSubText(it) }
        if (kind != KIND_REPLY) builder.addAction(0, context.getString(R.string.agents_notify_show), pending)
        try {
            NotificationManagerCompat.from(context).notify(id, builder.build())
        } catch (_: SecurityException) {
            // The permission went away between the check and the post.
        }
    }

    private companion object {
        const val KIND_REPLY = "reply"
        const val KIND_APPROVAL = "approval"
        const val KIND_DRAFT = "draft"
    }
}
