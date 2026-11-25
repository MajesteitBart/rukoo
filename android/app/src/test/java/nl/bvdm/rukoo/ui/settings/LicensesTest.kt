package nl.bvdm.rukoo.ui.settings

import java.io.File
import nl.bvdm.rukoo.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The About page's licenses: the embedded FCM distributor under the LGPL 2.1, with its text in the app. */
class LicensesTest {
    @Test
    fun `the embedded FCM distributor is listed as LGPL 2_1, with the license text bundled and its source linked`() {
        val fcm = LICENSES.filter { it.name.startsWith("UnifiedPush embedded FCM distributor") }
        if (!BuildConfig.EMBEDDED_FCM) {
            assertTrue("a build without it doesn't list it", fcm.isEmpty())
            return
        }
        val entry = fcm.single()
        assertEquals("LGPL 2.1", entry.license)
        assertEquals("https://codeberg.org/UnifiedPush/android-embedded_fcm_distributor/src/tag/3.1.0", entry.url)
        val text = File("src/main/assets/${entry.text}")
        assertTrue("the text is in the app's assets", text.isFile)
        assertTrue(text.readText().contains("GNU LESSER GENERAL PUBLIC LICENSE") && text.readText().contains("Version 2.1, February 1999"))
    }

    @Test
    fun `a license text shows as paragraphs the phone wraps`() {
        assertEquals("One two\n\nthree four", reflow("  One\n  two\n\n three\nfour\n"))
    }

    @Test
    fun `every other library links to its page`() {
        for (l in LICENSES.filter { it.text == null }) assertTrue(l.name, l.url.startsWith("https://"))
    }
}
