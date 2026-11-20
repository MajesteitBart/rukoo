package nl.bvdm.rukoo.ui.chat

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.w3c.dom.Element

/**
 * Team chat's English and Dutch catalogs agree: every name in values/strings_chat.xml is in values-nl with the
 * same kind, the same placeholders and the same plural quantities, and the chat strings that live in the shared
 * files (notification channel, settings row, Rukoo account) are there in both languages too.
 */
class ChatStringsTest {

    /** One catalog file: plain strings by name, plurals by name and quantity. */
    private class Catalog(dir: String, file: String) {
        val strings = LinkedHashMap<String, String>()
        val plurals = LinkedHashMap<String, Map<String, String>>()
        val duplicates = mutableListOf<String>()

        init {
            val path = listOf("src/main/res/$dir/$file", "app/src/main/res/$dir/$file").map(::File).firstOrNull { it.isFile }
                ?: error("$dir/$file not found from ${File(".").absolutePath}")
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(path)
            val seen = HashSet<String>()
            val s = doc.getElementsByTagName("string")
            for (i in 0 until s.length) {
                val e = s.item(i) as Element
                val name = e.getAttribute("name")
                if (!seen.add(name)) duplicates += name
                strings[name] = e.textContent
            }
            val p = doc.getElementsByTagName("plurals")
            for (i in 0 until p.length) {
                val e = p.item(i) as Element
                val name = e.getAttribute("name")
                if (!seen.add(name)) duplicates += name
                val items = e.getElementsByTagName("item")
                val forms = LinkedHashMap<String, String>()
                for (j in 0 until items.length) {
                    val item = items.item(j) as Element
                    val quantity = item.getAttribute("quantity")
                    if (forms.put(quantity, item.textContent) != null) duplicates += "$name/$quantity"
                }
                plurals[name] = forms
            }
        }

        val names: Set<String> get() = strings.keys + plurals.keys
    }

    private val en = Catalog("values", "strings_chat.xml")
    private val nl = Catalog("values-nl", "strings_chat.xml")

    @Test
    fun everyEnglishNameIsInDutchWithTheSamePlaceholders() {
        val problems = mutableListOf<String>()
        for ((name, text) in en.strings) {
            val dutch = nl.strings[name]
            when {
                dutch == null && name in nl.plurals -> problems += "$name is a plural in Dutch, a string in English"
                dutch == null -> problems += "$name is missing in values-nl"
                placeholders(dutch) != placeholders(text) ->
                    problems += "$name: English has ${placeholders(text)}, Dutch has ${placeholders(dutch)}"
            }
        }
        for ((name, forms) in en.plurals) {
            val dutch = nl.plurals[name]
            if (dutch == null) {
                problems += if (name in nl.strings) "$name is a string in Dutch, a plural in English" else "$name is missing in values-nl"
                continue
            }
            if (dutch.keys != forms.keys) problems += "$name: English quantities ${forms.keys}, Dutch ${dutch.keys}"
            for ((quantity, text) in forms) {
                val other = dutch[quantity] ?: continue
                if (placeholders(other) != placeholders(text)) {
                    problems += "$name/$quantity: English has ${placeholders(text)}, Dutch has ${placeholders(other)}"
                }
            }
        }
        assertNoProblems(problems)
    }

    @Test
    fun dutchHasNoNamesEnglishLacks() {
        assertEquals(emptySet<String>(), nl.names - en.names)
    }

    @Test
    fun namesAppearOnce() {
        assertEquals(emptyList<String>(), en.duplicates)
        assertEquals(emptyList<String>(), nl.duplicates)
    }

    @Test
    fun pluralsHaveOneAndOtherAndCarryTheirCount() {
        val problems = mutableListOf<String>()
        for (catalog in listOf(en, nl)) {
            for ((name, forms) in catalog.plurals) {
                if (!forms.keys.containsAll(listOf("one", "other"))) problems += "$name has ${forms.keys}"
                for ((quantity, text) in forms) {
                    if (placeholders(text).none { it.endsWith("d") }) problems += "$name/$quantity has no %d count"
                }
            }
        }
        assertNoProblems(problems)
    }

    @Test
    fun placeholdersArePositionalWhenThereAreSeveral() {
        val problems = mutableListOf<String>()
        for (catalog in listOf(en, nl)) {
            val texts = catalog.strings.entries.map { it.key to it.value } +
                catalog.plurals.flatMap { (name, forms) -> forms.map { (q, t) -> "$name/$q" to t } }
            for ((name, text) in texts) {
                val found = RAW.findAll(text.replace("%%", "")).toList()
                if (found.size > 1 && found.any { it.groupValues[1].isEmpty() }) problems += "$name mixes in unnumbered placeholders"
                val numbers = found.mapNotNull { it.groupValues[1].takeIf(String::isNotEmpty)?.toInt() }.toSortedSet()
                if (numbers.isNotEmpty() && numbers != (1..numbers.last()).toSortedSet()) problems += "$name skips a number: $numbers"
                if (text.contains('{') || text.contains('}')) problems += "$name still has a desktop {placeholder}"
            }
        }
        assertNoProblems(problems)
    }

    @Test
    fun theDesktopsComputerWordingSaysPhone() {
        val problems = mutableListOf<String>()
        for ((catalog, words) in listOf(en to "this computer", nl to "deze computer")) {
            val texts = catalog.strings.values + catalog.plurals.values.flatMap { it.values }
            texts.filter { it.contains(words, ignoreCase = true) }.forEach { problems += it }
        }
        assertNoProblems(problems)
    }

    @Test
    fun androidOnlyNamesArePresent() {
        val names = listOf(
            "chat_mode_mail", "chat_mode_switch", "chat_filter_all", "chat_filter_unread", "chat_join_paste",
            "chat_invite_share", "chat_room_details", "chat_room_pick",
        )
        assertEquals(emptyList<String>(), names.filterNot { it in en.strings })
    }

    @Test
    fun mappedNamesFollowTheDesktopKeys() {
        // A sample across the mapping rules: camelCase, a plural with a name, a {name} reused, an agent key.
        assertEquals("%1\$s, %2\$d unread messages", en.plurals["chat_sidebar_row_unread"]?.get("other"))
        assertEquals("%d members", en.plurals["chat_head_members"]?.get("other"))
        assertEquals("This invitation is for %1\$s. Rukoo joins workspaces on %2\$s, the server of your Rukoo account.", en.strings["chat_join_other_host"])
        assertEquals("%1\$s ziet de teamchat niet", nl.strings["agent_empty_title_chat"])
        assertTrue(en.strings.getValue("chat_block_body").split("%1\$s").size == 5)
    }

    @Test
    fun chatStringsInSharedFilesAreInBothLanguages() {
        val wanted = mapOf(
            "strings_common.xml" to listOf("notification_channel_chat", "notification_channel_chat_description"),
            "strings_settings.xml" to listOf("settings_general_chat_notifications", "settings_general_chat_notifications_help"),
            "strings_account.xml" to listOf("settings_rukoo_invite_chat_help", "settings_rukoo_delete_chat_note", "settings_rukoo_unsent_chat"),
        )
        val problems = mutableListOf<String>()
        for ((file, names) in wanted) {
            val english = Catalog("values", file)
            val dutch = Catalog("values-nl", file)
            for (name in names) {
                val a = english.strings[name]?.let { listOf(it) } ?: english.plurals[name]?.values?.toList()
                val b = dutch.strings[name]?.let { listOf(it) } ?: dutch.plurals[name]?.values?.toList()
                when {
                    a == null -> problems += "$name missing in values/$file"
                    b == null -> problems += "$name missing in values-nl/$file"
                    a.map(::placeholders) != b.map(::placeholders) -> problems += "$name placeholders differ in $file"
                }
            }
            val unsent = english.plurals["settings_rukoo_unsent_chat"]
            if (file == "strings_account.xml" && unsent?.keys != setOf("one", "other")) problems += "settings_rukoo_unsent_chat quantities: ${unsent?.keys}"
        }
        assertNoProblems(problems)
    }

    @Test
    fun dutchChatSaysInloggenAndUitloggenLikeTheAccountPages() {
        // The Rukoo account pages say Inloggen, Uitloggen and Uitgelogd; chat's Dutch follows them, as the desktop does.
        val account = Catalog("values-nl", "strings_account.xml")
        val texts = nl.strings.entries.map { it.key to it.value } +
            nl.plurals.flatMap { (name, forms) -> forms.map { (q, t) -> "$name/$q" to t } } +
            account.plurals.getValue("settings_rukoo_unsent_chat").map { (q, t) -> "settings_rukoo_unsent_chat/$q" to t }
        val problems = texts.filter { (_, text) -> SIGN_IN_WORDS.containsMatchIn(text) }.map { (name, text) -> "$name: $text" }
        assertNoProblems(problems)
        assertEquals(account.strings["settings_rukoo_sign_in"], nl.strings["chat_empty_sign_in_action"])
        assertEquals(account.strings["settings_rukoo_signed_out"], nl.strings["chat_status_signed_out"])
        assertEquals("Log in om teamchat te gebruiken", nl.strings["chat_empty_signed_out_title"])
        assertEquals("Je bent uitgelogd. Log in om teamchat te blijven gebruiken.", nl.strings["chat_errors_signed_out"])
    }

    @Test
    fun dutchCallsTheStartOverActionOpnieuwBeginnen() {
        val button = nl.strings.getValue("chat_banner_start_over")
        assertEquals("Opnieuw beginnen", button)
        val problems = mutableListOf<String>()
        for (name in listOf("chat_banner_paused", "chat_errors_paused")) {
            val text = nl.strings.getValue(name)
            if (text.contains("Begin opnieuw", ignoreCase = true) || !text.contains(button)) problems += "$name: $text"
        }
        assertNoProblems(problems)
    }

    @Test
    fun noDesktopShortcutsTheChatScreensDontHandle() {
        // Enter sends from the composer on a hardware keyboard (ChatComposer), so "Send (Enter)" may keep its hint.
        // Rukoo binds no other chat shortcut on Android: no Ctrl+ keys, no Esc.
        val problems = mutableListOf<String>()
        for (catalog in listOf(en, nl)) {
            val texts = catalog.strings.entries.map { it.key to it.value } +
                catalog.plurals.flatMap { (name, forms) -> forms.map { (q, t) -> "$name/$q" to t } }
            texts.filter { (_, text) -> SHORTCUT.containsMatchIn(text) }.forEach { (name, text) -> problems += "$name: $text" }
        }
        for (name in listOf("chat_mode_shortcut", "chat_sidebar_new_message_shortcut")) {
            if (name in en.names || name in nl.names) problems += "$name is left over from the desktop"
        }
        assertNoProblems(problems)
        assertEquals("Send (Enter)", en.strings["chat_input_send"])
        assertEquals("Close thread", en.strings["chat_thread_close"])
        assertEquals("Thread sluiten", nl.strings["chat_thread_close"])
    }

    @Test
    fun theHostCanReadPrivateChannelsOfflineNamesTheServerAndMuteSaysMentionsGoQuiet() {
        // The desktop's chat.log.startPrivate, chat.banner.offline, chat.channel.preview*, chat.mute.done say the same.
        assertEquals("Only people who are added, and %1\$s, which hosts this workspace, can read it.", en.strings["chat_log_start_private"])
        assertEquals("Alleen mensen die zijn toegevoegd, en %1\$s, die deze werkruimte host, kunnen het lezen.", nl.strings["chat_log_start_private"])
        assertEquals("Rukoo can't reach %1\$s. Messages you send wait until it reconnects.", unescape(en.strings["chat_banner_offline"]))
        assertEquals("Rukoo kan %1\$s niet bereiken. Berichten die je verstuurt, wachten tot er weer verbinding is.", nl.strings["chat_banner_offline"])
        assertEquals("Try now", en.strings["chat_banner_try_now"])
        assertEquals("#%1\$s", en.strings["chat_channel_preview_title"])
        assertEquals("#%1\$s", nl.strings["chat_channel_preview_title"])
        assertEquals("Join #%1\$s to read its messages and post in it.", en.strings["chat_channel_preview_body"])
        assertEquals("Neem deel aan #%1\$s om de berichten te lezen en erin te schrijven.", nl.strings["chat_channel_preview_body"])
        assertEquals("This is the start of #%1\$s", en.strings["chat_log_start_channel"])
        assertEquals("Muted %1\$s. No notifications or counts, even for mentions.", en.strings["chat_mute_done"])
        assertEquals("%1\$s gedempt. Geen meldingen of tellers, ook niet bij vermeldingen.", nl.strings["chat_mute_done"])
        assertEquals("No notifications or counts, even when someone mentions you.", en.strings["chat_head_mute_hint"])
        assertEquals("Geen meldingen of tellers, ook niet als iemand je noemt.", nl.strings["chat_head_mute_hint"])
    }

    /** Android's escaped apostrophe, as the screen shows it. */
    private fun unescape(text: String?) = text?.replace("\\'", "'")

    private fun assertNoProblems(problems: List<String>) {
        if (problems.isNotEmpty()) fail(problems.joinToString("\n"))
    }

    private companion object {
        val RAW = Regex("""%(?:(\d+)\$)?([a-zA-Z])""")

        /** Aanmelden and afmelden wording, which the account pages don't use: "meld je aan", "afgemeld", "je afmeldt". */
        val SIGN_IN_WORDS = Regex("""\b(aanmeld|afmeld|afgemeld|meld je (aan|af)|meld u)""", RegexOption.IGNORE_CASE)

        /** A desktop key hint: Ctrl+, Alt+, Shift+ or Esc. */
        val SHORTCUT = Regex("""\b(Ctrl|Alt|Shift)\s*\+|\(Esc\)|\bEsc\b""")

        /**
         * The distinct placeholders in a text, sorted, unnumbered ones numbered in order: [1$s, 2$d]. A translation
         * may repeat a name where English says it once ("Wat %1$s schreef"), so repeats don't count.
         */
        fun placeholders(text: String): List<String> {
            var next = 0
            return RAW.findAll(text.replace("%%", "")).map { m ->
                val number = m.groupValues[1].ifEmpty { (++next).toString() }
                "$number$" + m.groupValues[2]
            }.distinct().sorted().toList()
        }
    }
}
