---
pageId: "rk-chat-roles"
slug: "chat/roles-and-limits"
title: "Workspace roles and limits"
description: "Look up roles, retention and desktop, browser and Android differences."
docType: "reference"
productArea: "chat"
appliesTo: ["Mail 2.4.0 desktop", "Android 0.6.0", "Browser chat on a supporting server"]
reviewed: "2026-11-25"
behaviorChecked: null
---

## Roles

| Role | Workspace powers |
| --- | --- |
| Owner | Change anyone's role and remove anyone. The only owner must appoint another before leaving. |
| Admin | Invite people, change members to guests and guests to members, and remove members or guests. |
| Member | Join visible channels, create channels and use direct messages. |
| Guest | Use the channels selected for them. Guests cannot create channels or use direct messages. |

**Members** in the workspace menu shows the actions available to you. A channel manager is a channel-specific role. See [Manage a channel](/chat/channels/).

**Leave workspace** removes your access; your messages remain under your name. Hand over channels you alone manage first. **Delete workspace** is available to an owner who is its only member and permanently deletes its channels and messages.

## Default limits

A server operator can set different values. **Workspace settings** shows your host, retention and member limit.

| Item | Default |
| --- | --- |
| Message retention | 90 days |
| Members per workspace | 100 |
| Direct-message participants | 2 to 8 |
| Message text | 16 KiB and up to 32 mentions |
| Files | 10 per message, 25 MiB each, where storage is enabled |
| Reactions | 20 different emoji per message |
| Link previews | Up to 3 per message |

## Platform differences

Desktop and browser chat support rich messages on a supporting server. Browser downloads follow browser behavior. Android 0.6.0 supports channels, direct messages, threads, mentions, mute and blocks; it shows Markdown markers as text and omits files, reactions and link previews. Read state syncs; mute and drafts stay on the device.

Desktop chat keeps a local copy for offline use. Signing out or switching servers removes that copy, including unsent messages. [Account and chat privacy](/chat/privacy/) explains who can read workspace messages.
