package nl.bvdm.rukoo.ui.settings

import nl.bvdm.rukoo.desktop.UrlHosts
import nl.bvdm.rukoo.mail.model.GoogleClient
import nl.bvdm.rukoo.mail.model.MailProviders
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsRulesTest {
    @Test
    fun httpInsideTheTailnetIsFine() {
        for (url in listOf(
            "http://100.91.52.84:8642",
            "http://100.64.0.1",
            "http://100.127.255.255:1",
            "http://clarkbox:8642",
            "http://clarkbox.tail1234.ts.net:8642/",
            "http://[fd7a:115c:a1e0::5]:8642",
            "http://localhost:8642",
            "http://127.0.0.1:8642",
            "http://10.0.2.2:8650",
            " HTTP://100.91.52.84:8642 ",
        )) {
            assertFalse(url, AgentUrls.isInsecureRemote(url))
        }
    }

    @Test
    fun httpOutsideTheTailnetWarns() {
        for (url in listOf(
            "http://192.168.1.20:8642",
            "http://100.128.0.1:8642",
            "http://100.63.0.1:8642",
            "http://hermes.example.com",
            "http://[2001:db8::1]:8642",
        )) {
            assertTrue(url, AgentUrls.isInsecureRemote(url))
        }
    }

    @Test
    fun httpsNeverWarns() {
        assertFalse(AgentUrls.isInsecureRemote("https://hermes.example.com"))
        assertFalse(AgentUrls.isInsecureRemote(""))
    }

    @Test
    fun urlsMustBeHttp() {
        assertTrue(AgentUrls.isValid(""))
        assertTrue(AgentUrls.isValid("http://100.91.52.84:8642/"))
        assertTrue(AgentUrls.isValid("https://hermes.example.com"))
        assertFalse(AgentUrls.isValid("100.91.52.84:8642"))
        assertFalse(AgentUrls.isValid("ftp://x"))
        assertFalse(AgentUrls.isValid("http://"))
        assertEquals("http://100.91.52.84:8642", AgentUrls.normalize(" http://100.91.52.84:8642// "))
    }

    @Test
    fun loopbackUrls() {
        assertTrue(UrlHosts.isLoopback("http://127.0.0.1:18789"))
        assertTrue(UrlHosts.isLoopback("http://localhost:18789"))
        assertTrue(UrlHosts.isLoopback("http://[::1]:18789"))
        assertFalse(UrlHosts.isLoopback("http://100.64.0.1:18789"))
        assertEquals("fd7a::1", UrlHosts.host("http://user@[FD7A::1]:1/x"))
    }

    @Test
    fun openClawAgentIds() {
        assertTrue(AgentUrls.isValidOpenClawAgent(""))
        assertTrue(AgentUrls.isValidOpenClawAgent("main_2-b"))
        assertFalse(AgentUrls.isValidOpenClawAgent("-main"))
        assertFalse(AgentUrls.isValidOpenClawAgent("a b"))
    }

    @Test
    fun googleClientFilesInEveryShape() {
        val expected = GoogleClient("id.apps.googleusercontent.com", "s3cret")
        assertEquals(expected, GoogleClientFile.parse("""{"installed":{"client_id":"id.apps.googleusercontent.com","client_secret":"s3cret","redirect_uris":["http://localhost"]}}"""))
        assertEquals(expected, GoogleClientFile.parse("""{"web":{"client_id":"id.apps.googleusercontent.com","client_secret":"s3cret"}}"""))
        assertEquals(expected, GoogleClientFile.parse("""{"client_id":" id.apps.googleusercontent.com ","client_secret":"s3cret"}"""))
        assertNull(GoogleClientFile.parse("""{"installed":{"client_id":"id"}}"""))
        assertNull(GoogleClientFile.parse("""{"client_id":1,"client_secret":2}"""))
        assertNull(GoogleClientFile.parse("not json"))
        assertNull(GoogleClientFile.parse("[]"))
    }

    @Test
    fun openClawTokenMatchesDesktop() {
        // node -e "crypto.createHmac('sha256', key).update('rukoo-mcp-openclaw-remote-v1').digest('base64url')"
        assertEquals("zH_liMsCMypd2NxR_kgVAU2gmnl7jdrAiIwiXN0sqds", OpenClawSetup.token("gw-token-123"))
        assertEquals("T0Gh5h4y3LVvMxbJkiUVk0Krw5zpm84nlAUq-yp7xAI", OpenClawSetup.token("another token"))
        assertEquals("", OpenClawSetup.token(""))
    }

    @Test
    fun openClawCommandAsDesktopWritesIt() {
        assertEquals(
            "openclaw mcp set rukoo '{\"url\":\"http://100.64.0.3:47800/mcp\",\"transport\":\"streamable-http\",\"headers\":{\"Authorization\":\"Bearer zH_liMsCMypd2NxR_kgVAU2gmnl7jdrAiIwiXN0sqds\"}}'\n",
            OpenClawSetup.command("100.64.0.3", 47800, "gw-token-123"),
        )
        assertEquals("", OpenClawSetup.command("100.64.0.3", 47800, ""))
    }

    @Test
    fun serverDefaultsFollowTheDomain() {
        val (imap, smtp) = MailProviders.serverDefaults("other", "me@example.nl")
        assertEquals("imap.example.nl", imap.host)
        assertEquals("smtp.example.nl", smtp.host)
        assertEquals(465, smtp.port)
        // A known domain picks its preset.
        val (gImap, gSmtp) = MailProviders.serverDefaults("other", "me@gmail.com")
        assertEquals("imap.gmail.com", gImap.host)
        assertEquals("smtp.gmail.com", gSmtp.host)
        val (oImap, oSmtp) = MailProviders.serverDefaults("outlook", "me@company.com")
        assertEquals("outlook.office365.com", oImap.host)
        assertEquals(587, oSmtp.port)
        assertFalse(oSmtp.secure)
        assertEquals("me@company.com", oImap.user)
        assertEquals("other", MailProviders.preset("unknown").id)
    }
}
