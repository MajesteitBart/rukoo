package nl.bvdm.rukoo.agents.adapters

import nl.bvdm.rukoo.agents.AdapterDeps
import nl.bvdm.rukoo.agents.AdapterFactory
import nl.bvdm.rukoo.agents.AgentAdapter

/** Creates the Hermes, OpenClaw, computer and fake adapters. Placeholder until the adapters track fills it in. */
class DefaultAdapterFactory(private val deps: AdapterDeps) : AdapterFactory {
    override fun create(agentId: String): AgentAdapter? = null
}
