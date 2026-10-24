package nl.bvdm.rukoo.agents

import android.content.Context
import androidx.annotation.StringRes
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.agents.model.RukooSkill

/**
 * The chat's quick actions and the user's shortcuts, a port of desktop's actions.js and the shortcut rules
 * of config.js. The stored list (agents.json `shortcuts`, null for Rukoo's own) keeps only what the user
 * changed; [list] turns it into the shortcuts the chat offers.
 */
object QuickActions {
    val ICONS = listOf("sparkle", "mail", "search", "list", "arrow-right", "layers", "clock", "file", "pen", "calendar", "person", "globe", "chart", "link", "check", "shield", "info", "x")
    val KEY = Regex("^[a-z0-9]+(?:-[a-z0-9]+)*$")
    val RESERVED = setOf("approved", "declined", "skill", "shortcut")
    const val MAX = 40
    const val KEY_MAX = 40
    const val LABEL_MAX = 60
    const val PROMPT_MAX = 4000

    /** One stored entry, checked: what the user changed about a shortcut (config.js shortcutList). */
    data class Entry(
        val key: String,
        val custom: Boolean = false,
        val hidden: Boolean = false,
        val label: String = "",
        val prompt: String = "",
        val icon: String = "sparkle",
        val always: Boolean = false,
    )

    private fun text(v: JsonElement?, max: Int): String? = when {
        v == null || v is JsonNull -> ""
        v is JsonPrimitive && v.isString -> v.content.trim().takeIf { it.length <= max }
        else -> null
    }

    /**
     * The stored list as entries, or null for Rukoo's own: also when it breaks a rule (edited by hand, or from
     * a later Rukoo), as desktop's storedShortcuts gives way to the defaults.
     */
    fun entries(stored: JsonElement?): List<Entry>? {
        if (stored == null || stored is JsonNull) return null
        val list = stored as? JsonArray ?: return null
        if (list.size > MAX) return null
        val seen = HashSet<String>()
        val out = mutableListOf<Entry>()
        for (raw in list) {
            val e = raw as? JsonObject ?: return null
            val key = text(e["key"], KEY_MAX)?.lowercase() ?: return null
            if (!KEY.matches(key) || key in RESERVED || !seen.add(key)) return null
            val custom = (e["custom"] as? JsonPrimitive)?.booleanOrNull == true
            val hiddenRaw = e["hidden"]
            val hidden = when {
                hiddenRaw == null -> false
                hiddenRaw is JsonPrimitive && !hiddenRaw.isString && hiddenRaw.booleanOrNull != null -> hiddenRaw.booleanOrNull!!
                else -> return null
            }
            val label = text(e["label"], LABEL_MAX) ?: return null
            val prompt = text(e["prompt"], PROMPT_MAX) ?: return null
            if (custom && (label.isEmpty() || prompt.isEmpty())) return null
            val icon = (e["icon"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it in ICONS } ?: "sparkle"
            val always = (e["when"] as? JsonPrimitive)?.takeIf { it.isString }?.content == "always"
            out += Entry(key, custom, hidden, label, prompt, icon, custom && always)
        }
        return out
    }

    /** [entries] as the list to store, in the shape desktop's shortcutList gives them. */
    fun stored(entries: List<Entry>): JsonArray = JsonArray(
        entries.map { e ->
            buildJsonObject {
                put("key", e.key)
                if (e.custom) put("custom", true)
                if (e.hidden) put("hidden", true)
                if (e.label.isNotEmpty()) put("label", e.label)
                if (e.prompt.isNotEmpty()) put("prompt", e.prompt)
                if (e.custom) {
                    put("icon", e.icon)
                    put("when", if (e.always) "always" else "email")
                }
            }
        },
    )

    private fun builtIn(key: String) = QuickAction.BUILT_IN.firstOrNull { it.key == key }

    private fun make(e: Entry?, base: QuickAction?): QuickAction {
        if (base == null) {
            val entry = requireNotNull(e)
            return QuickAction(
                key = entry.key, icon = entry.icon, prompt = entry.prompt, label = entry.label, description = entry.label,
                needsEmail = !entry.always, custom = true, hidden = entry.hidden, always = entry.always,
            )
        }
        // Rukoo's keep their translated label (null here) unless the user wrote their own.
        return base.copy(
            hidden = e?.hidden == true,
            label = e?.label?.takeIf { it.isNotEmpty() },
            prompt = e?.prompt?.takeIf { it.isNotEmpty() } ?: base.prompt,
        )
    }

    /** The shortcuts in the user's order. One of Rukoo's the list doesn't have goes after the one before it in Rukoo's order. */
    fun list(stored: JsonElement?): List<QuickAction> = build(entries(stored).orEmpty())

    private fun build(entries: List<Entry>): List<QuickAction> {
        val out = mutableListOf<QuickAction>()
        val seen = HashSet<String>()
        for (e in entries) {
            if (e.key in seen) continue
            val base = builtIn(e.key)
            if (base == null && !(e.custom && e.label.isNotEmpty() && e.prompt.isNotEmpty())) continue
            seen += e.key
            out += make(e, base)
        }
        QuickAction.BUILT_IN.forEachIndexed { i, a ->
            if (a.key in seen) return@forEachIndexed
            val before = QuickAction.BUILT_IN.take(i).reversed().firstOrNull { it.key in seen }
            val at = if (before != null) out.indexOfFirst { it.key == before.key } + 1 else 0
            out.add(at, make(null, a))
            seen += a.key
        }
        return out
    }

    // ---------- editing, for Settings > Agents > Shortcuts (settings.js shortcutAction) ----------

    /**
     * What to store for [list]: null when it is Rukoo's own, as they come (actions.js storedShortcuts). A list
     * that can't be kept in [MAX] entries comes out longer, and is not to be saved (see [fits]).
     */
    fun store(list: List<QuickAction>): JsonArray? {
        val entries = list.map { a ->
            if (a.custom) {
                Entry(a.key, custom = true, hidden = a.hidden, label = a.label.orEmpty(), prompt = a.prompt, icon = a.icon, always = a.always)
            } else {
                Entry(a.key, hidden = a.hidden, label = a.label.orEmpty(), prompt = if (a.prompt == builtIn(a.key)?.prompt) "" else a.prompt)
            }
        }
        val plain = entries.size == QuickAction.BUILT_IN.size && entries.zip(QuickAction.BUILT_IN).all { (e, b) -> e == Entry(b.key) }
        return if (plain) null else stored(compact(entries))
    }

    /** True when [stored] is a list [entries] reads back rather than dropping for Rukoo's own. */
    fun fits(stored: JsonArray?): Boolean = stored == null || stored.size <= MAX

    /**
     * [entries] within [MAX] where that keeps the same shortcuts: an unchanged one of Rukoo's can go when [list]
     * puts it back in the same place. A list from the computer with 40 of the user's own and none of Rukoo's
     * then still fits after an edit here, where all 48 would no longer read back.
     */
    private fun compact(entries: List<Entry>): List<Entry> {
        var out = entries
        for (e in entries) {
            if (out.size <= MAX) break
            if (e.custom || e != Entry(e.key)) continue
            val fewer = out - e
            if (build(fewer) == build(out)) out = fewer
        }
        return out
    }

    /** One of Rukoo's with the user's own name or instructions. */
    fun edited(a: QuickAction): Boolean = !a.custom && (a.label != null || a.prompt != builtIn(a.key)?.prompt)

    /** [list] with [key] moved [by] places, -1 up and 1 down; as it was at either end. */
    fun move(list: List<QuickAction>, key: String, by: Int): List<QuickAction> {
        val i = list.indexOfFirst { it.key == key }
        val j = i + by
        if (i < 0 || j !in list.indices) return list
        return list.toMutableList().also { java.util.Collections.swap(it, i, j) }
    }

    /** [list] with [key] replaced by what [change] makes of it. */
    fun change(list: List<QuickAction>, key: String, change: (QuickAction) -> QuickAction): List<QuickAction> =
        list.map { if (it.key == key) change(it) else it }

    /**
     * One of Rukoo's with the user's [label] and [prompt]. A label equal to Rukoo's own [defaultLabel] (in the
     * interface language) and a prompt equal to Rukoo's are no change, as settings.js keeps them.
     */
    fun rewrite(a: QuickAction, label: String, prompt: String, defaultLabel: String?): QuickAction =
        a.copy(label = label.takeIf { it != defaultLabel }, prompt = prompt)

    /** One of Rukoo's back to its own name and instructions ("Restore default"). */
    fun restore(a: QuickAction): QuickAction = builtIn(a.key)?.let { a.copy(label = null, prompt = it.prompt) } ?: a

    /** The user's own shortcut, as [make] builds one from a stored entry. */
    fun custom(key: String, label: String, prompt: String, icon: String, always: Boolean, hidden: Boolean = false): QuickAction =
        make(Entry(key, custom = true, hidden = hidden, label = label, prompt = prompt, icon = icon.takeIf { it in ICONS } ?: "sparkle", always = always), null)

    /** Why a typed command can't be used. */
    enum class CommandProblem { BAD, TAKEN }

    /** The command [raw] names ("/Follow-up" is `follow-up`). */
    fun commandOf(raw: String): String = raw.trim().removePrefix("/").lowercase()

    /**
     * What is wrong with [key] as the command of the user's shortcut [editing] (null for a new one): the
     * pattern, Rukoo's message actions and commands, and the other shortcuts in [list].
     */
    fun commandProblem(key: String, list: List<QuickAction>, editing: String?): CommandProblem? = when {
        !KEY.matches(key) || key.length > KEY_MAX -> CommandProblem.BAD
        key in RESERVED || builtIn(key) != null || list.any { it.key == key && it.key != editing } -> CommandProblem.TAKEN
        else -> null
    }

    /** The chips in an empty chat: the shortcuts for the email (or for no email) the user didn't hide. */
    fun chips(list: List<QuickAction>, emailOpen: Boolean, unsubscribe: Boolean): List<QuickAction> =
        list.filter { !it.hidden && it.applies(emailOpen, unsubscribe) }

    /** The slash commands: the same shortcuts, hidden ones too; triage and the user's always-shortcuts are always there. */
    fun commands(list: List<QuickAction>, emailOpen: Boolean, unsubscribe: Boolean): List<QuickAction> =
        list.filter { it.key == "triage" || (it.custom && it.always) || it.applies(emailOpen, unsubscribe) }

    /** Skills as slash commands, after the shortcuts. A shortcut keeps its command: a skill with its name isn't offered. */
    fun skillCommands(skills: List<RukooSkill>, list: List<QuickAction>): List<RukooSkill> =
        skills.filter { s -> list.none { it.key == s.name } }

    /** A message that is exactly `/name` runs that command; `/reply some words` is plain text (panel.js). */
    fun slashName(text: String): String? = Regex("^/([\\w-]+)$").matchEntire(text)?.groupValues?.get(1)?.lowercase()

    @StringRes
    fun labelRes(key: String): Int? = when (key) {
        "reply" -> R.string.agents_action_reply_label
        "brief" -> R.string.agents_action_brief_label
        "tasks" -> R.string.agents_action_tasks_label
        "team" -> R.string.agents_action_team_label
        "update" -> R.string.agents_action_update_label
        "unsubscribe" -> R.string.agents_action_unsubscribe_label
        "summary" -> R.string.agents_action_summary_label
        "triage" -> R.string.agents_action_triage_label
        else -> null
    }

    @StringRes
    fun descriptionRes(key: String): Int? = when (key) {
        "reply" -> R.string.agents_action_reply_description
        "brief" -> R.string.agents_action_brief_description
        "tasks" -> R.string.agents_action_tasks_description
        "team" -> R.string.agents_action_team_description
        "update" -> R.string.agents_action_update_description
        "unsubscribe" -> R.string.agents_action_unsubscribe_description
        "summary" -> R.string.agents_action_summary_description
        "triage" -> R.string.agents_action_triage_description
        else -> null
    }

    /** The label the chip and the user's message show: the user's own, or Rukoo's translated one. */
    fun label(context: Context, action: QuickAction): String =
        action.label ?: labelRes(action.key)?.let(context::getString) ?: action.key

    /** The line under the label in the slash menu. A renamed Rukoo action describes itself with its original label. */
    fun description(context: Context, action: QuickAction): String = when {
        action.custom -> action.description ?: action.label.orEmpty()
        action.label != null -> labelRes(action.key)?.let(context::getString).orEmpty()
        else -> descriptionRes(action.key)?.let(context::getString).orEmpty()
    }
}
