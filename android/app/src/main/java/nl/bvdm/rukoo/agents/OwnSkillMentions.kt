package nl.bvdm.rukoo.agents

import nl.bvdm.rukoo.agents.model.OwnSkill

/**
 * The agent's own skills, offered after a `$` (desktop ownskills.js): the list an adapter reports, cleaned,
 * and the `$name` mentions in what the user wrote.
 */
object OwnSkillMentions {
    const val SKILLS_MAX = 500
    const val DESCRIPTION_MAX = 400

    // $name at the start of a word, ending at a space, punctuation or the end. A name has a letter somewhere,
    // so an amount such as $50 or $1.5k is never one.
    private val MENTION = Regex("(^|\\s)\\$(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=[\\s,.;!?)]|$)")
    private val ANY = Regex("(^|\\s)\\$[a-zA-Z0-9]")
    private val NAME = Regex("^[a-zA-Z0-9][a-zA-Z0-9:_-]*$")
    private val LETTER = Regex("[a-zA-Z]")

    /** Whether the text has anything that could be a mention, before a list is fetched (hub.js mentionedSkills). */
    fun mayMention(text: String): Boolean = ANY.containsMatchIn(text)

    /** The names a message mentions, in the order it mentions them, of those in [names] (the hub keeps each once). */
    fun mentionsIn(text: String, names: Set<String>): List<String> =
        MENTION.findAll(text).map { it.groupValues[2] }.filter { it in names }.toList()

    private fun clip(v: String?, max: Int): String {
        val s = jsOneLine(v)
        return if (s.length > max) "${s.take(max - 1)}…" else s
    }

    /** An adapter's list in one shape: valid names once each, descriptions on one line (ownskills.js cleanList). */
    fun cleanList(list: List<OwnSkill>): List<OwnSkill> {
        val out = mutableListOf<OwnSkill>()
        val seen = HashSet<String>()
        for (s in list) {
            if (out.size >= SKILLS_MAX) break
            val name = s.name.trim()
            if (!NAME.matches(name) || name.length > 120 || !LETTER.containsMatchIn(name) || name in seen) continue
            seen += name
            out += OwnSkill(name, clip(s.description, DESCRIPTION_MAX), s.scope?.takeIf { it.isNotEmpty() }?.let { clip(it, 40) })
        }
        return out
    }
}
