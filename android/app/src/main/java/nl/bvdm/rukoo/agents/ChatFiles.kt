package nl.bvdm.rukoo.agents

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import nl.bvdm.rukoo.agents.model.ChatFile
import nl.bvdm.rukoo.agents.model.ShownFile
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.Ids
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.mcp.tools.FileResults

/** A file waiting for the message being written (chatfiles.js shown()): what the input and the transcript see of it. */
@Serializable
data class StagedFile(val id: String, val name: String, val size: Long, val type: String, val kind: String)

/** What staging one file did: [file] when it waits for the message, else [error]: blocked, too-big, full, unreadable or too-many. */
data class StageResult(val name: String, val file: StagedFile? = null, val error: String? = null)

/**
 * A file the user picked: the name the picker gave, the size it claimed (null when it said none) and how to read it.
 * Neither the name nor the size is trusted: the name is cleaned and the read stops past [ChatFiles.FILE_MAX].
 */
class FileSource(val name: String, val claimedSize: Long?, val open: () -> InputStream?)

/**
 * A file of this turn as forTurn() hands it on (chatfiles.js forTurn): to the turn text with the start of its text,
 * and to the adapter as a [TurnFile]. [missing]: Rukoo could not read its copy. [omitted]: the files before it used
 * up [ChatFiles.TURN_TEXT_MAX]. [inline]: an image small enough to go along as an image.
 */
@Serializable
data class AttachedFile(
    val id: String,
    val name: String,
    val size: Long,
    val type: String,
    val kind: String,
    val path: String,
    val missing: Boolean = false,
    val text: String? = null,
    val truncated: Boolean = false,
    val omitted: Boolean = false,
    val partial: Boolean = false,
    val failed: String? = null,
    val encrypted: Boolean = false,
    val inline: Boolean = false,
) {
    fun turnFile() = TurnFile(id, name, type, kind, size, path, inline)
}

/**
 * Files the user attaches to a chat message, a port of desktop's chatfiles.js. Until the message goes out a picked
 * file waits in [root]/staged, copied in at once because a picker's grant on the file can end; the input holds only
 * a token for it. Sent, it moves into the chat's own folder under [root]/chats, named after its file_id, and every
 * agent reads it with read_chat_file. The folder survives a restart and goes with the chat.
 *
 * Desktop keeps staged files in memory. The phone keeps them on disk with a small record each, because Android can
 * end the app while the user is in another app, and the input keeps its chips across that.
 *
 * Every method reads or writes files: call it off the main thread.
 */
class ChatFiles(private val root: File, private val clock: Clock = Clock.System) {
    private val chats = File(root, "chats")
    private val stagedDir = File(root, "staged")
    private val lock = Any()
    private val staged = LinkedHashMap<String, Staged>()
    private var loaded = false

    /** A staged file and its copy on disk. */
    class Staged internal constructor(
        val id: String,
        val name: String,
        val size: Long,
        val type: String,
        val kind: String,
        val at: Long,
        val data: File,
    ) {
        fun shown() = StagedFile(id, name, size, type, kind)
    }

    @Serializable
    private data class Record(val id: String, val name: String, val size: Long, val type: String, val kind: String, val at: Long)

    // ---------- staging ----------

    /** Why a file can't go to an agent, known before Rukoo reads it: a program or script, or too big. null when it can. */
    fun refuse(name: String, size: Long?): String? {
        if (FileResults.RISKY.containsMatchIn(cleanName(name))) return "blocked"
        if (size != null && size > FILE_MAX) return "too-big"
        return null
    }

    /**
     * The files the user picked, staged in the order picked (chatfiles.js stagePaths). [room]: how many more the
     * message takes; past it a file is neither read nor staged ('too-many').
     */
    fun stageAll(sources: List<FileSource>, room: Int): List<StageResult> {
        var left = room.coerceIn(0, MAX_FILES)
        return sources.map { source ->
            if (left == 0) {
                StageResult(cleanName(source.name), error = "too-many")
            } else {
                stage(source).also { if (it.error == null) left-- }
            }
        }
    }

    /**
     * Keeps a file for a message the user is writing. The size the picker claims only refuses a file early; the
     * copy stops past [FILE_MAX] whatever it said, so a file that grew or lied is refused as too big, never read whole.
     */
    fun stage(source: FileSource): StageResult {
        val clean = cleanName(source.name)
        refuse(clean, source.claimedSize)?.let { return StageResult(clean, error = it) }
        synchronized(lock) {
            loadLocked()
            trimLocked()
            if (staged.size >= STAGED_MAX) return StageResult(clean, error = "full")
        }
        val id = "s_${Ids.rand(16)}"
        stagedDir.mkdirs()
        val part = File(stagedDir, "$id.part")
        val head = ByteArray(HEAD)
        var headSize = 0
        var size = 0L
        try {
            val input = source.open() ?: return StageResult(clean, error = "unreadable")
            input.use { stream ->
                part.outputStream().use { out ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val n = stream.read(buffer)
                        if (n < 0) break
                        if (headSize < HEAD) {
                            val take = minOf(n, HEAD - headSize)
                            System.arraycopy(buffer, 0, head, headSize, take)
                            headSize += take
                        }
                        size += n
                        if (size > FILE_MAX) break
                        out.write(buffer, 0, n)
                    }
                }
            }
        } catch (e: Exception) {
            part.delete()
            AppLog.w(TAG, "a picked file could not be read", e)
            return StageResult(clean, error = "unreadable")
        }
        if (size > FILE_MAX) {
            part.delete()
            return StageResult(clean, error = "too-big")
        }
        val type = typeOf(clean, head.copyOf(headSize))
        val entry = Staged(id, clean, size, type, kindOf(clean, type), clock.now(), File(stagedDir, id))
        synchronized(lock) {
            loadLocked()
            trimLocked()
            val bytes = staged.values.sumOf { it.size }
            if (staged.size >= STAGED_MAX || bytes + size > STAGED_BYTES) {
                part.delete()
                return StageResult(clean, error = "full")
            }
            try {
                if (!part.renameTo(entry.data)) throw IOException("could not keep the staged file")
                recordOf(id).writeText(RukooJson.encodeToString(Record.serializer(), Record(id, clean, size, type, entry.kind, entry.at)))
            } catch (e: IOException) {
                part.delete()
                entry.data.delete()
                recordOf(id).delete()
                AppLog.w(TAG, "a picked file could not be kept", e)
                return StageResult(clean, error = "unreadable")
            }
            staged[id] = entry
        }
        return StageResult(clean, entry.shown())
    }

    fun unstage(id: String): Boolean = synchronized(lock) {
        loadLocked()
        val s = staged.remove(id) ?: return@synchronized false
        s.data.delete()
        recordOf(id).delete()
        true
    }

    /** The staged file this token names, while it waits. */
    fun staged(id: String): StagedFile? = synchronized(lock) {
        loadLocked()
        staged[id]?.takeIf { fresh(it) }?.shown()
    }

    /** The copy of a staged file, for a thumbnail. */
    fun stagedData(id: String): File? = synchronized(lock) {
        loadLocked()
        staged[id]?.takeIf { fresh(it) }?.data
    }

    /** The tokens of these that name no staged file (any more). */
    fun missing(ids: List<String>): List<String> = ids.distinct().filter { pending(listOf(it)) == null }

    /** The staged files these tokens name, or null when one of them is gone, also when it is past [STAGED_TTL]. */
    fun pending(ids: List<String>): List<Staged>? = synchronized(lock) {
        loadLocked()
        val out = mutableListOf<Staged>()
        for (id in ids) {
            val s = staged[id]
            if (s == null || !fresh(s)) return@synchronized null
            if (s !in out) out += s
        }
        out
    }

    /** Lets go of the staged files past [STAGED_TTL]. */
    fun trim() = synchronized(lock) {
        loadLocked()
        trimLocked()
    }

    private fun fresh(s: Staged) = clock.now() - s.at <= STAGED_TTL

    private fun trimLocked() {
        for (s in staged.values.toList()) {
            if (fresh(s)) continue
            staged.remove(s.id)
            s.data.delete()
            recordOf(s.id).delete()
        }
    }

    private fun recordOf(id: String) = File(stagedDir, "$id.json")

    // The staged files of an earlier run of the app, still there for the chips the input kept. Anything else in the
    // folder (a copy that broke off, a record without its file) goes.
    private fun loadLocked() {
        if (loaded) return
        loaded = true
        val names = stagedDir.listFiles() ?: return
        val keep = HashSet<String>()
        for (f in names) {
            if (!f.name.endsWith(".json")) continue
            val r = runCatching { RukooJson.decodeFromString(Record.serializer(), f.readText()) }.getOrNull() ?: continue
            val data = File(stagedDir, r.id)
            if (!STAGED_ID.matches(r.id) || "${r.id}.json" != f.name || !data.isFile || data.length() != r.size) continue
            val s = Staged(r.id, cleanName(r.name), r.size, r.type, r.kind, r.at, data)
            if (!fresh(s)) continue
            staged[r.id] = s
            keep += r.id
            keep += f.name
        }
        for (f in names) if (f.name !in keep) f.deleteRecursively()
    }

    // ---------- sent files ----------

    fun dir(cid: String): File = File(chats, folderOf(cid))

    /** Only the file's own name counts, so a changed conversations.json can't point anywhere else. */
    fun path(cid: String, f: ChatFile): File = File(dir(cid), File(f.file).name)

    /** A kept file's bytes, at most [FILE_MAX]: what Rukoo kept is never larger. */
    fun read(cid: String, f: ChatFile): ByteArray = readCapped(path(cid, f), FILE_MAX)

    /**
     * Moves staged files into the chat's folder and forgets them. Returns what the chat keeps of each. A copy is
     * named after its file_id: the user's file name can be anyone's text. All or nothing: when one fails (a full
     * disk), the ones moved so far go back and every file stays staged, so the message can be sent again as it was.
     */
    fun keep(cid: String, entries: List<Staged>): List<ChatFile> = synchronized(lock) {
        val dir = dir(cid)
        dir.mkdirs()
        val kept = mutableListOf<ChatFile>()
        // Each file where it went, and whether it was moved (else copied).
        val done = mutableListOf<Triple<Staged, File, Boolean>>()
        try {
            for (s in entries) {
                val id = "f_${Ids.rand(10)}"
                val ext = extname(s.name).lowercase()
                val file = "$id${if (EXT.matches(ext)) ext else ""}"
                val full = File(dir, file)
                if (s.data.renameTo(full)) {
                    done += Triple(s, full, true)
                } else {
                    s.data.copyTo(full, overwrite = false)
                    done += Triple(s, full, false)
                }
                kept += ChatFile(id, s.name, file, s.size, s.type, s.kind, clock.now())
            }
        } catch (e: Exception) {
            for ((s, full, moved) in done) if (moved) full.renameTo(s.data) else full.delete()
            throw if (e is IOException) e else IOException(e)
        }
        for (s in entries) {
            staged.remove(s.id)
            s.data.delete()
            recordOf(s.id).delete()
        }
        kept
    }

    /**
     * What goes along with the message: each file with its path, and the start of its text for text files; the text
     * shares [TURN_TEXT_MAX] in order. The phone has no PDF reader, so a PDF goes as a file whose text Rukoo could
     * not extract, as read_chat_file hands it out (FileResults).
     */
    fun forTurn(cid: String, files: List<ChatFile>): List<AttachedFile> {
        var room = TURN_TEXT_MAX
        return files.map { f ->
            val file = path(cid, f)
            val out = AttachedFile(f.id, f.name, f.size, f.type, f.kind, file.absolutePath)
            if (!file.isFile) return@map out.copy(missing = true)
            val max = minOf(FILE_TEXT_INLINE, room)
            val done = when (f.kind) {
                "text" -> {
                    val data = try {
                        read(cid, f)
                    } catch (_: Exception) {
                        return@map out.copy(missing = true)
                    }
                    if (max > 0) {
                        val text = FileResults.decodeText(data)
                        out.copy(text = text.take(max), truncated = text.length > max)
                    } else {
                        // The files before it used up TURN_TEXT_MAX; read_chat_file returns it.
                        out.copy(omitted = data.isNotEmpty())
                    }
                }
                "pdf" -> out.copy(failed = "error")
                // Only its size counts here: an adapter that sends it along reads it itself.
                "image" -> out.copy(inline = file.length() <= INLINE_IMAGE_MAX)
                else -> out
            }
            room -= done.text?.length ?: 0
            done
        }
    }

    fun remove(cid: String) {
        if (!dir(cid).deleteRecursively()) AppLog.w(TAG, "a chat's files could not all be removed")
    }

    /** Folders of chats that are gone: removed while the app was closed, or a removal that broke off. */
    fun prune(cids: Collection<String>) {
        val known = cids.map(::folderOf).toSet()
        for (f in chats.listFiles() ?: return) if (f.name !in known) f.deleteRecursively()
    }

    companion object {
        private const val TAG = "ChatFiles"

        /** The same cap as read_attachment's. */
        const val FILE_MAX = 10L * 1024 * 1024
        const val MAX_FILES = 10

        // Files staged but not sent yet, across chats. Past these a new file is refused ('full'): a file that waits is
        // never let go of to make room for another.
        const val STAGED_MAX = 30
        const val STAGED_BYTES = 120L * 1024 * 1024
        const val STAGED_TTL = 2 * 60 * 60 * 1000L

        /** How much of a file's text goes along with the message; read_chat_file returns more. */
        const val FILE_TEXT_INLINE = 20000
        const val TURN_TEXT_MAX = 60000

        /** Images up to this size go along with the message itself (Claude Code, Codex); floor(3.75 MiB). */
        const val INLINE_IMAGE_MAX = 3_932_160L

        private const val HEAD = 1024
        private val STAGED_ID = Regex("^s_[a-z0-9]{16}$")
        private val EXT = Regex("^\\.[a-z0-9]{1,10}$")
        private val FOLDER = Regex("^[A-Za-z0-9_-]{1,100}$")

        private val TEXT_TYPES = Regex("^(text/|application/(json|xml|csv|x-yaml|yaml|ics)\\b)")
        private val TEXT_EXT = Regex("\\.(csv|md|markdown|ics|txt|json|xml|yaml|yml|log|vcf)$", RegexOption.IGNORE_CASE)
        private val IMAGE_TYPES = Regex("^image/(png|jpeg|gif|webp)$")
        private val TYPES = mapOf(
            "pdf" to "application/pdf",
            "txt" to "text/plain",
            "log" to "text/plain",
            "md" to "text/markdown",
            "markdown" to "text/markdown",
            "csv" to "text/csv",
            "tsv" to "text/tab-separated-values",
            "json" to "application/json",
            "xml" to "application/xml",
            "yaml" to "application/yaml",
            "yml" to "application/yaml",
            "ics" to "text/calendar",
            "vcf" to "text/vcard",
            "html" to "text/html",
            "htm" to "text/html",
            "png" to "image/png",
            "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg",
            "gif" to "image/gif",
            "webp" to "image/webp",
            "svg" to "image/svg+xml",
            "eml" to "message/rfc822",
            "doc" to "application/msword",
            "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xls" to "application/vnd.ms-excel",
            "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "ppt" to "application/vnd.ms-powerpoint",
            "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "odt" to "application/vnd.oasis.opendocument.text",
            "rtf" to "application/rtf",
            "zip" to "application/zip",
        )

        /** Node's path.extname: from the last dot of the name, unless that dot starts it. */
        internal fun extname(name: String): String {
            val i = name.lastIndexOf('.')
            return if (i <= 0) "" else name.substring(i)
        }

        /** The type goes by the name, or by the bytes for a PDF; never by what the picker says. */
        fun typeOf(name: String, head: ByteArray): String {
            if (FileResults.isPdf(head)) return "application/pdf"
            return TYPES[extname(name).drop(1).lowercase()] ?: "application/octet-stream"
        }

        /** What Rukoo does with it: 'text' and 'pdf' go along as text, 'image' as an image, 'file' as the file alone. */
        fun kindOf(name: String, type: String): String = when {
            type == "application/pdf" -> "pdf"
            IMAGE_TYPES.matches(type) -> "image"
            TEXT_TYPES.containsMatchIn(type) || TEXT_EXT.containsMatchIn(name) -> "text"
            else -> "file"
        }

        /** One file name, no folders, at most 150 characters with its extension (files.js safeName). */
        fun cleanName(name: String): String {
            val n = FileResults.safeName(name)
            if (n.length <= 150) return n
            val ext = extname(n).take(20)
            return n.take(150 - ext.length) + ext
        }

        /** A chat's folder name. Rukoo's ids are safe as they are; anything else becomes a hash, so no id can point outside. */
        fun folderOf(cid: String): String {
            if (FOLDER.matches(cid)) return cid
            val hash = MessageDigest.getInstance("SHA-256").digest(cid.toByteArray(Charsets.UTF_8))
            return "c_" + hash.joinToString("") { "%02x".format(it) }.take(24)
        }

        /** What the transcript keeps of a sent file. */
        fun shown(f: ChatFile) = ShownFile(f.id, f.name, f.size, f.type, f.kind)

        /** A file's bytes, read up to [max]; throws when it holds more, whatever its size said before. */
        fun readCapped(file: File, max: Long): ByteArray = file.inputStream().use { input ->
            val out = java.io.ByteArrayOutputStream(minOf(file.length(), max).toInt().coerceAtLeast(0))
            val buffer = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                total += n
                if (total > max) throw IOException("the file is larger than $max bytes")
                out.write(buffer, 0, n)
            }
            out.toByteArray()
        }
    }
}
