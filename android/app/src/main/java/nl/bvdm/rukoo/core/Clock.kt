package nl.bvdm.rukoo.core

/** Milliseconds since the epoch. Injected so tests and the demo data can pin the time. */
fun interface Clock {
    fun now(): Long

    companion object {
        val System: Clock = Clock { java.lang.System.currentTimeMillis() }
    }
}
