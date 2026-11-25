package nl.bvdm.rukoo.ui.settings

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.SettingsRow
import nl.bvdm.rukoo.ui.icons.PanelIcons

/** Where the Battery row shows. Each place says why the setting matters there. */
enum class BatteryPlace { PhoneTools, TeamChat }

/** The Battery row's words, without Compose, so they are unit-tested. */
object BatteryTexts {
    /** Unrestricted or Optimized, as Android's battery page names them. */
    @StringRes
    fun value(unrestricted: Boolean): Int =
        if (unrestricted) R.string.settings_phone_tools_battery_unrestricted else R.string.settings_phone_tools_battery_optimized

    /**
     * The line under the row. Under Phone tools it says agents can't reach a stopped app, naming Samsung on a Samsung
     * phone. Under Team chat notifications it says how often Rukoo checks in the background, or, while Phone tools'
     * foreground service runs ([phoneTools]), that team chat can notify sooner though Android can hold it back; with
     * the switch off ([notifyChat] false), what turning it on gives.
     */
    @StringRes
    fun help(place: BatteryPlace, samsung: Boolean, phoneTools: Boolean, notifyChat: Boolean = true): Int = when (place) {
        BatteryPlace.PhoneTools -> if (samsung) R.string.settings_phone_tools_battery_help else R.string.settings_phone_tools_battery_help_other
        BatteryPlace.TeamChat -> when {
            !notifyChat -> R.string.settings_notifications_chat_battery_help_off
            phoneTools -> R.string.settings_notifications_chat_battery_help_phone_tools
            else -> R.string.settings_notifications_chat_battery_help
        }
    }

    /**
     * Settings > Notifications shows the row with the Team chat notifications switch, on or off, while someone is
     * signed in to the Rukoo account: signed out, nothing checks for messages, so its line would promise what can't
     * happen.
     */
    fun showUnderChat(chatAvailable: Boolean, signedIn: Boolean): Boolean = chatAvailable && signedIn
}

/**
 * Battery use: Unrestricted or Optimized, opening the app's battery page in Android's settings. It reads the state
 * again each time the page comes back, so the value follows what the person chose there.
 */
@Composable
fun BatteryRow(place: BatteryPlace, phoneTools: Boolean = false, notifyChat: Boolean = true) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var unrestricted by remember { mutableStateOf(isUnrestricted(context)) }
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { unrestricted = isUnrestricted(context) }
    }
    SettingsRow(
        title = stringResource(R.string.settings_phone_tools_battery_row),
        description = stringResource(BatteryTexts.help(place, isSamsung(), phoneTools, notifyChat)),
        value = stringResource(BatteryTexts.value(unrestricted)),
        leading = { RowIcon(PanelIcons.Bolt) },
        onClick = { openBatterySettings(context) },
    )
}

private fun isUnrestricted(context: Context): Boolean =
    context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true

private fun isSamsung(): Boolean = Build.MANUFACTURER.equals("samsung", ignoreCase = true)

/**
 * The app's battery page, where Samsung offers Unrestricted. Android has no public intent for it, so this
 * tries the page Settings itself opens, then the app's info page that links to it.
 */
@SuppressLint("BatteryLife")
private fun openBatterySettings(context: Context) {
    val uri = "package:${context.packageName}".toUri()
    val tries = listOf(
        Intent("android.settings.VIEW_ADVANCED_POWER_USAGE_DETAIL", uri),
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri),
    )
    for (intent in tries) {
        if (runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess) return
    }
}
