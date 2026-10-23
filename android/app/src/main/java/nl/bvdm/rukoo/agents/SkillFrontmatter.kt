package nl.bvdm.rukoo.agents

/** A skill Rukoo can't read, with a reason fit for the user or an agent (desktop SkillError). */
class SkillException(message: String) : Exception(message)

/**
 * The YAML that SKILL.md frontmatter uses, a port of skills.js: top-level keys with plain, quoted or block
 * (| and >) values. Nested maps and lists are recognised and skipped; Rukoo reads only name and description.
 */
object SkillFrontmatter {
    /** A value that is a map or a list: not text. */
    object Nested

    data class Parsed(val data: Map<String, Any>, val body: String)

    private val OPEN = Regex("^---[ \\t]*$")
    private val CLOSE = Regex("^(?:---|\\.\\.\\.)[ \\t]*$")
    private val KEY_LINE = Regex("^([A-Za-z_][A-Za-z0-9_.-]*)[ \\t]*:(?:[ \\t]+(.*))?$")
    private val BLOCK = Regex("^([|>])([+-]?)[1-9]?([+-]?)[ \\t]*(?:#.*)?$")
    private val LIST_ITEM = Regex("^-(?:[ \\t]|$)")
    private val BLANK = Regex("^[ \\t]*$")
    private val COMMENT = Regex("(?:^|[ \\t]+)#.*$")
    private val INDENT = Regex("^[ \\t]*")
    private val TRAILING_NEWLINES = Regex("\n*\\z")

    private fun blank(line: String) = BLANK.matches(line)

    private fun indentOf(line: String) = INDENT.find(line)!!.value.length

    fun parse(source: String): Parsed {
        val text = source.removePrefix("﻿").replace(Regex("\r\n?"), "\n")
        val lines = text.split("\n")
        if (!OPEN.matches(lines[0])) throw SkillException("SKILL.md does not start with a --- line and frontmatter")
        var end = -1
        for (i in 1 until lines.size) if (CLOSE.matches(lines[i])) { end = i; break }
        if (end < 0) throw SkillException("the frontmatter has no closing --- line")
        return Parsed(parseMap(lines.subList(1, end)), lines.drop(end + 1).joinToString("\n"))
    }

    private fun parseMap(lines: List<String>): Map<String, Any> {
        val data = LinkedHashMap<String, Any>()
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            if (blank(line) || line.startsWith("#")) {
                i++
                continue
            }
            // Line 1 is the opening ---.
            val m = KEY_LINE.matchEntire(line) ?: throw SkillException("frontmatter line ${i + 2} is not \"key: value\"")
            val key = m.groupValues[1]
            if (key in data) throw SkillException("the frontmatter has \"$key\" twice")
            val raw = (m.groups[2]?.value ?: "").trim()
            // The value's other lines: indented ones and blank lines, and a list that starts at the margin.
            var j = i + 1
            while (j < lines.size && (lines[j].startsWith(" ") || lines[j].startsWith("\t") || blank(lines[j]) || (raw.isEmpty() && LIST_ITEM.containsMatchIn(lines[j])))) j++
            data[key] = value(key, raw, lines.subList(i + 1, j))
            i = j
        }
        return data
    }

    private fun value(key: String, raw: String, rest: List<String>): Any {
        val more = rest.filterNot(::blank)
        if (raw.isEmpty() || raw.startsWith("#")) return if (more.isNotEmpty()) Nested else ""
        if (raw[0] == '[' || raw[0] == '{') return Nested
        BLOCK.matchEntire(raw)?.let { b -> return blockScalar(b.groupValues[1], b.groupValues[2].ifEmpty { b.groupValues[3] }, rest) }
        if (raw[0] == '"' || raw[0] == '\'') return quoted(key, (listOf(raw) + rest.map { it.trim() }).joinToString(" "))
        // A plain value can go on over indented lines; a # after a space starts a comment.
        return (listOf(raw) + more.map { it.trim() })
            .map { it.replaceFirst(COMMENT, "") }
            .filter { it.isNotEmpty() }
            .joinToString(" ")
    }

    private fun blockScalar(style: String, chomp: String, rest: List<String>): String {
        val first = rest.firstOrNull { !blank(it) } ?: return ""
        val indent = indentOf(first)
        val lines = rest.map { if (blank(it)) "" else it.substring(minOf(indent, indentOf(it))) }
        val joined = lines.joinToString("\n")
        val trailing = TRAILING_NEWLINES.find(joined)!!.value
        val stripped = joined.replace(Regex("\n+\\z"), "")
        val text = if (style == "|") {
            stripped
        } else {
            // Folded: lines join with a space, a blank line stays a line break.
            stripped.replace(Regex("([^\n])\n(?=[^\n])"), "$1 ").replace("\n\n", "\n")
        }
        return when (chomp) {
            "-" -> text
            "+" -> text + trailing
            else -> "$text\n"
        }
    }

    private val ESCAPES = mapOf(
        '0' to "\u0000", 'a' to "\u0007", 'b' to "\b", 't' to "\t", '\t' to "\t", 'n' to "\n", 'v' to "\u000B", 'f' to "\u000C",
        'r' to "\r", 'e' to "\u001B", ' ' to " ", '"' to "\"", '/' to "/", '\\' to "\\", 'N' to "\u0085", '_' to " ",
        'L' to " ", 'P' to " ",
    )
    private val HEX = mapOf('x' to 2, 'u' to 4, 'U' to 8)
    private val HEX_DIGITS = Regex("^[0-9a-fA-F]+$")
    private val AFTER_QUOTE = Regex("^[ \\t]*(?:#.*)?$")

    private fun quoted(key: String, text: String): String {
        val q = text[0]
        val out = StringBuilder()
        var i = 1
        while (i < text.length) {
            val c = text[i]
            if (c == q) {
                if (q == '\'' && i + 1 < text.length && text[i + 1] == '\'') {
                    out.append('\'')
                    i += 2
                    continue
                }
                break
            }
            if (q == '"' && c == '\\') {
                i++
                val e = text.getOrNull(i)
                val digits = e?.let { HEX[it] }
                when {
                    digits != null -> {
                        val hex = text.substring(minOf(i + 1, text.length), minOf(i + 1 + digits, text.length))
                        if (hex.length != digits || !HEX_DIGITS.matches(hex)) throw SkillException("\"$key\" has a broken \\$e escape")
                        val code = hex.toLong(16)
                        if (code > Character.MAX_CODE_POINT) throw SkillException("\"$key\" has a broken \\$e escape")
                        out.appendCodePoint(code.toInt())
                        i += digits
                    }
                    e != null && e in ESCAPES -> out.append(ESCAPES.getValue(e))
                    else -> throw SkillException("\"$key\" has an unknown escape \\${e ?: ""}")
                }
                i++
                continue
            }
            out.append(c)
            i++
        }
        if (i >= text.length) throw SkillException("the value of \"$key\" opens a quote it never closes")
        if (!AFTER_QUOTE.matches(text.substring(i + 1))) throw SkillException("the value of \"$key\" goes on after its closing quote")
        return out.toString()
    }
}
