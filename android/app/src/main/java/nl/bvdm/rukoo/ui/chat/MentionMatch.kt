package nl.bvdm.rukoo.ui.chat

import java.text.Normalizer
import java.util.Locale
import nl.bvdm.rukoo.workspaces.Member

/**
 * Who fits a mention being typed: a port of desktop src/renderer/mention-match.js `matchScore` and `rankMembers`,
 * pure so MentionMatchTest covers it. The composer's picker offers the people [rank] returns.
 */
object MentionMatch {
    /** The picker shows at most this many people (android.md "Composer with mentions"). */
    const val LIMIT = 6

    private val MARKS = Regex("\\p{M}+")

    // JavaScript's \s, which also takes the no-break and other Unicode spaces.
    private val SPACES = Regex("[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")

    /** Lower case without accents and with single spaces, so "joel" finds "Joël" and "de  vries" finds "De Vries". */
    fun fold(s: String?): String =
        Normalizer.normalize(s.orEmpty(), Normalizer.Form.NFD).replace(MARKS, "").replace(SPACES, " ").trim().lowercase(Locale.ROOT)

    /**
     * How well [name] fits what was typed after the @: 4 when the name starts with it, 3 when a later part does ("vries"
     * or "de vries" for Sanne de Vries), 0 when nothing fits. An empty [query] fits everyone with 1.
     */
    fun score(name: String, query: String): Int {
        val q = fold(query)
        if (q.isEmpty()) return 1
        val n = fold(name)
        if (n.startsWith(q)) return 4
        val words = n.split(' ')
        for (i in 1 until words.size) if (words.subList(i, words.size).joinToString(" ").startsWith(q)) return 3
        return 0
    }

    /**
     * The people to offer for [query], best first: among equally good matches the ones in [recent] (who posted lately,
     * the latest first) go first, then the order of [people]. Only active members count, never [me], each once, and at
     * most [limit].
     */
    fun rank(query: String, people: List<Member>, me: String?, recent: List<String> = emptyList(), limit: Int = LIMIT): List<Member> {
        val order = HashMap<String, Int>()
        for (id in recent) if (id !in order) order[id] = order.size
        val seen = HashSet<String>()
        data class Hit(val member: Member, val score: Int, val recent: Int, val index: Int)
        val hits = ArrayList<Hit>()
        people.forEachIndexed { i, m ->
            if (m.id == me || m.state != "active" || !seen.add(m.id)) return@forEachIndexed
            val s = score(m.name, query)
            if (s > 0) hits += Hit(m, s, order[m.id] ?: Int.MAX_VALUE, i)
        }
        return hits
            .sortedWith(compareByDescending<Hit> { it.score }.thenBy { it.recent }.thenBy { it.index })
            .take(limit)
            .map { it.member }
    }
}
