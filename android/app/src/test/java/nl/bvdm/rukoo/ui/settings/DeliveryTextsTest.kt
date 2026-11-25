package nl.bvdm.rukoo.ui.settings

import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.workspaces.ChatDelivery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Settings > Notifications > Delivery: its value, its line and what a tap does, for each state of push wakes. */
class DeliveryTextsTest {
    private val ntfy = "io.heckel.ntfy"

    @Test
    fun `Instant only while wakes come through a distributor`() {
        assertEquals(R.string.settings_notifications_delivery_instant, DeliveryTexts.value(ChatDelivery.Instant(ntfy)))
        for (d in listOf(ChatDelivery.NoDistributor, ChatDelivery.ServerWithout, ChatDelivery.Connecting(ntfy), ChatDelivery.Failed(ntfy, "NETWORK"))) {
            assertEquals(d.toString(), R.string.settings_notifications_delivery_periodic, DeliveryTexts.value(d))
        }
    }

    @Test
    fun `each state has its own line, naming the distributor where there is one`() {
        assertEquals(R.string.settings_notifications_delivery_help_instant, DeliveryTexts.help(ChatDelivery.Instant(ntfy)))
        assertEquals(R.string.settings_notifications_delivery_help_connecting, DeliveryTexts.help(ChatDelivery.Connecting(ntfy)))
        assertEquals(R.string.settings_notifications_delivery_help_none, DeliveryTexts.help(ChatDelivery.NoDistributor))
        assertEquals(R.string.settings_notifications_delivery_help_server, DeliveryTexts.help(ChatDelivery.ServerWithout))
        assertEquals(R.string.settings_notifications_delivery_help_action, DeliveryTexts.help(ChatDelivery.Failed(ntfy, "ACTION_REQUIRED")))
        assertEquals(R.string.settings_notifications_delivery_help_unavailable, DeliveryTexts.help(ChatDelivery.Failed(ntfy, "TEMP_UNAVAILABLE")))
        assertEquals(R.string.settings_notifications_delivery_help_refused, DeliveryTexts.help(ChatDelivery.Failed(ntfy, "REFUSED")))
        assertEquals(R.string.settings_notifications_delivery_help_failed, DeliveryTexts.help(ChatDelivery.Failed(ntfy, "INTERNAL_ERROR")))
        assertEquals(ntfy, DeliveryTexts.distributor(ChatDelivery.Failed(ntfy, "NETWORK")))
        assertNull(DeliveryTexts.distributor(ChatDelivery.NoDistributor))
    }

    @Test
    fun `a tap picks among several, opens a distributor that needs the person, or shows where to get one`() {
        assertEquals(DeliveryTexts.Tap.LEARN, DeliveryTexts.tap(ChatDelivery.NoDistributor, 0))
        assertEquals(DeliveryTexts.Tap.NONE, DeliveryTexts.tap(ChatDelivery.Instant(ntfy), 1))
        assertEquals(DeliveryTexts.Tap.CHOOSE, DeliveryTexts.tap(ChatDelivery.Instant(ntfy), 2))
        assertEquals(DeliveryTexts.Tap.OPEN_DISTRIBUTOR, DeliveryTexts.tap(ChatDelivery.Failed(ntfy, "ACTION_REQUIRED"), 1))
        assertEquals(DeliveryTexts.Tap.NONE, DeliveryTexts.tap(ChatDelivery.ServerWithout, 2))
        // Rukoo's own embedded distributor has no app to open.
        assertEquals(DeliveryTexts.Tap.NONE, DeliveryTexts.tap(ChatDelivery.Failed("nl.bvdm.rukoo", "ACTION_REQUIRED"), 1, own = "nl.bvdm.rukoo"))
    }

    @Test
    fun `the row shows unless chat notifications can't come at all`() {
        assertFalse(DeliveryTexts.shows(ChatDelivery.Off))
        assertTrue(DeliveryTexts.shows(ChatDelivery.ServerWithout))
        assertTrue(DeliveryTexts.shows(ChatDelivery.NoDistributor))
    }
}
