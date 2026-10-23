package nl.bvdm.rukoo.ui.theme

/**
 * The desktop's `hue(text)` (ui.js:127-131, bui.js hueOf): one hue per address, so a sender has the same
 * color in the list, the reader and the agent panel. JS iterates code points but takes `charCodeAt(0)`, which
 * for a character outside the BMP is its high surrogate; [Character.toChars] gives the same unit.
 */
fun rukooHue(text: String?): Int {
    var h = 7
    val lower = (text ?: "").lowercase()
    var i = 0
    while (i < lower.length) {
        val cp = lower.codePointAt(i)
        h = (h * 31 + Character.toChars(cp)[0].code) % 360
        i += Character.charCount(cp)
    }
    return h
}

private val NoiseInName = Regex("""\(.*?\)|["'<>\[\]]""")
private val WordSplit = Regex("""[\s._-]+""")

/**
 * Avatar initials (ui.js `initials`): strip parentheses and quotes; without a name, use the local part of the
 * address; then the first letter of the first and last word, or the first two letters of a single word.
 */
fun rukooInitials(name: String?, address: String? = null): String {
    val source = name?.takeIf { it.isNotBlank() } ?: address?.takeIf { it.isNotBlank() } ?: "?"
    val raw = source.replace(NoiseInName, " ").trim()
    val words = if (name.isNullOrBlank() && raw.contains('@')) listOf(raw.substringBefore('@'))
    else raw.split(WordSplit).filter { it.isNotEmpty() }
    return firstAndLast(words.ifEmpty { listOf("?") })
}

/**
 * Monogram text (bui.js `monogram`): a label of one or two characters is shown as is, uppercased; anything
 * longer gets initials, where a bare address uses its local part.
 */
fun rukooMonogramText(label: String?): String {
    val text = label ?: ""
    if (text.codePointCount(0, text.length) in 1..2) return text.uppercase()
    val raw = (label ?: "?").ifEmpty { "?" }.replace(NoiseInName, " ").trim()
    val words = if (raw.contains('@') && !raw.contains(' ')) listOf(raw.substringBefore('@'))
    else raw.split(WordSplit).filter { it.isNotEmpty() }
    if (words.isEmpty()) return "?"
    return firstAndLast(words)
}

private fun firstAndLast(words: List<String>): String {
    val first = words.first().codePoints().toArray()
    val last = if (words.size > 1) words.last().codePoints().toArray() else IntArray(0)
    val a = first.getOrNull(0)?.let { String(Character.toChars(it)) } ?: "?"
    val b = (last.getOrNull(0) ?: first.getOrNull(1))?.let { String(Character.toChars(it)) } ?: ""
    return (a + b).uppercase()
}
