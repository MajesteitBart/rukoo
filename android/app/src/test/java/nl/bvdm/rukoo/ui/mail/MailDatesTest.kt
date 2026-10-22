package nl.bvdm.rukoo.ui.mail

import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

class MailDatesTest {
    private val zone = ZoneId.of("Europe/Amsterdam")
    private val en = MailDates(Locale.forLanguageTag("en-GB"), zone, "Today", "Yesterday")
    private val nl = MailDates(Locale.forLanguageTag("nl-NL"), zone, "Vandaag", "Gisteren")

    private fun at(y: Int, mo: Int, d: Int, h: Int = 14, mi: Int = 45) = LocalDateTime.of(y, mo, d, h, mi).atZone(zone).toInstant().toEpochMilli()

    // Thursday 22 October 2026, 16:00.
    private val now = at(2026, 10, 22, 16, 0)

    @Test
    fun listTimeIsTheTimeTodayTheDayThisYearAndTheDateBefore() {
        assertEquals("14:45", en.listTime(at(2026, 10, 22), now))
        assertEquals("8 Oct", en.listTime(at(2026, 10, 8), now))
        assertEquals("05/10/2025", en.listTime(at(2025, 10, 5), now))
        assertEquals("05-10-2025", nl.listTime(at(2025, 10, 5), now))
        assertEquals("09:05", nl.listTime(at(2026, 10, 22, 9, 5), now))
    }

    @Test
    fun groupLabelsFollowDesktop() {
        assertEquals("Today", en.groupLabel(at(2026, 10, 22, 1, 0), now))
        assertEquals("Yesterday", en.groupLabel(at(2026, 10, 21), now))
        assertEquals("Monday", en.groupLabel(at(2026, 10, 19), now))
        assertEquals("Maandag", nl.groupLabel(at(2026, 10, 19), now))
        assertEquals("8 October", en.groupLabel(at(2026, 10, 8), now))
        assertEquals("8 oktober", nl.groupLabel(at(2026, 10, 8), now))
        assertEquals("October 2025", en.groupLabel(at(2025, 10, 8), now))
        assertEquals("Oktober 2025", nl.groupLabel(at(2025, 10, 8), now))
    }

    @Test
    fun readerAndLongDates() {
        assertEquals("Today 14:45", en.readerDate(at(2026, 10, 22), now))
        assertEquals("Gisteren 09:12", nl.readerDate(at(2026, 10, 21, 9, 12), now))
        assertEquals("Tue 6 Oct 2026, 14:45", en.readerDate(at(2026, 10, 6), now))
        assertEquals("8 October 2026  14:45", en.longDate(at(2026, 10, 8)))
    }

    @Test
    fun quoteDateCarriesTheOffsetOfThatMoment() {
        assertEquals("08/10/2026 14:45 (GMT+02:00)", en.quoteDate(at(2026, 10, 8)))
        assertEquals("08-12-2026 14:45 (GMT+01:00)", nl.quoteDate(at(2026, 12, 8)))
    }

    @Test
    fun fileSizes() {
        assertEquals("192 B", MailDates.fileSize(192, Locale.UK))
        assertEquals("12 kB", MailDates.fileSize(12 * 1024, Locale.UK))
        assertEquals("1.4 MB", MailDates.fileSize((1.4 * 1024 * 1024).toLong(), Locale.UK))
        assertEquals("1,4 MB", MailDates.fileSize((1.4 * 1024 * 1024).toLong(), Locale.forLanguageTag("nl-NL")))
    }
}
