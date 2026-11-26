---
pageId: rk-join-chat
slug: chat/join
title: "Join your team and send a first message"
description: "Use a workspace invitation in the desktop app, then send a channel message."
docType: tutorial
productArea: chat
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

In this lesson, you will join a colleague's workspace and send a short message in its first channel. Team chat works with a Rukoo account even when you have no mailbox connected.

## Before you start

Install Rukoo Mail 2.4.0 desktop. Ask a workspace owner or admin for a fresh invitation link. It works once and expires at the time they chose. Your Rukoo account must use the server named in the invitation.

The workspace host can read channel messages and direct messages. Rukoo identifies the host before you join. See [account and chat privacy](/chat/privacy/).

## Bring the invitation into Rukoo

1. At **Set up email**, find **Team chat** and choose **Join with an invitation link**. If you already use Rukoo, open the **Chat** tab and choose **Join with an invitation link** there. If you already have a workspace open, use its menu at the top of the sidebar.
2. Paste the link and choose **Continue**.
3. If asked, sign in to your Rukoo account or [create an account](/account/create/). Save the recovery key when creating one. Rukoo then opens the invitation's Join dialog.
4. Check who invited you, your role, the channels and the expiry. Enter the name your teammates should see.
5. Choose **Join** followed by the workspace's name. Rukoo opens its first channel.

## Send a message

1. In the message box below the conversation, type a short greeting.
2. Press `Enter` to send it. Use `Shift+Enter` for a new line.

Your message appears in the channel. You have joined your team and sent your first message.

## If the link does not work

If it has expired or was already used, ask the sender for a new one. If Rukoo says the invitation is for another server, check **Settings > Rukoo account** against the invitation's host before signing in.

For the next task, learn to [reply in a thread and mention a teammate](/chat/reply-and-mention/).

Source: [Fresh-install chat and invitations](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/chat.md), [Setup flow](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/src/renderer/setup.js), [Join labels](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/src/i18n/en.js), Rukoo Mail 2.4.0.

After joining, [start a direct message](/chat/direct-messages/), [find a channel](/chat/channels/) or [check workspace roles](/chat/roles-and-limits/).
