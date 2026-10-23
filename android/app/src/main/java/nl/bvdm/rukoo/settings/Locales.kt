package nl.bvdm.rukoo.settings

import android.app.LocaleManager
import android.content.Context
import android.os.Build
import android.os.LocaleList

/**
 * Per-app language through Android's LocaleManager (API 33+), with the locales of res/xml/locales_config.xml.
 * On Android 12 the app follows the system language; the app has no AppCompat to do it there.
 */
object Locales {
    fun apply(context: Context, language: Language) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val manager = context.getSystemService(LocaleManager::class.java) ?: return
        val wanted = language.tag?.let { LocaleList.forLanguageTags(it) } ?: LocaleList.getEmptyLocaleList()
        // Setting the same list again would still restart the activity.
        if (manager.applicationLocales != wanted) manager.applicationLocales = wanted
    }

    /** The language set for the app in Rukoo or in the system's per-app language settings. */
    fun current(context: Context): Language {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return Language.SYSTEM
        val locales = context.getSystemService(LocaleManager::class.java)?.applicationLocales ?: return Language.SYSTEM
        if (locales.isEmpty) return Language.SYSTEM
        return when (locales[0].language) {
            "nl" -> Language.NL
            "en" -> Language.EN
            else -> Language.SYSTEM
        }
    }
}
