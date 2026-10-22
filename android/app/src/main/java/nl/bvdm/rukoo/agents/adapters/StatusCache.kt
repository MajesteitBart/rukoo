package nl.bvdm.rukoo.agents.adapters

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import nl.bvdm.rukoo.core.Clock

/**
 * The status check cache of hermes.js and openclaw.js: an answer is kept [ttlMs] per settings [key], callers
 * that ask while a check runs share it, and only the newest check may fill the cache, so a check that started
 * before a settings change can't put its stale answer back. `force` (the Test button) skips the cache.
 * Checks run in [scope], so a caller that gives up doesn't cancel the check for the others.
 */
internal class StatusCache<T>(private val scope: CoroutineScope, private val clock: Clock, private val ttlMs: Long = 30_000) {
    private class Entry<T>(val key: String, val at: Long, val value: T)

    private val lock = Any()
    private var cache: Entry<T>? = null
    private var checking: Pair<String, Deferred<T>>? = null
    private var checks = 0
    private var cachedCheck = 0

    suspend fun get(key: String, force: Boolean, check: suspend () -> T): T {
        val running: Deferred<T> = synchronized(lock) {
            val c = cache
            if (!force && c != null && c.key == key && clock.now() - c.at < ttlMs) return c.value
            val shared = checking
            if (!force && shared != null && shared.first == key) {
                shared.second
            } else {
                val n = ++checks
                lateinit var self: Deferred<T>
                // Lazy, so the body can't run (on an immediate dispatcher) before `self` is set; await starts it.
                self = scope.async(start = CoroutineStart.LAZY) {
                    try {
                        val value = check()
                        synchronized(lock) {
                            if (n > cachedCheck) {
                                cachedCheck = n
                                cache = Entry(key, clock.now(), value)
                            }
                        }
                        value
                    } finally {
                        // Also after a failure, so the next caller asks again instead of sharing it.
                        synchronized(lock) { if (checking?.second === self) checking = null }
                    }
                }
                checking = key to self
                self
            }
        }
        return running.await()
    }

    /** Settings changed or a turn reached the server: the next status asks again. */
    fun invalidate() = synchronized(lock) {
        cache = null
        // A check that started before this answers about the old state: it must not fill the cache again.
        cachedCheck = checks
    }
}
