package nl.bvdm.rukoo.ui.settings

import nl.bvdm.rukoo.ui.settings.RukooAccountModel.InviteInput
import nl.bvdm.rukoo.workspaces.InviteLink
import org.junit.Assert.assertEquals
import org.junit.Test

/** The sign-up form's invite field takes a workspace invitation link too (contract §3.2, §3.3). */
class RukooAccountInviteTest {
    private val w = "w_" + "A".repeat(22)
    private val secret = "s".repeat(43)

    @Test
    fun `a link for the configured server goes as a workspace invitation`() {
        val text = "Join us: https://rukoo.io/join#w=$w&i=$secret thanks"
        assertEquals(InviteInput.Link(InviteLink("https://rukoo.io", w, secret)), RukooAccountModel.inviteInput(text, "https://rukoo.io", devHosts = false))
    }

    @Test
    fun `the emulator's address works in debug builds only`() {
        val text = "http://10.0.2.2:38850/join#i=$secret&w=$w"
        assertEquals(InviteInput.Link(InviteLink("http://10.0.2.2:38850", w, secret)), RukooAccountModel.inviteInput(text, "http://10.0.2.2:38850", devHosts = true))
        assertEquals(InviteInput.Code(text), RukooAccountModel.inviteInput(text, "http://10.0.2.2:38850", devHosts = false))
    }

    @Test
    fun `a link for another server is refused, naming its host`() {
        val text = "https://chat.elsewhere.example/join#w=$w&i=$secret"
        assertEquals(InviteInput.OtherServer("chat.elsewhere.example"), RukooAccountModel.inviteInput(text, "https://rukoo.io", devHosts = false))
    }

    @Test
    fun `anything else is the operator's invite code, as typed`() {
        assertEquals(InviteInput.Code("TEAM-2026"), RukooAccountModel.inviteInput("TEAM-2026", "https://rukoo.io", devHosts = false))
        assertEquals(InviteInput.Code(""), RukooAccountModel.inviteInput("", "https://rukoo.io", devHosts = false))
        // A join link with a bad fragment isn't an invitation.
        val broken = "https://rukoo.io/join#w=$w"
        assertEquals(InviteInput.Code(broken), RukooAccountModel.inviteInput(broken, "https://rukoo.io", devHosts = false))
    }
}
