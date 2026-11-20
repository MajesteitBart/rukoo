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
}
