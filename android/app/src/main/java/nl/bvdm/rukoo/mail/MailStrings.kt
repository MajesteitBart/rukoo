package nl.bvdm.rukoo.mail

import android.content.res.Resources
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes

/**
 * Texts the engine shows the user, from strings_mail_engine.xml. An interface so JVM tests can read the
 * English catalog without Android resources.
 */
interface MailStrings {
    fun get(@StringRes id: Int, vararg args: Any): String

    fun plural(@PluralsRes id: Int, count: Int, vararg args: Any): String

    companion object {
        fun of(resources: Resources): MailStrings = object : MailStrings {
            override fun get(id: Int, vararg args: Any): String =
                if (args.isEmpty()) resources.getString(id) else resources.getString(id, *args)

            override fun plural(id: Int, count: Int, vararg args: Any): String =
                resources.getQuantityString(id, count, *args)
        }
    }
}

/** A user-facing failure with the given text. */
internal fun MailStrings.fail(@StringRes id: Int, vararg args: Any, code: String? = null, cause: Throwable? = null): Nothing =
    throw MailException(get(id, *args), code, cause)
