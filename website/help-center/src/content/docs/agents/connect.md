---
pageId: rk-connect-local-agent
slug: agents/connect
title: "Connect Claude Code or Codex"
description: "Use an installed and signed-in agent beside your mail."
docType: how-to
productArea: agents
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

You need Claude Code or Codex CLI installed and signed in under your user account. Rukoo uses that agent's own account, settings and tools. This route is for the desktop app.

## Connect the agent

1. Open **Settings** > **Agents**.
2. Find the **Claude Code** or **Codex** card and enable it.
3. Check **Program path** if Rukoo cannot find the installed program. Use the executable you already run as your user.
4. Keep **Access** at **Ask before actions**. Commands and file changes will then wait for your approval in the chat.
5. Use **Test** on the card to check the connection.
6. Check **Permission level** and start with **Ask**. This controls Rukoo's own mail and calendar approvals.
7. Open the agent panel with the sparkle button in the title bar and choose the connected agent from its agent menu.

Start a chat and ask a simple question. The answer appears beside your mail. Try [Draft a reply with an agent](/agents/draft-reply/) when the connection works.

## If the program cannot be found

Check that the program works and is signed in outside Rukoo under the same user account. On Linux, Rukoo searches `~/.local/bin` and its process's `PATH`. On macOS it also searches common Homebrew and Node version-manager directories. Set **Program path** for an installation elsewhere.

## Understand the two permission settings

**Access** controls the agent's commands and file changes. **Permission level** controls Rukoo's mail actions, calendar events and proposal cards. Read the [permission table](/agents/permissions/) before changing either.

For Hermes, OpenClaw or another agent, use the [connection guide on GitHub](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/agents.md#how-each-agent-connects). Those routes have their own server and network prerequisites.

Read more: [Agents guide (GitHub)](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/agents.md).

Other connections: [Hermes Agent](/agents/hermes/), [OpenClaw](/agents/openclaw/) and [custom agents](/agents/custom/). To use desktop agents from Android, [pair your phone](/agents/pair-phone/).
