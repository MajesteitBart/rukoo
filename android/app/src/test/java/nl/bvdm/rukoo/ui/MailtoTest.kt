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
    fun ignoresOtherLinks() {
        assertEquals(MailtoFields(), Mailto.parse("https://example.com"))
        assertEquals(MailtoFields(), Mailto.parse(null))
    }
}
