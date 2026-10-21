package nl.bvdm.rukoo.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp

/**
 * Every color token of the desktop app (styles.css :root and :root.light) and of the agent panel (agent.css
 * under .bui), under the same names. The panel's Beautiful UI names are aliases of the app tokens, as in
 * agent.css, so both vocabularies stay usable when porting a component.
 *
 * Color is a condiment: dots, pills and one primary action. A selected row is grey ([sel]), never blue, and
 * the primary button is ink ([primary] on [onPrimary]), not accent.
 */
@Immutable
data class RukooColors(
    val isDark: Boolean,
    // Surfaces, from the window canvas up.
    val bg: Color,
    val panel: Color,
    val panel2: Color,
    val raised: Color,
    // Edges and fills.
    val border: Color,
    val borderStrong: Color,
    val lineSoft: Color,
    val hover: Color,
    val active: Color,
    val sel: Color,
    val selStrong: Color,
    val chip: Color,
    // The ink ramp: quieter text moves down it, never to a thinner weight.
    val text: Color,
    val text2: Color,
    val text3: Color,
    // Accent marks unread mail, links, focus and "on" controls.
    val accent: Color,
    val accentSoft: Color,
    val link: Color,
    // The one filled button per surface.
    val primary: Color,
    val onPrimary: Color,
    // App status (chrome): sync dot, connected, destructive.
    val danger: Color,
    val star: Color,
    val ok: Color,
    val warn: Color,
    val focus: Color,
    // Panel status (Beautiful UI): done, busy, failed, each with a tint for pill backgrounds.
    val green: Color,
    val greenTint: Color,
    val orange: Color,
    val orangeTint: Color,
    val red: Color,
    val redTint: Color,
    val skill: Color,
    // A signature is drawn on light paper and inverted in dark mode, like the email (styles.css --signature-*).
    val signatureInk: Color,
    val signatureLink: Color,
    val invertSignature: Boolean,
) {
    // Beautiful UI names (agent.css:10-23).
    val page: Color get() = panel
    val canvas: Color get() = panel
    val surface: Color get() = raised
    val inset: Color get() = panel2
    val hover2: Color get() = active
    val ink: Color get() = text
    val ink2: Color get() = text2
    val ink3: Color get() = text3
    val line: Color get() = border
    val lineStrong: Color get() = borderStrong
    val field: Color get() = chip
    val accentInk: Color get() = link
    val accentTint: Color get() = accentSoft

    // Literal colors outside the token blocks. The toast is dark in both themes on purpose (components.md).
    val toastBackground: Color get() = Color(0xFF22252D)
    val toastText: Color get() = Color(0xFFF2F4F8)
    val toastAction: Color get() = Color(0xFF9CC0FF)
    val toastActionPressed: Color get() = Color(0x14FFFFFF)
    val swipeRead: Color get() = Color(0xFF2F6FE0)
    val swipeDelete: Color get() = Color(0xFFD9474B)
    val onSwipe: Color get() = Color.White
    val scrim: Color get() = Color(0x730A0C12)
    val knob: Color get() = Color.White
    val onAccent: Color get() = Color.White
    val logoBackground: Color get() = Color.White
    val logoRing: Color get() = Color(0x14000000)
    /** Bars that sit on the canvas: the system bars follow it, like the desktop title bar (main.js:46-47). */
    val systemBar: Color get() = bg

    /** Status ring of the danger pill button: red at 28% (agent.css:314). */
    val redRing: Color get() = red.copy(alpha = 0.28f)

    // Generated colors (spec 6 §2.4). Never hand-pick a color for a person or folder.

    /** Avatar and monogram background for a hue from [rukooHue]. */
    fun avatarBackground(hue: Int): Color =
        if (isDark) Color.hsl(hue.toFloat(), 0.38f, 0.27f) else Color.hsl(hue.toFloat(), 0.60f, 0.93f)

    fun avatarText(hue: Int): Color =
        if (isDark) Color.hsl(hue.toFloat(), 0.70f, 0.84f) else Color.hsl(hue.toFloat(), 0.45f, 0.32f)

    /** The 8dp square dot before a custom folder. */
    fun folderDot(hue: Int): Color = Color.hsl(hue.toFloat(), 0.62f, 0.55f)

    /** The lettered folder tile of the icon rail. */
    fun folderTileBackground(hue: Int): Color =
        if (isDark) Color.hsl(hue.toFloat(), 0.30f, 0.26f) else Color.hsl(hue.toFloat(), 0.55f, 0.90f)

    fun folderTileText(hue: Int): Color =
        if (isDark) Color.hsl(hue.toFloat(), 0.70f, 0.82f) else Color.hsl(hue.toFloat(), 0.45f, 0.30f)

    /** The 14dp badge of a source chip. */
    fun sourceBadgeBackground(hue: Int): Color =
        if (isDark) Color.hsl(hue.toFloat(), 0.38f, 0.30f) else Color.hsl(hue.toFloat(), 0.55f, 0.90f)

    fun sourceBadgeText(hue: Int): Color =
        if (isDark) Color.hsl(hue.toFloat(), 0.70f, 0.86f) else Color.hsl(hue.toFloat(), 0.45f, 0.32f)

    /** Account avatar in the switcher: color-mix(acc 24%, panel) on color-mix(acc 80%, text). */
    fun accountBackground(account: Color): Color = lerp(panel, account, 0.24f)

    fun accountText(account: Color): Color = lerp(text, account, 0.80f)

    companion object {
        val Dark = RukooColors(
            isDark = true,
            bg = Color(0xFF141519),
            panel = Color(0xFF1B1C21),
            panel2 = Color(0xFF212228),
            raised = Color(0xFF25262D),
            border = Color(0xFF2A2C33),
            borderStrong = Color(0xFF3A3D47),
            lineSoft = Color(0x992A2C33),
            hover = Color(0xFF23252C),
            active = Color(0xFF2C2F38),
            sel = Color(0xFF2C2F38),
            selStrong = Color(0xFF353946),
            chip = Color(0xFF2A2C34),
            text = Color(0xFFECEDF1),
            text2 = Color(0xFFA7ADBA),
            text3 = Color(0xFF7A808E),
            accent = Color(0xFF7AA5F5),
            accentSoft = Color(0x267AA5F5),
            link = Color(0xFF8AB0FF),
            primary = Color(0xFFE9ECF5),
            onPrimary = Color(0xFF15171C),
            danger = Color(0xFFFF6B6B),
            star = Color(0xFFFFC23D),
            ok = Color(0xFF4CCF8B),
            warn = Color(0xFFF5B84C),
            focus = Color(0xFF7AA5F5),
            green = Color(0xFF3CBB72),
            greenTint = Color(0x243CBB72),
            orange = Color(0xFFF68F3C),
            orangeTint = Color(0x24F68F3C),
            red = Color(0xFFEE5C61),
            redTint = Color(0x24EE5C61),
            skill = Color(0xFFB261BE),
            signatureInk = Color(0xFF565C69),
            signatureLink = Color(0xFF2F63C8),
            invertSignature = true,
        )

        val Light = RukooColors(
            isDark = false,
            bg = Color(0xFFF3F4F6),
            panel = Color(0xFFFFFFFF),
            panel2 = Color(0xFFF8F9FB),
            raised = Color(0xFFFFFFFF),
            border = Color(0xFFE6E8EC),
            borderStrong = Color(0xFFD2D6DE),
            lineSoft = Color(0x99E6E8EC),
            hover = Color(0xFFF2F3F6),
            active = Color(0xFFEBEDF1),
            sel = Color(0xFFEBEDF1),
            selStrong = Color(0xFFE1E4EA),
            chip = Color(0xFFEFF1F4),
            text = Color(0xFF16181D),
            text2 = Color(0xFF565C69),
            text3 = Color(0xFF868B98),
            accent = Color(0xFF2F66D6),
            accentSoft = Color(0x1A2F66D6),
            link = Color(0xFF2F63C8),
            primary = Color(0xFF1C2340),
            onPrimary = Color(0xFFFFFFFF),
            danger = Color(0xFFD23B3B),
            star = Color(0xFFE8A200),
            ok = Color(0xFF1F9D5C),
            warn = Color(0xFFC27C00),
            focus = Color(0xFF2F66D6),
            green = Color(0xFF199A4D),
            greenTint = Color(0xFFE8F5ED),
            orange = Color(0xFFEF720D),
            orangeTint = Color(0xFFFDF1E5),
            red = Color(0xFFE3474C),
            redTint = Color(0xFFFCECEC),
            skill = Color(0xFFB261BE),
            signatureInk = Color(0xFF565C69),
            signatureLink = Color(0xFF2F63C8),
            invertSignature = false,
        )
    }
}

/**
 * Account colors in the order new accounts get them (engine.js:18), with the key of their name in Settings
 * (settings.colors.*).
 */
object AccountColors {
    val all: List<Pair<String, Color>> = listOf(
        "turquoise" to Color(0xFF2FD6C0),
        "blue" to Color(0xFF4A7DFF),
        "orange" to Color(0xFFFF8A3D),
        "purple" to Color(0xFFC56CF0),
        "yellow" to Color(0xFFF5C542),
        "red" to Color(0xFFFF5D73),
        "lightBlue" to Color(0xFF5EC2FF),
    )

    /** The color a new account gets: `COLORS[accounts.length % COLORS.length]`. */
    fun forIndex(existingAccounts: Int): Color = all[existingAccounts.mod(all.size)].second

    /** Parses the `#rrggbb` an account stores; falls back to the first color. */
    fun parse(hex: String?): Color {
        val digits = hex?.removePrefix("#")?.takeIf { it.length == 6 } ?: return all[0].second
        return digits.toLongOrNull(16)?.let { Color(0xFF000000 or it) } ?: all[0].second
    }
}

/** File-type tiles in attachment cards (styles.css:1902-1936). White 9.5px/750 text sits on them. */
object FileTileColors {
    val default = Color(0xFF6B7385)
    val pdf = Color(0xFFD9474B)
    val doc = Color(0xFF2F6FE0)
    val sheet = Color(0xFF1F9D5C)
    val slides = Color(0xFFE07B2F)
    val image = Color(0xFF8A5CD6)
    val archive = Color(0xFF8D7A52)
    val calendar = Color(0xFF2A8FA8)
    val mail = Color(0xFF2A8FA8)
}
