package nl.bvdm.rukoo.mcp.tools

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.agents.AgentHub

/**
 * Rukoo's skills as the tools need them: the list for the instructions and read_skill's description, and
 * read_skill's answer (desktop skills.js read()). Skills come from Rukoo's bundled skills and the user's, never
 * from an email, so nothing here is tagged.
 */
interface SkillSource {
    /** Every usable skill, sorted by name. */
    fun list(): List<SkillInfo>

    /** read_skill: without [name] the list, with [file] that file, else SKILL.md and its files. Throws [ToolError]. */
    fun read(name: String, file: String): JsonObject
}

/**
 * Skills through the hub's port of skills.js ([AgentHub.skills], bundled assets plus the user's folder). The hub
 * hands over each skill's SKILL.md as [nl.bvdm.rukoo.agents.model.RukooSkill.body]; files next to it are not
 * offered on the phone, so SKILL.md is the one file a skill has here.
 */
class HubSkillSource(private val hub: AgentHub) : SkillSource {
    private fun skills() = hub.skills().sortedBy { it.name }

    override fun list(): List<SkillInfo> = skills().map { SkillInfo(it.name, oneLine(it.description), it.source) }

    override fun read(name: String, file: String): JsonObject {
        val all = skills()
        if (name.isEmpty()) {
            return buildJsonObject {
                put(
                    "skills",
                    buildJsonArray {
                        for (s in all) {
                            add(
                                buildJsonObject {
                                    put("name", s.name)
                                    put("description", oneLine(s.description))
                                    put("source", s.source)
                                },
                            )
                        }
                    },
                )
            }
        }
        val skill = all.firstOrNull { it.name == name } ?: run {
            val known = all.joinToString(", ") { it.name }
            throw ToolError("There is no skill named \"${SkillText.clip(name, 80)}\". ${if (known.isNotEmpty()) "Skills: $known." else "There are no skills."}")
        }
        val text = skill.body.removePrefix("﻿").replace(Regex("\\r\\n?"), "\n")
        val head = buildJsonObject {
            put("name", skill.name)
            put("description", oneLine(skill.description))
            put("source", skill.source)
        }
        if (file.isNotEmpty()) {
            // Only paths the skill has can be read, so no path from an agent reaches the file system.
            val want = file.replace('\\', '/').replace(Regex("^(?:\\./)+"), "")
            if (want != SKILL_MD) throw ToolError("The skill ${skill.name} has no file ${SkillText.clip(want, 200)}. Its files: $SKILL_MD.")
            return head.plus("path" to SKILL_MD, "size" to text.toByteArray(Charsets.UTF_8).size, "text" to text)
        }
        return head.plus("skill_md" to text, "files" to JsonArray(emptyList()), "left_out" to JsonArray(emptyList()))
    }

    private fun oneLine(s: String) = s.replace(Regex("\\s+"), " ").trim()

    private companion object {
        const val SKILL_MD = "SKILL.md"
    }
}
