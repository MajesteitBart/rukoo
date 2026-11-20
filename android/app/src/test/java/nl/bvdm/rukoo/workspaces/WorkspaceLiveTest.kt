package nl.bvdm.rukoo.workspaces

import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import nl.bvdm.rukoo.account.AccountKeys
import nl.bvdm.rukoo.account.AccountService
import nl.bvdm.rukoo.account.OkHttpAccountHttp
import nl.bvdm.rukoo.account.PlainSecrets
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.settings.AppSettings
import nl.bvdm.rukoo.ui.ScreenState
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The phone's team chat against the real account server (contract §8.6): the Worker in server/ started by
 * `node test/fixtures/real-server-cli.js --port 38850 --ready-file tmp/rukoo-server.json`. Set
 * RUKOO_ACCOUNT_TEST_SERVER to its address and RUKOO_ACCOUNT_TEST_INVITE to its invite code (`test-invite`); without
 * the address these tests skip. They sign up throwaway accounts with the phone's own AccountService and run the whole
 * WorkspaceService against it: the feed, history, the outbox, the wake socket through OkHttp, alerts.
 *
 * Two people cover a workspace, an invitation link and joining with it, a visible and a private channel, a mention
 * after an emoji, a thread reply, a removal seen through the feed, a DM and a block, a socket wake and a lost answer
 * that is sent again and posts once. A third person signs up with an invitation link in place of an invite code.
 */
class WorkspaceLiveTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val server = System.getenv("RUKOO_ACCOUNT_TEST_SERVER").orEmpty()
    private val invite = System.getenv("RUKOO_ACCOUNT_TEST_INVITE").orEmpty()
    private val okhttp = OkHttpClient.Builder().readTimeout(30, TimeUnit.SECONDS).build()
    private val people = mutableListOf<Person>()

    @After
    fun tearDown() = runBlocking {
        for (p in people) p.close()
    }

    private fun live() = assumeTrue("set RUKOO_ACCOUNT_TEST_SERVER to run against a real account server", server.isNotEmpty())

    private fun email() = "chat-${AccountKeys.b64u(AccountKeys.randomBytes(6)).lowercase().replace(Regex("[^a-z0-9]"), "x")}@example.com"

    /** A workspace route whose answer can be lost on the way back: the server took the request, the phone hears nothing. */
    class LossyHttp(private val inner: WorkspaceHttp) : WorkspaceHttp {
        @Volatile var loseNextPost = false
        val posts = CopyOnWriteArrayList<JsonElement?>()

        override suspend fun request(server: String, method: String, path: String, body: JsonElement?, token: String): WorkspaceAnswer {
            val answer = inner.request(server, method, path, body, token)
            if (method == "POST" && path.endsWith("/messages")) {
                posts += body
                if (loseNextPost) {
                    loseNextPost = false
                    throw WorkspaceError("network", message = "the answer was lost on the way back")
                }
            }
            return answer
        }
    }

    /** One person: a phone with its own account files, chat cache and service. */
    inner class Person(val name: String) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val account = AccountService(tmp.newFolder(), PlainSecrets, server, name, OkHttpAccountHttp(okhttp), scope, devHosts = true, pushAfterMs = 60_000)
        val http = LossyHttp(OkHttpWorkspaceHttp(okhttp))
        val sink = ChatAlertRulesTest.RecordingSink()
        val screen = ScreenState()
        val chat = WorkspaceService(
            account = AccountChat { account },
            http = http,
            file = ChatDb.fileIn(tmp.newFolder()),
            driver = BundledSQLiteDriver(),
            sockets = OkHttpChatSockets(okhttp),
            scope = scope,
            settings = MutableStateFlow(AppSettings()),
            screen = screen,
            sink = sink,
            words = { ChatAlertRulesTest.Words },
            clock = Clock.System,
            timing = ChatTiming(
                sync = SyncTiming(syncBackoffMs = listOf(300, 600, 1_000)),
                outbox = Outbox.Timing(sendBackoff = listOf(300, 600, 1_000)),
            ),
        )

        init {
            people += this
        }

        suspend fun signUp(link: InviteLink? = null) {
            if (link != null) account.signUp(email(), PASSWORD, workspaceInvite = link) else account.signUp(email(), PASSWORD, invite)
            chat.start()
            // The app is open, as MainActivity and ChatBackground mark it: outside the foreground and the worker's
            // window the service neither lists, runs nor retries on its own.
            screen.setForeground(true)
            chat.resumed()
            chat.state.until("$name's chat") { it.signedIn && it.available && it.connection == Connection.ONLINE }
        }

        suspend fun view(ws: String) = chat.view(ws).first()
        suspend fun me(ws: String) = view(ws).me.id
        suspend fun room(ws: String, test: (Room) -> Boolean) = view(ws).rooms.firstOrNull(test)

        suspend fun close() {
            chat.close()
            account.close()
            scope.cancel()
        }
    }

    private suspend fun <T> Flow<T>.until(what: String, timeoutMs: Long = 20_000, test: (T) -> Boolean): T {
        var last: T? = null
        return try {
            withTimeout(timeoutMs) { first { last = it; test(it) } }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            // The last value seen says which part of the wait never came true.
            fail("timed out waiting for $what; last seen: $last")
            throw e
        }
    }

    private fun <T : Any> present(value: T?, what: String): T {
        assertNotNull(what, value)
        return value!!
    }

    private suspend fun eventually(what: String, timeoutMs: Long = 20_000, test: suspend () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (!test()) {
            if (System.currentTimeMillis() > end) fail("timed out waiting for $what")
            delay(100)
        }
    }

    @Test
    fun `two people chat in a workspace through the phone's own code`() = runBlocking<Unit> {
        live()
        val bart = Person("Bart")
        val olga = Person("Olga")
        bart.signUp()
        olga.signUp()

        // A workspace and its general channel.
        val ws = bart.chat.createWorkspace("Live team", "Bart")
        val general = present(bart.room(ws) { it.name == "general" }, "general").id
        assertEquals(ws, bart.chat.state.value.selected)

        // An invitation link (§3.2), its preview and joining with it: a member gets general (§2.11).
        val made = bart.chat.createInvite(ws, "member", emptyList(), 86_400)
        assertEquals("member", made.invite.role)
        val text = made.link
        assertTrue(text, text.startsWith("${bart.chat.state.value.server}/join#w=$ws&i="))
        val link = present(InviteLink.parse(text, devHosts = true), "a link")
        val preview = olga.chat.previewInvite(link)
        assertEquals("Live team", preview.workspace.name)
        assertEquals("Bart", preview.issuer.name)
        assertFalse(preview.already)
        assertEquals(ws, olga.chat.join(link, "Olga"))
        assertNotNull("the default channel", olga.room(ws) { it.id == general })
        val bartId = bart.me(ws)
        val olgaId = olga.me(ws)

        // A visible and a private channel: only the visible one is in Olga's directory, and she can join it.
        val projects = bart.chat.createChannel(ws, "projects", "workspace")
        val secret = bart.chat.createChannel(ws, "secret", "private")
        olga.chat.refresh(ws)
        olga.chat.view(ws).until("projects in Olga's directory") { v -> v.channels.any { it.id == projects } }
        assertFalse("a private channel stays out of others' directory", olga.view(ws).channels.any { it.id == secret })
        olga.chat.joinChannel(ws, projects)
        assertNotNull(olga.room(ws) { it.id == projects })

        // A mention after an emoji, in UTF-8 bytes (§3.17).
        bart.chat.refresh(ws)
        val words = "🎉 Bart, look"
        val mentions = Utf8Offsets.toWire(words, listOf(MentionSpan(3, 7, bartId)))
        assertEquals(listOf(Mention(bartId, 5, 9)), mentions)
        // A sent message joins the cached range when it follows it, so Olga has the room open, as the UI would.
        olga.chat.open(ws, general)
        olga.chat.send(ws, general, null, words, mentions)
        val sent = olga.chat.timeline(ws, general).until("Olga's message sent") { t -> t.pending.isEmpty() && t.events.any { it.text == words } }
            .events.single { it.text == words }
        bart.chat.refresh(ws)
        val bartsRoom = bart.chat.view(ws).until("Bart's mention") { v -> v.rooms.single { it.id == general }.mentions == 1 }.rooms.single { it.id == general }
        assertEquals(1, bartsRoom.attention)
        eventually("Bart's alert for the mention") { bart.sink.shown.any { it.room == general } }
        val alert = bart.sink.shown.last { it.room == general }
        assertEquals("#general", alert.title)
        assertEquals("Olga: 🎉 @Bart, look", alert.body)

        // Bart opens general: the message with its mention as Olga sent it.
        bart.chat.open(ws, general)
        val seen = bart.chat.timeline(ws, general).until("the message in Bart's timeline") { t -> t.events.any { it.id == sent.id } }.events.single { it.id == sent.id }
        assertEquals(mentions, seen.mentions)

        // A thread reply.
        bart.chat.send(ws, general, sent.id, "on it", emptyList())
        bart.chat.timeline(ws, general).until("Bart's reply sent") { it.pending.isEmpty() && it.replies[sent.id]?.count == 1 }
        olga.chat.refresh(ws)
        olga.chat.open(ws, general)
        olga.chat.loadThread(ws, general, sent.id)
        val thread = olga.chat.thread(ws, general, sent.id).until("the reply in Olga's thread") { t -> t.replies.any { it.text == "on it" } }
        assertEquals(sent.id, thread.root?.id)

        // A removal, seen through Bart's feed: the text goes and Bart's alert for it is taken back.
        olga.chat.redact(ws, general, sent.id)
        bart.chat.refresh(ws)
        bart.chat.timeline(ws, general).until("the removal in Bart's cache") { t -> t.events.single { it.id == sent.id }.let { it.redacted && it.text == null } }
        eventually("Bart's alert taken back") { ChatAlertRules.roomKey(ws, general) !in bart.sink.activeKeys() }

        // A DM, then a block closes it for both.
        val dm = bart.chat.startDm(ws, listOf(olgaId))
        bart.chat.open(ws, dm)
        bart.chat.send(ws, dm, null, "hello in private", emptyList())
        bart.chat.timeline(ws, dm).until("the DM message sent") { it.pending.isEmpty() && it.events.any { e -> e.text == "hello in private" } }
        olga.chat.refresh(ws)
        olga.chat.view(ws).until("the DM with an unread message") { v -> v.rooms.any { it.id == dm && it.unread == 1 } }
        eventually("Olga's alert for the DM") { olga.sink.shown.any { it.room == dm && it.title == "Bart" } }
        olga.chat.block(ws, bartId)
        assertEquals(listOf(bartId), olga.view(ws).blocks.map { it.member })
        olga.chat.view(ws).until("the DM closed for Olga") { v -> v.rooms.single { it.id == dm }.closedReason == "closed" }
        bart.chat.refresh(ws)
        bart.chat.view(ws).until("the DM closed for Bart") { v -> v.rooms.single { it.id == dm }.closedReason == "closed" }
        olga.chat.unblock(ws, bartId)
        assertTrue(olga.view(ws).blocks.isEmpty())

        // A socket wake: Bart has general on screen, and Olga's message arrives without anyone asking for a run.
        bart.screen.setForeground(true)
        bart.chat.onScreen(ws, general, null)
        bart.chat.resumed()
        bart.chat.state.until("Bart's socket open") { s -> s.workspaces.single { it.id == ws }.socket == SocketState.OPEN }
        delay(500)
        olga.chat.send(ws, general, null, "live from Olga", emptyList())
        bart.chat.timeline(ws, general).until("the woken run", timeoutMs = 10_000) { t -> t.events.any { it.text == "live from Olga" } }
        assertTrue("no alert for the room on screen", bart.sink.shown.none { it.lines.any { l -> l.text == "live from Olga" } })

        // A lost answer: the outbox sends the same operation again, and the server has the message once.
        olga.http.loseNextPost = true
        val before = olga.http.posts.size
        olga.chat.send(ws, general, null, "only once", emptyList())
        olga.chat.timeline(ws, general).until("the retried send") { t -> t.pending.isEmpty() && t.events.any { it.text == "only once" } }
        val attempts = olga.http.posts.drop(before)
        assertEquals("sent twice", 2, attempts.size)
        assertEquals("with the same bytes, so the same operation", attempts[0], attempts[1])
        bart.chat.refresh(ws)
        bart.chat.timeline(ws, general).until("Olga's message at Bart's") { t -> t.events.any { it.text == "only once" } }
        assertEquals(1, bart.chat.timeline(ws, general).first().events.count { it.text == "only once" })
    }

    @Test
    fun `a colleague signs up with an invitation link and joins from the pending join`() = runBlocking<Unit> {
        live()
        val bart = Person("Bart")
        bart.signUp()
        val ws = bart.chat.createWorkspace("Signup team", "Bart")
        val link = present(InviteLink.parse(bart.chat.createInvite(ws, "member", emptyList(), 86_400).link, devHosts = true), "a link")

        // No invite code: the invitation stands in for it (§2.12, §3.3).
        val sam = Person("Sam")
        sam.signUp(link)
        sam.chat.rememberJoin(link)
        sam.chat.state.until("the pending join") { it.pendingJoin }
        val pending = present(sam.chat.takePendingJoin(), "the pending join")
        assertNull("taken once", sam.chat.takePendingJoin())
        assertEquals(ws, sam.chat.join(pending, "Sam"))
        assertTrue(sam.view(ws).rooms.any { it.name == "general" })
        bart.chat.refresh(ws)
        bart.chat.view(ws).until("Sam among Bart's members") { v -> v.members.any { it.name == "Sam" } }
    }

    private companion object {
        const val PASSWORD = "a long enough password"
    }
}
