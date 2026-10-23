package nl.bvdm.rukoo.ui.agent

import java.net.URI
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToLong
import nl.bvdm.rukoo.mail.model.Address

/** Small formatting rules of the chat, ported from bui.js and ui.js so they can be tested. */
object ChatFormat {
    private val FENCE = Regex("^\\s*(```|~~~)")
    private val SAFE_LINK = Regex("^(https?:|mailto:)", RegexOption.IGNORE_CASE)
    private val OPEN_LINK = Regex("^(https?://|mailto:|obsidian://)", RegexOption.IGNORE_CASE)
    private val PREVIEW_MARK = Regex("^\\s*(?:[-*+>]|#{1,6}|\\d+[.)])\\s+")
    private val PREVIEW_EMPHASIS = Regex("\\*\\*|__|`")

    /**
     * How many characters show after one 9ms tick of the stream: two, or a 40th of the backlog when a big chunk
     * arrived, so the text catches up quickly (bui.js streamText). A surrogate pair is never split.
     */
    fun revealStep(text: String, count: Int): Int {
        val length = text.length
        if (count >= length) return length
        var next = minOf(length, count + max(2, ceil((length - count) / 40.0).toInt()))
        if (next < length && Character.isHighSurrogate(text[next - 1])) next++
        return next
    }

    /** The last blank line outside a code fence after [from]: everything before it is complete and never redrawn. */
    fun settleCut(text: String, from: Int): Int {
        var cut = from
        var fence = false
        var offset = from
        val lines = text.substring(from).split('\n')
        // The last line can still grow, so it never counts.
        for (k in 0 until lines.size - 1) {
            if (FENCE.containsMatchIn(lines[k])) fence = !fence
            offset += lines[k].length + 1
            if (!fence && lines[k].isBlank()) cut = offset
        }
        return cut
    }

    /** Streaming text: a `**` or backtick that isn't closed yet formats up to the end instead of showing as a stray marker. */
    fun closeOpen(text: String): String {
        var s = text
        for (marker in listOf("**", "`")) {
            val n = s.split(marker).size - 1
            if (n % 2 == 0) continue
            s = if (s.trimEnd().endsWith(marker)) s.trimEnd().dropLast(marker.length) else s + marker
        }
        return s
    }

    /** Links in agent text: only http, https and mailto (bui.js SAFE_LINK); anything else stays plain text. */
    fun safeLink(url: String?): Boolean = url != null && SAFE_LINK.containsMatchIn(url.trim())

    /** Links in plans and sources may also open an Obsidian note (main's openAgentLink). */
    fun openableLink(url: String?): Boolean = url != null && OPEN_LINK.containsMatchIn(url.trim())

    /** Whole seconds of thinking, at least 1 (bui.js thinking). */
    fun seconds(startedAt: Long, endedAt: Long): Long = max(1L, ((endedAt - startedAt) / 1000.0).roundToLong())

    /** The loading timer: "0.0s", or "1m 3.2s" past a minute. */
    fun elapsed(ms: Long): String {
        val t = max(0L, ms) / 1000.0
        return if (t < 60) String.format(Locale.ROOT, "%.1fs", t) else String.format(Locale.ROOT, "%dm %.1fs", (t / 60).toLong(), t % 60)
    }

    /** "example.com" for web links, the scheme ("obsidian") for app links. */
    fun hostOf(url: String): String = try {
        val u = URI(url.trim())
        val scheme = u.scheme?.lowercase().orEmpty()
        if (scheme == "http" || scheme == "https") (u.host ?: url).removePrefix("www.") else scheme.ifEmpty { url }
    } catch (_: Exception) {
        url
    }

    /** Recipients of a draft card: names, else addresses. */
    fun people(list: List<Address>): String = list.mapNotNull { a -> a.name.ifBlank { a.address }.takeIf { it.isNotBlank() } }.joinToString(", ")

    /** A sender for chips: the name, else the address (ui.js person). */
    fun person(a: Address?): String = a?.name?.takeIf { it.isNotBlank() } ?: a?.address.orEmpty()

    /** A chat-list preview starts an answer, which can be Markdown: on one line its list marks and bold are noise. */
    fun plainPreview(text: String): String = PREVIEW_EMPHASIS.replace(PREVIEW_MARK.replaceFirst(text, ""), "")

    /** The chat list's time (ui.js listTime): the time today, "8 Oct" this year, else the date in numbers. 24-hour. */
    fun listTime(ts: Long, now: Long, locale: Locale, zone: ZoneId = ZoneId.systemDefault()): String {
        val day = Instant.ofEpochMilli(ts).atZone(zone)
        val today = Instant.ofEpochMilli(now).atZone(zone)
        return when {
            day.toLocalDate() == today.toLocalDate() -> DateTimeFormatter.ofPattern("HH:mm", locale).format(day)
            day.year == today.year -> DateTimeFormatter.ofPattern("d MMM", locale).format(day).removeSuffix(".")
            else -> DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(locale).format(day)
        }
    }
}
