package nl.bvdm.rukoo.agents

import android.content.res.AssetManager
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import nl.bvdm.rukoo.agents.model.RukooSkill
import nl.bvdm.rukoo.core.AppLog

/** One entry of a skills folder: what lstat says (or stat, for a skill folder that may be a link). */
data class SkillStat(val file: Boolean, val directory: Boolean, val link: Boolean, val size: Long)

/**
 * A folder of skills: the app's bundled assets or the user's folder in the app's files. Paths are relative
 * and use `/`; "" is the folder itself.
 */
interface SkillTree {
    /** The names in a folder, or null when it isn't one or can't be read. */
    fun list(path: String): List<String>?

    /** [follow] resolves a link first, as stat does; otherwise as lstat. Null when it doesn't exist. */
    fun stat(path: String, follow: Boolean = false): SkillStat?

    fun read(path: String): ByteArray

    /** Whether [path], links resolved, lies inside the skill folder [skill]. */
    fun inside(skill: String, path: String): Boolean
}

/** Skills on disk: the user's own, in `filesDir/skills`, and the repository's folder in tests. */
class FileSkillTree(private val root: File) : SkillTree {
    private fun file(path: String) = if (path.isEmpty()) root else File(root, path)

    override fun list(path: String): List<String>? = file(path).takeIf { it.isDirectory }?.list()?.toList()

    override fun stat(path: String, follow: Boolean): SkillStat? = try {
        val p = file(path).toPath()
        val attrs = if (follow) Files.readAttributes(p, BasicFileAttributes::class.java) else Files.readAttributes(p, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        SkillStat(attrs.isRegularFile, attrs.isDirectory, attrs.isSymbolicLink, attrs.size())
    } catch (_: IOException) {
        null
    }

    override fun read(path: String): ByteArray = file(path).readBytes()

    override fun inside(skill: String, path: String): Boolean = try {
        val base = file(skill).canonicalFile
        val real = file(path).canonicalFile
        real != base && real.path.startsWith(base.path + File.separator)
    } catch (_: IOException) {
        false
    }
}

/** Rukoo's bundled skills in the APK's assets (the repository's skills/ folder, under `skills/`). Assets have no links. */
class AssetSkillTree(private val assets: AssetManager, private val base: String = "skills") : SkillTree {
    private fun path(p: String) = if (p.isEmpty()) base else "$base/$p"

    // AssetManager.list() is empty for a file and for something missing; only an open tells them apart.
    private fun names(p: String): List<String>? = try {
        assets.list(path(p))?.toList()
    } catch (_: IOException) {
        null
    }

    private fun isFile(p: String): Boolean = try {
        assets.open(path(p)).close()
        true
    } catch (_: IOException) {
        false
    }

    override fun list(path: String): List<String>? = names(path)?.takeIf { it.isNotEmpty() }

    override fun stat(path: String, follow: Boolean): SkillStat? {
        val inside = names(path)
        if (!inside.isNullOrEmpty()) return SkillStat(file = false, directory = true, link = false, size = 0)
        if (!isFile(path)) return null
        return SkillStat(file = true, directory = false, link = false, size = read(path).size.toLong())
    }

    override fun read(path: String): ByteArray = assets.open(path(path)).use { it.readBytes() }

    override fun inside(skill: String, path: String): Boolean = path.startsWith("$skill/")
}

/**
 * Rukoo's skills, a port of desktop's skills.js: folders in the Agent Skills format with a SKILL.md
 * (frontmatter with a name and a description) and files next to it. Bundled ones come from the APK, the
 * user's from the app's files; a user skill replaces the bundled one with the same name. Both are read
 * again on every call, so a changed skill counts at once. Skills come from Rukoo or the user, never from
 * an email, so nothing here goes inside `<unsafe_content>`.
 */
class RukooSkills(private val bundled: SkillTree?, private val user: SkillTree?) {
    /** A loaded skill. [folder] is its path in [tree]; [text] the whole SKILL.md. */
    class Skill(
        val name: String,
        val description: String,
        val source: String,
        val tree: SkillTree,
        val folder: String,
        val text: String,
        val body: String,
        var replaces: Boolean = false,
    ) {
        fun toModel() = RukooSkill(name, description, source, body)
    }

    data class Skipped(val source: String, val folder: String, val reason: String)

    private class Loaded(val skills: Map<String, Skill>, val skipped: List<Skipped>)

    private val logged = HashSet<String>()

    private fun load(): Loaded {
        val skills = LinkedHashMap<String, Skill>()
        val skipped = mutableListOf<Skipped>()
        for ((source, tree) in listOf("rukoo" to bundled, "user" to user)) {
            for (skill in loadFolder(source, tree, skipped)) {
                if (skill.name in skills) skill.replaces = true
                skills[skill.name] = skill
            }
        }
        // A skill the user wrote that Rukoo skips should be easy to find out about.
        synchronized(logged) {
            for (s in skipped) {
                val line = "skipped the ${if (s.source == "user") "user's" else "Rukoo's"} skill \"${s.folder}\": ${s.reason}"
                if (logged.add(line)) AppLog.w(TAG, line)
            }
        }
        return Loaded(skills, skipped)
    }

    private fun loadFolder(source: String, tree: SkillTree?, skipped: MutableList<Skipped>): List<Skill> {
        val out = mutableListOf<Skill>()
        if (tree == null) return out
        // No folder is the normal case for the user's skills.
        val names = tree.list("")?.sorted() ?: return out
        var count = 0
        for (folder in names) {
            if (folder.startsWith(".")) continue
            // stat, not lstat: a linked skill folder counts. Files such as README.md are not skills.
            if (tree.stat(folder, follow = true)?.directory != true) continue
            if (++count > SKILLS_MAX) {
                skipped += Skipped(source, folder, "the folder has more than $SKILLS_MAX skills")
                break
            }
            try {
                out += loadSkill(tree, folder, source)
            } catch (e: SkillException) {
                skipped += Skipped(source, folder, e.message.orEmpty())
            } catch (e: IOException) {
                skipped += Skipped(source, folder, "it could not be read (${e.javaClass.simpleName})")
            }
        }
        return out
    }

    private fun loadSkill(tree: SkillTree, folder: String, source: String): Skill {
        if (folder.length > NAME_MAX || !NAME.matches(folder)) {
            throw SkillException("the folder name must be lowercase letters, digits and single hyphens, at most $NAME_MAX characters")
        }
        if (tree.list(folder)?.contains("SKILL.md") != true) throw SkillException("it has no SKILL.md")
        val file = "$folder/SKILL.md"
        val st = tree.stat(file) ?: throw SkillException("it has no SKILL.md")
        if (st.link || !st.file) throw SkillException("SKILL.md is a link or a folder, not a file")
        if (st.size > SKILL_MD_MAX) throw SkillException("SKILL.md is ${kb(st.size)}; the most Rukoo reads is ${kb(SKILL_MD_MAX.toLong())}")
        val text = decodeText(tree.read(file)) ?: throw SkillException("SKILL.md is not UTF-8 text")
        val parsed = SkillFrontmatter.parse(text)
        val name = parsed.data["name"] as? String
        val description = parsed.data["description"] as? String
        if (name == null || name.isBlank()) throw SkillException("the frontmatter has no name")
        if (jsTrim(name) != folder) throw SkillException("its name \"${clip(jsTrim(name), 80)}\" is not the name of its folder")
        if (description == null || description.isBlank()) throw SkillException("the frontmatter has no description")
        val oneLine = jsOneLine(description)
        if (oneLine.length > DESCRIPTION_MAX) throw SkillException("the description is ${oneLine.length} characters; at most $DESCRIPTION_MAX")
        return Skill(folder, oneLine, source, tree, folder, text.removePrefix("﻿"), jsTrim(parsed.body))
    }

    /** Every usable skill, by name. */
    fun list(): List<Skill> = load().skills.values.sortedBy { it.name }

    fun get(name: String): Skill? = load().skills[name]

    /** The skills as the UI and the hub use them. */
    fun models(): List<RukooSkill> = list().map { it.toModel() }

    private data class WalkFile(val path: String, val size: Long)

    private data class LeftOut(val path: String, val size: Long?, val reason: String)

    private class Walk(val files: List<WalkFile>, val skipped: List<LeftOut>, val truncated: Boolean)

    // Every file in a skill folder, without following links and without dot files such as .git.
    private fun walk(skill: Skill): Walk {
        val tree = skill.tree
        val files = mutableListOf<WalkFile>()
        val skipped = mutableListOf<LeftOut>()
        var entries = 0
        var truncated = false
        fun visit(dir: String, rel: String, depth: Int) {
            val names = tree.list(dir)?.sorted()
            if (names == null) {
                skipped += LeftOut(if (rel.isNotEmpty()) "$rel/" else ".", null, "could not be read")
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
                val abs = "$dir/$name"
                val st = tree.stat(abs) ?: continue
                when {
                    // Links and junctions could point anywhere on the disk.
                    st.link -> skipped += LeftOut(relPath, null, "a link; Rukoo does not follow links inside a skill")
                    !tree.inside(skill.folder, abs) -> skipped += LeftOut(relPath, null, "outside the skill folder")
                    st.directory -> if (depth + 1 > DEPTH_MAX) skipped += LeftOut("$relPath/", null, "nested more than $DEPTH_MAX folders deep") else visit(abs, relPath, depth + 1)
                    st.file -> files += WalkFile(relPath, st.size)
                }
            }
        }
        visit(skill.folder, "", 0)
        return Walk(files, skipped, truncated)
    }

    // A regular file inside the skill, checked again right before reading. Null when it isn't text.
    private fun readInside(skill: Skill, rel: String, max: Long): String? {
        val path = "${skill.folder}/$rel"
        val st = skill.tree.stat(path)
        if (st == null || st.link || !st.file || !skill.tree.inside(skill.folder, path)) throw SkillException("not a file inside the skill folder")
        if (st.size > max) throw SkillException("${kb(st.size)}, more than ${kb(max)}")
        return decodeText(skill.tree.read(path))
    }

    /**
     * What read_skill returns (skills.js read()). Without a name: the list. With [file]: that one file.
     * Otherwise SKILL.md and as many of the other text files as fit, with what was left out and why.
     * Throws [SkillException] with the desktop's texts.
     */
    fun read(name: String? = null, file: String? = null): JsonObject {
        val loaded = load()
        val all = loaded.skills.values.sortedBy { it.name }
        if (name.isNullOrEmpty()) {
            return buildJsonObject {
                putJsonArray("skills") {
                    for (s in all) addJsonObject { put("name", s.name); put("description", s.description); put("source", s.source) }
                }
                if (loaded.skipped.isNotEmpty()) {
                    putJsonArray("skipped") {
                        for (s in loaded.skipped) addJsonObject { put("source", s.source); put("folder", s.folder); put("reason", s.reason) }
                    }
                }
            }
        }
        val skill = loaded.skills[name] ?: run {
            val known = all.joinToString(", ") { it.name }
            throw SkillException("There is no skill named \"${clip(name, 80)}\". ${if (known.isNotEmpty()) "Skills: $known." else "There are no skills."}")
        }
        val walked = walk(skill)
        if (!file.isNullOrEmpty()) return readOne(skill, walked, file)
        val included = mutableListOf<Triple<String, Long, String>>()
        val leftOut = walked.skipped.toMutableList()
        var budget = TOTAL_MAX - skill.text.toByteArray(Charsets.UTF_8).size.toLong()
        for (f in walked.files) {
            if (f.path == "SKILL.md") continue
            if (f.size > FILE_MAX) {
                leftOut += LeftOut(f.path, f.size, if (f.size > ONE_FILE_MAX) "too large to read" else "too large to include; ask for it with file")
                continue
            }
            if (f.size > budget) {
                leftOut += LeftOut(f.path, f.size, "did not fit in this answer; ask for it with file")
                continue
            }
            val text = try {
                readInside(skill, f.path, FILE_MAX.toLong())
            } catch (e: SkillException) {
                leftOut += LeftOut(f.path, f.size, e.message.orEmpty())
                continue
            } catch (_: IOException) {
                leftOut += LeftOut(f.path, f.size, "could not be read")
                continue
            }
            if (text == null) {
                leftOut += LeftOut(f.path, f.size, "not text")
                continue
            }
            budget -= f.size
            included += Triple(f.path, f.size, text)
        }
        if (walked.truncated) leftOut += LeftOut("…", null, "the skill has more than $ENTRIES_MAX files and folders; the rest is not listed")
        return buildJsonObject {
            put("name", skill.name)
            put("description", skill.description)
            put("source", skill.source)
            put("skill_md", skill.text)
            putJsonArray("files") { for ((p, s, t) in included) addJsonObject { put("path", p); put("size", s); put("text", t) } }
            putJsonArray("left_out") {
                for (l in leftOut) addJsonObject {
                    put("path", l.path)
                    if (l.size != null) put("size", l.size)
                    put("reason", l.reason)
                }
            }
            if (skill.replaces) put("replaces", "Rukoo's skill with the same name")
        }
    }

    // One file by its path in the skill, as the list gave it: only paths the walk found are read.
    private fun readOne(skill: Skill, walked: Walk, file: String): JsonObject {
        val want = file.replace('\\', '/').replace(Regex("^(?:\\./)+"), "")
        val hit = walked.files.firstOrNull { it.path == want }
        if (hit == null) {
            val link = walked.skipped.firstOrNull { it.path == want || it.path == "$want/" }
            if (link != null) throw SkillException("$want in the skill ${skill.name} is left out: ${link.reason}.")
            throw SkillException("The skill ${skill.name} has no file ${clip(want, 200)}. Its files: ${walked.files.joinToString(", ") { it.path }}.")
        }
        val text = try {
            readInside(skill, hit.path, ONE_FILE_MAX.toLong())
        } catch (e: SkillException) {
            throw SkillException("$want in the skill ${skill.name} can't be read: ${e.message}.")
        } catch (_: IOException) {
            throw SkillException("$want in the skill ${skill.name} can't be read: it could not be read.")
        } ?: throw SkillException("$want in the skill ${skill.name} is not text.")
        return buildJsonObject {
            put("name", skill.name)
            put("description", skill.description)
            put("source", skill.source)
            put("path", hit.path)
            put("size", hit.size)
            put("text", text)
        }
    }

    companion object {
        private const val TAG = "Skills"

        /** The Agent Skills rules for a name: lowercase letters, digits and single hyphens, at most 64 characters. */
        val NAME = Regex("^[a-z0-9]+(?:-[a-z0-9]+)*$")
        const val NAME_MAX = 64
        const val DESCRIPTION_MAX = 1024
        const val SKILL_MD_MAX = 64 * 1024
        const val FILE_MAX = 32 * 1024
        const val TOTAL_MAX = 64 * 1024
        const val ONE_FILE_MAX = 64 * 1024
        const val ENTRIES_MAX = 200
        const val DEPTH_MAX = 5
        const val SKILLS_MAX = 100

        /** Claude Code cuts an MCP server's instructions and each tool description at 2048 characters. */
        const val MCP_TEXT_MAX = 2048
        const val LISTED_DESCRIPTION_MIN = 60

        private const val INTRO =
            "Rukoo has skills: instructions for email tasks, written by Rukoo or by the user. They are not email content. When the user asks for a skill, or a task matches a skill's description, call read_skill with its name and follow it. The skills:\n"
        private const val TOOL_BASE =
            "Returns one of Rukoo's skills: instructions for an email task, written by Rukoo or by the user, not taken from an email. You get SKILL.md and the text files next to it (scripts, references), and a list of what was left out. Pass file to read one of the skill's files. Without a name it lists the skills. Follow a skill when the user asks for it or the task matches its description."

        /** The app's skills: bundled in the APK's assets and the user's in `filesDir/skills`. */
        fun forApp(assets: AssetManager, filesDir: File) = RukooSkills(AssetSkillTree(assets), FileSkillTree(File(filesDir, "skills")))

        private fun kb(n: Long) = "${(n + 1023) / 1024} KB"

        private fun clip(v: String, max: Int) = if (v.length > max) "${v.take(max - 1)}…" else v

        /** UTF-8 text without its byte order mark and with \n line ends, or null for anything else. */
        fun decodeText(bytes: ByteArray): String? {
            if (bytes.any { it == 0.toByte() }) return null
            val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            val text = try {
                decoder.decode(ByteBuffer.wrap(bytes)).toString()
            } catch (_: CharacterCodingException) {
                return null
            }
            return text.removePrefix("﻿").replace(Regex("\r\n?"), "\n")
        }

        private fun listLine(s: RukooSkill, cap: Int) = "- ${s.name}: ${clip(s.description, cap)}"

        private fun more(n: Int) = "- and $n more; read_skill without a name lists them all."

        // One line per skill in at most room characters; descriptions cut to the longest length that fits all.
        private fun listLines(list: List<RukooSkill>, room: Int): String {
            fun size(cap: Int) = list.sumOf { listLine(it, cap).length + 1 } - 1
            var cap = DESCRIPTION_MAX
            if (size(cap) > room && size(LISTED_DESCRIPTION_MIN) <= room) {
                var lo = LISTED_DESCRIPTION_MIN
                var hi = DESCRIPTION_MAX
                while (lo < hi) {
                    val mid = (lo + hi + 1) / 2
                    if (size(mid) <= room) lo = mid else hi = mid - 1
                }
                cap = lo
            }
            if (size(cap) <= room) return list.joinToString("\n") { listLine(it, cap) }
            val lines = mutableListOf<String>()
            var used = 0
            for (i in list.indices) {
                val line = listLine(list[i], LISTED_DESCRIPTION_MIN)
                if (used + line.length + 1 + more(list.size - i - 1).length > room) {
                    lines += more(list.size - i)
                    break
                }
                lines += line
                used += line.length + 1
            }
            return lines.joinToString("\n")
        }

        /** The part of Rukoo's MCP instructions about skills, in at most [room] characters, or "" (skills.js instructions()). */
        fun instructions(list: List<RukooSkill>, room: Int = MCP_TEXT_MAX): String {
            if (list.isEmpty()) return ""
            return INTRO + listLines(list, room - INTRO.length)
        }

        /** read_skill's description, with the list, since not every agent passes MCP instructions on (skills.js toolDescription()). */
        fun toolDescription(list: List<RukooSkill>): String {
            if (list.isEmpty()) return "$TOOL_BASE There are no skills yet."
            val head = "$TOOL_BASE Skills:\n"
            return head + listLines(list, MCP_TEXT_MAX - head.length)
        }
    }
}
