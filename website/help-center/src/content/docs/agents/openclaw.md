---
pageId: "rk-openclaw-connect"
slug: "agents/openclaw"
title: "Connect OpenClaw"
description: "Connect a gateway and install Rukoo tools on its computer."
docType: "how-to"
productArea: "agents"
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

You need an OpenClaw gateway with its OpenAI-compatible Chat Completions endpoint enabled, and the gateway token or password. Treat that credential as gateway operator access.

## Connect the gateway

1. Enable `gateway.http.endpoints.chatCompletions.enabled` in OpenClaw's configuration and restart the gateway.
2. Open **Settings** > **Agents** > **OpenClaw** in Rukoo.
3. Enter the gateway URL and token. For a gateway on this computer the usual URL is `http://127.0.0.1:18789`.
4. Use **Test connection**. Optionally set an agent ID; an existing chat keeps the agent it started with.

## Let OpenClaw use Rukoo

1. If the gateway runs elsewhere, first turn on **Let OpenClaw use Rukoo from another computer**. Both computers need Tailscale.
2. Choose **Copy OpenClaw setup**. Do both copied steps on the gateway computer: replace its `RUKOO_MCP_TOKEN` line in OpenClaw's `.env` file, then run the copied `openclaw mcp set` command.
3. Restart the gateway so it reads the environment and loads the tools.
4. Run `openclaw mcp doctor rukoo --probe` there. Keep Rukoo open while using the tools.

Use the copied address and token for the chosen local or remote route. If the gateway token changes, copy the setup again and repeat both steps.

## Fix a failed probe

A 401 can mean the gateway never read the environment variable. Setting it in a terminal alone does not update a running service. A variable already present in the service overrides its `.env` file. The [tagged OpenClaw guide on GitHub](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/agents.md#openclaw) covers service configuration and the offline-ownership error.

The chat shows OpenClaw's answer text. Its own approvals stay in OpenClaw; [Rukoo permission levels](/agents/permissions/) govern Rukoo tool actions.
