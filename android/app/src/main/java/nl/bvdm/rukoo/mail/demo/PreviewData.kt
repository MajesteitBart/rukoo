package nl.bvdm.rukoo.mail.demo

import java.time.Instant
import java.time.ZoneId
import nl.bvdm.rukoo.core.UriComponent
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.Unsubscribe

/**
 * The demo account's mailbox, ported from desktop's `seed()` (src/main/demo.js:44-334, spec 4 §7):
 * the same folders, messages, uids and Message-IDs, so the preview engine shows what desktop's demo
 * shows and the screenshots line up.
 */
internal object PreviewData {
    const val ACCOUNT_ID = "demo"

    /** Desktop's FOLDERS (demo.js:11-20). */
    val FOLDERS = listOf(
        "INBOX" to FolderRole.INBOX,
        "Sent" to FolderRole.SENT,
        "Drafts" to FolderRole.DRAFTS,
        "Trash" to FolderRole.TRASH,
        "Junk" to FolderRole.JUNK,
        "Archive" to FolderRole.ARCHIVE,
        "Invoices" to FolderRole.NONE,
        "Travel" to FolderRole.NONE,
    )

    /** The bytes of desktop's tiny one-page PDF (demo.js:58-65). */
    val PDF: ByteArray =
        ("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj " +
            "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF").toByteArray(Charsets.US_ASCII)

    val ME = Address("Demo User", "demo@example.com")

    data class Seeded(
        val uid: Long,
        val folder: String,
        val from: Address,
        val to: List<Address>,
        val cc: List<Address>,
        val subject: String,
        val date: Long,
        val html: String?,
        val text: String?,
        /** PDF attachment file names. */
        val attachments: List<String>,
        val messageId: String,
        val unread: Boolean,
        val starred: Boolean,
        val inReplyTo: String? = null,
        val references: List<String> = emptyList(),
        val unsubscribe: Unsubscribe? = null,
    )

    private class Item(val title: String, val text: String)

    // Desktop's newsletter template (demo.js:22-42), verbatim.
    private fun newsletter(brand: String, color: String, title: String, intro: String, items: List<Item>): String {
        val blocks = items.joinToString("") { i ->
            """<tr><td style="padding:16px 24px;border-top:1px solid #e6e6e6">
<h3 style="margin:0 0 6px;font:600 18px Arial,sans-serif;color:#111">${i.title}</h3>
<p style="margin:0;font:15px/1.5 Arial,sans-serif;color:#444">${i.text}</p>
<p style="margin:10px 0 0"><a href="https://example.com/${UriComponent.encode(i.title)}" style="color:$color;font:600 14px Arial,sans-serif">Read more</a></p>
</td></tr>"""
        }
        return """<!doctype html><html lang="en"><body style="margin:0;background:#f2f2f2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:600px">
<tr><td style="padding:14px 24px;text-align:right;font:12px Arial,sans-serif"><a href="https://example.com/browser" style="color:#3b78c4">View email in browser</a></td></tr>
<tr><td style="padding:20px 24px;background:$color;color:#fff;font:700 26px Arial,sans-serif">$brand</td></tr>
<tr><td style="padding:24px"><h1 style="margin:0 0 8px;font:700 26px Arial,sans-serif;color:#111">$title</h1>
<p style="margin:0;font:16px/1.5 Arial,sans-serif;color:#333">$intro</p></td></tr>
$blocks
<tr><td style="padding:20px 24px;background:#fafafa;font:12px Arial,sans-serif;color:#777">You are receiving this email because you subscribed. <a href="https://example.com/unsubscribe" style="color:#777">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>"""
    }

    private class Spec(
        val from: Address,
        val subject: String,
        val date: Long,
        val to: List<Address>? = null,
        val cc: List<Address> = emptyList(),
        val html: String? = null,
        val text: String? = null,
        val attachments: List<String> = emptyList(),
        val unread: Boolean = false,
        val starred: Boolean = false,
        val key: String? = null,
        val replyTo: String? = null,
    )

    /**
     * Desktop's `at(daysAgo, h, m)`: that local time [daysAgo] days back. Today's mail must lie in the past,
     * so before 15:00 the whole day is squeezed into the time since midnight, keeping the order.
     */
    fun at(now: Long, zone: ZoneId, daysAgo: Int, h: Int, m: Int): Long {
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val target = today.minusDays(daysAgo.toLong()).atTime(h, m).atZone(zone).toInstant().toEpochMilli()
        if (daysAgo > 0) return target
        val midnight = today.atStartOfDay(zone).toInstant().toEpochMilli()
        if (now >= midnight + 15 * 3_600_000L) return target
        return midnight + Math.floor(((h * 60 + m) / (15.0 * 60)) * (now - midnight)).toLong()
    }

    fun seed(now: Long, zone: ZoneId = ZoneId.systemDefault()): List<Seeded> {
        fun at(d: Int, h: Int, m: Int) = at(now, zone, d, h, m)
        val sanne = Address("Sanne de Vries", "sanne@example.com")
        val joris = Address("Joris Bakker", "joris@example.com")
        val vandebron = Address("Vandebron", "support@vandebron.nl")
        val noReply = Address("Vandebron No Reply", "noreply@vandebron.nl")
        val contract = "Dear Demo User,\n\nCustomer number: 2434702\n\nDo you agree to your new contract? The contract confirmation is attached.\n\nGreen regards,\nVandebron"

        val inbox = listOf(
            Spec(
                Address("ANWB Newsletter", "newsletter@anwb.nl"), "Traffic fines in 2027: what you will pay", at(0, 14, 45), unread = true,
                html = newsletter(
                    "ANWB", "#0b5cad", "Driving in low sun: keep your windows clean",
                    "Follow these tips to improve visibility and avoid dangerous situations.",
                    listOf(
                        Item("Top 10 cheapest new cars", "These models cost the least to buy and maintain."),
                        Item("Traffic fines in 2027: what you will pay", "An overview of the new fines for each offence."),
                        Item("Winter tyres: when should you switch?", "Below 7°C, winter tyres offer better grip than summer tyres."),
                    ),
                ),
            ),
            Spec(
                Address("Forward Future (Matthew Berman)", "newsletter@forwardfuture.ai"), "The music industry can't agree on AI", at(0, 14, 6), unread = true,
                html = newsletter(
                    "Forward Future", "#111111", "Video: 28 Days of OpenAI",
                    "This week in AI: labels split on licensing, new agent benchmarks and a look back at a busy month.",
                    listOf(
                        Item("The music industry can't agree on AI", "Two major labels signed deals while a third filed suit."),
                        Item("Agents in the enterprise", "Why most pilots stall after the demo, and what the successful ones do differently."),
                    ),
                ),
            ),
            Spec(vandebron, "Here is another copy of your contract", at(0, 13, 0), unread = true, attachments = listOf("Contract-confirmation.pdf"), text = contract),
            Spec(vandebron, "Here is another copy of your contract", at(0, 12, 54), unread = true, attachments = listOf("Contract-confirmation.pdf"), text = contract),
            Spec(noReply, "Your password has changed", at(0, 12, 30), unread = true, text = "Your password has changed.\n\nIf this was not you, contact us immediately."),
            Spec(noReply, "Your sign-in details have been updated", at(0, 12, 30), text = "Your sign-in details have been updated.\n\nYou can now sign in to My Vandebron with your new details."),
            Spec(noReply, "How to change your My Vandebron password", at(0, 12, 29), text = "How to change your My Vandebron password.\n\nClick the link below to set a new password:\nhttps://example.com/password"),
            Spec(noReply, "Failed sign-in attempt on your My Vandebron account", at(0, 12, 29), text = "Failed sign-in attempt on your My Vandebron account.\n\nWe noticed a failed sign-in attempt. If this was not you, change your password."),
            Spec(Address("Bencompare", "info@bencompare.nl"), "Sign in to Bencompare", at(0, 12, 28), text = "Your Bencompare account\n\nSign in using the link below. The link is valid for 15 minutes.\nhttps://example.com/sign-in"),
            Spec(
                Address("Google", "no-reply@accounts.google.com"), "You updated some of your Google Account details", at(0, 11, 2), unread = true,
                html = newsletter(
                    "Google", "#1a73e8", "Your Google Account details have been updated",
                    "You updated some of your Google Account details. If this was you, no action is needed.",
                    listOf(Item("Security check", "Review recent security activity in your Google Account.")),
                ),
            ),
            Spec(
                Address("Serus", "alerts@serus.example"), "5 more exposures ready to review", at(0, 10, 20), starred = true,
                html = newsletter(
                    "Serus", "#7b61ff", "5 more exposures ready to review",
                    "Your email may be exposed in data breaches. Unlock all now or review the ones below.",
                    listOf(
                        Item("Myspace (High)", "Account data exposed in a historic breach."),
                        Item("Wbgames (Low)", "Account e-mail address exposed."),
                        Item("Adobe (High)", "E-mail address and password hint exposed."),
                    ),
                ),
            ),
            Spec(
                sanne, "Call on Thursday", at(1, 16, 12), to = listOf(ME), cc = listOf(joris), unread = true, key = "call",
                attachments = listOf("Proposal-v3.pdf"),
                text = "Hi!\n\nShall we have a call on Thursday at 10:00 to discuss the proposal? I have attached the latest version.\n\nBest,\nSanne",
            ),
            Spec(Address("NS", "noreply@ns.nl"), "Your travel summary for September", at(1, 9, 3), text = "Your travel summary for September is ready in My NS.\n\nTotal distance travelled: 412 km."),
            Spec(Address("bol", "service@bol.com"), "Your parcel is on its way", at(2, 18, 40), text = "Good news! Your parcel is on its way and will arrive tomorrow between 13:00 and 16:00."),
            Spec(
                joris, "Re: Dinner on Saturday", at(3, 20, 15), to = listOf(ME), starred = true, replyTo = "dinner",
                text = "Great, I will book a table for 19:30. See you on Saturday!\n\n> Saturday works for me too.",
            ),
            Spec(Address("Dutch Tax Administration", "noreply@belastingdienst.example"), "You have a new message", at(9, 8, 0), text = "You have a new message in your inbox on MijnOverheid."),
        )
        val sent = listOf(
            Spec(ME, "Re: Call on Thursday", at(1, 17, 2), to = listOf(sanne), replyTo = "call", text = "Thursday at 10:00 works for me. I will call you.\n\nSent from my PC"),
            Spec(ME, "Dinner on Saturday", at(3, 19, 50), to = listOf(joris), key = "dinner", text = "Saturday works for me too. Could you book a table?"),
            Spec(ME, "Question about my contract", at(4, 10, 30), to = listOf(vandebron), text = "Good afternoon,\n\nCould you send the contract again? I have not received it.\n\nKind regards,\nDemo User"),
        )
        val drafts = listOf(
            Spec(ME, "Quote request", at(2, 11, 0), to = listOf(Address("", "info@example.com")), text = "Hello,\n\nI would like to request a quote for"),
            Spec(ME, "Holiday ideas", at(5, 21, 0), to = emptyList(), text = "Lisbon? Porto?"),
            Spec(ME, "Notes", at(6, 9, 30), to = listOf(sanne), text = "Action items:\n- send the proposal\n- create a schedule"),
        )
        val trash = listOf(Spec(Address("Webshop", "promo@webshop.example"), "Last chance: 50% off", at(4, 7, 0), text = "Today only: half price."))
        val invoices = listOf(
            Spec(
                Address("Ziggo", "billing@ziggo.example"), "Your invoice for October", at(5, 6, 0), attachments = listOf("Invoice-October.pdf"),
                text = "Your invoice for October is ready. The amount of €54.95 will be debited around the 28th.",
            ),
        )
        val travel = listOf(
            Spec(
                Address("KLM", "noreply@klm.example"), "Your booking to Lisbon", at(12, 14, 0),
                text = "Thank you for your booking. Booking reference: QX7P2L.\nDeparture: 14 November, 07:15 from Amsterdam Schiphol.",
            ),
        )

        var uid = 1L
        val out = mutableListOf<Seeded>()
        val keyed = mutableMapOf<String, String>()
        val replies = mutableListOf<Pair<Int, String>>()
        fun fill(folder: String, list: List<Spec>) {
            for (m in list) {
                val thisUid = uid++
                // Desktop increments uid before it builds the Message-ID, so the number is uid + 1 (spec 4 §7.5).
                val messageId = "<demo-$uid@example.com>"
                val unsubscribe = if (m.html?.contains("example.com/unsubscribe") == true) {
                    Unsubscribe(url = "https://example.com/unsubscribe", oneClick = true)
                } else {
                    null
                }
                m.key?.let { keyed[it] = messageId }
                m.replyTo?.let { replies += out.size to it }
                out += Seeded(
                    uid = thisUid, folder = folder, from = m.from, to = m.to ?: listOf(ME), cc = m.cc,
                    subject = m.subject, date = m.date, html = m.html, text = m.text, attachments = m.attachments,
                    messageId = messageId, unread = m.unread, starred = m.starred, unsubscribe = unsubscribe,
                )
            }
        }
        fill("INBOX", inbox)
        fill("Sent", sent)
        fill("Drafts", drafts)
        fill("Trash", trash)
        fill("Invoices", invoices)
        fill("Travel", travel)
        for ((index, key) in replies) {
            val parent = keyed[key] ?: continue
            out[index] = out[index].copy(inReplyTo = parent, references = listOf(parent))
        }
        return out
    }
}
