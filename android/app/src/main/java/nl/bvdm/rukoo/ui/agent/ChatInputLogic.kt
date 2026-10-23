package nl.bvdm.rukoo.ui.agent

import nl.bvdm.rukoo.agents.QuickActions
import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.agents.model.RukooSkill

/** A `/command` or `$skill` being typed: the sigil, what follows it (lowercase), and where it sits in the text. */
data class InputToken(val sigil: Char, val query: String, val start: Int, val end: Int)

/** A row of the `/` menu: one of Rukoo's quick actions or the user's shortcuts, or a Rukoo skill. */
data class SlashCommand(val name: String, val icon: String, val skill: Boolean, val action: QuickAction? = null, val description: String = "")

/** A piece of text that holds the agent's own skills: plain text, or one skill named as `$name`. */
sealed interface SkillPart {
    data class Text(val text: String) : SkillPart

    data class Skill(val skill: OwnSkill) : SkillPart
}

/** The chat input's `/` and `$` rules (bui.js chatComposer, actions.js commandsFor). */
object ChatInputLogic {
    private val TOKEN = Regex("(^|\\s)([/$])([\\w:-]*)$")
    private val SKILL_SENT = Regex("(^|\\s)\\$(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=[\\s,.;!?)]|$)")
    // While typing, a name at the very end is still being written, so it stays text.
    private val SKILL_TYPED = Regex("(^|\\s)\\$(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=[\\s,.;!?)])")
    const val SKILL_ROWS_MAX = 200

    /** The token just before the caret, at the start of a word. A `$` followed by a digit is an amount, not a skill. */
    fun token(text: String, caret: Int): InputToken? {
        val at = caret.coerceIn(0, text.length)
        val m = TOKEN.find(text.substring(0, at)) ?: return null
        val sigil = m.groupValues[2][0]
        val query = m.groupValues[3]
        if (sigil == '$' && query.firstOrNull()?.isDigit() == true) return null
        return InputToken(sigil, query.lowercase(), m.range.first + m.groupValues[1].length, at)
    }

    /**
     * The `/` menu as rows: the shortcuts and Rukoo's skills the hub offers here. Which ones is the hub's rule
     * (QuickActions.commands and skillCommands, actions.js commandsFor); this only turns them into rows.
     */
    fun commands(actions: List<QuickAction>, skills: List<RukooSkill>, emailOpen: Boolean, unsubscribe: Boolean): List<SlashCommand> =
        QuickActions.commands(actions, emailOpen, unsubscribe).map { SlashCommand(it.key, it.icon, skill = false, action = it) } +
            QuickActions.skillCommands(skills, actions).map { SlashCommand(it.name, "file", skill = true, description = it.description) }

    fun matching(commands: List<SlashCommand>, query: String): List<SlashCommand> =
        commands.filter { it.name.lowercase().startsWith(query) }

    /** A message that is just one of the offered commands ("/summary") runs it, like picking it from the menu. */
    fun wholeCommand(text: String, commands: List<SlashCommand>): SlashCommand? {
        val name = QuickActions.slashName(text.trim()) ?: return null
        return commands.firstOrNull { it.name.equals(name, ignoreCase = true) }
    }

    /**
     * The agent's skills for what was typed after the `$`: names that start with it first, then names with a word
     * that does, then names and descriptions that hold it anywhere.
     */
    fun skillMatches(skills: List<OwnSkill>, query: String): List<OwnSkill> {
        if (query.isEmpty()) return skills.take(SKILL_ROWS_MAX)
        return skills.mapNotNull { k ->
            val name = k.name.lowercase()
            val score = when {
                name.startsWith(query) -> 0
                name.split('-', '_', ':').any { it.startsWith(query) } -> 1
                query in name -> 2
                query in k.description.lowercase() -> 3
                else -> return@mapNotNull null
            }
            k to score
        }
            .sortedWith(compareBy<Pair<OwnSkill, Int>> { it.second }.thenBy { it.first.name })
            .take(SKILL_ROWS_MAX)
            .map { it.first }
    }

    /** [text] split into plain text and the agent's skills it names. [typing]: a name at the very end doesn't count yet. */
    fun skillParts(text: String, skills: List<OwnSkill>, typing: Boolean = false): List<SkillPart> {
        val known = skills.associateBy { it.name }
        if (known.isEmpty() || '$' !in text) return if (text.isEmpty()) emptyList() else listOf(SkillPart.Text(text))
        val out = ArrayList<SkillPart>()
        var at = 0
        for (m in (if (typing) SKILL_TYPED else SKILL_SENT).findAll(text)) {
            val skill = known[m.groupValues[2]] ?: continue
            val start = m.range.first + m.groupValues[1].length
            if (start < at) continue
            if (start > at) out += SkillPart.Text(text.substring(at, start))
            out += SkillPart.Skill(skill)
            at = start + 1 + m.groupValues[2].length
        }
        if (at < text.length) out += SkillPart.Text(text.substring(at))
        return out
    }

    /** Where the skills sit in typed text, as ranges over `$name`, for drawing them as chips. */
    fun skillRanges(text: String, skills: List<OwnSkill>): List<IntRange> {
        var at = 0
        val out = ArrayList<IntRange>()
        for (part in skillParts(text, skills, typing = true)) {
            val length = when (part) {
                is SkillPart.Text -> part.text.length
                is SkillPart.Skill -> part.skill.name.length + 1
            }
            if (part is SkillPart.Skill) out += at until at + length
            at += length
        }
        return out
    }

    /** A chip's label: the words of the skill's name, each with a capital (t3code's skillLabel). */
    fun skillLabel(name: String): String =
        name.split(Regex("[\\s:_-]+")).filter { it.isNotEmpty() }.joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }
}
