package nl.bvdm.rukoo.workspaces

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import nl.bvdm.rukoo.core.RukooJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The directory pages the server sends a guest who shares no channel with an agent's sponsor, read with the models of
 * the published Android builds. Android reads wire version 1, so the server leaves such an agent's settings out for it
 * (server/WORKSPACES.md `GET /members`); a reader of version 2 gets `sponsor: null`.
 */
class PublishedDirectoryTest {
    /** Member and AgentSettings as Rukoo for Android 0.6.1-nightly.20261124.17 has them: a sponsor is required. */
    @Serializable
    private data class NightlyMember(
        val id: String,
        val kind: String = "human",
        val name: String,
        val role: String,
        val state: String,
        val joinedAt: Long = 0,
        val agent: NightlySettings? = null,
    )

    @Serializable
    private data class NightlySettings(val sponsor: String, val answers: String, val members: List<String> = emptyList(), val agents: Boolean = false)

    @Serializable
    private data class NightlyPage(val members: List<NightlyMember> = emptyList(), val more: Boolean = false)

    /** Member as Rukoo for Android 0.6.0 has it: no agent settings at all. */
    @Serializable
    private data class StableMember(val id: String, val kind: String = "human", val name: String, val role: String, val state: String, val joinedAt: Long = 0)

    @Serializable
    private data class StablePage(val members: List<StableMember> = emptyList(), val more: Boolean = false)

    private val me = "u_" + "M".repeat(22)
    private val mila = "u_" + "L".repeat(22)
    private val clark = "u_" + "C".repeat(22)
    private val bee = "u_" + "B".repeat(22)

    private fun page(clarkSettings: String?) = """{"members":[
          {"id":"$me","kind":"human","name":"Me","role":"guest","state":"active","joinedAt":1},
          {"id":"$mila","kind":"human","name":"Mila","role":"admin","state":"active","joinedAt":2},
          {"id":"$clark","kind":"agent","name":"Clark","role":"member","state":"active","joinedAt":3${clarkSettings?.let { ""","agent":$it""" } ?: ""}},
          {"id":"$bee","kind":"agent","name":"Bee","role":"member","state":"active","joinedAt":4,
           "agent":{"sponsor":"$mila","answers":"sponsor","members":[],"agents":false}}
        ],"more":false}"""

    // What a reader of version 1 gets now: Clark, whose sponsor the guest can't see, without settings.
    private val version1 = page(null)

    // What a reader of version 2 gets, and what every reader got from the first version of this change.
    private val version2 = page("""{"sponsor":null,"answers":"members","members":["$mila"],"agents":false}""")

    @Test
    fun `the 0_6_1 nightly reads the version 1 page and refused the null sponsor`() {
        val read = RukooJson.decodeFromString(NightlyPage.serializer(), version1)
        assertEquals(listOf("Me", "Mila", "Clark", "Bee"), read.members.map { it.name })
        assertNull(read.members[2].agent)
        assertEquals(mila, read.members[3].agent?.sponsor)
        // The shape this change first sent to every reader: the nightly refuses the whole page over it.
        try {
            RukooJson.decodeFromString(NightlyPage.serializer(), version2)
            throw AssertionError("the nightly's model took a null sponsor")
        } catch (e: SerializationException) {
            assertEquals(true, e.message.orEmpty().isNotEmpty())
        }
    }

    @Test
    fun `Android 0_6_0 reads either page, as it has no agent settings`() {
        assertEquals(4, RukooJson.decodeFromString(StablePage.serializer(), version1).members.size)
        assertEquals(4, RukooJson.decodeFromString(StablePage.serializer(), version2).members.size)
    }

    @Test
    fun `this build reads both pages`() {
        val one = RukooJson.decodeFromString(MembersPage.serializer(), version1)
        assertNull(one.members[2].agent)
        val two = RukooJson.decodeFromString(MembersPage.serializer(), version2)
        assertEquals(AgentSettings(null, "members", listOf(mila)), two.members[2].agent)
    }
}
