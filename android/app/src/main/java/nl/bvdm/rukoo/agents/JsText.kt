package nl.bvdm.rukoo.agents

/**
 * JavaScript's `\s`, which desktop's text rules use. Java's `\s` is ASCII only, so a no-break space would
 * survive here where the desktop collapses it, and an agent would read different text on each.
 */
internal val JS_SPACES = Regex("[\\t\\n\\u000B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")

/** `String(v).replace(/\s+/g, ' ').trim()` as desktop writes it. */
internal fun jsOneLine(v: String?): String = (v ?: "").replace(JS_SPACES, " ").trim(*JS_TRIM)

// What JavaScript's trim() removes: its whitespace plus the line terminators.
private val JS_TRIM = charArrayOf(
    '\t', '\n', '\u000B', '\u000C', '\r', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ',
    ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿',
)

internal fun jsTrim(v: String): String = v.trim(*JS_TRIM)
