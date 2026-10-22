package nl.bvdm.rukoo.agents.adapters

import android.content.Context
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes

/**
 * What the adapters say in their own words: status details, error details and notices, from
 * strings_agent_adapters.xml in the user's language. What a server or agent sends stays as it came, and so
 * do approval cards: the chat UI words those by tool kind, field key and choice id, as desktop does, so their
 * English is the key it matches.
 */
interface AdapterTexts {
    fun get(@StringRes id: Int, vararg args: Any): String

    fun plural(@PluralsRes id: Int, count: Int, vararg args: Any): String
}

/** The app's resources, so the texts follow the language picked in Rukoo. */
class ResourceTexts(private val context: Context) : AdapterTexts {
    override fun get(id: Int, vararg args: Any): String = context.getString(id, *args)

    override fun plural(id: Int, count: Int, vararg args: Any): String = context.resources.getQuantityString(id, count, *args)
}
