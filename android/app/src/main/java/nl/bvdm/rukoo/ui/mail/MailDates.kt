package nl.bvdm.rukoo.ui.mail

import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * Desktop's date and size helpers (ui.js:22-93), in the interface language rather than the phone's, and
 * always on a 24-hour clock (`hourCycle: 'h23'`). [today] and [yesterday] are the translated words.
 */
class MailDates(
    val locale: Locale,
    private val zone: ZoneId = ZoneId.systemDefault(),
    private val today: String = "Today",
    private val yesterday: String = "Yesterday",
) {
    private val hhmm = DateTimeFormatter.ofPattern("HH:mm", locale)
    private val dayMonth = DateTimeFormatter.ofPattern("d MMM", locale)
    private val dayMonthLong = DateTimeFormatter.ofPattern("d MMMM", locale)
    private val monthYear = DateTimeFormatter.ofPattern("LLLL yyyy", locale)
    private val weekday = DateTimeFormatter.ofPattern("EEEE", locale)
    private val readerLong = DateTimeFormatter.ofPattern("EEE d MMM yyyy", locale)
    private val long = DateTimeFormatter.ofPattern("d MMMM yyyy", locale)
    // Intl's {day: '2-digit', month: '2-digit', year: 'numeric'}: "08-10-2026" in Dutch, "08/10/2026" in British English.
    private val numeric = DateTimeFormatter.ofPattern(if (locale.language == "nl") "dd-MM-yyyy" else "dd/MM/yyyy", locale)

    private fun at(ts: Long): ZonedDateTime = Instant.ofEpochMilli(ts).atZone(zone)

    private fun days(ts: Long, now: Long): Long = ChronoUnit.DAYS.between(at(ts).toLocalDate(), at(now).toLocalDate())

    private fun capitalized(text: String) = text.replaceFirstChar { if (it.isLowerCase()) it.titlecase(locale) else it.toString() }

    fun time(ts: Long): String = hhmm.format(at(ts))

    /** List time: "14:45" today, "8 Oct" this year, "08/10/2025" before that. */
    fun listTime(ts: Long, now: Long): String {
        val d = at(ts)
        if (d.toLocalDate() == at(now).toLocalDate()) return hhmm.format(d)
        if (d.year == at(now).year) return dayMonth.format(d)
        return numeric.format(d)
    }

    /** Day heads: Today, Yesterday, the weekday within a week, "8 October" this year, "October 2025" before. */
    fun groupLabel(ts: Long, now: Long): String {
        val diff = days(ts, now)
        if (diff <= 0) return today
        if (diff == 1L) return yesterday
        val d = at(ts)
        if (diff < 7) return capitalized(weekday.format(d))
        if (d.year == at(now).year) return dayMonthLong.format(d)
        return capitalized(monthYear.format(d))
    }

    /** The reader's date: "Today 14:45", "Yesterday 09:12" or "Tue 6 Oct 2026, 14:45". */
    fun readerDate(ts: Long, now: Long): String {
        val diff = days(ts, now)
        if (diff == 0L) return "$today ${time(ts)}"
        if (diff == 1L) return "$yesterday ${time(ts)}"
        return "${readerLong.format(at(ts))}, ${time(ts)}"
    }

    /** The details box: "8 October 2026  14:45", two spaces as on desktop. */
    fun longDate(ts: Long): String = "${long.format(at(ts))}  ${time(ts)}"

    fun numericDate(ts: Long): String = numeric.format(at(ts))

    /** The quote header's date: "08/10/2026 14:45 (GMT+02:00)" with the offset of that moment. */
    fun quoteDate(ts: Long): String {
        val d = at(ts)
        val seconds = d.offset.totalSeconds
        val sign = if (seconds >= 0) "+" else "-"
        val abs = kotlin.math.abs(seconds) / 60
        return "${numericDate(ts)} ${time(ts)} (GMT$sign${"%02d".format(abs / 60)}:${"%02d".format(abs % 60)})"
    }

    /** Whether two moments fall on the same calendar day here. */
    fun sameDay(a: Long, b: Long): Boolean = at(a).toLocalDate() == at(b).toLocalDate()

    fun localDate(ts: Long): LocalDate = at(ts).toLocalDate()

    companion object {
        /** "192 B", "12 kB", "1.4 MB" (ui.js fileSize), with the locale's decimal mark. */
        fun fileSize(bytes: Long, locale: Locale): String {
            if (bytes < 0) return ""
            if (bytes < 1024) return "$bytes B"
            if (bytes < 1024 * 1024) {
                val f = NumberFormat.getNumberInstance(locale).apply { maximumFractionDigits = 0 }
                return "${f.format(bytes / 1024.0)} kB"
            }
            val f = NumberFormat.getNumberInstance(locale).apply {
                minimumFractionDigits = 1
                maximumFractionDigits = 1
            }
            return "${f.format(bytes / 1024.0 / 1024.0)} MB"
        }
    }
}
