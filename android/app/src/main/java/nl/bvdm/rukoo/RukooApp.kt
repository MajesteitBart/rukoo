package nl.bvdm.rukoo

import android.app.Application
import android.content.Context
import nl.bvdm.rukoo.ui.Notifications

class RukooApp : Application() {
    val container: AppContainer by lazy { AppContainer(this) }

    override fun onCreate() {
        super.onCreate()
        Notifications.createChannels(this)
    }
}

val Context.appContainer: AppContainer
    get() = (applicationContext as RukooApp).container
