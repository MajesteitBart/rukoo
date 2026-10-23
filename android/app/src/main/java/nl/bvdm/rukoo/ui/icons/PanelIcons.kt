// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine.
package nl.bvdm.rukoo.ui.icons

import androidx.compose.ui.graphics.vector.ImageVector

/**
 * The agent panel's icons, ported from `ICONS` in `src/renderer/agent/bui.js` (Beautiful UI and Lucide
 * paths, MIT) with each icon's own stroke width. A width of 0 means a filled shape. Unknown names fall back
 * to the wrench, as `icon()` does; the spinner is the `Spinner` composable.
 */
object PanelIcons {
    private fun spec(width: Float, block: IconSpecBuilder.() -> Unit) = IconSpec(width, IconSpecBuilder().apply(block).parts)

    private val set = IconSet(
        mapOf(
            "plus" to spec(2f) { path("M12 5v14M5 12h14") },
            "clock" to spec(2f) {
                circle(12f, 12f, 9f)
                path("M12 7v5l3 2")
            },
            "more" to spec(2f) {
                circle(5f, 12f, 1.8f, fill = true, stroke = false)
                circle(12f, 12f, 1.8f, fill = true, stroke = false)
                circle(19f, 12f, 1.8f, fill = true, stroke = false)
            },
            "send" to spec(2.4f) { path("M12 19V5M5 12l7-7 7 7") },
            "stop" to spec(0f) { rect(4.5f, 4.5f, 15f, 15f, 3f, fill = true, stroke = false) },
            "check" to spec(2.5f) { path("M20 6L9 17l-5-5") },
            "x" to spec(2.2f) { path("M18 6L6 18M6 6l12 12") },
            "chevron" to spec(2.2f) { path("M6 9l6 6 6-6") },
            "chevron-up" to spec(2.2f) { path("M18 15l-6-6-6 6") },
            "chevron-right" to spec(2.2f) { path("M9 6l6 6-6 6") },
            "file" to spec(1.8f) {
                path("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z")
                path("M14 2v6h6")
            },
            "file-text" to spec(1.8f) {
                path("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z")
                path("M14 2v6h6M8 13h8M8 17h6")
            },
            "image" to spec(1.8f) {
                rect(3f, 3f, 18f, 18f, 2.5f)
                circle(9f, 9f, 2f)
                path("m21 15-4.6-4.6a1.5 1.5 0 0 0-2.1 0L5 21")
            },
            "clip" to spec(1.8f) { path("m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48") },
            "globe" to spec(1.8f) {
                circle(12f, 12f, 10f)
                path("M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z")
            },
            "layers" to spec(1.8f) {
                path("M12 2 2 7l10 5 10-5-10-5z")
                path("M2 17l10 5 10-5M2 12l10 5 10-5")
            },
            "chart" to spec(1.8f) { path("M4 20V10M10 20V4M16 20v-7M22 20H2") },
            "mic" to spec(2f) {
                path("M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z")
                path("M19 10v2a7 7 0 0 1-14 0v-2M12 19v3")
            },
            "sparkle" to spec(0f) { path("M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z", fill = true, stroke = false) },
            "search" to spec(2f) {
                circle(11f, 11f, 7f)
                path("M21 21l-4.3-4.3")
            },
            "mail" to spec(1.8f) {
                rect(3f, 5f, 18f, 14f, 2.5f)
                path("m3.5 7.5 8.5 6 8.5-6")
            },
            "list" to spec(2.2f) { path("M4 6h16M4 12h16M4 18h10") },
            "list-check" to spec(2f) { path("m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8") },
            "link" to spec(1.8f) {
                path("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71")
                path("M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71")
            },
            "arrow-right" to spec(2f) { path("M5 12h14M12 5l7 7-7 7") },
            "arrow-out" to spec(2.5f) { path("M7 17L17 7M7 7h10v10") },
            "undo" to spec(1.8f) {
                path("M9 14 4 9l5-5")
                path("M4 9h10a6 6 0 0 1 0 12h-3")
            },
            "pen" to spec(2f) { path("M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z") },
            "terminal" to spec(2f) { path("M4 17l6-5-6-5M12 19h8") },
            "retry" to spec(2f) { path("M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6") },
            "copy" to spec(1.8f) {
                rect(9f, 9f, 12f, 12f, 2.5f)
                path("M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1")
            },
            "shield" to spec(1.8f) {
                path("M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z")
                path("m9 12 2 2 4-4")
            },
            "wrench" to spec(1.8f) { path("M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z") },
            "person" to spec(1.8f) {
                circle(12f, 8f, 4f)
                path("M4 21a8 8 0 0 1 16 0")
            },
            "calendar" to spec(1.8f) {
                rect(3f, 5f, 18f, 16f, 2.5f)
                path("M3 10h18M8 3v4M16 3v4")
            },
            "info" to spec(2f) {
                circle(12f, 12f, 9f)
                path("M12 11v5M12 8v.2")
            },
            "minus" to spec(2.5f) { path("M5 12h14") },
            "bolt" to spec(1.8f) { path("M13 2 4.5 13.5H12L11 22l8.5-11.5H12z") },
            "skill" to spec(1.85f) {
                path("M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z")
                path("m3.3 7 8.7 5 8.7-5")
                path("M12 22V12")
            },
            "sliders" to spec(1.8f) {
                path("M4 7h10M18 7h2M4 17h4M12 17h8")
                circle(16f, 7f, 2f)
                circle(10f, 17f, 2f)
            },
        ),
        fallback = "wrench",
    )

    /** Every icon name, as in bui.js. */
    val names: Set<String> get() = set.names

    fun has(name: String): Boolean = set.has(name)

    /** The icon called [name] in bui.js (the wrench when unknown), optionally at another stroke width. */
    fun named(name: String, strokeWidth: Float? = null): ImageVector = set.get(name, strokeWidth)

    val Plus: ImageVector get() = named("plus")
    val Clock: ImageVector get() = named("clock")
    val More: ImageVector get() = named("more")
    val Send: ImageVector get() = named("send")
    val Stop: ImageVector get() = named("stop")
    val Check: ImageVector get() = named("check")
    val X: ImageVector get() = named("x")
    val Chevron: ImageVector get() = named("chevron")
    val ChevronUp: ImageVector get() = named("chevron-up")
    val ChevronRight: ImageVector get() = named("chevron-right")
    val File: ImageVector get() = named("file")
    val FileText: ImageVector get() = named("file-text")
    val Image: ImageVector get() = named("image")
    val Clip: ImageVector get() = named("clip")
    val Globe: ImageVector get() = named("globe")
    val Layers: ImageVector get() = named("layers")
    val Chart: ImageVector get() = named("chart")
    val Mic: ImageVector get() = named("mic")
    val Sparkle: ImageVector get() = named("sparkle")
    val Search: ImageVector get() = named("search")
    val Mail: ImageVector get() = named("mail")
    val List: ImageVector get() = named("list")
    val ListCheck: ImageVector get() = named("list-check")
    val Link: ImageVector get() = named("link")
    val ArrowRight: ImageVector get() = named("arrow-right")
    val ArrowOut: ImageVector get() = named("arrow-out")
    val Undo: ImageVector get() = named("undo")
    val Pen: ImageVector get() = named("pen")
    val Terminal: ImageVector get() = named("terminal")
    val Retry: ImageVector get() = named("retry")
    val Copy: ImageVector get() = named("copy")
    val Shield: ImageVector get() = named("shield")
    val Wrench: ImageVector get() = named("wrench")
    val Person: ImageVector get() = named("person")
    val Calendar: ImageVector get() = named("calendar")
    val Info: ImageVector get() = named("info")
    val Minus: ImageVector get() = named("minus")
    val Bolt: ImageVector get() = named("bolt")
    val Skill: ImageVector get() = named("skill")
    val Sliders: ImageVector get() = named("sliders")
}
