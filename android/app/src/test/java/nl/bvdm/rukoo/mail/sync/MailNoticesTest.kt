package nl.bvdm.rukoo.mail.sync

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import nl.bvdm.rukoo.categories.MailNotice
import nl.bvdm.rukoo.categories.NoticeCategories
import nl.bvdm.rukoo.categories.NoticeContext
import nl.bvdm.rukoo.categories.NoticeDecision
import nl.bvdm.rukoo.categories.NoticeListener
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.MessageSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** MailNotices on its own, on virtual time, with categories that decide what the test says. */
@OptIn(ExperimentalCoroutinesApi::class)
class MailNoticesTest {
    /** Each email's decision by subject: what notice() answers now, and with jev = false (after the wait). */
    private class FakeCategories(var muted: Set<String> = setOf("promotions")) : NoticeCategories {
        val now = HashMap<String, MailNotice>()
        val after = HashMap<String, MailNotice>()
        val listeners = mutableListOf<NoticeListener>()

        override fun noticeContext() = NoticeContext(muted)

        override fun notice(m: MessageSummary, ctx: NoticeContext, jev: Boolean): NoticeDecision {
            val what = if (jev) now[m.subject] ?: MailNotice.SHOW else after[m.subject] ?: now[m.subject]?.takeIf { it != MailNotice.WAIT } ?: MailNotice.SHOW
            return NoticeDecision(what, "key:${m.subject}")
        }

        override fun addNoticeListener(listener: NoticeListener) {
            listeners += listener
        }

        override fun removeNoticeListener(listener: NoticeListener) {
            listeners -= listener
        }
    }

    private fun mail(subject: String, account: String = "a") =
        MessageSummary(id = "$account:INBOX:$subject", accountId = account, folder = "INBOX", uid = 1, subject = subject, from = Address(subject, "$subject@example.com"))

    private class Shown {
        val calls = mutableListOf<Pair<List<String>, Set<String>>>()
        val show: (List<MessageSummary>, Set<String>) -> Set<String> = { list, quiet ->
            calls += list.map { it.subject } to quiet
            list.map { it.accountId }.toSet()
        }
    }

    @Test
    fun nothingMutedOrNoCategoriesNotifiesAtOnce() = runTest {
        val shown = Shown()
        MailNotices({ null }, shown.show, backgroundScope).add(listOf(mail("x")))
        val cats = FakeCategories(muted = emptySet()).apply { now["x"] = MailNotice.WAIT }
        val notices = MailNotices({ cats }, shown.show, backgroundScope)
        notices.add(listOf(mail("x"), mail("y")))
        assertEquals(listOf(listOf("x") to emptySet<String>(), listOf("x", "y") to emptySet()), shown.calls)
        assertTrue("nothing muted asks nothing of the categories", cats.listeners.isEmpty())
    }

    @Test
    fun aMutedEmailStaysAwayAndAWaitingOneGoesAfterTwentySecondsAtMost() = runTest {
        val cats = FakeCategories().apply {
            now["offer"] = MailNotice.MUTE
            now["question"] = MailNotice.WAIT
            after["question"] = MailNotice.SHOW
        }
        val shown = Shown()
        val notices = MailNotices({ cats }, shown.show, backgroundScope)
        notices.add(listOf(mail("offer"), mail("question"), mail("hello")))
        assertEquals(listOf(listOf("hello") to emptySet<String>()), shown.calls)
        val settled = async { notices.settle() }
        advanceTimeBy(MailNotices.HOLD - 1)
        runCurrent()
        assertEquals(1, shown.calls.size)
        assertFalse(settled.isCompleted)
        advanceTimeBy(1)
        runCurrent()
        // The account already sounded for this batch: the rest joins quietly.
        assertEquals(listOf("question") to setOf("a"), shown.calls[1])
        assertTrue(settled.isCompleted)
    }

    @Test
    fun jevsAnswerForOneEmailDecidesIt() = runTest {
        val cats = FakeCategories().apply {
            now["question"] = MailNotice.WAIT
            now["notes"] = MailNotice.WAIT
        }
        val shown = Shown()
        val notices = MailNotices({ cats }, shown.show, backgroundScope)
        notices.add(listOf(mail("question"), mail("notes", account = "b")))
        assertTrue(shown.calls.isEmpty())
        // Jev put the question in a muted category.
        cats.now["question"] = MailNotice.MUTE
        cats.listeners.forEach { it.answered("key:question") }
        assertTrue("the batch waits for its last answer", shown.calls.isEmpty())
        cats.now["notes"] = MailNotice.SHOW
        cats.listeners.forEach { it.answered("key:notes") }
        runCurrent()
        // Nothing sounded yet for this batch, so this one does.
        assertEquals(listOf(listOf("notes") to emptySet<String>()), shown.calls)
        advanceTimeBy(MailNotices.HOLD)
        runCurrent()
        assertEquals("the wait has nothing left to do", 1, shown.calls.size)
    }

    @Test
    fun aChangeForAllReleasesWhatNoLongerWaits() = runTest {
        val cats = FakeCategories().apply { now["question"] = MailNotice.WAIT }
        val shown = Shown()
        val notices = MailNotices({ cats }, shown.show, backgroundScope)
        notices.add(listOf(mail("question")))
        // An answer for another email changes nothing for this one.
        cats.listeners.forEach { it.answered("key:other") }
        assertTrue(shown.calls.isEmpty())
        // Jev turned off: the category it has now decides.
        cats.now["question"] = MailNotice.SHOW
        cats.listeners.forEach { it.reconsider() }
        runCurrent()
        assertEquals(listOf(listOf("question") to emptySet<String>()), shown.calls)
        notices.settle()
    }

    @Test
    fun aBatchReleasedAfterItsScopeEndedStillCountsAsDone() = runTest {
        val cats = FakeCategories().apply { now["question"] = MailNotice.WAIT }
        val shown = Shown()
        val scope = CoroutineScope(backgroundScope.coroutineContext + Job())
        val notices = MailNotices({ cats }, shown.show, scope)
        notices.add(listOf(mail("question")))
        scope.cancel()
        // Decided after the scope ended: nothing can show it, and nothing waits for it either.
        cats.now["question"] = MailNotice.SHOW
        cats.listeners.forEach { it.reconsider() }
        runCurrent()
        assertTrue(shown.calls.isEmpty())
        notices.settle()
    }

    @Test
    fun closingWhileReleasedMailIsBeingCheckedShowsNothingAndKeepsCountingRight() = runTest {
        val cats = FakeCategories().apply { now["question"] = MailNotice.WAIT }
        val shown = Shown()
        val gate = CompletableDeferred<Unit>()
        val notices = MailNotices({ cats }, shown.show, backgroundScope, current = { list -> gate.await(); list })
        notices.add(listOf(mail("question")))
        cats.now["question"] = MailNotice.SHOW
        cats.listeners.forEach { it.reconsider() }
        runCurrent()
        notices.close()
        gate.complete(Unit)
        runCurrent()
        assertTrue(shown.calls.isEmpty())
        notices.settle()
        // Used again after closing, the count is still right: one batch, released, done.
        cats.now["notes"] = MailNotice.WAIT
        notices.add(listOf(mail("notes")))
        val settled = async { notices.settle() }
        runCurrent()
        assertFalse(settled.isCompleted)
        advanceTimeBy(MailNotices.HOLD)
        runCurrent()
        assertTrue(settled.isCompleted)
        assertEquals(listOf(listOf("notes") to emptySet<String>()), shown.calls)
    }

    @Test
    fun mailReadOrMovedWhileItWaitedIsNotAnnounced() = runTest {
        val cats = FakeCategories().apply {
            now["question"] = MailNotice.WAIT
            now["notes"] = MailNotice.WAIT
        }
        val shown = Shown()
        // Read on another device while Jev thought about it: no longer unread in Inbox.
        val read = setOf("a:INBOX:question")
        val notices = MailNotices({ cats }, shown.show, backgroundScope, current = { list -> list.filter { it.id !in read } })
        notices.add(listOf(mail("question"), mail("notes")))
        advanceTimeBy(MailNotices.HOLD)
        runCurrent()
        assertEquals(listOf(listOf("notes") to emptySet<String>()), shown.calls)
        notices.settle()
        // Nothing left at all: nothing to show.
        notices.add(listOf(mail("question")))
        advanceTimeBy(MailNotices.HOLD)
        runCurrent()
        assertEquals(1, shown.calls.size)
        notices.settle()
    }

    @Test
    fun closingDropsWhatWaitsAndStopsListening() = runTest {
        val cats = FakeCategories().apply { now["question"] = MailNotice.WAIT }
        val shown = Shown()
        val notices = MailNotices({ cats }, shown.show, backgroundScope)
        notices.add(listOf(mail("question")))
        notices.close()
        assertTrue(cats.listeners.isEmpty())
        advanceTimeBy(MailNotices.HOLD + 1)
        runCurrent()
        assertTrue(shown.calls.isEmpty())
        notices.settle()
    }
}
