package nl.bvdm.rukoo.ui.icons

import androidx.compose.ui.graphics.vector.ImageVector

/**
 * The app's line icons, ported from `src/renderer/icons.js` with the path data copied verbatim: a 24 grid,
 * 1.6 round strokes, `currentColor` as the tint. Toolbars on desktop draw them at 17-18 with stroke 1.7
 * (`named(name, 1.7f)`). Look icons up by their desktop name with [named]; the properties below are the same
 * icons by name.
 */
object RukooIcons {
    const val STROKE = 1.6f

    private fun spec(block: IconSpecBuilder.() -> Unit) = IconSpec(STROKE, IconSpecBuilder().apply(block).parts)

    private val set = IconSet(
        mapOf(
            "menu" to spec { path("M4 6.5h16M4 12h16M4 17.5h16") },
            "search" to spec {
                circle(10.5f, 10.5f, 6.5f)
                path("M15.5 15.5 20 20")
            },
            "more" to spec {
                circle(12f, 5.5f, 1.3f, fill = true, stroke = false)
                circle(12f, 12f, 1.3f, fill = true, stroke = false)
                circle(12f, 18.5f, 1.3f, fill = true, stroke = false)
            },
            "star" to spec { path("m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z") },
            "starFilled" to spec { path("m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z", fill = true) },
            "clip" to spec { path("M15.5 7.5 8.6 14.4a1.8 1.8 0 0 0 2.5 2.5l7.3-7.3a3.6 3.6 0 0 0-5.1-5.1l-7.4 7.4a5.3 5.3 0 0 0 7.5 7.5l6-6") },
            "compose" to spec {
                rect(3.5f, 3.5f, 17f, 17f, 4f)
                path("m9 15 .6-2.6 5.6-5.6a1.4 1.4 0 0 1 2 2l-5.6 5.6z")
            },
            "expand" to spec { path("M14 4h6v6M20 4l-6.5 6.5M10 20H4v-6M4 20l6.5-6.5") },
            "collapse" to spec { path("M20 4l-6 6M14 5v5h5M4 20l6-6M10 19v-5H5") },
            "up" to spec { path("m5 15 7-7 7 7") },
            "down" to spec { path("m5 9 7 7 7-7") },
            "back" to spec { path("m15 4-8 8 8 8") },
            "close" to spec { path("M5 5l14 14M19 5 5 19") },
            "reply" to spec {
                path("M20 7v4a4 4 0 0 1-4 4H5")
                path("m9 11-4 4 4 4")
            },
            "replyAll" to spec {
                path("M21 7v4a4 4 0 0 1-4 4H8")
                path("m12 11-4 4 4 4")
                path("m8 11-4 4 4 4")
            },
            "forward" to spec { path("M4 12h15M13 6l6 6-6 6") },
            "trash" to spec { path("M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5l1 13.5h9l1-13.5M10 10.5v6M14 10.5v6") },
            "send" to spec {
                path("M20.5 3.5 10 14")
                path("m20.5 3.5-6.5 17-4-6.5-6.5-4z")
            },
            "settings" to spec {
                circle(12f, 12f, 3f)
                path("M12 2.8 14 4l2.3-.3 1.2 2 2.1 1-.1 2.3 1.3 2-1.3 2 .1 2.3-2.1 1-1.2 2L14 20l-2 1.2L10 20l-2.3.3-1.2-2-2.1-1 .1-2.3L3.2 13l1.3-2-.1-2.3 2.1-1 1.2-2L10 4z")
            },
            "inbox" to spec {
                rect(3.5f, 4f, 17f, 16f, 3f)
                path("M3.5 13.5H8l1.2 2.5h5.6l1.2-2.5h4.5")
            },
            "unread" to spec {
                rect(3.5f, 5.5f, 17f, 13f, 2.5f)
                path("m4 7 8 6 8-6")
            },
            "saved" to spec {
                rect(4f, 3.5f, 16f, 17f, 3f)
                path("M12 7.5v7M8.5 11.5 12 15l3.5-3.5")
            },
            "drafts" to spec {
                rect(3.5f, 3.5f, 17f, 17f, 3f)
                path("m8.5 15.5.5-2.5 5.6-5.6a1.4 1.4 0 0 1 2 2L11 15z")
            },
            "sent" to spec {
                rect(3.5f, 5.5f, 13f, 12f, 2.5f)
                path("m4 7 6 4.5L16 7")
                path("M15 16h6M18.5 13.5 21 16l-2.5 2.5")
            },
            "junk" to spec {
                circle(12f, 12f, 8.5f)
                path("M6 6l12 12")
            },
            "archive" to spec {
                rect(3.5f, 4f, 17f, 4.5f, 1.5f)
                path("M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5M10 12.5h4")
            },
            "folder" to spec { path("M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z") },
            "check" to spec { path("m5 12.5 4.5 4.5L19 7.5") },
            "eye" to spec {
                path("M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z")
                circle(12f, 12f, 3f)
            },
            "eyeOff" to spec {
                path("M4 4l16 16M10 6c.6-.1 1.3-.2 2-.2 6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.6M6.6 7.3C4 9 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1")
                path("M9.9 10a3 3 0 0 0 4.1 4.1")
            },
            "undo" to spec {
                path("M9 14 4 9l5-5")
                path("M4 9h10a6 6 0 0 1 0 12h-3")
            },
            "redo" to spec {
                path("m15 14 5-5-5-5")
                path("M20 9H10a6 6 0 0 0 0 12h3")
            },
            "image" to spec {
                rect(3.5f, 4f, 17f, 16f, 3f)
                circle(9f, 9.5f, 1.7f)
                path("m4 17 5-4.5 4 3.5 2.5-2 4.5 3.5")
            },
            "bold" to spec { path("M7 4.5h6a3.5 3.5 0 0 1 0 7H7zM7 11.5h7a4 4 0 0 1 0 8H7z", width = 2.4f) },
            "italic" to spec { path("M10 4.5h8M6 19.5h8M15 4.5l-6 15") },
            "underline" to spec { path("M7 4v7a5 5 0 0 0 10 0V4M5 20.5h14") },
            "textColor" to spec {
                path("M6 4.5h12M12 4.5v11")
                path("M5 20.5h14", width = 2.4f)
            },
            "highlight" to spec {
                rect(5f, 3.5f, 14f, 12.5f, 2f)
                path("M9 7h6M12 7v6")
                path("M5 20.5h14", width = 2.4f)
            },
            "ol" to spec {
                path("M10 6h10M10 12h10M10 18h10")
                path("M4 4.5h1.5V8M4 8h3M4 10.5h2.5L4 13.5h3M4 16h3l-1.5 1.5L7 19H4", width = 1.2f)
            },
            "ul" to spec {
                path("M9 6h11M9 12h11M9 18h11")
                circle(4.5f, 6f, 1.2f, fill = true)
                circle(4.5f, 12f, 1.2f, fill = true)
                circle(4.5f, 18f, 1.2f, fill = true)
            },
            "indent" to spec { path("M4 5h16M11 10h9M11 14h9M4 19h16M4 9.5l3 2.5-3 2.5") },
            "outdent" to spec { path("M4 5h16M11 10h9M11 14h9M4 19h16M7 9.5 4 12l3 2.5") },
            "caret" to spec { path("m7 10 5 5 5-5", fill = true) },
            "sync" to spec { path("M20 11a8 8 0 0 0-14.3-4.6L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.6L20 15.5M20 20v-4.5h-4.5") },
            "plus" to spec { path("M12 5v14M5 12h14") },
            "file" to spec {
                path("M6.5 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5z")
                path("M13.5 3.5v4h4")
            },
            "download" to spec { path("M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14") },
            "person" to spec {
                circle(12f, 8.5f, 3.8f)
                path("M4.5 20a7.5 7.5 0 0 1 15 0")
            },
            "mailOpen" to spec {
                path("M3.5 10 12 4l8.5 6v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19z")
                path("m4 10.5 8 5.5 8-5.5")
            },
            "info" to spec {
                circle(12f, 12f, 8.5f)
                path("M12 11v5.5M12 7.8v.2")
            },
            "panelLeft" to spec {
                rect(3.5f, 4.5f, 17f, 15f, 2.5f)
                path("M9.5 4.5v15")
            },
            "chevronDown" to spec { path("m7 10 5 5 5-5") },
            "chevronRight" to spec { path("m10 7 5 5-5 5") },
            "chevronUpDown" to spec { path("m8 9.5 4-4 4 4M8 14.5l4 4 4-4") },
            "markUnread" to spec {
                path("M20.5 11.5V17a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17V8A2.5 2.5 0 0 1 6 5.5h8.5")
                path("m4 7.5 8 6 4.5-3.4")
                circle(19f, 6f, 2.3f, fill = true, stroke = false)
            },
            "move" to spec {
                path("M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z")
                path("M8.5 13.5h7M13 11l2.5 2.5L13 16")
            },
            "popOut" to spec {
                path("M13.5 4.5h6v6M19.5 4.5l-8 8")
                path("M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4")
            },
            "code" to spec { path("m8.5 7.5-4.5 4.5 4.5 4.5M15.5 7.5l4.5 4.5-4.5 4.5M13.2 5.5l-2.4 13") },
            "link" to spec {
                path("M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1")
                path("M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1")
            },
            "vip" to spec {
                circle(10f, 8f, 3.6f)
                path("M3.5 19.5a6.5 6.5 0 0 1 9.5-5.8")
                path("m18 12.6 1.3 2.6 2.8.4-2 2 .5 2.8-2.6-1.4-2.5 1.4.5-2.8-2-2 2.7-.4z")
            },
            "edit" to spec {
                path("M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10z")
                path("m13 7 4 4")
            },
            "clearFormat" to spec {
                path("M6 5.5h12M12 5.5l-3 13M5 19.5h7")
                path("m15 14 5 5M20 14l-5 5")
            },
            "replied" to spec {
                path("M20 7v4a4 4 0 0 1-4 4H5")
                path("m9 11-4 4 4 4")
            },
            "print" to spec {
                path("M7 8.5V3.5h10v5")
                rect(3.5f, 8.5f, 17f, 8f, 2f)
                path("M7 14h10v6.5H7z")
            },
            "export" to spec {
                path("M12 15V4M7.5 8.5 12 4l4.5 4.5")
                path("M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13")
            },
            "ban" to spec {
                circle(12f, 12f, 8.5f)
                path("M6 6l12 12")
            },
            "textFormat" to spec {
                path("M3.5 18 8 6h1.2l4.5 12M5.3 14h6.6")
                path("M16 12.3c.6-.5 1.4-.8 2.2-.8 1.6 0 2.3.9 2.3 2.4V18M20.5 15c-3-.3-5 .3-5 1.6 0 1.8 3.8 1.7 5-.4")
            },
            "unsubscribe" to spec {
                rect(3.5f, 5.5f, 17f, 13f, 2.5f)
                path("m4 7 8 6 8-6")
                path("M15.5 16.5h6", width = 2f)
            },
            "keyboard" to spec {
                rect(2.5f, 6f, 19f, 12f, 2.5f)
                path("M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7.5 14h9")
            },
            "sparkle" to spec {
                path("M10.5 4.5Q11.2 12.3 19 13 11.2 13.7 10.5 21.5 9.8 13.7 2 13 9.8 12.3 10.5 4.5z")
                path("M18.5 3v4.5M16.25 5.25h4.5")
            },
            "clock" to spec {
                circle(12f, 12f, 8.5f)
                path("M12 7.5V12l3 2")
            },
            "bell" to spec {
                path("M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z")
                path("M10 20.5a2.2 2.2 0 0 0 4 0")
            },
            "panelRight" to spec {
                rect(3.5f, 4.5f, 17f, 15f, 2.5f)
                path("M14.5 4.5v15")
            },
            "calendar" to spec {
                rect(3.5f, 5f, 17f, 15.5f, 3f)
                path("M3.5 10h17M8 3v4M16 3v4")
            },
            "calendarPlus" to spec {
                rect(3.5f, 5f, 17f, 15.5f, 3f)
                path("M3.5 10h17M8 3v4M16 3v4M12 12.5v5M9.5 15h5")
            },
            "chevronLeft" to spec { path("m14 7-5 5 5 5") },
            "pin" to spec {
                path("M12 20.5s-6.5-5.4-6.5-10.5a6.5 6.5 0 0 1 13 0c0 5.1-6.5 10.5-6.5 10.5z")
                circle(12f, 10f, 2.4f)
            },
            "video" to spec {
                rect(3f, 6.5f, 12.5f, 11f, 2.5f)
                path("m15.5 10.5 5.5-3v9l-5.5-3")
            },
            "notes" to spec { path("M5 6.5h14M5 11h14M5 15.5h9") },
            "people" to spec {
                circle(9f, 8.5f, 3.3f)
                path("M3 19.5a6 6 0 0 1 12 0")
                path("M15.5 5.6a3.3 3.3 0 0 1 0 5.8M17.5 14a6 6 0 0 1 3.5 5.5")
            },
            "repeat" to spec {
                path("m17 3.5 3 3-3 3")
                path("M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H20")
                path("m7 20.5-3-3 3-3")
                path("M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4")
            },
        ),
        fallback = null,
    )

    /** Every icon name, as in icons.js. */
    val names: Set<String> get() = set.names

    /** The icon called [name] in icons.js, optionally at another stroke width. Throws for an unknown name. */
    fun named(name: String, strokeWidth: Float? = null): ImageVector = set.get(name, strokeWidth)

    val Menu: ImageVector get() = named("menu")
    val Search: ImageVector get() = named("search")
    val More: ImageVector get() = named("more")
    val Star: ImageVector get() = named("star")
    val StarFilled: ImageVector get() = named("starFilled")
    val Clip: ImageVector get() = named("clip")
    val Compose: ImageVector get() = named("compose")
    val Expand: ImageVector get() = named("expand")
    val Collapse: ImageVector get() = named("collapse")
    val Up: ImageVector get() = named("up")
    val Down: ImageVector get() = named("down")
    val Back: ImageVector get() = named("back")
    val Close: ImageVector get() = named("close")
    val Reply: ImageVector get() = named("reply")
    val ReplyAll: ImageVector get() = named("replyAll")
    val Forward: ImageVector get() = named("forward")
    val Trash: ImageVector get() = named("trash")
    val Send: ImageVector get() = named("send")
    val Settings: ImageVector get() = named("settings")
    val Inbox: ImageVector get() = named("inbox")
    val Unread: ImageVector get() = named("unread")
    val Saved: ImageVector get() = named("saved")
    val Drafts: ImageVector get() = named("drafts")
    val Sent: ImageVector get() = named("sent")
    val Junk: ImageVector get() = named("junk")
    val Archive: ImageVector get() = named("archive")
    val Folder: ImageVector get() = named("folder")
    val Check: ImageVector get() = named("check")
    val Eye: ImageVector get() = named("eye")
    val EyeOff: ImageVector get() = named("eyeOff")
    val Undo: ImageVector get() = named("undo")
    val Redo: ImageVector get() = named("redo")
    val Image: ImageVector get() = named("image")
    val Bold: ImageVector get() = named("bold")
    val Italic: ImageVector get() = named("italic")
    val Underline: ImageVector get() = named("underline")
    val TextColor: ImageVector get() = named("textColor")
    val Highlight: ImageVector get() = named("highlight")
    val Ol: ImageVector get() = named("ol")
    val Ul: ImageVector get() = named("ul")
    val Indent: ImageVector get() = named("indent")
    val Outdent: ImageVector get() = named("outdent")
    val Caret: ImageVector get() = named("caret")
    val Sync: ImageVector get() = named("sync")
    val Plus: ImageVector get() = named("plus")
    val File: ImageVector get() = named("file")
    val Download: ImageVector get() = named("download")
    val Person: ImageVector get() = named("person")
    val MailOpen: ImageVector get() = named("mailOpen")
    val Info: ImageVector get() = named("info")
    val PanelLeft: ImageVector get() = named("panelLeft")
    val ChevronDown: ImageVector get() = named("chevronDown")
    val ChevronRight: ImageVector get() = named("chevronRight")
    val ChevronUpDown: ImageVector get() = named("chevronUpDown")
    val MarkUnread: ImageVector get() = named("markUnread")
    val Move: ImageVector get() = named("move")
    val PopOut: ImageVector get() = named("popOut")
    val Code: ImageVector get() = named("code")
    val Link: ImageVector get() = named("link")
    val Vip: ImageVector get() = named("vip")
    val Edit: ImageVector get() = named("edit")
    val ClearFormat: ImageVector get() = named("clearFormat")
    val Replied: ImageVector get() = named("replied")
    val Print: ImageVector get() = named("print")
    val Export: ImageVector get() = named("export")
    val Ban: ImageVector get() = named("ban")
    val TextFormat: ImageVector get() = named("textFormat")
    val Unsubscribe: ImageVector get() = named("unsubscribe")
    val Keyboard: ImageVector get() = named("keyboard")
    val Sparkle: ImageVector get() = named("sparkle")
    val Clock: ImageVector get() = named("clock")
    val Bell: ImageVector get() = named("bell")
    val PanelRight: ImageVector get() = named("panelRight")
    val Calendar: ImageVector get() = named("calendar")
    val CalendarPlus: ImageVector get() = named("calendarPlus")
    val ChevronLeft: ImageVector get() = named("chevronLeft")
    val Pin: ImageVector get() = named("pin")
    val Video: ImageVector get() = named("video")
    val Notes: ImageVector get() = named("notes")
    val People: ImageVector get() = named("people")
    val Repeat: ImageVector get() = named("repeat")
}
