package nl.bvdm.rukoo.settings

import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsStoreTest {
    @Test
    fun `swipe choices survive a save and a load`() {
        val prefs = mutablePreferencesOf()
        SettingsStore.write(prefs, AppSettings(swipeRight = SwipeAction.ARCHIVE, swipeLeft = SwipeAction.NONE))
        val back = SettingsStore.fromPreferences(prefs)
        assertEquals(SwipeAction.ARCHIVE, back.swipeRight)
        assertEquals(SwipeAction.NONE, back.swipeLeft)
    }

    @Test
    fun `a swipe choice this version doesn't know falls back to the default`() {
        val prefs = mutablePreferencesOf(stringPreferencesKey("swipe_right") to "fly", stringPreferencesKey("swipe_left") to "")
        val back = SettingsStore.fromPreferences(prefs)
        assertEquals(SwipeAction.READ, back.swipeRight)
        assertEquals(SwipeAction.DELETE, back.swipeLeft)
    }
}
