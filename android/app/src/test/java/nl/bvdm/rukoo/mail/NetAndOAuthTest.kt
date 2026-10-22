package nl.bvdm.rukoo.mail

import java.net.InetAddress
import java.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.UriComponent
import nl.bvdm.rukoo.mail.google.GoogleAuth
import nl.bvdm.rukoo.mail.google.GoogleClientStore
import nl.bvdm.rukoo.mail.google.GoogleOAuth
import nl.bvdm.rukoo.mail.model.GoogleClient
import nl.bvdm.rukoo.mail.net.PublicAddress
import nl.bvdm.rukoo.mail.net.SafeHttp
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class NetAndOAuthTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun `only public addresses count, also inside IPv6`() {
        for (ip in listOf("8.8.8.8", "142.250.180.14", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8")) assertTrue(ip, PublicAddress.isPublic(ip))
        for (ip in listOf(
            "10.0.0.1", "127.0.0.1", "100.91.52.84", "169.254.1.1", "172.16.5.4", "192.168.1.1", "192.0.0.8", "198.18.0.1", "0.0.0.0",
            "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "64:ff9b::1.2.3.4",
            "::127.0.0.1", "not-an-ip", "1.2.3", "01.2.3.4",
        )) assertFalse(ip, PublicAddress.isPublic(ip))
    }

    @Test
    fun `unsubscribe requests refuse http, private literals and private names`() = runBlocking {
        val http = SafeHttp(OkHttpClient())
        assertNull(http.request("http://example.com/u"))
        assertNull(http.request("https://127.0.0.1/u"))
        assertNull(http.request("https://[::1]/u"))
        assertNull(http.request("ftp://example.com/u"))
        val intranet = object : Dns {
            override fun lookup(hostname: String) = listOf(InetAddress.getByName("10.0.0.5"))
        }
        val local = SafeHttp(OkHttpClient(), dns = nl.bvdm.rukoo.mail.net.PublicDns(intranet))
        assertNull(local.request("https://intranet.example/u"))
    }

    @Test
    fun `one-click posts the form, counts only 2xx and never follows a redirect`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(200))
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "/elsewhere"))
            server.start()
            val http = SafeHttp(OkHttpClient(), scheme = "http", dns = Dns.SYSTEM, checkLiterals = false)
            assertTrue(http.oneClickUnsubscribe(server.url("/u").toString()))
            val req = server.takeRequest()
            assertEquals("POST", req.method)
            assertEquals("List-Unsubscribe=One-Click", req.body.readUtf8())
            assertTrue(req.getHeader("Content-Type")!!.startsWith("application/x-www-form-urlencoded"))
            assertFalse(http.oneClickUnsubscribe(server.url("/u").toString()))
            assertEquals(2, server.requestCount)
        }
    }

    @Test
    fun `answers over the size limit are dropped and redirects are capped`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("x".repeat(2000)))
            repeat(5) { server.enqueue(MockResponse().setResponseCode(301).setHeader("Location", "/next")) }
            server.start()
            val http = SafeHttp(OkHttpClient(), scheme = "http", dns = Dns.SYSTEM, checkLiterals = false)
            assertNull(http.request(server.url("/big").toString(), maxBytes = 1000))
            val redirected = http.request(server.url("/loop").toString(), redirects = 2)
            assertEquals(301, redirected!!.status)
            assertNull(redirected.body)
            assertEquals(4, server.requestCount)
        }
    }

    @Test
    fun `PKCE, the consent URL and XOAUTH2 follow the standards`() {
        // RFC 7636 appendix B.
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", GoogleOAuth.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        val pkce = GoogleOAuth.Pkce.create()
        assertEquals(64, pkce.verifier.length)
        assertEquals(32, pkce.state.length)
        assertFalse(pkce.verifier.contains('=') || pkce.verifier.contains('+') || pkce.verifier.contains('/'))

        val url = GoogleOAuth.authUrl(GoogleClient("cid.apps.googleusercontent.com", "s"), "http://127.0.0.1:5555/", pkce, "me@gmail.com")
        val params = url.substringAfter('?').split('&').associate { p -> p.substringBefore('=') to UriComponent.decode(p.substringAfter('=').replace("+", " "))!! }
        assertTrue(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?client_id="))
        assertEquals("http://127.0.0.1:5555/", params["redirect_uri"])
        assertEquals("code", params["response_type"])
        assertEquals(GoogleOAuth.SCOPES.joinToString(" "), params["scope"])
        assertEquals("offline", params["access_type"])
        assertEquals("consent", params["prompt"])
        assertEquals("true", params["include_granted_scopes"])
        assertEquals("S256", params["code_challenge_method"])
        assertEquals(pkce.challenge, params["code_challenge"])
        assertEquals(pkce.state, params["state"])
        assertEquals("me@gmail.com", params["login_hint"])

        val xoauth = String(Base64.getDecoder().decode(GoogleOAuth.xoauth2("me@gmail.com", "ya29.token")))
        assertEquals("user=me@gmail.com\u0001auth=Bearer ya29.token\u0001\u0001", xoauth)
    }

    @Test
    fun `client files in Google's and the flat shape are read`() {
        assertEquals(GoogleClient("a", "b"), GoogleOAuth.parseClient("{\"installed\":{\"client_id\":\"a\",\"client_secret\":\"b\",\"redirect_uris\":[]}}"))
        assertEquals(GoogleClient("a", "b"), GoogleOAuth.parseClient("{\"web\":{\"client_id\":\"a\",\"client_secret\":\"b\"}}"))
        assertEquals(GoogleClient("a", "b"), GoogleOAuth.parseClient("{\"client_id\":\"a\",\"client_secret\":\"b\"}"))
        assertNull(GoogleOAuth.parseClient("{\"client_id\":\"a\"}"))
        assertNull(GoogleOAuth.parseClient("not json"))
        val payload = Base64.getUrlEncoder().withoutPadding().encodeToString("{\"email\":\"me@gmail.com\",\"name\":\"Me\"}".toByteArray())
        assertEquals("me@gmail.com", GoogleOAuth.decodeJwtPayload("h.$payload.s")["email"]?.toString()?.trim('"'))
    }

    private fun auth(server: MockWebServer, scope: CoroutineScope): GoogleAuth {
        val store = GoogleClientStore(tmp.newFile("client.json").also { it.delete() }, FakeCipher)
        store.set(GoogleClient("cid", "secret"))
        return GoogleAuth(store, OkHttpClient(), TestStrings, scope, Clock { 1_000 }, tokenEndpoint = server.url("/token").toString())
    }

    @Test
    fun `the code exchange checks scope, refresh token and email`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        MockWebServer().use { server ->
            val idToken = "h." + Base64.getUrlEncoder().withoutPadding().encodeToString("{\"email\":\"me@gmail.com\",\"name\":\"Me\"}".toByteArray()) + ".s"
            server.enqueue(MockResponse().setBody("{\"access_token\":\"at\",\"refresh_token\":\"rt\",\"expires_in\":3599,\"scope\":\"openid https://mail.google.com/ email\",\"id_token\":\"$idToken\"}"))
            server.enqueue(MockResponse().setBody("{\"access_token\":\"at\",\"refresh_token\":\"rt\",\"scope\":\"openid email\",\"id_token\":\"$idToken\"}"))
            server.enqueue(MockResponse().setResponseCode(400).setBody("{\"error\":\"invalid_grant\"}"))
            server.enqueue(MockResponse().setResponseCode(400).setBody("{\"error\":\"invalid_client\"}"))
            server.start()
            val google = auth(server, scope)
            val tokens = google.exchange(GoogleClient("cid", "secret"), "code1", "http://127.0.0.1:1/", "verifier")
            assertEquals("me@gmail.com", tokens.email)
            assertEquals("rt", tokens.refreshToken)
            assertEquals(1_000 + 3_599_000L, tokens.expiresAt)
            val form = server.takeRequest().body.readUtf8()
            assertTrue(form.contains("grant_type=authorization_code") && form.contains("code_verifier=verifier") && form.contains("client_secret=secret"))
            try {
                google.exchange(GoogleClient("cid", "secret"), "code2", "http://127.0.0.1:1/", "v")
                fail()
            } catch (e: MailException) {
                assertEquals("scope", e.code)
                assertEquals("Allow Rukoo Mail to access Gmail (select all permissions) and try again.", e.message)
            }
            try {
                google.refresh("old")
                fail()
            } catch (e: MailException) {
                assertEquals("Your Google access has expired or been revoked. Sign in again through Settings.", e.message)
            }
            try {
                google.refresh("old")
                fail()
            } catch (e: MailException) {
                assertEquals("Google rejected the request (invalid_client).", e.message)
            }
        }
        scope.cancel()
    }

    private fun get(port: Int, path: String): String = java.net.Socket("127.0.0.1", port).use { s ->
        s.getOutputStream().write("GET $path HTTP/1.1\r\nHost: 127.0.0.1:$port\r\n\r\n".toByteArray())
        s.getInputStream().readBytes().toString(Charsets.UTF_8)
    }

    @Test(timeout = 30_000)
    fun `the loopback sign-in ignores stray requests, answers the redirect and sends the browser back to Rukoo`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        MockWebServer().use { server ->
            val idToken = "h." + Base64.getUrlEncoder().withoutPadding().encodeToString("{\"email\":\"me@gmail.com\"}".toByteArray()) + ".s"
            server.enqueue(MockResponse().setBody("{\"access_token\":\"at\",\"refresh_token\":\"rt\",\"scope\":\"https://mail.google.com/\",\"id_token\":\"$idToken\"}"))
            server.start()
            val store = GoogleClientStore(tmp.newFile("c.json").also { it.delete() }, FakeCipher).apply { set(GoogleClient("cid", "secret")) }
            val pages = java.util.Collections.synchronizedList(mutableListOf<String>())
            var browser: Thread? = null
            val google = GoogleAuth(store, OkHttpClient(), TestStrings, scope, tokenEndpoint = server.url("/token").toString(), openBrowser = { _, url ->
                val params = url.substringAfter('?').split('&').associate { p -> p.substringBefore('=') to UriComponent.decode(p.substringAfter('='))!! }
                val port = params.getValue("redirect_uri").substringAfter("127.0.0.1:").trimEnd('/').toInt()
                browser = Thread {
                    // A connection opened ahead of time that never sends anything must not hold up the redirect.
                    val idle = java.net.Socket("127.0.0.1", port)
                    pages += get(port, "/?state=wrong&code=x")
                    pages += get(port, "/favicon.ico")
                    pages += get(port, "/?state=${params.getValue("state")}&code=the-code&scope=x")
                    idle.close()
                }.also { it.start() }
            })
            val tokens = google.signIn(android.content.ContextWrapper(null))
            browser!!.join(10_000)
            assertEquals("me@gmail.com", tokens.email)
            assertTrue(pages[0].startsWith("HTTP/1.1 200") && pages[0].contains("Invalid request. Start sign-in again from Rukoo Mail."))
            assertTrue(pages[1].startsWith("HTTP/1.1 404"))
            assertTrue(pages[2].contains("You are signed in") && pages[2].contains("url=rukoo-oauth://done") && pages[2].contains("href=\"rukoo-oauth://done\""))
            val form = server.takeRequest().body.readUtf8()
            assertTrue(form.contains("code=the-code"))
        }
        scope.cancel()
    }

    @Test
    fun `a browser connection accepted while sign-in ends is closed, not leaked`() {
        java.net.ServerSocket(0, 8, InetAddress.getByName("127.0.0.1")).use { server ->
            val client1 = java.net.Socket("127.0.0.1", server.localPort)
            val client2 = java.net.Socket("127.0.0.1", server.localPort)
            val early = server.accept()
            val late = server.accept()
            val connections = GoogleAuth.Connections()
            assertTrue(connections.add(early))
            connections.closeAll()
            assertTrue(early.isClosed)
            assertFalse(connections.add(late))
            assertTrue(late.isClosed)
            client1.close()
            client2.close()
        }
    }

    @Test
    fun `the client secret is stored encrypted`() {
        val file = tmp.newFile("google.json").also { it.delete() }
        GoogleClientStore(file, FakeCipher).set(GoogleClient("cid", "topsecret"))
        assertFalse(file.readText().contains("topsecret"))
        assertEquals(GoogleClient("cid", "topsecret"), GoogleClientStore(file, FakeCipher).client.value)
    }
}
