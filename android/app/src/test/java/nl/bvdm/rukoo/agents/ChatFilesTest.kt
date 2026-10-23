package nl.bvdm.rukoo.agents

import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import nl.bvdm.rukoo.agents.model.ChatFile
import nl.bvdm.rukoo.core.Clock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Staging, caps, keeping and the turn's view of attached files (desktop chatfiles.js). */
class ChatFilesTest {
    private val dir: File = Files.createTempDirectory("rukoo-files").toFile()
    private var now = 1_000_000L
    private val clock = Clock { now }

    private fun files() = ChatFiles(dir, clock)

    private fun src(name: String, bytes: ByteArray, claimed: Long? = bytes.size.toLong()) = FileSource(name, claimed) { ByteArrayInputStream(bytes) }

    private fun text(name: String, body: String) = src(name, body.toByteArray())

    private fun ChatFiles.staged(name: String, body: String): StagedFile = stage(text(name, body)).file ?: error("not staged")

    // A stream that produces [size] bytes without holding them.
    private fun endless(size: Long): InputStream = object : InputStream() {
        var left = size

        override fun read(): Int = if (left-- > 0) 'x'.code else -1

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = minOf(len.toLong(), left).toInt()
            b.fill('x'.code.toByte(), off, off + n)
            left -= n
            return n
        }
    }

    @Test
    fun typesGoByTheNameOrByThePdfBytes() {
        val f = files()
        val notes = f.staged("notes.txt", "hi")
        assertEquals(StagedFile(notes.id, "notes.txt", 2, "text/plain", "text"), notes)
        // report.txt can be a PDF: the bytes decide, never what the picker says.
        val pdf = f.stage(src("report.txt", "%PDF-1.7\n...".toByteArray())).file!!
        assertEquals("application/pdf" to "pdf", pdf.type to pdf.kind)
        assertEquals("image", f.staged("Photo.PNG", "png").kind)
        assertEquals("file", f.staged("Offerte.docx", "PK").kind)
        assertEquals("application/octet-stream" to "file", f.staged("photo.heic", "x").let { it.type to it.kind })
        assertEquals("text", f.staged("data.yml", "a: 1").kind)
        assertTrue(notes.id.matches(Regex("s_[a-z0-9]{16}")))
    }

    @Test
    fun programsAndBigFilesAreRefusedWhateverTheySay() {
        val f = files()
        assertEquals("blocked", f.stage(text("setup.exe", "MZ")).error)
        assertEquals("blocked", f.stage(text("rukoo.apk", "PK")).error)
        // A bidi override can't hide the extension: it becomes _ and the name still ends in .exe.
        assertEquals("blocked", f.stage(text("invoice‮txt.exe", "MZ")).error)
        var opened = false
        val claimed = f.stage(FileSource("big.zip", ChatFiles.FILE_MAX + 1) {
            opened = true
            ByteArrayInputStream(ByteArray(0))
        })
        assertEquals("too-big", claimed.error)
        assertFalse("a file that says it is too big isn't read", opened)
        // A picker that claims a small size gets read up to the cap and no further.
        val lying = f.stage(FileSource("log.txt", 10) { endless(ChatFiles.FILE_MAX + 1) })
        assertEquals("too-big", lying.error)
        val exact = f.stage(FileSource("full.txt", null) { endless(ChatFiles.FILE_MAX) })
        assertNull(exact.error)
        assertEquals(ChatFiles.FILE_MAX, exact.file!!.size)
        assertEquals("unreadable", f.stage(FileSource("gone.txt", 3) { throw SecurityException("grant ended") }).error)
        assertEquals("unreadable", f.stage(FileSource("none.txt", 3) { null }).error)
        // Only the one that fit is left in the folder.
        assertEquals(listOf(exact.file!!.id, "${exact.file!!.id}.json"), File(dir, "staged").list()!!.sorted())
    }

    @Test
    fun namesAreOneSafeFileName() {
        assertEquals("_.._etc_passwd", ChatFiles.cleanName("../../etc/passwd"))
        assertEquals("a_b_c.txt", ChatFiles.cleanName("a<b>c.txt"))
        assertEquals("attachment", ChatFiles.cleanName(" .. "))
        val long = ChatFiles.cleanName("n".repeat(300) + ".markdown")
        assertEquals(150, long.length)
        assertTrue(long.endsWith(".markdown"))
        assertEquals("notes.txt", files().staged("../notes.txt", "x").name.removePrefix("_"))
    }

    @Test
    fun theMessageTakesNoMoreThanItsRoom() {
        val f = files()
        val results = f.stageAll(listOf(text("a.txt", "a"), text("b.exe", "b"), text("c.txt", "c"), text("d.txt", "d")), room = 2)
        assertEquals(listOf(null, "blocked", null, "too-many"), results.map { it.error })
        assertEquals(listOf("a.txt", "b.exe", "c.txt", "d.txt"), results.map { it.name })
        assertEquals(listOf("too-many"), f.stageAll(listOf(text("e.txt", "e")), room = 0).map { it.error })
    }

    @Test
    fun stagedFilesAcrossChatsHaveACap() {
        val f = files()
        repeat(ChatFiles.STAGED_MAX) { f.staged("f$it.txt", "x") }
        assertEquals("full", f.stage(text("one-more.txt", "x")).error)
    }

    @Test
    fun pendingFilesGoAfterTwoHours() {
        val f = files()
        val a = f.staged("a.txt", "a")
        val b = f.staged("b.txt", "b")
        assertEquals(listOf(a.id), f.pending(listOf(a.id, a.id))!!.map { it.id })
        assertNull(f.pending(listOf(a.id, "s_nope")))
        assertEquals(listOf("s_nope"), f.missing(listOf(a.id, "s_nope", "s_nope")))
        now += ChatFiles.STAGED_TTL + 1
        assertNull(f.pending(listOf(b.id)))
        assertEquals(listOf(a.id, b.id), f.missing(listOf(a.id, b.id)))
        f.trim()
        assertEquals(emptyList<String>(), File(dir, "staged").list()!!.toList())
    }

    @Test
    fun stagedFilesSurviveTheAppEnding() {
        val a = files().staged("a.txt", "hello")
        // What an ended copy or a lost record leaves behind goes when the folder is read again.
        File(dir, "staged/s_broken.part").writeText("half")
        File(dir, "staged/s_aaaaaaaaaaaaaaaa").writeText("no record")
        val again = files()
        assertEquals(a, again.staged(a.id))
        assertEquals("hello", again.stagedData(a.id)!!.readText())
        assertEquals(setOf(a.id, "${a.id}.json"), File(dir, "staged").list()!!.toSet())
    }

    @Test
    fun keptFilesMoveIntoTheChatsFolderUnderTheirFileId() {
        val f = files()
        val a = f.staged("Notes <1>.TXT", "hello")
        val b = f.staged("no-extension", "x")
        val kept = f.keep("c_1", f.pending(listOf(a.id, b.id))!!)
        assertEquals(listOf("Notes _1_.TXT", "no-extension"), kept.map { it.name })
        assertTrue(kept[0].file, kept[0].file.matches(Regex("f_[a-z0-9]{10}\\.txt")))
        assertTrue(kept[1].file.matches(Regex("f_[a-z0-9]{10}")))
        assertEquals(now, kept[0].at)
        assertEquals("hello", String(f.read("c_1", kept[0])))
        assertEquals(File(dir, "chats/c_1/${kept[0].file}"), f.path("c_1", kept[0]))
        assertNull(f.staged(a.id))
        assertEquals(emptyList<String>(), File(dir, "staged").list()!!.toList())
    }

    @Test
    fun keepingIsAllOrNothing() {
        val f = files()
        val a = f.staged("a.txt", "a")
        val b = f.staged("b.txt", "b")
        val entries = f.pending(listOf(a.id, b.id))!!
        // The second copy is gone from under it: the first goes back, and both stay staged.
        entries[1].data.delete()
        try {
            f.keep("c_1", entries)
            fail("expected the keep to fail")
        } catch (_: java.io.IOException) {
        }
        assertEquals(emptyList<String>(), File(dir, "chats/c_1").list()!!.toList())
        assertEquals("a", f.stagedData(a.id)!!.readText())
        assertNotNull(f.pending(listOf(a.id)))
    }

    @Test
    fun onlyTheFilesOwnNameCounts() {
        val f = files()
        val evil = ChatFile("f_1", "x", "../../conversations.json", 1, "text/plain", "text")
        assertEquals(File(dir, "chats/c_1/conversations.json"), f.path("c_1", evil))
        assertEquals("c_1", ChatFiles.folderOf("c_1"))
        val odd = ChatFiles.folderOf("../c 1")
        assertTrue(odd, odd.matches(Regex("c_[0-9a-f]{24}")))
    }

    @Test
    fun theTurnGetsTheStartOfEachTextUpTo60000Characters() {
        val f = files()
        val texts = (1..4).map { f.staged("t$it.txt", "$it".repeat(25000)) }
        val png = f.stage(src("small.png", ByteArray(100))).file!!
        val pdf = f.stage(src("c.pdf", "%PDF-1.4".toByteArray())).file!!
        val doc = f.staged("o.docx", "PK")
        val kept = f.keep("c_1", f.pending(texts.map { it.id } + listOf(png.id, pdf.id, doc.id))!!)
        val gone = ChatFile("f_gone000000", "gone.txt", "f_gone000000.txt", 3, "text/plain", "text")
        val turn = f.forTurn("c_1", kept + gone)
        assertEquals(listOf(20000, 20000, 20000), turn.take(3).map { it.text!!.length })
        assertTrue(turn.take(3).all { it.truncated })
        // The fourth gets no text: the others filled the message, read_chat_file has it.
        assertNull(turn[3].text)
        assertTrue(turn[3].omitted)
        assertTrue(turn[4].inline)
        assertEquals("image", turn[4].kind)
        // The phone has no PDF reader: a PDF goes as a file whose text Rukoo could not extract.
        assertEquals("error", turn[5].failed)
        assertNull(turn[6].text)
        assertFalse(turn[6].missing)
        assertTrue(turn[7].missing)
        assertEquals(File(dir, "chats/c_1/${kept[0].file}").absolutePath, turn[0].path)
        assertEquals(TurnFile(kept[4].id, "small.png", "image/png", "image", 100, turn[4].path, inline = true), turn[4].turnFile())
    }

    @Test
    fun aLargeImageGoesAsAFileNotInline() {
        val f = files()
        val big = f.stage(FileSource("big.jpg", null) { endless(ChatFiles.INLINE_IMAGE_MAX + 1) }).file!!
        val kept = f.keep("c_1", f.pending(listOf(big.id))!!)
        assertFalse(f.forTurn("c_1", kept).single().inline)
    }

    @Test
    fun aRemovedChatTakesItsFilesAndPruneTakesFoldersOfGoneChats() {
        val f = files()
        f.keep("c_1", f.pending(listOf(f.staged("a.txt", "a").id))!!)
        f.keep("c_2", f.pending(listOf(f.staged("b.txt", "b").id))!!)
        f.remove("c_1")
        assertFalse(File(dir, "chats/c_1").exists())
        f.prune(listOf("c_3"))
        assertFalse(File(dir, "chats/c_2").exists())
    }
}
