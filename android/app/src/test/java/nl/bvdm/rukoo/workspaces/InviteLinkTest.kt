package nl.bvdm.rukoo.workspaces

import nl.bvdm.rukoo.account.AccountServers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Invitation links (contract §3.2) on the shared vectors, as an Android debug build and a release build parse them. */
class InviteLinkTest {
    private val cases = ChatVectors.all.inviteLinks

    private fun outcome(text: String, server: String, devHosts: Boolean): Pair<ChatVectors.Link?, String?> = try {
        val link = InviteLink.check(text, server, devHosts)
        ChatVectors.Link(link.server, link.workspace, link.secret) to null
    } catch (e: WorkspaceError) {
        null to e.code
    }

    @Test
    fun `the vectors cover what the contract lists`() {
        assertTrue("at least 14 invitation link cases", cases.size >= 14)
        assertTrue(cases.any { it.android != null })
    }

    @Test
    fun `every case parses as a debug build expects`() {
        for (c in cases) {
            val expect = c.android?.takeIf { it.build == "debug" }?.let { it.expect to it.error } ?: (c.expect to c.error)
            assertEquals(c.name, expect, outcome(c.text, c.server, devHosts = true))
        }
    }

    @Test
    fun `every case parses as a release build expects, which is desktop's answer`() {
        for (c in cases) assertEquals(c.name, c.expect to c.error, outcome(c.text, c.server, devHosts = false))
    }

    @Test
    fun `each configured server is written as the account service normalizes it`() {
        for (c in cases) assertEquals(c.name, c.server, AccountServers.serverUrl(c.server, devHosts = true))
    }

    @Test
    fun `a parsed link formats back to the same link`() {
        for (c in cases) {
            val link = InviteLink.parse(c.text, devHosts = true) ?: continue
            val again = InviteLink.parse(link.text, devHosts = true)
            assertEquals(c.name, link, again)
            assertTrue(c.name, link.text.startsWith(link.server + "/join#w="))
        }
    }

    @Test
    fun `the emulator host is refused without dev hosts`() {
        val c = cases.first { it.android != null }
        assertNull(InviteLink.parse(c.text, devHosts = false))
        try {
            InviteLink.check(c.text, c.server, devHosts = false)
            fail("bad_link expected")
        } catch (e: WorkspaceError) {
            assertEquals("bad_link", e.code)
        }
    }

    @Test
    fun `the secret stays out of toString`() {
        val c = cases.first { it.expect != null }
        val link = InviteLink.parse(c.text, devHosts = false)!!
        assertFalse(link.toString().contains(link.secret))
    }

    // rukoo.io and rukoo-account.bvdm.ai are one server (RUK-234); desktop's chat-wire.test.js checks the same.
    private val w = "w_" + "A".repeat(22)
    private val secret = "S".repeat(43)
    private fun at(server: String) = "$server/join#w=$w&i=$secret"

    @Test
    fun `a link from another address of the same server is its own, both ways`() {
        assertEquals("https://rukoo.io", InviteLink.homeOf("https://rukoo.io"))
        for (bad in listOf(null, "", "ftp://rukoo.io", "http://rukoo.io", "https://user@rukoo.io")) assertNull(bad, InviteLink.homeOf(bad))
        assertEquals("http://10.0.2.2:38850", InviteLink.homeOf("http://10.0.2.2:38850"))

        val atNew = InviteLink.sameServers("https://rukoo.io")
        assertEquals(listOf("https://rukoo.io", "https://rukoo-account.bvdm.ai"), atNew)
        assertEquals("https://rukoo-account.bvdm.ai", InviteLink.check(at("https://rukoo-account.bvdm.ai"), atNew, devHosts = false).server)
        val atOld = InviteLink.sameServers("https://rukoo-account.bvdm.ai")
        assertEquals(listOf("https://rukoo-account.bvdm.ai", "https://rukoo.io"), atOld)
        assertEquals("https://rukoo.io", InviteLink.check(at("https://rukoo.io"), atOld, devHosts = false).server)
        try {
            InviteLink.check(at("https://chat.example.net"), atOld, devHosts = false)
            fail("other_server expected")
        } catch (e: WorkspaceError) {
            assertEquals("other_server", e.code)
        }
        assertEquals(listOf("https://chat.example.com"), InviteLink.sameServers("https://chat.example.com"))
        assertEquals(emptyList<String>(), InviteLink.sameServers(""))
    }

    @Test
    fun `a server that claims rukoo's address as its home doesn't get rukoo's links`() {
        // Its /v1/info names https://rukoo.io as the home; only the built-in list decides which links are its own.
        val servers = InviteLink.sameServers("https://chat.example.com")
        for (server in listOf("https://rukoo.io", "https://rukoo-account.bvdm.ai")) {
            try {
                InviteLink.check(at(server), servers, devHosts = false)
                fail("other_server expected for $server")
            } catch (e: WorkspaceError) {
                assertEquals("other_server", e.code)
            }
        }
        assertEquals("https://chat.example.com", InviteLink.inviteServer("https://chat.example.com", "https://rukoo.io"))
    }

    @Test
    fun `new links name the home when it is one of the server's own addresses`() {
        assertEquals("https://rukoo.io", InviteLink.inviteServer("https://rukoo-account.bvdm.ai", "https://rukoo.io"))
        assertEquals("https://rukoo.io", InviteLink.inviteServer("https://rukoo.io", "https://rukoo.io"))
        assertEquals("https://rukoo-account.bvdm.ai", InviteLink.inviteServer("https://rukoo-account.bvdm.ai", null))
        assertEquals("https://example.com/rukoo", InviteLink.inviteServer("https://example.com/rukoo", "https://example.com"))
        assertEquals("https://chat.example.com", InviteLink.inviteServer("https://chat.example.com", "https://home.example.com"))
    }
}
