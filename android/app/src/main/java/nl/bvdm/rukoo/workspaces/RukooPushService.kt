package nl.bvdm.rukoo.workspaces

import android.content.Context
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.appContainer
import nl.bvdm.rukoo.core.AppLog
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint as UpEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * Where UnifiedPush's connector hands Rukoo what the distributor says (ChatPush): a new endpoint, a failure, the end
 * of the registration, and push wakes. The distributor raises Rukoo to the foreground for a few seconds when it
 * delivers a message, long enough to start ChatSyncWorker's catch-up as expedited work.
 */
class RukooPushService : PushService() {
    private val push get() = applicationContext.appContainer.push

    override fun onNewEndpoint(endpoint: UpEndpoint, instance: String) {
        val keys = endpoint.pubKeySet
        if (keys == null) {
            // Without keys the server can't encrypt for this phone, and UnifiedPush requires encryption.
            AppLog.w(TAG, "The distributor gave an endpoint without Web Push keys")
            push.registrationFailed("INTERNAL_ERROR")
            return
        }
        push.newEndpoint(PushEndpoint(endpoint.url, keys.pubKey, keys.auth))
    }

    override fun onMessage(message: PushMessage, instance: String) {
        // A wake says that there is something new and in which workspaces, which the catch-up runs first. One that the
        // connector couldn't decrypt with Rukoo's keys didn't come from the server, and wakes nothing.
        if (!message.decrypted) {
            AppLog.w(TAG, "A push message that wasn't encrypted for this phone")
            return
        }
        push.message(PushPlan.wakeWorkspaces(message.content))
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        push.registrationFailed(reason.name)
    }

    override fun onUnregistered(instance: String) {
        push.unregistered()
    }

    override fun onTempUnavailable(instance: String) {
        push.unavailable()
    }

    private companion object {
        const val TAG = "RukooPushService"
    }
}

/** [PushDistributors] through UnifiedPush's connector, with one registration for the whole app. */
class UnifiedPushDistributors(private val context: Context) : PushDistributors {
    override val own: String = context.packageName

    override fun installed(): List<String> = UnifiedPush.getDistributors(context)

    override fun register(distributor: String, vapid: String) {
        if (UnifiedPush.getSavedDistributor(context) != distributor) UnifiedPush.saveDistributor(context, distributor)
        UnifiedPush.register(context, messageForDistributor = context.getString(R.string.push_distributor_message), vapid = vapid)
    }

    override fun unregister() {
        UnifiedPush.unregister(context)
    }
}
