package nl.bvdm.rukoo.mail.mime

/**
 * One node of a message's MIME structure as the server describes it (IMAP BODYSTRUCTURE), with the
 * part number IMAP addresses it by. [type] is `type/subtype` in lower case.
 */
data class PartNode(
    val part: String?,
    val type: String,
    val disposition: String? = null,
    /** Content-ID. */
    val id: String? = null,
    val encoding: String? = null,
    val charset: String? = null,
    /** Content-Disposition filename. */
    val filename: String? = null,
    /** Content-Type name. */
    val name: String? = null,
    val children: List<PartNode> = emptyList(),
)

/** Desktop's structure rules for previews and the attachment icon (mailutil.js:58-99, spec 4 §2.7). */
object Structure {
    /**
     * How many multipart levels are read, in the body ([MimeParser]) and in the server's structure. Real mail
     * nests a handful; a crafted message nests thousands to exhaust the stack, so parts below this level are left out.
     */
    const val MAX_DEPTH = 100

    /** Single-part messages have no part number; IMAP addresses their body as part 1. */
    fun partKey(node: PartNode): String = node.part ?: "1"

    /** Parents before children, in order; a loop rather than recursion, so no tree is too deep for it. */
    fun walk(node: PartNode?, visit: (PartNode) -> Unit) {
        val pending = ArrayDeque(listOfNotNull(node))
        while (pending.isNotEmpty()) {
            val next = pending.removeFirst()
            visit(next)
            for (child in next.children.asReversed()) pending.addFirst(child)
        }
    }

    fun isAttachmentNode(node: PartNode): Boolean {
        val type = node.type.lowercase()
        val disposition = node.disposition?.lowercase()
        if (type.startsWith("multipart/")) return false
        if (disposition == "attachment") return true
        if (type == "message/rfc822") return true
        if (type.startsWith("text/")) return false
        // Inline images referenced by cid are part of the body, not attachments.
        if (disposition == "inline" && !node.id.isNullOrEmpty()) return false
        return !node.filename.isNullOrEmpty() || !node.name.isNullOrEmpty()
    }

    /** The first text/plain part outside attachments, else the first text/html. */
    fun findPreviewPart(root: PartNode?): PartNode? {
        var plain: PartNode? = null
        var html: PartNode? = null
        walk(root) { node ->
            if (isAttachmentNode(node)) return@walk
            val type = node.type.lowercase()
            if (type == "text/plain" && plain == null) plain = node
            if (type == "text/html" && html == null) html = node
        }
        return plain ?: html
    }

    fun hasAttachments(root: PartNode?): Boolean {
        var found = false
        walk(root) { if (isAttachmentNode(it)) found = true }
        return found
    }
}
