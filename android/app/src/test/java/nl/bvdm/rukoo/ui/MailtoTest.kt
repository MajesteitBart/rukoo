package nl.bvdm.rukoo.ui

import nl.bvdm.rukoo.mail.model.Address
import org.junit.Assert.assertEquals
import org.junit.Test

// The behavior of desktop's src/main/mailto.js.
class MailtoTest {
    @Test
    fun readsRecipientsSubjectAndBody() {
        val m = Mailto.parse("mailto:a@x.nl,%22Last,%20First%22%20%3Cc@x.nl%3E?cc=b@x.nl&subject=Hi%20there&body=Line%201%0D%0ALine%202&bcc=d@x.nl")
        assertEquals(listOf(Address("", "a@x.nl"), Address("Last, First", "c@x.nl")), m.to)
        assertEquals(listOf(Address("", "b@x.nl")), m.cc)
        assertEquals(listOf(Address("", "d@x.nl")), m.bcc)
        assertEquals("Hi there", m.subject)
        assertEquals("Line 1\nLine 2", m.body)
    }

    @Test
    fun keepsPlusAndBrokenEscapes() {
        val m = Mailto.parse("MAILTO:me+tag@x.nl?subject=50%25%20off%ZZ&subject=second")
        assertEquals("me+tag@x.nl", m.to.single().address)
        assertEquals("50% off%ZZ", m.subject)
    }

    @Test
    fun androidsComposeIntentExtrasFillABareMailto() {
        // Intent(ACTION_SENDTO, "mailto:").putExtra(EXTRA_EMAIL, ...).putExtra(EXTRA_SUBJECT, ...): the usual "Contact support".
        val m = Mailto.withExtras(
            Mailto.parse("mailto:"),
            to = arrayOf("help@x.com", "\"Support, NL\" <nl@x.com>"),
            cc = arrayOf("a@x.com, b@x.com"),
            bcc = null,
            subject = "Bug",
            text = "Steps:\r\n1. Open",
        )
        assertEquals(listOf(Address("", "help@x.com"), Address("Support, NL", "nl@x.com")), m.to)
        assertEquals(listOf(Address("", "a@x.com"), Address("", "b@x.com")), m.cc)
        assertEquals("Bug", m.subject)
        assertEquals("Steps:\n1. Open", m.body)
    }

    @Test
    fun theLinksOwnFieldsWinAndRecipientsAreNotDoubled() {
        val m = Mailto.withExtras(
            Mailto.parse("mailto:help@x.com?subject=From%20link&body=Link%20body"),
            to = arrayOf("HELP@x.com", "more@x.com"),
            subject = "From extra",
            text = "Extra body",
        )
        assertEquals(listOf("help@x.com", "more@x.com"), m.to.map { it.address })
        assertEquals("From link", m.subject)
        assertEquals("Link body", m.body)
    }

    @Test
    fun ignoresOtherLinks() {
        assertEquals(MailtoFields(), Mailto.parse("https://example.com"))
        assertEquals(MailtoFields(), Mailto.parse(null))
    }
}
