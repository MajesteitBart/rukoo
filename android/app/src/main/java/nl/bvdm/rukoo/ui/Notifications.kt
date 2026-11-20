package nl.bvdm.rukoo.ui

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import nl.bvdm.rukoo.R

/**
 * Rukoo's notification channels. Every track posts on one of these ids; the app creates them at
 * start so the user can tune each in the system settings before the first notification.
 */
object Notifications {
    /** New mail found by sync. */
    const val CHANNEL_MAIL = "mail"

    /** Agent replies, drafts and approvals while the chat isn't on screen. */
    const val CHANNEL_AGENTS = "agents"

    /** The foreground service that serves Rukoo's tools; silent. */
    const val CHANNEL_SERVICE = "service"

    /** Team chat: direct messages and mentions while their room isn't on screen (workspaces/ChatNotifier). */
    const val CHANNEL_CHAT = "chat"

    /** Notification id of the MCP foreground service. */
    const val SERVICE_NOTIFICATION_ID = 1

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_MAIL, context.getString(R.string.notification_channel_mail), NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = context.getString(R.string.notification_channel_mail_description)
                },
                NotificationChannel(CHANNEL_AGENTS, context.getString(R.string.notification_channel_agents), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = context.getString(R.string.notification_channel_agents_description)
                },
                NotificationChannel(CHANNEL_SERVICE, context.getString(R.string.notification_channel_service), NotificationManager.IMPORTANCE_MIN).apply {
                    description = context.getString(R.string.notification_channel_service_description)
                    setShowBadge(false)
                },
                NotificationChannel(CHANNEL_CHAT, context.getString(R.string.notification_channel_chat), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = context.getString(R.string.notification_channel_chat_description)
                },
            ),
        )
    }
}
