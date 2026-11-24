package nl.bvdm.rukoo.ui.settings

import nl.bvdm.rukoo.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Battery row's words in its two places: Settings > Phone tools and Settings > Notifications. */
class BatteryTextsTest {
    @Test
    fun `the value names Android's two choices`() {
        assertEquals(R.string.settings_phone_tools_battery_unrestricted, BatteryTexts.value(unrestricted = true))
        assertEquals(R.string.settings_phone_tools_battery_optimized, BatteryTexts.value(unrestricted = false))
    }

    @Test
    fun `under Phone tools it speaks of agents, naming Samsung on a Samsung phone`() {
        assertEquals(R.string.settings_phone_tools_battery_help, BatteryTexts.help(BatteryPlace.PhoneTools, samsung = true, phoneTools = false))
        assertEquals(R.string.settings_phone_tools_battery_help_other, BatteryTexts.help(BatteryPlace.PhoneTools, samsung = false, phoneTools = true))
    }

    @Test
    fun `under team chat it gives the 15 minutes, or says Phone tools keeps chat connected`() {
        for (samsung in listOf(true, false)) {
            assertEquals(R.string.settings_notifications_chat_battery_help, BatteryTexts.help(BatteryPlace.TeamChat, samsung, phoneTools = false))
            assertEquals(R.string.settings_notifications_chat_battery_help_phone_tools, BatteryTexts.help(BatteryPlace.TeamChat, samsung, phoneTools = true))
        }
    }

    @Test
    fun `Notifications shows the row while team chat notifications show and are on`() {
        assertTrue(BatteryTexts.showUnderChat(chatAvailable = true, notifyChat = true))
        assertFalse(BatteryTexts.showUnderChat(chatAvailable = true, notifyChat = false))
        assertFalse(BatteryTexts.showUnderChat(chatAvailable = false, notifyChat = true))
    }
}
