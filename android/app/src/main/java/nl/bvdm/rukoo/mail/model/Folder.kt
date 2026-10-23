package nl.bvdm.rukoo.mail.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A folder's special use. NONE is desktop's `null`: a user folder. FLAGGED and IMPORTANT are Gmail's
 * Starred and Important, which the UI hides; ALL is Gmail's All Mail, which serves as the archive.
 */
@Serializable
enum class FolderRole(val wire: String?) {
    @SerialName("inbox") INBOX("inbox"),
    @SerialName("sent") SENT("sent"),
    @SerialName("drafts") DRAFTS("drafts"),
    @SerialName("trash") TRASH("trash"),
    @SerialName("junk") JUNK("junk"),
    @SerialName("archive") ARCHIVE("archive"),
    @SerialName("all") ALL("all"),
    @SerialName("flagged") FLAGGED("flagged"),
    @SerialName("important") IMPORTANT("important"),
    @SerialName("none") NONE(null),
    ;

    companion object {
        fun fromWire(value: String?): FolderRole = entries.firstOrNull { it.wire != null && it.wire == value } ?: NONE
    }
}

/**
 * A folder of an account. [name] is the server's leaf name; the UI shows the translated role name for
 * folders with a role (desktop's displayFolderName). Counts are over the cached messages.
 */
@Serializable
data class Folder(
    val accountId: String,
    val path: String,
    val name: String,
    val role: FolderRole = FolderRole.NONE,
    val delimiter: String? = "/",
    val specialUse: String? = null,
    val unread: Int = 0,
    val total: Int = 0,
)

/** Desktop's folderRole (mailutil.js:18-51): which special use a folder has. */
object FolderRoles {
    private val SPECIAL_USE = mapOf(
        "\\inbox" to FolderRole.INBOX,
        "\\sent" to FolderRole.SENT,
        "\\drafts" to FolderRole.DRAFTS,
        "\\trash" to FolderRole.TRASH,
        "\\junk" to FolderRole.JUNK,
        "\\archive" to FolderRole.ARCHIVE,
        "\\all" to FolderRole.ALL,
        "\\flagged" to FolderRole.FLAGGED,
        "\\important" to FolderRole.IMPORTANT,
    )

    // Fallback for servers without SPECIAL-USE: common names in English and Dutch.
    private val NAME_ROLES = listOf(
        Regex("^(inbox|postvak in)$", RegexOption.IGNORE_CASE) to FolderRole.INBOX,
        Regex("^(sent|sent items|sent mail|sent messages|verzonden|verzonden items)$", RegexOption.IGNORE_CASE) to FolderRole.SENT,
        Regex("^(drafts|draft|concepten)$", RegexOption.IGNORE_CASE) to FolderRole.DRAFTS,
        Regex("^(trash|deleted|deleted items|deleted messages|bin|prullenbak|verwijderde items)$", RegexOption.IGNORE_CASE) to FolderRole.TRASH,
        Regex("^(junk|spam|junk e-mail|junk email|bulk mail|ongewenste e-mail)$", RegexOption.IGNORE_CASE) to FolderRole.JUNK,
        Regex("^(archive|archives|archief)$", RegexOption.IGNORE_CASE) to FolderRole.ARCHIVE,
    )

    // IMAP attributes are case-insensitive (RFC 3501); imapflow hands desktop the canonical case, Jakarta
    // Mail hands over what the server sent, so compare without case.
    private fun special(value: String?): FolderRole? = value?.let { SPECIAL_USE[it.trim().lowercase()] }

    /**
     * In order: the path INBOX, the SPECIAL-USE attribute, any folder flag that is a special use, then
     * the leaf name ([name], else [path]) against the English and Dutch names. NONE for a user folder.
     */
    fun roleFor(path: String, name: String?, specialUse: String?, flags: Collection<String> = emptyList()): FolderRole {
        if (path.uppercase() == "INBOX") return FolderRole.INBOX
        special(specialUse)?.let { return it }
        for (flag in flags) special(flag)?.let { return it }
        val leaf = (name?.takeIf { it.isNotEmpty() } ?: path).trim()
        for ((re, role) in NAME_ROLES) if (re.matches(leaf)) return role
        return FolderRole.NONE
    }
}
