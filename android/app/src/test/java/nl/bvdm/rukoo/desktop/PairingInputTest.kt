package nl.bvdm.rukoo.desktop

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingInputTest {
    @Test
    fun codeAcceptsTheDashAndAnyCase() {
        assertEquals("K7QM2XPA", PairingCode.normalize("K7QM-2XPA"))
        assertEquals("K7QM2XPA", PairingCode.normalize("k7qm2xpa"))
        assertEquals("K7QM2XPA", PairingCode.normalize(" k7qm - 2xpa "))
    }

    @Test
    fun codeReadsLookalikesAsTheComputerDoes() {
        // phonehost.js normalizeCode: O is 0, I and L are 1.
        assertEquals("K7Q02X1A", PairingCode.normalize("k7qo-2xia"))
        assertEquals("1111AAAA", PairingCode.normalize("IlLi-aaaa"))
    }

    @Test
    fun codeRejectsWhatCantBeACode() {
        assertNull(PairingCode.normalize(""))
        assertNull(PairingCode.normalize("K7QM-2XP"))
        assertNull(PairingCode.normalize("K7QM-2XPAB"))
        // U is not in the alphabet.
        assertNull(PairingCode.normalize("UUUU-UUUU"))
        assertNull(PairingCode.normalize("K7QM_2XPA"))
    }

    @Test
    fun formatsWithTheDash() {
        assertEquals("K7QM-2XPA", PairingCode.format("K7QM2XPA"))
    }

    @Test
    fun addressTakesWhatTheComputerShows() {
        assertEquals(DesktopAddress("100.101.102.103", 47800), DesktopAddress.parse("http://100.101.102.103:47800"))
        assertEquals(DesktopAddress("100.101.102.103", 47800), DesktopAddress.parse("100.101.102.103"))
        assertEquals(DesktopAddress("100.101.102.103", 47801), DesktopAddress.parse(" 100.101.102.103:47801 "))
        assertEquals(DesktopAddress("100.101.102.103", 47800), DesktopAddress.parse("http://100.101.102.103:47800/mcp"))
    }

    @Test
    fun addressTakesMagicDnsNames() {
        assertEquals(DesktopAddress("office-pc", 47800), DesktopAddress.parse("Office-PC"))
        assertEquals(DesktopAddress("office-pc.tail1234.ts.net", 47800), DesktopAddress.parse("office-pc.tail1234.ts.net."))
    }

    @Test
    fun addressTakesIpv6InBrackets() {
        val a = DesktopAddress.parse("[fd7a:115c:a1e0::1]:47802")
        assertEquals(DesktopAddress("fd7a:115c:a1e0::1", 47802), a)
        assertEquals("http://[fd7a:115c:a1e0::1]:47802", a!!.baseUrl)
        assertEquals(DesktopAddress("fd7a:115c:a1e0::1", 47800), DesktopAddress.parse("fd7a:115c:a1e0::1"))
    }

    @Test
    fun addressRejectsTheRest() {
        assertNull(DesktopAddress.parse(""))
        assertNull(DesktopAddress.parse("https://100.101.102.103"))
        assertNull(DesktopAddress.parse("100.101.102.103:0"))
        assertNull(DesktopAddress.parse("100.101.102.103:99999"))
        assertNull(DesktopAddress.parse("host:port"))
        assertNull(DesktopAddress.parse("user@host"))
        assertNull(DesktopAddress.parse("two words"))
        assertNull(DesktopAddress.parse("-bad-"))
    }
}
