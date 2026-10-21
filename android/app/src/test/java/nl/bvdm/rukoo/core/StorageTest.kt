package nl.bvdm.rukoo.core

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.Serializable
import nl.bvdm.rukoo.agents.AgentSettings
import nl.bvdm.rukoo.agents.AgentSettingsStore
import nl.bvdm.rukoo.agents.ClarkSettings
import nl.bvdm.rukoo.agents.PairedComputer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StorageTest {
    @Serializable
    data class Sample(val name: String = "", val count: Int = 0)

    private fun dir(): File = Files.createTempDirectory("rukoo-test").toFile().apply { deleteOnExit() }

    @Test
    fun writesAtomicallyAndReadsBack() {
        val file = File(dir(), "sample.json")
        assertEquals(Sample("default"), JsonFiles.read(file, Sample.serializer(), Sample("default")))
        JsonFiles.write(file, Sample.serializer(), Sample("a", 1))
        JsonFiles.write(file, Sample.serializer(), Sample("b", 2))
        assertEquals(Sample("b", 2), JsonFiles.read(file, Sample.serializer(), Sample()))
        // No temp files left behind.
        assertEquals(listOf("sample.json"), file.parentFile!!.list()!!.toList())
    }

    @Test
    fun movesABadFileAside() {
        val d = dir()
        val file = File(d, "sample.json")
        file.writeText("{not json")
        assertEquals(Sample("default"), JsonFiles.read(file, Sample.serializer(), Sample("default"), clock = { 42 }))
        assertFalse(file.exists())
        assertTrue(File(d, "sample.json.bad-42").exists())
    }

    // Wraps instead of encrypting, so the test can see what reaches the disk.
    private val fakeCipher = object : SecretCipher {
        override fun encrypt(plain: String) = "X" + plain.reversed()
        override fun decrypt(blob: String) = if (blob.startsWith("X")) blob.drop(1).reversed() else null
    }

    @Test
    fun agentSecretsAreEncryptedOnDisk() = runTest {
        val file = File(dir(), AgentSettingsStore.FILE_NAME)
        val store = AgentSettingsStore(file, fakeCipher)
        store.update {
            it.copy(
                clark = ClarkSettings(name = "Clark", url = "http://100.91.52.84:8642", key = "hermes-key"),
                computers = listOf(PairedComputer("ph_k3j9x0m2qa", "desktop-zolder", "100.101.102.103", token = "tok", mcpToken = "mcp")),
            )
        }
        val disk = file.readText()
        assertFalse(disk, "hermes-key" in disk)
        assertTrue(disk, "\"key\":\"enc:Xyek-semreh\"" in disk)
        assertTrue(disk, "\"mcpToken\":\"enc:Xpcm\"" in disk)
        val again = AgentSettingsStore(file, fakeCipher).current()
        assertEquals("hermes-key", again.clark.key)
        assertEquals("tok", again.computer("ph_k3j9x0m2qa")!!.token)
        // A secret this device can't decrypt reads as empty, so the user is asked again.
        file.writeText(disk.replace("enc:Xyek-semreh", "enc:garbage"))
        assertEquals("", AgentSettingsStore(file, fakeCipher).current().clark.key)
        assertFalse(again.clark.toString().contains("hermes-key"))
        assertEquals(AgentSettings().defaultAgent, again.defaultAgent)
    }
}
