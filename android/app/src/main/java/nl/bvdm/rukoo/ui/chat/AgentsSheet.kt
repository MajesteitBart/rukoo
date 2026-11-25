package nl.bvdm.rukoo.ui.chat

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.Avatar
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkButtonSize
import nl.bvdm.rukoo.ui.components.RkMenuItem
import nl.bvdm.rukoo.ui.components.RkSearchField
import nl.bvdm.rukoo.ui.components.RkTextField
import nl.bvdm.rukoo.ui.components.Spinner
import nl.bvdm.rukoo.ui.icons.IconSpec
import nl.bvdm.rukoo.ui.icons.IconSpecBuilder
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.ChatSheet
import nl.bvdm.rukoo.ui.settings.ErrorLine
import nl.bvdm.rukoo.ui.settings.RkDialog
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooMono
import nl.bvdm.rukoo.workspaces.Agent
import nl.bvdm.rukoo.workspaces.AgentSettings
import nl.bvdm.rukoo.workspaces.MadeAgent
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind

// ---- the rules, pure so ChatSheetRulesTest covers them ----

/**
 * Agents in channels as the sheets need them (WORKSPACES.md "Agents in channels", the spec's desktop and Android
 * parts): whom an agent answers, who may manage or add it, what its form takes, and the runner config of a new key.
 */
object AgentRules {
    const val EVERYONE = "everyone"
    const val SPONSOR = "sponsor"
    const val MEMBERS = "members"

    /** The choices of "Who it answers", in the order the form shows them. */
    val ANSWERS = listOf(EVERYONE, SPONSOR, MEMBERS)

    /** An agent answers at most this many chosen people besides its sponsor. */
    const val MEMBERS_MAX = 50

    /**
     * Whether the agent answers a mention by [me]: its sponsor always, anyone for `everyone`, the chosen people for
     * `members`. Settings this phone doesn't have yet count as answering, so no row says otherwise without knowing; a
     * choice this version doesn't know counts as not answering, as on the desktop.
     */
    fun answers(settings: AgentSettings?, me: String?): Boolean = when {
        settings == null || me == null -> true
        settings.sponsor == me -> true
        settings.answers == EVERYONE -> true
        settings.answers == MEMBERS -> me in settings.members
        else -> false
    }

    /** Whom the agent answers, its sponsor first, or null when it answers everyone. An unknown choice reads as its sponsor only. */
    fun answered(settings: AgentSettings): List<String>? = when (settings.answers) {
        EVERYONE -> null
        MEMBERS -> (listOfNotNull(settings.sponsor) + settings.members).distinct()
        else -> listOfNotNull(settings.sponsor)
    }

    /**
     * Whom "Answers only …" names: [answered] without the people this phone's directory doesn't list ([known]), so
     * nobody reads as "Former member". A guest's directory holds only the people of their channels, which can leave the
     * sponsor out. Empty when it knows none of them, which reads "Answers only the person who made it"; null when the
     * agent answers everyone.
     */
    fun answeredKnown(settings: AgentSettings, known: (String) -> Boolean): List<String>? = answered(settings)?.filter(known)

    /** Whether [me], with workspace role [myRole], may edit or remove an agent [sponsor] made. */
    fun canManage(sponsor: String?, me: String?, myRole: String?): Boolean =
        (me != null && sponsor == me) || myRole == "owner" || myRole == "admin"

    /**
     * Whether [me] may make a new key for an agent [sponsor] made: its sponsor only. The key reads every channel the
     * agent is in, so the server refuses anyone else with 403, owners and admins too.
     */
    fun canNewKey(sponsor: String?, me: String?): Boolean = me != null && sponsor == me

    /** Whether [me] sponsors an active agent of [members]. */
    fun sponsors(members: List<Member>, me: String?): Boolean =
        me != null && members.any { it.isAgent && it.state == "active" && it.agent?.sponsor == me }

    /** Whether [me] has agents of their own to bring into a channel: an active one, while the server has agents [on]. */
    fun ownAgents(members: List<Member>, me: String?, on: Boolean): Boolean = on && sponsors(members, me)

    /**
     * An agent as the directory has it, for its form: null for a person, settings this phone can't read, or a sponsor
     * the directory leaves out (only a guest's or an agent's, and neither manages agents).
     */
    fun agentOf(member: Member): Agent? {
        val s = member.agent ?: return null
        if (!member.isAgent) return null
        val sponsor = s.sponsor ?: return null
        return Agent(member.id, member.name, sponsor, s.answers, s.members, s.agents)
    }

    /**
     * What the Agents sheet opens on when another sheet sends the person there: an agent's form ([key] false) or the
     * key just made for it ([key] true), as the sheet's target says it.
     */
    data class Opened(val agent: String, val key: Boolean)

    fun editTarget(agent: String) = "edit:$agent"

    fun keyTarget(agent: String) = "key:$agent"

    fun opened(target: String?): Opened? = when {
        target == null -> null
        target.startsWith("edit:") -> Opened(target.removePrefix("edit:"), key = false)
        target.startsWith("key:") -> Opened(target.removePrefix("key:"), key = true)
        else -> null
    }

    /**
     * Whether someone who doesn't manage [room] may still add their own agents to it ([ownAgents]): an open channel the
     * whole workspace sees, as the server takes it.
     */
    fun sponsorAdds(room: Room, ownAgents: Boolean): Boolean =
        ownAgents && room.kind == RoomKind.CHANNEL && !room.archived && room.visibility == "workspace"

    /**
     * The agents [me] may add to [room], which already holds [inside], while the server has agents [on]: any agent
     * for its managers, and their own agents in an open channel the workspace sees for anyone else. A private channel
     * takes an agent only while its sponsor is in it (`409 sponsor_not_in_channel`), so the others aren't offered. By
     * name. Nobody else is offered one.
     */
    fun addable(members: List<Member>, inside: Set<String>, room: Room, me: String?, compare: Comparator<String>, on: Boolean): List<Member> {
        if (!on || room.kind != RoomKind.CHANNEL || room.archived) return emptyList()
        val manager = room.role == "manager"
        val open = room.visibility == "workspace"
        return members.filter { m ->
            val sponsor = m.agent?.sponsor
            m.isAgent && m.state == "active" && m.id !in inside &&
                (manager || (open && me != null && sponsor == me)) &&
                (open || (sponsor != null && sponsor in inside))
        }.sortedWith { a, b -> compare.compare(a.name, b.name) }
    }

    /** The people an agent [sponsor] made can be set to answer: active people, guests too, never an agent. By name. */
    fun choosable(members: List<Member>, sponsor: String?, compare: Comparator<String>): List<Member> =
        members.filter { it.state == "active" && !it.isAgent && it.id != sponsor }.sortedWith { a, b -> compare.compare(a.name, b.name) }

    /** Whether the form can go: a name the server takes, a known choice, and someone picked for "Chosen people". */
    fun formReady(name: String, answers: String, chosen: Collection<String>): Boolean =
        SheetRules.nameOk(name) && answers in ANSWERS && (answers != MEMBERS || chosen.isNotEmpty()) && chosen.size <= MEMBERS_MAX

    /**
     * Whom "Answers only …" names of [ids], as desktop's chat-model.js `agentAnswersText` does: up to three, or the
     * first two and how many more (`chat.agents.answersMore`).
     */
    fun named(ids: List<String>): Pair<List<String>, Int> = if (ids.size <= 3) ids to 0 else ids.take(2) to ids.size - 2

    /**
     * The backend of a config made on the phone, desktop's chat-agents.js `PLACEHOLDER_BACKEND`: a command to replace
     * with the person's own. The phone can't read the desktop's Settings > Agents to fill in one of theirs.
     */
    const val CONFIG_COMMAND = "my-agent"

    /** How to start the runner with the config saved as agent.json (desktop's `RUNNER_COMMAND`). */
    const val RUNNER_COMMAND = "node integrations/agent-runner/runner.js --config agent.json"

    @OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
    private val pretty = Json {
        prettyPrint = true
        prettyPrintIndent = "  "
    }

    /**
     * A config for the reference runner (integrations/agent-runner) with this agent's key, as desktop's chat-agents.js
     * `runnerConfig` and `runnerText` write it: [server], the account server the key works at, [workspace], the key, the
     * placeholder backend, what the runner reads of a conversation, and empty instructions, two spaces deep.
     */
    fun runnerConfig(server: String, workspace: String, key: String): String {
        val config: JsonObject = buildJsonObject {
            put("server", server.trimEnd('/'))
            put("workspace", workspace)
            put("key", key)
            putJsonObject("backend") {
                put("type", "command")
                put("command", CONFIG_COMMAND)
            }
            putJsonObject("context") {
                put("threadMessages", 50)
                put("channelMessages", 20)
                put("maxChars", 30000)
            }
            put("instructions", "")
        }
        return pretty.encodeToString(JsonObject.serializer(), config) + "\n"
    }
}

// ---- texts the sheets, the members lists and the mention picker share ----

/**
 * Whom an agent answers, as a row says it (desktop's chat-model.js `agentAnswersText`): "Answers everyone", "Answers
 * only" and up to three names, or two names and how many more. Only people the directory lists are named; when it
 * lists none of them, as for a guest who doesn't share a channel with the sponsor, it answers "only the person who
 * made it". Null for settings this phone doesn't have.
 */
@Composable
internal fun agentAnswersText(settings: AgentSettings?, members: Map<String, Member>): String? {
    if (settings == null) return null
    val names = rememberChatNames()
    val ids = AgentRules.answeredKnown(settings) { it in members } ?: return stringResource(R.string.chat_agents_answers_everyone)
    if (ids.isEmpty()) return stringResource(R.string.chat_agents_answers_sponsor_gone)
    val (shown, more) = AgentRules.named(ids)
    val display = shown.map { names.display(members[it]) }
    return if (more == 0) {
        stringResource(R.string.chat_agents_answers_only, if (display.size == 1) display[0] else names.list(display))
    } else {
        pluralStringResource(R.plurals.chat_agents_answers_more, more, display.joinToString(", "), more)
    }
}

/**
 * The line under an agent in Workspace members, a channel's members and the Agents sheet, as desktop's chat-model.js
 * `agentNote` writes it: who made it, whom it answers and whether it answers other agents, joined by middle dots
 * ("Made by Olga · Answers only Olga · Answers other agents"). "Made by" is left out for a sponsor the directory
 * doesn't list.
 */
@Composable
internal fun agentNote(settings: AgentSettings?, members: Map<String, Member>): String? {
    if (settings == null) return null
    val names = rememberChatNames()
    val by = settings.sponsor?.let { members[it] }?.let { stringResource(R.string.chat_agents_made_by, names.display(it)) }
    val agents = if (settings.agents) stringResource(R.string.chat_agents_answers_agents) else null
    return listOfNotNull(by, agentAnswersText(settings, members), agents).joinToString(" · ")
}

/** A key (Lucide `key-round`), drawn like RukooIcons, for New key. */
internal val KeyIcon: ImageVector by lazy {
    IconSpec(
        RukooIcons.STROKE,
        IconSpecBuilder().apply {
            path("M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z")
            path("M16.5 7.5h.01")
        }.parts,
    ).build("key")
}

// ---- the sheet ----

private const val KEY_FORM = "sheet:agentForm"

/** Where the Agents sheet is: the list, the form for a new agent ([Form.agent] null) or a change, or a key to copy. */
private sealed interface AgentStep {
    data object Agents : AgentStep

    data class Form(val agent: Agent?) : AgentStep

    data class Key(val made: MadeAgent) : AgentStep
}

/**
 * What the form holds while it is open, above both its fields and its buttons. A new agent starts out answering only
 * its sponsor, so nobody else's mention reaches it until they choose so.
 */
private class AgentFormState(val agent: Agent?) {
    var name by mutableStateOf(agent?.name.orEmpty())
    var answers by mutableStateOf(agent?.answers?.takeIf { it in AgentRules.ANSWERS } ?: AgentRules.SPONSOR)
    var chosen by mutableStateOf(agent?.members.orEmpty().toSet())
    var answersAgents by mutableStateOf(agent?.agents ?: false)
    var query by mutableStateOf("")
    var error by mutableStateOf<String?>(null)

    /** The chosen people who can still be chosen, for "Chosen people" only. */
    fun picked(choosable: List<Member>): List<String> =
        if (answers == AgentRules.MEMBERS) chosen.filter { id -> choosable.any { it.id == id } } else emptyList()

    fun ready(choosable: List<Member>): Boolean = AgentRules.formReady(name, answers, picked(choosable))
}

/**
 * The workspace's agents (the spec's Android part, desktop's Agents dialog), in one sheet whose content changes: the
 * list, each agent with who added it, whom it answers, whether it answers other agents and when it was last active,
 * with Edit and Remove for its sponsor, owners and admins and New key for its sponsor only; Add an agent's form, with
 * its name, who it answers (Everyone, Only me, or Chosen people from the workspace) and whether it answers other
 * agents; and after Add and New key the key, shown once, with the server, the workspace's ID and a runner config,
 * each to copy. Closing before anything was copied asks first, and the sheet stays while a key is being made.
 *
 * Workspace members' agent menu opens it on [target] ([AgentRules.opened]): an agent's form, or the key just made for
 * one (handed over through [ChatUi.holdAgentKey]). Done, Save and Cancel then go back to Workspace members.
 */
@Composable
internal fun AgentsSheet(app: AppViewModel, target: String?, twoPane: Boolean, onDismiss: () -> Unit) {
    val ui = app.chatUi
    val workspaces = app.services.workspaces ?: return
    val view = selectedView(app) ?: return
    val chat by app.chatState.collectAsStateWithLifecycle()
    val ws = view.ws.id
    val me = view.me.id
    val compare = rememberCompare()
    val members = remember(view) { view.members.associateBy { it.id } }
    // Where Workspace members sent the person, once: the key it holds is handed over a single time.
    val start: AgentStep = remember(target) {
        val opened = AgentRules.opened(target)
        when {
            opened == null -> AgentStep.Agents
            opened.key -> ui.takeAgentKey(ws, opened.agent)?.let { AgentStep.Key(it) } ?: AgentStep.Agents
            else -> members[opened.agent]
                ?.takeIf { it.state == "active" && AgentRules.canManage(it.agent?.sponsor, me, view.me.role) }
                ?.let(AgentRules::agentOf)?.let { AgentStep.Form(it) } ?: AgentStep.Agents
        }
    }
    val fromMembers = start !is AgentStep.Agents
    var step by remember { mutableStateOf(start) }
    var list by remember { mutableStateOf<List<Agent>?>(null) }
    var listError by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var copied by remember { mutableStateOf(false) }
    var asking by remember { mutableStateOf(false) }
    LaunchedEffect(ws, reload) {
        try {
            list = workspaces.agents(ws).sortedWith { a, b -> compare.compare(a.name, b.name) }
            listError = null
        } catch (e: kotlin.coroutines.cancellation.CancellationException) {
            throw e
        } catch (e: Exception) {
            listError = ui.errorText(e, ui.context(ws))
        }
    }
    val current = step
    val form = remember(current) { (current as? AgentStep.Form)?.let { AgentFormState(it.agent) } }
    val sponsor = form?.agent?.sponsor ?: me
    val choosable = remember(view, sponsor, compare) { AgentRules.choosable(view.members, sponsor, compare) }
    val formBusy = ui.isBusy(KEY_FORM)
    // A key only this sheet can show stays until it was copied, and the sheet stays while one is being made.
    val holdClose: () -> Boolean = {
        val making = ui.isBusy(KEY_FORM) || list.orEmpty().any { ui.isBusy(ui.agentKeyKey(it.id)) }
        val key = step is AgentStep.Key && !copied
        if (!making && key) asking = true
        making || key
    }

    fun showKey(made: MadeAgent) {
        copied = false
        step = AgentStep.Key(made)
        reload++
    }

    // Opened on a form or a key from Workspace members, the person goes back there once it is done.
    fun back() {
        if (fromMembers) app.openChatSheet(ChatSheet.MEMBERS) else step = AgentStep.Agents
    }

    fun submit(f: AgentFormState) {
        if (!f.ready(choosable)) return
        f.error = null
        val picked = f.picked(choosable)
        val agent = f.agent
        ui.attempt(KEY_FORM, failed = { e -> f.error = ui.errorText(e, ui.context(ws)) }) {
            if (agent == null) {
                showKey(createAgent(ws, f.name, f.answers, picked, f.answersAgents))
            } else {
                updateAgent(ws, agent.id, f.name, f.answers, picked, f.answersAgents)
                reload++
                back()
            }
        }
    }

    val title = when (current) {
        AgentStep.Agents -> stringResource(R.string.chat_agents_title, view.ws.name)
        is AgentStep.Form -> current.agent?.let { stringResource(R.string.chat_agents_edit_title, it.name) } ?: stringResource(R.string.chat_agents_add_title)
        is AgentStep.Key -> stringResource(R.string.chat_agents_key_title, current.made.agent.name)
    }
    SheetFrame(
        twoPane,
        title,
        onDismiss,
        holdClose = holdClose,
        buttons = { close ->
            when (current) {
                AgentStep.Agents -> {
                    // Close waits while a new key is made: the answer is the only place the key shows, and the old
                    // key stops as soon as the server makes the new one.
                    val rotating = list.orEmpty().any { ui.isBusy(ui.agentKeyKey(it.id)) }
                    Secondary(stringResource(R.string.common_actions_close), enabled = !rotating) { close() }
                    Primary(stringResource(R.string.chat_agents_add), busy = false) { step = AgentStep.Form(null) }
                }
                is AgentStep.Form -> {
                    Secondary(stringResource(R.string.common_actions_cancel), enabled = !formBusy) { back() }
                    Primary(
                        stringResource(if (current.agent == null) R.string.chat_agents_make else R.string.common_actions_save),
                        busy = formBusy,
                        enabled = form?.ready(choosable) == true,
                    ) { form?.let(::submit) }
                }
                is AgentStep.Key -> if (copied) {
                    Primary(stringResource(R.string.chat_invite_done), busy = false) { back() }
                } else {
                    Secondary(stringResource(R.string.chat_invite_done)) { asking = true }
                }
            }
        },
    ) { close ->
        when (current) {
            AgentStep.Agents -> AgentList(
                app, ws, list, listError, members, me, view.me.role,
                onEdit = { step = AgentStep.Form(it) },
                onKey = ::showKey,
                onRemoved = { reload++ },
            )
            is AgentStep.Form -> form?.let { AgentFields(it, members, me, choosable, chat.agentDepth, formBusy) }
            is AgentStep.Key -> KeyFields(ui, current.made, server = chat.server, ws = ws, copied = copied, onCopied = { copied = true })
        }
        if (asking) {
            RkDialog(
                title = stringResource(R.string.chat_agents_close_title),
                text = stringResource(R.string.chat_agents_close_body),
                confirmLabel = stringResource(R.string.common_actions_close),
                dismissLabel = stringResource(R.string.chat_invite_go_back),
                onConfirm = {
                    asking = false
                    copied = true
                    close()
                },
                onDismiss = { asking = false },
            )
        }
    }
}

/** The list: what agents are, then each agent, or why there are none. */
@Composable
private fun AgentList(
    app: AppViewModel,
    ws: String,
    agents: List<Agent>?,
    error: String?,
    members: Map<String, Member>,
    me: String,
    myRole: String,
    onEdit: (Agent) -> Unit,
    onKey: (MadeAgent) -> Unit,
    onRemoved: () -> Unit,
) {
    Form { SheetText(stringResource(R.string.chat_agents_intro)) }
    Column {
        when {
            agents == null && error == null -> Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { Spinner(size = 16.dp) }
            agents != null && agents.isEmpty() -> Form { Help(stringResource(R.string.chat_agents_none)) }
        }
        error?.let { Form { ErrorLine(it) } }
        for (agent in agents.orEmpty()) AgentRow(app, ws, agent, members, me, myRole, onEdit = { onEdit(agent) }, onKey = onKey, onRemoved = onRemoved)
    }
}

/** An agent in the list: its name, the line about it, and a menu for those who may change it. */
@Composable
private fun AgentRow(
    app: AppViewModel,
    ws: String,
    agent: Agent,
    members: Map<String, Member>,
    me: String,
    myRole: String,
    onEdit: () -> Unit,
    onKey: (MadeAgent) -> Unit,
    onRemoved: () -> Unit,
) {
    val ui = app.chatUi
    val seen = agent.lastSeen?.let { stringResource(R.string.chat_agents_last_active, dateTime(it)) } ?: stringResource(R.string.chat_agents_never_active)
    val note = listOfNotNull(agentNote(agent.settings, members), seen).joinToString(" · ")
    val member = members[agent.id] ?: Member(agent.id, Member.KIND_AGENT, agent.name, "member", "active", agent = agent.settings)
    val manage = AgentRules.canManage(agent.sponsor, me, myRole) && takesWrites(app, ws)
    val newKey = AgentRules.canNewKey(agent.sponsor, me)
    PersonRow(
        agent.id,
        member,
        agent.name,
        note = note,
        trailing = if (!manage) null else {
            {
                MemberMenu(stringResource(R.string.chat_members_more, agent.name)) { dismissMenu ->
                    RkMenuItem(stringResource(R.string.chat_agents_edit), icon = RukooIcons.Edit, onClick = {
                        dismissMenu()
                        onEdit()
                    })
                    // Only its sponsor: a key reads the agent's channels, private ones too.
                    if (newKey) {
                        RkMenuItem(stringResource(R.string.chat_agents_new_key), icon = KeyIcon, enabled = !ui.isBusy(ui.agentKeyKey(agent.id)), onClick = {
                            dismissMenu()
                            ui.askNewAgentKey(ws, agent.id, agent.name, onKey)
                        })
                    }
                    MenuSeparator()
                    RkMenuItem(stringResource(R.string.chat_agents_remove), icon = RukooIcons.Trash, danger = true, onClick = {
                        dismissMenu()
                        ui.askRemoveAgent(ws, agent.id, agent.name)?.invokeOnCompletion { onRemoved() }
                    })
                }
            }
        },
    )
}

/**
 * The form's fields: name, who it answers, the people for "Chosen people" from [choosable] (found by name, guests
 * too) with how many are picked, and whether it answers other agents, with the server's [depth] limit. A new agent's
 * form ends with what comes next: its key and the runner config.
 */
@Composable
private fun AgentFields(
    f: AgentFormState,
    members: Map<String, Member>,
    me: String,
    choosable: List<Member>,
    depth: Int,
    busy: Boolean,
) {
    val names = rememberChatNames()
    val sponsor = f.agent?.sponsor ?: me
    val sponsorName = names.display(members[sponsor])
    val shown = SheetRules.pickerShown(choosable, f.query, null) { names.display(it) }
    Form {
        RkTextField(
            value = f.name,
            onValueChange = {
                f.name = it
                f.error = null
            },
            label = stringResource(R.string.chat_agents_name),
            placeholder = stringResource(R.string.chat_agents_name_placeholder),
            enabled = !busy,
        )
        Text(stringResource(R.string.chat_agents_answers), style = Rk.type.text12_5, color = Rk.colors.text2)
    }
    Column(Modifier.selectableGroup()) {
        RadioRow(
            stringResource(R.string.chat_agents_answers_everyone_option),
            selected = f.answers == AgentRules.EVERYONE,
            onClick = { f.answers = AgentRules.EVERYONE },
            hint = stringResource(R.string.chat_agents_answers_everyone_help),
        )
        RadioRow(
            if (sponsor == me) stringResource(R.string.chat_agents_answers_me_option) else stringResource(R.string.chat_agents_answers_sponsor_option, sponsorName),
            selected = f.answers == AgentRules.SPONSOR,
            onClick = { f.answers = AgentRules.SPONSOR },
            hint = stringResource(R.string.chat_agents_answers_only_help),
        )
        RadioRow(
            stringResource(R.string.chat_agents_answers_chosen_option),
            selected = f.answers == AgentRules.MEMBERS,
            onClick = { f.answers = AgentRules.MEMBERS },
            hint = if (sponsor == me) stringResource(R.string.chat_agents_answers_chosen_help) else stringResource(R.string.chat_agents_answers_chosen_sponsor_help, sponsorName),
        )
    }
    if (f.answers == AgentRules.MEMBERS) {
        if (SheetRules.successorSearch(choosable.size)) Form { RkSearchField(f.query, { f.query = it }, placeholder = stringResource(R.string.chat_members_search)) }
        Column {
            when {
                choosable.isEmpty() -> Form { Help(stringResource(R.string.chat_agents_nobody_to_pick)) }
                shown.isEmpty() -> Form { Help(stringResource(R.string.chat_new_none)) }
            }
            val full = f.chosen.size >= AgentRules.MEMBERS_MAX
            for (m in shown) {
                val on = m.id in f.chosen
                CheckRow(
                    names.display(m),
                    checked = on,
                    enabled = !busy && (on || !full),
                    tag = if (m.role == "guest") stringResource(R.string.chat_roles_guest) else null,
                    onChange = { now -> f.chosen = if (now) f.chosen + m.id else f.chosen - m.id },
                    leading = { Avatar(m.name, m.id, size = 24.dp) },
                )
            }
        }
        if (choosable.isNotEmpty()) {
            // Nobody picked yet keeps the button off, and the line says why; then it says how many are picked.
            val count = f.picked(choosable).size
            Form {
                if (count == 0) {
                    Help(stringResource(R.string.chat_agents_chosen_none), warn = true)
                } else {
                    Help(pluralStringResource(R.plurals.chat_agents_chosen_count, count, count))
                }
            }
        }
    }
    CheckRow(
        stringResource(R.string.chat_agents_answers_agents_option),
        checked = f.answersAgents,
        enabled = !busy,
        note = pluralStringResource(R.plurals.chat_agents_answers_agents_help, depth, depth),
        onChange = { f.answersAgents = it },
    )
    if (f.agent == null) Form { Help(stringResource(R.string.chat_agents_runs_note)) }
    f.error?.let { Form { ErrorLine(it) } }
}

/**
 * A key shown once: the key, the server it works at and the workspace's ID, each to read, and a runner config that
 * holds all three, to copy, with what to change in it and how to start the runner. Until something was [copied],
 * Copy key is the filled button.
 */
@Composable
private fun KeyFields(ui: ChatUi, made: MadeAgent, server: String, ws: String, copied: Boolean, onCopied: () -> Unit) {
    val context = LocalContext.current
    val config = remember(made, server, ws) { AgentRules.runnerConfig(server, ws, made.key) }
    val keyCopied = stringResource(R.string.chat_agents_key_copied)
    val configCopied = stringResource(R.string.chat_agents_config_copied)
    Form {
        RkTextField(value = made.key, onValueChange = {}, label = stringResource(R.string.chat_agents_key), readOnly = true, singleLine = false, maxLines = 3, mono = true)
        Help(stringResource(R.string.chat_agents_key_once))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RkButton(stringResource(R.string.chat_agents_copy_key), {
                copySensitive(context, made.key)
                onCopied()
                ui.toasts.showToast(keyCopied)
            }, kind = if (copied) RkButtonKind.SECONDARY else RkButtonKind.PRIMARY, size = RkButtonSize.SMALL, icon = PanelIcons.Copy)
        }
        RkTextField(value = server.trimEnd('/'), onValueChange = {}, label = stringResource(R.string.chat_agents_server), readOnly = true)
        RkTextField(value = ws, onValueChange = {}, label = stringResource(R.string.chat_agents_workspace_id), readOnly = true, mono = true)
        RkTextField(value = config.trimEnd(), onValueChange = {}, label = stringResource(R.string.chat_agents_config), readOnly = true, singleLine = false, maxLines = 14, mono = true)
        Help(stringResource(R.string.chat_agents_config_backend))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RkButton(stringResource(R.string.chat_agents_copy_config), {
                copySensitive(context, config)
                onCopied()
                ui.toasts.showToast(configCopied)
            }, kind = RkButtonKind.SECONDARY, size = RkButtonSize.SMALL, icon = PanelIcons.Copy)
        }
        Help(stringResource(R.string.chat_agents_config_run))
        Text(AgentRules.RUNNER_COMMAND, style = Rk.type.text12.copy(fontFamily = RukooMono, fontFeatureSettings = null), color = Rk.colors.text)
        Help(stringResource(R.string.chat_agents_config_private))
    }
}

/** Puts [text] on the clipboard marked sensitive, as an invitation link, so Android keeps it out of previews. */
private fun copySensitive(context: Context, text: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(sensitiveClip(text))
}
