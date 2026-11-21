package nl.bvdm.rukoo.ui.chat

import java.util.Locale
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.workspaces.BillingPrice
import nl.bvdm.rukoo.workspaces.WorkspaceBilling
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The billing row's numbers and choices (BillingLine), as the desktop's test/chat-billing.test.js checks them. */
class BillingLineTest {
    private val none = WorkspaceBilling(status = "none", members = 3, pending = 1, canCheckout = true)
    private val active = none.copy(status = "active", seats = 4, canCheckout = false, canManage = true)

    @Test
    fun beforeSetUpEveryMemberIsASeat() {
        assertEquals(3, BillingLine.seats(none))
        assertEquals(5850L, BillingLine.totalCents(none))
        assertEquals(1, BillingLine.seats(none.copy(members = 0)))
        assertEquals("checkout", BillingLine.action(none, "owner"))
    }

    @Test
    fun aSubscriptionCountsWhatStripeBillsVacantSeatsIncluded() {
        assertEquals(4, BillingLine.seats(active))
        assertEquals(7800L, BillingLine.totalCents(active))
        assertEquals("portal", BillingLine.action(active, "owner"))
        // An ended subscription bills nothing: one seat per member again.
        assertEquals(3, BillingLine.seats(active.copy(status = "canceled")))
    }

    @Test
    fun onlyOwnersGetAnAction() {
        assertNull(BillingLine.action(none, "admin"))
        assertNull(BillingLine.action(active, "admin"))
        assertNull(BillingLine.action(active.copy(canManage = false), "owner"))
    }

    @Test
    fun theTotalIsWrittenForTheLanguage() {
        assertEquals("€58.50", BillingLine.money(5850, "eur", Locale.UK))
        assertEquals("€ 58,50", BillingLine.money(5850, "eur", Locale.forLanguageTag("nl-NL")).replace('\u00a0', ' '))
        assertEquals("¥1,950", BillingLine.money(1950, "jpy", Locale.US).replace("JP¥", "¥"))
        assertEquals(1612L * 2, BillingLine.totalCents(active.copy(seats = 2, price = BillingPrice(amount = 1612, taxBehavior = "exclusive"))))
    }

    @Test
    fun everyStatusHasAText() {
        assertEquals(R.string.chat_billing_status_none, BillingLine.statusText("incomplete_expired"))
        assertEquals(R.string.chat_billing_status_past_due, BillingLine.statusText("past_due"))
        assertEquals(R.string.chat_billing_status_unknown, BillingLine.statusText("something_new"))
    }
}
