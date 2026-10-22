package nl.bvdm.rukoo.mcp.tools

import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.model.RukooSkill

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
 * Skills through the hub's port of skills.js ([AgentHub.skills]: bundled assets plus the user's folder). A skill
 * that lives in a folder on the phone ([folderOf], the user's `filesDir/skills/<name>`) is read from it with
 * desktop's rules, files next to SKILL.md included. A bundled skill ships as SKILL.md alone
 * ([RukooSkill.body] is that file), so it has no other files to offer.
 */
class HubSkillSource(private val hub: AgentHub, private val folderOf: (RukooSkill) -> File? = { null }) : SkillSource {
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
        val head = buildJsonObject {
            put("name", skill.name)
            put("description", oneLine(skill.description))
            put("source", skill.source)
        }
        // The name becomes part of a path: only the Agent Skills form (lowercase, digits, single hyphens).
        val folder = if (SkillFolder.NAME.matches(skill.name)) runCatching { folderOf(skill) }.getOrNull()?.takeIf { it.isDirectory } else null
        if (folder != null) return SkillFolder.read(folder, skill.name, head, file)
        val text = skill.body.removePrefix("﻿").replace(Regex("\\r\\n?"), "\n")
        if (file.isNotEmpty()) {
            // Only paths the skill has can be read, so no path from an agent reaches the file system.
            val want = SkillFolder.normalize(file)
            if (want != SkillFolder.SKILL_MD) throw ToolError("The skill ${skill.name} has no file ${SkillText.clip(want, 200)}. Its files: ${SkillFolder.SKILL_MD}.")
            return head.plus("path" to SkillFolder.SKILL_MD, "size" to text.toByteArray(Charsets.UTF_8).size, "text" to text)
        }
        return head.plus("skill_md" to text, "files" to JsonArray(emptyList()), "left_out" to JsonArray(emptyList()))
    }

    private fun oneLine(s: String) = s.replace(Regex("\\s+"), " ").trim()
}

/**
 * Reading a skill folder the way desktop's skills.js does (walk, readInside, readOne): every file without following
 * links or dot files, each file up to 32 KB in one answer and 64 KB on its own, 64 KB of text in total, at most 200
 * entries five folders deep, and a list of what was left out and why.
 */
object SkillFolder {
    const val SKILL_MD = "SKILL.md"
    val NAME = Regex("^[a-z0-9]+(?:-[a-z0-9]+)*$")
    private const val FILE_MAX = 32 * 1024L
    private const val TOTAL_MAX = 64 * 1024L
    private const val ONE_FILE_MAX = 64 * 1024L
    private const val ENTRIES_MAX = 200
    private const val DEPTH_MAX = 5

    private class Entry(val path: String, val abs: Path, val size: Long)

    private class Skipped(val path: String, val reason: String)

    private class Walk(val files: List<Entry>, val skipped: List<Skipped>, val truncated: Boolean)

    private class Unreadable(message: String) : Exception(message)

    fun normalize(file: String): String = file.replace('\\', '/').replace(Regex("^(?:\\./)+"), "")

    private fun kb(n: Long) = "${Math.ceil(n / 1024.0).toLong()} KB"

    /** UTF-8 text with \n line ends and no byte order mark, or null for anything else. */
    private fun decode(bytes: ByteArray): String? {
        if (bytes.any { it == 0.toByte() }) return null
        val text = try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: CharacterCodingException) {
            return null
        }
        return text.removePrefix("﻿").replace(Regex("\\r\\n?"), "\n")
    }

    private fun inside(root: Path, abs: Path): Boolean {
        val real = runCatching { abs.toRealPath() }.getOrNull() ?: return false
        val rel = root.relativize(real).toString()
        return rel.isNotEmpty() && !rel.startsWith("..") && !File(rel).isAbsolute
    }

    // A regular file inside root, checked again right before reading, so a file swapped for a link is not followed.
    private fun readInside(root: Path, abs: Path, max: Long): String? {
        if (Files.isSymbolicLink(abs) || !Files.isRegularFile(abs, LinkOption.NOFOLLOW_LINKS) || !inside(root, abs)) {
            throw Unreadable("not a file inside the skill folder")
        }
        val size = Files.size(abs)
        if (size > max) throw Unreadable("${kb(size)}, more than ${kb(max)}")
        return decode(Files.readAllBytes(abs))
    }

    private fun walk(root: Path): Walk {
        val files = mutableListOf<Entry>()
        val skipped = mutableListOf<Skipped>()
        var entries = 0
        var truncated = false
        fun visit(dir: Path, rel: String, depth: Int) {
            val names = runCatching { dir.toFile().list() }.getOrNull()?.sorted() ?: run {
                skipped += Skipped(if (rel.isNotEmpty()) "$rel/" else ".", "could not be read")
                return
            }
            for (name in names) {
                if (truncated) return
                if (name.startsWith(".")) continue
                if (++entries > ENTRIES_MAX) {
                    truncated = true
                    return
                }
                val relPath = if (rel.isNotEmpty()) "$rel/$name" else name
                val abs = dir.resolve(name)
                when {
                    // Links could point anywhere on the device.
                    Files.isSymbolicLink(abs) -> skipped += Skipped(relPath, "a link; Rukoo does not follow links inside a skill")
                    !inside(root, abs) -> skipped += Skipped(relPath, "outside the skill folder")
                    Files.isDirectory(abs, LinkOption.NOFOLLOW_LINKS) -> {
                        if (depth + 1 > DEPTH_MAX) skipped += Skipped("$relPath/", "nested more than $DEPTH_MAX folders deep") else visit(abs, relPath, depth + 1)
                    }
                    Files.isRegularFile(abs, LinkOption.NOFOLLOW_LINKS) -> files += Entry(relPath, abs, runCatching { Files.size(abs) }.getOrDefault(0))
                }
            }
        }
        visit(root, "", 0)
        return Walk(files, skipped, truncated)
    }

    private fun leftOut(path: String, size: Long?, reason: String) = buildJsonObject {
        put("path", path)
        if (size != null) put("size", size)
        put("reason", reason)
    }

    /** read_skill for a skill in [folder]: SKILL.md and as many other text files as fit, or one [file]. */
    fun read(folder: File, name: String, head: JsonObject, file: String): JsonObject {
        val root = runCatching { folder.toPath().toRealPath() }.getOrElse { throw ToolError("The skill $name can't be read.") }
        val md = root.resolve(SKILL_MD)
        val skillMd = try {
            readInside(root, md, ONE_FILE_MAX)
        } catch (_: Exception) {
            null
        } ?: throw ToolError("The skill $name can't be read.")
        val walk = walk(root)
        if (file.isNotEmpty()) return head.plus(*readOne(root, name, walk, file))
        val included = mutableListOf<JsonObject>()
        val leftOut = walk.skipped.map { leftOut(it.path, null, it.reason) }.toMutableList()
        var budget = TOTAL_MAX - skillMd.toByteArray(Charsets.UTF_8).size
        for (f in walk.files) {
            if (f.path == SKILL_MD) continue
            if (f.size > FILE_MAX) {
                leftOut += leftOut(f.path, f.size, if (f.size > ONE_FILE_MAX) "too large to read" else "too large to include; ask for it with file")
                continue
            }
            if (f.size > budget) {
                leftOut += leftOut(f.path, f.size, "did not fit in this answer; ask for it with file")
                continue
            }
            val text = try {
                readInside(root, f.abs, FILE_MAX)
            } catch (e: Unreadable) {
                leftOut += leftOut(f.path, f.size, e.message.orEmpty())
                continue
            } catch (_: Exception) {
                leftOut += leftOut(f.path, f.size, "could not be read")
                continue
            }
            if (text == null) {
                leftOut += leftOut(f.path, f.size, "not text")
                continue
            }
            budget -= f.size
            included += buildJsonObject {
                put("path", f.path)
                put("size", f.size)
                put("text", text)
            }
        }
        if (walk.truncated) leftOut += leftOut("…", null, "the skill has more than $ENTRIES_MAX files and folders; the rest is not listed")
        return head.plus("skill_md" to skillMd, "files" to JsonArray(included), "left_out" to JsonArray(leftOut))
    }

    // One file by its path in the skill, as the list gave it. Only paths the walk found can be read.
    private fun readOne(root: Path, name: String, walk: Walk, file: String): Array<Pair<String, Any?>> {
        val want = normalize(file)
        val hit = walk.files.firstOrNull { it.path == want }
        if (hit == null) {
            val link = walk.skipped.firstOrNull { it.path == want || it.path == "$want/" }
            if (link != null) throw ToolError("$want in the skill $name is left out: ${link.reason}.")
            throw ToolError("The skill $name has no file ${SkillText.clip(want, 200)}. Its files: ${walk.files.joinToString(", ") { it.path }}.")
        }
        val text = try {
            readInside(root, hit.abs, ONE_FILE_MAX)
        } catch (e: Unreadable) {
            throw ToolError("$want in the skill $name can't be read: ${e.message}.")
        } catch (_: Exception) {
            throw ToolError("$want in the skill $name can't be read: it could not be read.")
        } ?: throw ToolError("$want in the skill $name is not text.")
        return arrayOf("path" to hit.path, "size" to hit.size, "text" to text)
    }
}
