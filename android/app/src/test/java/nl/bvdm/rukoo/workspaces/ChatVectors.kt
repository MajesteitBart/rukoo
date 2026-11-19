package nl.bvdm.rukoo.workspaces

import java.io.File
import kotlinx.serialization.Serializable
import nl.bvdm.rukoo.core.RukooJson

/**
 * test/fixtures/chat-vectors.json at the repository's root (contract §8.2), read where it is, as AccountKeysTest
 * reads account-vectors.json. Desktop's tests read the same file.
 */
object ChatVectors {
    @Serializable
    data class MentionCase(val name: String, val text: String, val utf16: List<Mention>, val bytes: List<Mention>)

    @Serializable
    data class BadMentionCase(val name: String, val rule: String, val text: String, val bytes: List<Mention>)

    @Serializable
    data class Link(val server: String, val workspace: String, val secret: String)

    @Serializable
    data class AndroidOverride(val build: String, val expect: Link? = null, val error: String? = null)

    @Serializable
    data class InviteCase(
        val name: String,
        val text: String,
        val server: String,
        val expect: Link? = null,
        val error: String? = null,
        val android: AndroidOverride? = null,
    )

    @Serializable
    data class UuidCase(val name: String, val ms: Long, val random: String, val id: String)

    @Serializable
    data class File_(
        val about: String,
        val mentions: List<MentionCase>,
        val badMentions: List<BadMentionCase>,
        val inviteLinks: List<InviteCase>,
        val uuidv7: List<UuidCase>,
    )

    val file: File by lazy {
        listOf("../../test/fixtures/chat-vectors.json", "../test/fixtures/chat-vectors.json").map(::File).first { it.exists() }
    }

    val all: File_ by lazy { RukooJson.decodeFromString(File_.serializer(), file.readText()) }
}
