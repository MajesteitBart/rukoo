package nl.bvdm.rukoo.core

import android.util.Log

/**
 * Logcat with one tag prefix. Messages are developer text: never pass a password, token, key,
 * email body or anything else from an account. Log the kind of failure, not the request.
 */
object AppLog {
    private const val PREFIX = "Rukoo."

    fun d(tag: String, message: String) {
        Log.d(PREFIX + tag, message)
    }

    fun i(tag: String, message: String) {
        Log.i(PREFIX + tag, message)
    }

    fun w(tag: String, message: String, error: Throwable? = null) {
        if (error == null) Log.w(PREFIX + tag, message) else Log.w(PREFIX + tag, "$message: ${error.javaClass.simpleName}")
    }

    fun e(tag: String, message: String, error: Throwable? = null) {
        // Only the exception type: messages of network and mail errors can quote the server's answer or a URL with a token.
        if (error == null) Log.e(PREFIX + tag, message) else Log.e(PREFIX + tag, "$message: ${error.javaClass.simpleName}")
    }
}
