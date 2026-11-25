package nl.bvdm.rukoo.ui.settings

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.net.toUri
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.SettingsRow
import nl.bvdm.rukoo.ui.components.SettingsTrailingValue
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.workspaces.ChatDelivery
import nl.bvdm.rukoo.workspaces.ChatPushControl
import nl.bvdm.rukoo.workspaces.PushState

/** The Delivery row's words and what tapping it does, without Compose, so they are unit-tested. */
object DeliveryTexts {
    /** Where UnifiedPush lists the apps that receive push messages, for someone who has none. */
    const val DISTRIBUTORS_URL = "https://unifiedpush.org/users/distributors/"

    /** What a tap does: nothing, pick among the distributors, open the distributor, or show where to get one. */
    enum class Tap { NONE, CHOOSE, OPEN_DISTRIBUTOR, LEARN }

    /** The row shows while team chat notifications can come at all: signed in, team chat on and notifications on. */
    fun shows(delivery: ChatDelivery): Boolean = delivery != ChatDelivery.Off

    /** Instant while wakes come through a distributor, else every 15 minutes. */
    @StringRes
    fun value(delivery: ChatDelivery): Int =
        if (delivery is ChatDelivery.Instant) R.string.settings_notifications_delivery_instant else R.string.settings_notifications_delivery_periodic

    /** The line under the row; the ones that name the distributor take its name as their one argument. */
    @StringRes
    fun help(delivery: ChatDelivery): Int = when (delivery) {
        ChatDelivery.Off, ChatDelivery.NoDistributor -> R.string.settings_notifications_delivery_help_none
        ChatDelivery.ServerWithout -> R.string.settings_notifications_delivery_help_server
        is ChatDelivery.Connecting -> R.string.settings_notifications_delivery_help_connecting
        is ChatDelivery.Instant -> R.string.settings_notifications_delivery_help_instant
        is ChatDelivery.Failed -> when (delivery.reason) {
            "ACTION_REQUIRED" -> R.string.settings_notifications_delivery_help_action
            "TEMP_UNAVAILABLE" -> R.string.settings_notifications_delivery_help_unavailable
            "REFUSED" -> R.string.settings_notifications_delivery_help_refused
            "NOT_ALLOWED" -> R.string.settings_notifications_delivery_help_not_allowed
            else -> R.string.settings_notifications_delivery_help_failed
        }
    }

    /** The distributor the line names, or null for the lines that name none. */
    fun distributor(delivery: ChatDelivery): String? = when (delivery) {
        is ChatDelivery.Connecting -> delivery.distributor
        is ChatDelivery.Instant -> delivery.distributor
        is ChatDelivery.Failed -> delivery.distributor
        else -> null
    }

    /**
     * With several distributors a tap picks one; a distributor that needs the person opens; without one, the tap shows
     * where to get one. [count] is how many distributors are installed; [own] is Rukoo's package, whose embedded
     * distributor has no app to open.
     */
    fun tap(delivery: ChatDelivery, count: Int, own: String? = null): Tap = when {
        delivery == ChatDelivery.NoDistributor -> Tap.LEARN
        distributor(delivery) != null && count > 1 -> Tap.CHOOSE
        delivery is ChatDelivery.Failed && delivery.reason == "ACTION_REQUIRED" && delivery.distributor != own -> Tap.OPEN_DISTRIBUTOR
        else -> Tap.NONE
    }
}

/**
 * A distributor's name as the launcher shows it; the package name when Android doesn't know it. Rukoo's own package is
 * the embedded distributor, which receives through Google Play services.
 */
@Suppress("DEPRECATION")
fun distributorLabel(context: Context, pkg: String): String = if (pkg == context.packageName) {
    context.getString(R.string.push_embedded_distributor)
} else try {
    val pm = context.packageManager
    pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
} catch (e: PackageManager.NameNotFoundException) {
    pkg
}

/**
 * Delivery, under Team chat notifications: Instant while push wakes come through a UnifiedPush distributor, else every
 * 15 minutes, with a line that says why and what would make it instant.
 */
@Composable
fun DeliveryRow(push: ChatPushControl, state: PushState) {
    val context = LocalContext.current
    var choosing by remember { mutableStateOf(false) }
    val delivery = state.delivery
    val name = DeliveryTexts.distributor(delivery)?.let { distributorLabel(context, it) }
    val tap = DeliveryTexts.tap(delivery, state.distributors.size, own = context.packageName)
    val value = stringResource(DeliveryTexts.value(delivery))
    // A row that does something shows its value as the settings' accent line; one that doesn't, as plain text at its
    // end, so it doesn't look like a link.
    SettingsRow(
        title = stringResource(R.string.settings_notifications_delivery),
        description = if (name != null) stringResource(DeliveryTexts.help(delivery), name) else stringResource(DeliveryTexts.help(delivery)),
        value = value.takeIf { tap != DeliveryTexts.Tap.NONE },
        trailing = if (tap == DeliveryTexts.Tap.NONE) ({ SettingsTrailingValue(value) }) else null,
        leading = { RowIcon(RukooIcons.Bell, if (delivery is ChatDelivery.Instant) Rk.colors.accent else Rk.colors.text2) },
        onClick = when (tap) {
            DeliveryTexts.Tap.NONE -> null
            DeliveryTexts.Tap.CHOOSE -> ({ choosing = true })
            DeliveryTexts.Tap.OPEN_DISTRIBUTOR -> ({ DeliveryTexts.distributor(delivery)?.let { openApp(context, it) } })
            DeliveryTexts.Tap.LEARN -> ({ openPage(context, DeliveryTexts.DISTRIBUTORS_URL) })
        },
    )
    if (choosing) {
        ChoiceSheet(
            title = stringResource(R.string.settings_notifications_delivery_choose),
            choices = state.distributors.map { Choice(it, distributorLabel(context, it)) },
            selected = DeliveryTexts.distributor(delivery),
            onSelect = { push.choose(it) },
            onDismiss = { choosing = false },
        )
    }
}

private fun openApp(context: Context, pkg: String) {
    val intent = context.packageManager.getLaunchIntentForPackage(pkg) ?: return
    runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

private fun openPage(context: Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}
