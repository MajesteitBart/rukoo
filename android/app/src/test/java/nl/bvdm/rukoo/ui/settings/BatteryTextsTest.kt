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
        assertEquals(
            "the chat switch doesn't change the Phone tools line",
            R.string.settings_phone_tools_battery_help_other,
            BatteryTexts.help(BatteryPlace.PhoneTools, samsung = false, phoneTools = false, notifyChat = false),
        )
    }

    @Test
    fun `under team chat it gives the 15 minutes, or says Phone tools can notify sooner`() {
        for (samsung in listOf(true, false)) {
            assertEquals(R.string.settings_notifications_chat_battery_help, BatteryTexts.help(BatteryPlace.TeamChat, samsung, phoneTools = false))
            assertEquals(R.string.settings_notifications_chat_battery_help_phone_tools, BatteryTexts.help(BatteryPlace.TeamChat, samsung, phoneTools = true))
        }
    }

    @Test
    fun `with team chat notifications off, its line says what turning them on gives`() {
        for (phoneTools in listOf(true, false)) {
            assertEquals(
                R.string.settings_notifications_chat_battery_help_off,
                BatteryTexts.help(BatteryPlace.TeamChat, samsung = true, phoneTools = phoneTools, notifyChat = false),
            )
        }
    }

    @Test
    fun `with push wakes through a distributor, it says both apps want Unrestricted`() {
        for (phoneTools in listOf(true, false)) {
            assertEquals(
                R.string.settings_notifications_chat_battery_help_push,
                BatteryTexts.help(BatteryPlace.TeamChat, samsung = true, phoneTools = phoneTools, push = true),
            )
        }
        // Off is off, whatever came before.
        assertEquals(
            R.string.settings_notifications_chat_battery_help_off,
            BatteryTexts.help(BatteryPlace.TeamChat, samsung = true, phoneTools = false, notifyChat = false, push = true),
        )
        assertEquals(R.string.settings_phone_tools_battery_help, BatteryTexts.help(BatteryPlace.PhoneTools, samsung = true, phoneTools = false, push = true))
    }

    @Test
    fun `Notifications shows the row with the team chat notifications switch while someone is signed in`() {
        assertTrue(BatteryTexts.showUnderChat(chatAvailable = true, signedIn = true))
        assertFalse(BatteryTexts.showUnderChat(chatAvailable = false, signedIn = true))
        // Signed out, nothing checks for messages: no row, whatever the server offers.
        assertFalse(BatteryTexts.showUnderChat(chatAvailable = true, signedIn = false))
    }
}
