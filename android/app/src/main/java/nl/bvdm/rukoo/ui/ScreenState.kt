package nl.bvdm.rukoo.ui

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.mail.model.MailView

/**
 * What the user sees, for the agent tools (get_context) and the bridge's `rukoo/hello` (desktop
 * hub.view(), spec 1 §5.5). The UI writes it; tools only read. [lastInteractionAt] is the last touch,
 * scroll or key in the app; [foreground] is false while no activity is started.
 */
data class Screen(
    val view: MailView = MailView.AllInboxes,
    val openMessageId: String? = null,
    val selectedIds: List<String> = emptyList(),
    val composer: ComposerState? = null,
    val chatConversationId: String? = null,
    val foreground: Boolean = false,
    val lastInteractionAt: Long = 0,
    /** When the app last left the foreground; 0 while it never was in it. */
    val leftForegroundAt: Long = 0,
)

class ScreenState(private val clock: Clock = Clock.System) {
    private val _state = MutableStateFlow(Screen())
    val state: StateFlow<Screen> = _state.asStateFlow()

    val current: Screen get() = _state.value

    fun update(transform: (Screen) -> Screen) = _state.update(transform)

    /** Call on any user input: the bridge sends calls without a chat to the device used last. */
    fun touched() = _state.update { it.copy(lastInteractionAt = clock.now()) }

    fun setForeground(foreground: Boolean) = _state.update {
        val now = clock.now()
        if (foreground) it.copy(foreground = true, lastInteractionAt = now) else it.copy(foreground = false, leftForegroundAt = now)
    }

    /**
     * The bridge's idle (design.md "Decisions"): 0 while the app is on screen, otherwise whole seconds since
     * it left the foreground, so calls without a chat go to the device used last.
     */
    fun idleSeconds(): Long {
        val s = _state.value
        if (s.foreground) return 0
        if (s.leftForegroundAt == 0L) return NEVER_USED_IDLE
        return ((clock.now() - s.leftForegroundAt) / 1000).coerceAtLeast(0)
    }

    companion object {
        /** A year: not used since the process started, so calls without a chat should go to a computer. */
        const val NEVER_USED_IDLE = 365L * 24 * 3600
    }
}
