package nl.bvdm.rukoo.mail.sync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.categories.MailNotice
import nl.bvdm.rukoo.categories.NoticeCategories
import nl.bvdm.rukoo.categories.NoticeContext
import nl.bvdm.rukoo.categories.NoticeListener
import nl.bvdm.rukoo.mail.model.MessageSummary

/**
 * New-mail notifications by inbox category, a port of desktop's src/main/categories/notices.js. A category muted on
 * this phone sends none. An email Jev is about to sort, because the rules aren't sure about it, waits for Jev's answer,
 * at most [hold], and then goes by the category it got. With nothing muted, all new mail notifies at once, as without
 * categories.
 *
 * A batch of new mail notifies as one, also when part of it waits: what is decided at arrival shows at once, and the
 * rest joins the same account's notification when it is decided, without a second sound for an account that already
 * made one. [show] puts mail in the notifications; its second argument names the accounts that update quietly, and it
 * answers with the accounts whose notification grew. [categories] is null where there are none yet. [current] keeps
 * what is still new when waiting mail is released: an email read or moved meanwhile, here or elsewhere, isn't announced.
 */
class MailNotices(
    private val categories: () -> NoticeCategories?,
    private val show: (List<MessageSummary>, Set<String>) -> Set<String>,
    private val scope: CoroutineScope,
    private val hold: Long = HOLD,
    private val current: suspend (List<MessageSummary>) -> List<MessageSummary> = { it },
) {
    /** A batch with mail waiting for Jev. [alerted]: accounts whose notification already sounded for it. */
    private class Batch(val held: List<MessageSummary>, val entries: List<Entry>, val alerted: Set<String>) {
        val waiting = HashSet<Entry>()
        var timer: Job? = null

        /** Showing what is left, once it is released. Under [lock]. */
        var showing: Job? = null
    }

    private class Entry(val m: MessageSummary, val key: String) {
        lateinit var batch: Batch
    }

    private val lock = Any()

    // Batches with mail still waiting.
    private val batches = LinkedHashSet<Batch>()

    // Batches not done yet: waiting, or released and still being shown. Each leaves once ([finish]).
    private val open = HashSet<Batch>()

    // The waiting emails by key, so Jev's answer for one looks at that one only.
    private val byKey = HashMap<String, MutableSet<Entry>>()

    /** How many batches are [open]; [settle] waits for none. */
    private val pending = MutableStateFlow(0)
    private var attached: NoticeCategories? = null

    private val listener = object : NoticeListener {
        override fun answered(key: String) = recheck(synchronized(lock) { byKey[key]?.toList().orEmpty() })

        // Muted categories, Jev or categories turned on or off, a category removed: every waiting email.
        override fun reconsider() = recheck(synchronized(lock) { byKey.values.flatten() })
    }

    /** Listens to [cats]' answers and changes, once. MailModule attaches as soon as the categories exist. */
    fun attach(cats: NoticeCategories) {
        synchronized(lock) {
            if (attached != null) return
            attached = cats
        }
        cats.addNoticeListener(listener)
    }

    /** A batch of new inbox mail (the engine's new mail). What Jev is about to sort waits; the rest is decided now. */
    fun add(messages: List<MessageSummary>) {
        if (messages.isEmpty()) return
        val cats = categories()
        val ctx = cats?.noticeContext() ?: NoticeContext.NONE
        if (cats == null || ctx.muted.isEmpty()) {
            show(messages, emptySet())
            return
        }
        attach(cats)
        val now = ArrayList<MessageSummary>()
        val held = ArrayList<MessageSummary>()
        val entries = ArrayList<Entry>()
        for (m in messages) {
            val d = cats.notice(m, ctx)
            when (d.what) {
                MailNotice.SHOW -> now += m
                MailNotice.MUTE -> Unit
                MailNotice.WAIT -> {
                    held += m
                    entries += Entry(m, d.key ?: continue)
                }
            }
        }
        val alerted = if (now.isNotEmpty()) show(now, emptySet()) else emptySet()
        if (held.isEmpty()) return
        val batch = Batch(held, entries, alerted)
        synchronized(lock) {
            for (e in entries) {
                e.batch = batch
                batch.waiting += e
                byKey.getOrPut(e.key) { HashSet() } += e
            }
            batches += batch
            open += batch
            pending.value = open.size
        }
        batch.timer = scope.launch {
            delay(hold)
            release(batch)
        }
        // An answer that came in while this batch was being decided found nothing waiting for it.
        recheck(entries)
    }

    /** Waits until no notification waits for Jev any more, at most [hold] after the last batch came in. */
    suspend fun settle() {
        pending.first { it == 0 }
    }

    /** Waiting emails Jev may no longer have to answer for; a batch goes once none of it waits. */
    private fun recheck(entries: List<Entry>) {
        if (entries.isEmpty()) return
        val cats = synchronized(lock) { attached } ?: return
        val ctx = cats.noticeContext()
        val decided = entries.filter { cats.notice(it.m, ctx).what != MailNotice.WAIT }
        if (decided.isEmpty()) return
        val done = synchronized(lock) {
            for (e in decided) drop(e)
            decided.map { it.batch }.distinct().filter { it.waiting.isEmpty() && it in batches }
        }
        for (batch in done) release(batch, ctx)
    }

    /** Under [lock]. */
    private fun drop(entry: Entry) {
        entry.batch.waiting -= entry
        val same = byKey[entry.key] ?: return
        if (same.remove(entry) && same.isEmpty()) byKey.remove(entry.key)
    }

    /**
     * The rest of a batch, by the category each email has now, without what was read or moved meanwhile ([current]); the
     * global setting and the screen are asked again when it shows.
     */
    private fun release(batch: Batch, given: NoticeContext? = null) {
        synchronized(lock) {
            if (!batches.remove(batch)) return
            batch.entries.forEach(::drop)
        }
        val shows = try {
            // From the timer this cancels its own coroutine, which has nothing left to suspend for.
            batch.timer?.cancel()
            val cats = synchronized(lock) { attached }
            val ctx = given ?: cats?.noticeContext()
            if (cats == null || ctx == null) batch.held else batch.held.filter { cats.notice(it, ctx, jev = false).what == MailNotice.SHOW }
        } catch (e: Exception) {
            finish(batch)
            throw e
        }
        val job = scope.launch {
            val still = if (shows.isEmpty()) shows else current(shows)
            if (still.isNotEmpty()) show(still, batch.alerted)
        }
        // Also when the job is cancelled before it starts, or the scope has ended: the batch is done either way.
        job.invokeOnCompletion { finish(batch) }
        synchronized(lock) { if (batch in open) batch.showing = job else job.cancel() }
    }

    /** A batch is done: shown, cancelled or closed. Only the first time counts. */
    private fun finish(batch: Batch) {
        synchronized(lock) { if (open.remove(batch)) pending.value = open.size }
    }

    fun close() {
        val cats = synchronized(lock) {
            // A copy: cancelling a job that hasn't started finishes it here and now (finish), which changes open.
            for (b in open.toList()) {
                b.timer?.cancel()
                b.showing?.cancel()
            }
            batches.clear()
            open.clear()
            byKey.clear()
            pending.value = 0
            attached.also { attached = null }
        }
        cats?.removeNoticeListener(listener)
    }

    companion object {
        /** How long a notification waits for Jev; after that, the category the email has then decides. */
        const val HOLD = 20_000L
    }
}
