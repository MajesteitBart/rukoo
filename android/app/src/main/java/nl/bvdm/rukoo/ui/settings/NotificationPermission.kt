package nl.bvdm.rukoo.ui.settings

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Android 13's notification permission. Rukoo asks at a moment the user can tell why: right after the first
 * account came in (new-mail notifications start then), or when they turn a notification on in Settings.
 */
object NotificationPermission {
    private const val REQUEST = 4713

    fun granted(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Whether to ask now: on Android 13 and later, while it isn't granted and the user wants a notification. */
    fun shouldAsk(sdk: Int, granted: Boolean, wanted: Boolean): Boolean = sdk >= Build.VERSION_CODES.TIRAMISU && !granted && wanted

    /**
     * Asks without a registered launcher, because the screen that asks may be gone before the answer comes (setup
     * closes once the first account exists). Nothing waits for the answer: Settings reads the permission again when
     * it shows. Android itself stops asking after the user declined twice.
     */
    fun ask(context: Context, wanted: Boolean) {
        val activity = context.activity() ?: return
        if (activity.isFinishing || activity.isChangingConfigurations) return
        if (!shouldAsk(Build.VERSION.SDK_INT, granted(activity), wanted)) return
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST)
    }

    private tailrec fun Context.activity(): Activity? = when (this) {
        is Activity -> this
        is ContextWrapper -> baseContext.activity()
        else -> null
    }
}
