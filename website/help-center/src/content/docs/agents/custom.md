---
pageId: "rk-custom-agent"
slug: "agents/custom"
title: "Connect a custom agent"
description: "Add Booper, a Runs API agent or an OpenAI-compatible server."
docType: "how-to"
productArea: "agents"
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

You need the server URL, its API kind and a key if it requires one. Rukoo supports up to eight custom agents on desktop.

1. Open **Settings** > **Agents** > **Add an agent**.
2. Choose **Booper**, **Runs API agent** or **OpenAI-compatible agent** to match the server.
3. Enter its name, address, key and default model. Test the connection.
4. Choose it by name in the agent panel and send a test question.
5. If it needs Rukoo tools, copy its setup from its card. Apply that setup on the agent's computer. For a remote agent, enable its other-computer option first and use the Tailscale route it supplies.

For Booper, enable its app channel before connecting. **Copy Booper setup** supplies a `booper.yaml` MCP block and an environment line. Put the environment line where Booper's service reads it and restart Booper. The [tagged custom-agent guide on GitHub](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/agents.md#custom-agents) gives the channel and MCP configuration.

## Match conversation behavior

An OpenAI-compatible server receives streamed Chat Completions requests. Rukoo sends previous messages by default for a server that keeps no conversation. Turn off **Send earlier messages** when the server manages its own conversation. Its model menu comes from the server's model list.

Removing a custom agent forgets its address and key and stops its Rukoo-tool token. Existing chats remain, but cannot take new messages. Android 0.6.0 does not show custom agents.

Start with [Ask permission](/agents/permissions/) and test with fictional mail before using an agent for account changes.
