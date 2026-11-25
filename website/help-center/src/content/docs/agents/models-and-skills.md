---
pageId: "rk-agent-model-skills"
slug: "agents/models-and-skills"
title: "Choose an agent model or start a skill"
description: "Set chat-specific model choices and use reusable task instructions."
docType: "how-to"
productArea: "agents"
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

## Choose a model for this chat

Use the model menu below the chat input, next to the agent. A change applies to the next message. A running answer keeps its current model. The chat remembers its choice after restart.

**Default** follows **Settings** > **Agents**, or the agent's own model when Settings leaves it empty. The effort menu appears only for agents and models that support effort. OpenClaw has no effort menu.

If a model is missing, check the agent's own sign-in and configuration. Rukoo refreshes the list when the panel opens and caches it for ten minutes. A failed refresh still leaves Default and already configured choices available.

## Start a skill

Type `/` and pick a skill from the suggestions. Rukoo sends its instructions with your message. A skill started while the agent works waits as a new turn. An agent's own skills may appear under `$` where that agent supports listing them.

To add a Rukoo skill, put its folder in `skills/` under [your Rukoo profile](/start/platform-help/). The folder needs a UTF-8 `SKILL.md` with a matching lowercase, hyphenated `name` and a `description`. A profile skill replaces a shipped skill of the same name. Rukoo rereads the folders when you open the panel or type `/`.

The [tagged skills guide on GitHub](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/agents.md#skills) gives the format and size limits. If a skill is missing, ask the connected agent to list `read_skill` results and skipped-skill reasons.

Skills supply instructions. [Permission levels](/agents/permissions/) still govern what Rukoo tools can change.
