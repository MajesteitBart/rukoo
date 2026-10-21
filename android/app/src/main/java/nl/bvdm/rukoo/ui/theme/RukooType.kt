package nl.bvdm.rukoo.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import nl.bvdm.rukoo.R

/** The weights Rukoo uses (SKILL.md "Type"): 400 text, 500 emphasis, 600 panel headings, 650 titles, 700 unread. */
object RukooWeights {
    val Normal = FontWeight(400)
    val Medium = FontWeight(500)
    val Semibold = FontWeight(600)
    val Title = FontWeight(650)
    val Bold = FontWeight(700)
    internal val all = listOf(400, 500, 600, 650, 700)
}

@OptIn(ExperimentalTextApi::class)
private fun inter(opticalSize: Float) = FontFamily(
    RukooWeights.all.map { w ->
        Font(
            R.font.inter_variable,
            weight = FontWeight(w),
            variationSettings = FontVariation.Settings(
                FontVariation.weight(w),
                FontVariation.Setting("opsz", opticalSize),
            ),
        )
    },
)

/**
 * Inter with its text optical size. Browsers pick `opsz` from the font size; Android doesn't, so text gets
 * the axis minimum (14) and titles use [InterDisplay].
 */
val Inter: FontFamily = inter(14f)

/** Inter's display cut, for titles of 18px and up (list title, reader subject, page and setup titles). */
val InterDisplay: FontFamily = inter(20f)

/** Code, commands and file names in tool details. The desktop ships JetBrains Mono; this uses the system mono. */
val RukooMono: FontFamily = FontFamily.Monospace

internal const val FeaturesApp = "cv11"
internal const val FeaturesPanel = "cv11, ss01"

// Text sits centred in its line box, like CSS, so rows don't shift when a style's line height changes.
private val CenteredLines = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)

/**
 * A desktop size in px becomes sp one step up (spec 6 §2.6): 11 to 14.5 gain 1sp, so the 13px body lands on
 * 14sp; titles gain less (16→17, 18→20, 20→21, 26→27). Sizes stay in sp so the user's font scale applies.
 */
private fun style(sp: Float, family: FontFamily = Inter, tracking: Float = 0f) = TextStyle(
    fontFamily = family,
    fontWeight = RukooWeights.Normal,
    fontSize = sp.sp,
    lineHeight = 1.4.em,
    letterSpacing = tracking.em,
    fontFeatureSettings = FeaturesApp,
    lineHeightStyle = CenteredLines,
)

/**
 * The type scale, named by the desktop size in px so a CSS value ports one to one: "12.5px/500 text-3"
 * becomes `Rk.type.text12_5.medium` in `Rk.colors.text3`. Every style is weight 400 with line height 1.4
 * and Inter's `cv11`; derive the rest with the extensions below ([medium], [panel], [tabular], ...).
 */
@Immutable
class RukooType internal constructor() {
    val text11 = style(12f)
    val text11_5 = style(12.5f)
    val text12 = style(13f)
    val text12_5 = style(13.5f)
    val text13 = style(14f)
    val text13_5 = style(14.5f)
    val text14 = style(15f)
    val text14_5 = style(15.5f)
    val text16 = style(17f)
    val text18 = style(20f, InterDisplay, -0.015f)
    val text20 = style(21f, InterDisplay, -0.018f)
    val text26 = style(27f, InterDisplay, -0.02f)

    // Roles, from spec 6 §2.5.
    /** Body text, menus, buttons and chat text. */
    val body = text13

    /** List title ("Inbox") and Settings page titles: 18/650. */
    val pageTitle = text18.title

    /** Reader subject: 20/650, line height 1.3. */
    val readerSubject = text20.title.lineHeight(1.3f)

    /** Setup title: 26/650. */
    val setupTitle = text26.title

    /** Dialog title: 16/650. */
    val dialogTitle = text16.title

    /** Timestamps, counts and captions: 11.5, tabular. */
    val meta = text11_5.tabular

    /** The email body and the composer editor: 14.5, line height 1.6. */
    val emailBody = text14_5.lineHeight(1.6f)

    /** Agent panel base: 13, line height 1.5, tracking -0.01em, `cv11, ss01`. */
    val panelBody = text13.panel

    /** Agent prose (answers, thinking traces): panel text at line height 1.625. */
    val panelProse = text13.panel.lineHeight(1.625f)

    /** Commands and code in tool details: mono 11.5, line height 1.55. */
    val mono = text11_5.copy(fontFamily = RukooMono, lineHeight = 1.55.em, fontFeatureSettings = null, letterSpacing = 0.em)

    companion object {
        val Default = RukooType()
    }
}

val TextStyle.medium: TextStyle get() = copy(fontWeight = RukooWeights.Medium)
val TextStyle.semibold: TextStyle get() = copy(fontWeight = RukooWeights.Semibold)
val TextStyle.title: TextStyle get() = copy(fontWeight = RukooWeights.Title)
val TextStyle.bold: TextStyle get() = copy(fontWeight = RukooWeights.Bold)

fun TextStyle.weight(weight: Int): TextStyle = copy(fontWeight = FontWeight(weight))

fun TextStyle.lineHeight(ratio: Float): TextStyle = copy(lineHeight = ratio.em)

/** Tabular numbers for times, counts, timers and sizes (styles.css:153-158). */
val TextStyle.tabular: TextStyle get() = copy(fontFeatureSettings = withFeature(fontFeatureSettings, "tnum"))

/** The agent panel's text: line height 1.5, tracking -0.01em and Inter's `ss01` (agent.css:56-59). */
val TextStyle.panel: TextStyle
    get() = copy(
        lineHeight = 1.5.em,
        letterSpacing = (-0.01).em,
        fontFeatureSettings = withFeature(fontFeatureSettings ?: FeaturesApp, "ss01"),
    )

internal fun withFeature(current: String?, feature: String): String {
    val parts = current?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }.orEmpty()
    return if (feature in parts) parts.joinToString(", ") else (parts + feature).joinToString(", ")
}
