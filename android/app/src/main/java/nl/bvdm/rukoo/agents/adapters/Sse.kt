package nl.bvdm.rukoo.agents.adapters

// Server-sent events, as Hermes and OpenClaw write them: a port of desktop's src/main/agents/sse.js.
// `id:`/`event:`/`data:` lines, a blank line ends a frame, lines starting with ':' are comments (keepalives).
// Chunks can split anywhere, also inside a UTF-8 character or between \r and \n, so the parser buffers whole
// lines; \r and \n never occur inside a multi-byte UTF-8 character, so lines are cut on bytes and decoded whole.

import java.io.IOException
import java.io.InterruptedIOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import okhttp3.Call
import okhttp3.Response
import okio.Buffer
import okio.BufferedSource
import okio.ByteString.Companion.encodeUtf8

/** One complete frame: its event name (`message` when it had none), its data lines joined by \n, its id. */
internal data class SseFrame(val event: String, val data: String, val id: String? = null)

internal class SseParser(private val onEvent: (SseFrame) -> Unit) {
    private val buffer = Buffer()
    private var event = ""
    private val data = mutableListOf<String>()
    private var id: String? = null

    var lastEventId: String? = null
        private set

    fun push(bytes: ByteArray, count: Int = bytes.size) {
        buffer.write(bytes, 0, count)
        while (true) {
            val at = buffer.indexOfElement(LINE_ENDS)
            if (at < 0) return
            val ch = buffer[at]
            // A trailing \r may be the first half of \r\n: wait for the next chunk before deciding.
            if (ch == CR && at == buffer.size - 1) return
            val text = buffer.readUtf8(at)
            buffer.skip(1)
            if (ch == CR && buffer.size > 0 && buffer[0] == LF) buffer.skip(1)
            line(text)
        }
    }

    fun push(text: String) {
        val bytes = text.toByteArray(Charsets.UTF_8)
        push(bytes, bytes.size)
    }

    /** The stream ended: a frame without its closing blank line is incomplete and dropped, as browsers do. */
    fun end() {
        buffer.clear()
        reset()
    }

    private fun reset() {
        event = ""
        data.clear()
        id = null
    }

    private fun line(text: String) {
        if (text.isEmpty()) return dispatch()
        if (text[0] == ':') return
        val colon = text.indexOf(':')
        val field = if (colon == -1) text else text.substring(0, colon)
        var value = if (colon == -1) "" else text.substring(colon + 1)
        if (value.startsWith(' ')) value = value.substring(1)
        when (field) {
            "event" -> event = value
            "data" -> data.add(value)
            "id" -> if (!value.contains('\u0000')) id = value
        }
    }

    private fun dispatch() {
        if (id != null) lastEventId = id
        if (data.isNotEmpty()) onEvent(SseFrame(event.ifEmpty { "message" }, data.joinToString("\n"), id))
        reset()
    }

    private companion object {
        const val CR = '\r'.code.toByte()
        const val LF = '\n'.code.toByte()
        val LINE_ENDS = "\r\n".encodeUtf8()
    }
}

/** How a stream ended: the server closed it, it stayed silent past the read timeout, or Rukoo cancelled the call. */
internal enum class SseOutcome { END, IDLE, ABORTED }

/**
 * Reads [source] through [parser] until the server closes it. A read timeout (the client's read timeout is the
 * stream's silence limit) is [SseOutcome.IDLE]; a cancelled [call] is [SseOutcome.ABORTED]; other failures throw.
 */
internal fun readSseBlocking(call: Call, source: BufferedSource, parser: SseParser): SseOutcome {
    val chunk = ByteArray(8192)
    try {
        while (true) {
            val n = source.read(chunk)
            if (n == -1) break
            parser.push(chunk, n)
        }
        parser.end()
        return SseOutcome.END
    } catch (e: InterruptedIOException) {
        return if (call.isCanceled()) SseOutcome.ABORTED else SseOutcome.IDLE
    } catch (e: IOException) {
        if (call.isCanceled()) return SseOutcome.ABORTED
        throw e
    }
}

/**
 * Reads the event stream of [response] on the IO dispatcher and hands each frame to [onFrame] in the caller's
 * context, so adapters handle events (and call the turn handle) where the hub runs them, never on a socket thread.
 * Cancelling the caller cancels the call.
 */
internal suspend fun streamSse(call: Call, response: Response, onFrame: (SseFrame) -> Unit): SseOutcome = coroutineScope {
    val frames = Channel<SseFrame>(Channel.UNLIMITED)
    val reader = async(Dispatchers.IO) {
        try {
            response.use { readSseBlocking(call, it.body!!.source(), SseParser { frame -> frames.trySend(frame) }) }
        } finally {
            frames.close()
        }
    }
    try {
        for (frame in frames) onFrame(frame)
    } catch (e: CancellationException) {
        call.cancel()
        throw e
    }
    reader.await()
}
