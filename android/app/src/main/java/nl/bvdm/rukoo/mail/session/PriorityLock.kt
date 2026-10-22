package nl.bvdm.rukoo.mail.session

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred

/**
 * One holder at a time; waiting user work goes before waiting background work, and work already
 * running is never pre-empted. The queue of an IMAP connection on desktop (imap.js `queue.now` before
 * `queue.later`): a flag change goes ahead of the next folder of a sync.
 */
class PriorityLock {
    private val lock = Any()
    private var held = false
    private val now = ArrayDeque<CompletableDeferred<Unit>>()
    private val later = ArrayDeque<CompletableDeferred<Unit>>()

    suspend fun <T> withLock(background: Boolean = false, block: suspend () -> T): T {
        val ticket = synchronized(lock) {
            if (!held) {
                held = true
                null
            } else {
                CompletableDeferred<Unit>().also { (if (background) later else now).addLast(it) }
            }
        }
        if (ticket != null) {
            try {
                ticket.await()
            } catch (e: CancellationException) {
                val stillQueued = synchronized(lock) { now.remove(ticket) || later.remove(ticket) }
                // Granted just as the waiter was cancelled: pass the turn on.
                if (!stillQueued) release()
                throw e
            }
        }
        try {
            return block()
        } finally {
            release()
        }
    }

    private fun release() {
        val next = synchronized(lock) {
            (now.removeFirstOrNull() ?: later.removeFirstOrNull()).also { if (it == null) held = false }
        }
        next?.complete(Unit)
    }
}
