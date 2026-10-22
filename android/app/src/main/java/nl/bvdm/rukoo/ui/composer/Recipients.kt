package nl.bvdm.rukoo.ui.composer

import nl.bvdm.rukoo.mail.model.Address

/** Turning typed text into recipient chips, and the composer's address checks. */
object Recipients {
    private val EMAIL = Regex("^[^\\s@<>(),;:\"]+@[^\\s@<>(),;:\"]+\\.[^\\s@<>(),;:\"]+$")

    // Commas and semicolons outside quotes and angle brackets separate addresses ("Last, First" <a@b.c> stays one).
    private val PARTS = Regex("(?:\"[^\"]*\"|<[^>]*>|[^,;])+")
    private val NAMED = Regex("^(.*?)<([^>]+)>$")

    fun isValid(address: String): Boolean = EMAIL.matches(address.trim())

    /** Every address in [text]: `a@b.c`, `Name <a@b.c>` or `"Last, First" <a@b.c>`. */
    fun parse(text: String): List<Address> = PARTS.findAll(text).mapNotNull { match ->
        val item = match.value.trim()
        if (item.isEmpty()) return@mapNotNull null
        val named = NAMED.find(item)
        val address = (named?.groupValues?.get(2) ?: item).trim()
        if (address.isEmpty()) return@mapNotNull null
        Address(named?.groupValues?.get(1)?.trim()?.removeSurrounding("\"")?.trim().orEmpty(), address)
    }.toList()

    /**
     * What typing [text] does: the parts finished by a separator become chips, the rest stays in the field.
     * Space finishes a part too once it is a whole address, the way a phone keyboard ends a word.
     */
    fun split(text: String): Pair<List<Address>, String> {
        val cut = text.indexOfLast { it == ',' || it == ';' || it == '\n' }
        if (cut >= 0) return parse(text.substring(0, cut)) to text.substring(cut + 1).trimStart()
        if (text.endsWith(' ') && !text.contains('"') && !text.contains('<') && isValid(text.trim())) return parse(text) to ""
        return emptyList<Address>() to text
    }

    /** Adds [more] to [list], leaving out addresses that are there already. */
    fun merge(list: List<Address>, more: List<Address>): List<Address> {
        val seen = list.map { it.address.lowercase() }.toMutableSet()
        return list + more.filter { seen.add(it.address.lowercase()) }
    }

    /** Recipient suggestions for [query]: a case-insensitive match on "name address", six at most (composer.js:474-495). */
    fun suggest(contacts: List<Address>, query: String, exclude: List<Address>): List<Address> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return emptyList()
        val taken = exclude.map { it.address.lowercase() }.toSet()
        return contacts.asSequence()
            .filter { it.address.lowercase() !in taken && "${it.name} ${it.address}".lowercase().contains(q) }
            .take(6)
            .toList()
    }
}
