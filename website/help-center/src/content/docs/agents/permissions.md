---
pageId: rk-agent-permissions
slug: agents/permissions
title: "Agent permission levels"
description: "Compare Ask, Auto and Full permission for mail and calendar actions."
docType: reference
productArea: agents
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

**Settings** > **Agents** > **Permission level** sets the default. The shield beside **Send** shows the current chat's level. Choose **Default** there to follow Settings again. Changes apply from the agent's next action and a chat keeps its choice after a restart.

## Rukoo actions

| Action | Ask, the default | Auto | Full permission |
| --- | --- | --- | --- |
| Archive, move between folders, mark read or unread, star | Approval card | Goes ahead | Goes ahead |
| Delete or move to Trash | Approval card | Approval card | Goes ahead |
| Move to Spam | Approval card | Approval card | Goes ahead |
| Unsubscribe | Approval card | Approval card | Goes ahead |
| Create an event without guests on your own calendar | Approval card | Goes ahead | Goes ahead |
| Create an event with guests or on someone else's calendar | Approval card | Approval card | Goes ahead; guests receive invitations |
| Propose a message or change in another system | Approval card | Approval card | Agent goes ahead |
| Write a draft into the composer | Goes ahead; you review and send | Same | Same |

Your own calendar means your primary calendar or one you created. A calendar shared with you counts as someone else's, including one you manage.

**Full permission** removes Rukoo's approval cards for actions that can delete mail, send invitations or change another system. Choose it only for an agent you trust to take those actions. An agent may have its own sending tools; Rukoo's draft tool leaves the final email in the composer for you to send.

## Per-chat limits

Claude Code and Codex chats can choose a looser level than Settings. Hermes, OpenClaw and custom-agent chats can choose a stricter level, but cannot loosen the setting. When such an agent works in several chats, the strictest applicable level controls its calls.

## Commands and file changes

Claude Code and Codex have a separate **Access** setting on their cards. **Ask before actions** requests approval for commands and file changes; **Full access** runs them without asking. Hermes and OpenClaw use their own approval settings. OpenClaw's own approvals remain in OpenClaw.

## Android 0.6.0

The phone has no permission-level controls yet. With a transferred Auto or Full permission setting, it archives, moves and marks mail without asking. Other actions still ask, including a move into Trash or Spam. Claude Code and Codex turns from the phone always ask before commands and file changes.

For a first mail task, use [Draft a reply with an agent](/agents/draft-reply/).

Read more: [Agents guide (GitHub)](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/agents.md).
