package nl.bvdm.rukoo.ui.chat

import java.text.NumberFormat
import java.util.Currency
import java.util.Locale
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.workspaces.WorkspaceBilling

/**
 * The workspace drawer's billing row as numbers and choices (server/WORKSPACES.md "Billing"), as the desktop's
 * src/renderer/chat-billing.js works them out: the seats the total counts are what Stripe bills once billing is set
 * up, else one per member, which Checkout will ask for; the price comes from the server. Pure, for the tests.
 */
object BillingLine {
    private val ENDED = setOf("none", "canceled", "incomplete_expired")

    /** Whether Stripe can still charge in this status. */
    fun live(b: WorkspaceBilling): Boolean = b.status !in ENDED

    fun seats(b: WorkspaceBilling): Int = b.seats?.takeIf { live(b) } ?: maxOf(1, b.members)

    /** The monthly total in the currency's smallest unit. */
    fun totalCents(b: WorkspaceBilling): Long = seats(b).toLong() * b.price.amount

    /** What a tap does: `checkout` or `portal` for an owner, nothing for anyone else. */
    fun action(b: WorkspaceBilling, role: String): String? = when {
        role != "owner" -> null
        b.canCheckout -> "checkout"
        b.canManage -> "portal"
        else -> null
    }

    fun statusText(status: String): Int = when (status) {
        "none", "incomplete_expired" -> R.string.chat_billing_status_none
        "incomplete" -> R.string.chat_billing_status_incomplete
        "trialing" -> R.string.chat_billing_status_trialing
        "active" -> R.string.chat_billing_status_active
        "past_due" -> R.string.chat_billing_status_past_due
        "unpaid" -> R.string.chat_billing_status_unpaid
        "paused" -> R.string.chat_billing_status_paused
        "canceled" -> R.string.chat_billing_status_canceled
        else -> R.string.chat_billing_status_unknown
    }

    /** [cents] in the currency's smallest unit, written for [locale]: €58.50, or € 58,50 in Dutch. */
    fun money(cents: Long, currency: String, locale: Locale): String {
        val code = runCatching { Currency.getInstance(currency.uppercase(Locale.ROOT)) }.getOrDefault(Currency.getInstance("EUR"))
        val format = NumberFormat.getCurrencyInstance(locale).apply { this.currency = code }
        val digits = code.defaultFractionDigits.coerceAtLeast(0)
        format.minimumFractionDigits = digits
        format.maximumFractionDigits = digits
        return format.format(cents.toDouble() / Math.pow(10.0, digits.toDouble()))
    }
}
