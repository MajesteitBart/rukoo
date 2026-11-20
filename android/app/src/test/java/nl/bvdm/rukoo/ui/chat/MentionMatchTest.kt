package nl.bvdm.rukoo.ui.chat

import nl.bvdm.rukoo.workspaces.Member
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Who the mention picker offers (desktop test/mention-match.test.js `rankMembers`, android.md "Composer with mentions"). */
class MentionMatchTest {
    private fun member(id: String, name: String, role: String = "member", state: String = "active") =
        Member(id = "u_" + id.padEnd(22, 'A'), name = name, role = role, state = state)

    private val joel = member("joel", "Joël Smit")
    private val jolien = member("jolien", "Jolien Bakker")
    private val anna = member("anna", "Anna Jonker")
    private val bob = member("bob", "Bob de Vries")
    private val me = member("me", "Jo Self")
    private val people = listOf(anna, jolien, joel, bob)

    private fun names(list: List<Member>) = list.map { it.name }

    @Test
    fun `the whole name scores above a later part of it, and accents and case don't matter`() {
        assertEquals(4, MentionMatch.score("Joël Smit", "joel"))
        assertEquals(4, MentionMatch.score("Joël Smit", "JOËL s"))
        assertEquals(3, MentionMatch.score("Sanne de Vries", "vries"))
        assertEquals(3, MentionMatch.score("Sanne de Vries", "de  vries"))
        assertEquals(0, MentionMatch.score("Sanne de Vries", "anne"))
        assertEquals(1, MentionMatch.score("Anyone", ""))
        assertEquals(1, MentionMatch.score("Anyone", "   "))
        assertEquals("zoe", MentionMatch.fold(" Zoë  "))
    }

    @Test
    fun `joel finds Joël`() {
        assertEquals(listOf("Joël Smit"), names(MentionMatch.rank("joel", people, me = null)))
    }

    @Test
    fun `the start of the name comes before a later word, then the order given`() {
        assertEquals(listOf("Jolien Bakker", "Joël Smit", "Anna Jonker"), names(MentionMatch.rank("jo", people, me = null)))
    }

    @Test
    fun `a recent author goes first among equal matches, never above a better one`() {
        assertEquals(
            listOf("Joël Smit", "Jolien Bakker", "Anna Jonker"),
            names(MentionMatch.rank("jo", people, me = null, recent = listOf(joel.id, anna.id))),
        )
    }

    @Test
    fun `a bare @ offers everyone, the latest author first`() {
        assertEquals(
            listOf("Bob de Vries", "Jolien Bakker", "Anna Jonker", "Joël Smit"),
            names(MentionMatch.rank("", people, me = null, recent = listOf(bob.id, jolien.id, bob.id))),
        )
    }

    @Test
    fun `never yourself, nobody who left, and each person once`() {
        val former = member("old", "Joost Oud", state = "former")
        val ranked = MentionMatch.rank("jo", listOf(me, former, joel, joel.copy()), me = me.id)
        assertEquals(listOf("Joël Smit"), names(ranked))
        assertTrue(MentionMatch.rank("x", people, me = null).isEmpty())
    }

    @Test
    fun `at most six by default, and the member objects come back as given`() {
        val many = (0 until 12).map { member("m$it", "Member $it") }
        assertEquals(6, MentionMatch.rank("mem", many, me = null).size)
        assertEquals(3, MentionMatch.rank("mem", many, me = null, limit = 3).size)
        assertSame(joel, MentionMatch.rank("joel", listOf(joel), me = null).single())
    }

    @Test
    fun `guests can be mentioned like anyone in the room`() {
        val guest = member("gast", "Greta Gast", role = "guest")
        assertEquals(listOf(guest), MentionMatch.rank("gr", listOf(guest), me = null))
    }
}
