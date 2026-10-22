package nl.bvdm.rukoo.desktop

import android.content.Context
import android.os.Build
import android.provider.Settings
import nl.bvdm.rukoo.BuildConfig

/** How this phone introduces itself when it pairs: the computer lists it under this name ("Galaxy Z Fold7"). */
object DesktopDevice {
    fun info(context: Context): DeviceInfo {
        // The name the user gave the phone, as Bluetooth and Quick Share show it; the model when there is none.
        val name = runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }
            .getOrNull()?.trim()?.takeIf { it.isNotEmpty() }
            ?: listOf(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL).filter { it.isNotBlank() }.joinToString(" ")
        return DeviceInfo(name = name.take(60), platform = "android", model = Build.MODEL.orEmpty().take(60), appVersion = BuildConfig.VERSION_NAME)
    }
}
