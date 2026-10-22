package nl.bvdm.rukoo.agents.adapters

import java.util.concurrent.ConcurrentHashMap
import nl.bvdm.rukoo.BuildConfig
import nl.bvdm.rukoo.agents.AdapterDeps
import nl.bvdm.rukoo.agents.AdapterFactory
import nl.bvdm.rukoo.agents.AgentAdapter
import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.model.AgentIds

/**
 * Creates the Hermes, OpenClaw, computer and fake adapters, one per agent id, reused: an adapter keeps its status
 * cache and the runs it still has to stop. Clark and OpenClaw always get one (unconfigured, they say so in their
 * status); a computer agent only while its pairing exists; the fake agent only in debug builds.
 */
class DefaultAdapterFactory(
    private val deps: AdapterDeps,
    /** The hub, for the fake agent's tool calls (plans, sources, proposals) and agent names; null until it exists. */
    private val hub: () -> AgentHub? = { null },
    /** Rukoo's tool handlers for the fake agent, once the MCP side offers them; else [HubFakeTools]. */
    private val fakeTools: FakeTools? = null,
    /** Debug screenshots: every agent id answers with the fake agent, like desktop's SEM_AGENT_FAKE=1. */
    private val allFake: Boolean = false,
    private val debug: Boolean = BuildConfig.DEBUG,
    private val texts: AdapterTexts = ResourceTexts(deps.context),
    /** Multiplies the fake agent's delays. */
    private val fakeScale: Double = 1.0,
) : AdapterFactory {
    private val adapters = ConcurrentHashMap<String, AgentAdapter>()
    private val hello = HelloCache(deps.desktop, deps.scope, deps.clock)

    override fun create(agentId: String): AgentAdapter? {
        val computer = AgentIds.parseComputer(agentId)
        val fake = debug && (agentId == AgentIds.FAKE || (allFake && AgentIds.isKnown(agentId)))
        // A computer that was unpaired takes its agents with it.
        if (!fake && computer != null && deps.settings.current().computer(computer.first) == null) {
            adapters.remove(agentId)
            return null
        }
        adapters[agentId]?.let { return it }
        val made = build(agentId, fake) ?: return null
        return adapters.putIfAbsent(agentId, made) ?: made
    }

    private fun build(agentId: String, fake: Boolean): AgentAdapter? {
        if (fake) return FakeAdapter(agentId, fakeTools ?: HubFakeTools(hub), hub, fakeScale)
        val settings = deps.settings
        return when (agentId) {
            AgentIds.CLARK -> HermesAdapter({ settings.current().clark }, deps.http, deps.scope, texts, deps.clock)
            AgentIds.OPENCLAW -> OpenClawAdapter({ settings.current().openclaw }, deps.http, deps.scope, texts, deps.clock)
            else -> {
                val (pairingId, program) = AgentIds.parseComputer(agentId) ?: return null
                ComputerAdapter(pairingId, program, { settings.current() }, deps.desktop, { deps.mcp.status.value }, hello, deps.scope, texts, deps.clock)
            }
        }
    }
}
