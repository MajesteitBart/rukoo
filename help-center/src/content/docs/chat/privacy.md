---
pageId: rk-chat-privacy
slug: chat/privacy
title: "How account and chat privacy differ"
description: "Understand encrypted account records and the workspace host's access to team chat."
docType: explanation
productArea: chat
appliesTo: ["Mail 2.4.0", "Android 0.6.0"]
reviewed: "2026-11-24"
behaviorChecked: null
---

Rukoo uses different privacy models for account sync and team chat. The distinction matters when you choose a workspace host and decide what to share.

## Account sync

The records your Rukoo account syncs are end-to-end encrypted. The key comes from your password and stays on your device. The account server stores the encrypted records.

## Team chat

The server that runs a workspace can read and change its messages, including direct messages. It can also read files shared in chat. Choose a host you trust with those conversations.

Rukoo names the host before you join a workspace, in direct-message conversation headers and in **Workspace settings**. That identifies who operates the workspace you are using.

## Browser chat

Browser Chat uses a session that can access Chat but cannot read or change your encrypted account records. The browser loads its code from the host's website. A host that changes that code could capture a password entered there. The desktop and Android apps run the code you installed.

These differences explain why encrypted account sync does not make team conversations private from the workspace host.

Read the released [team chat guide](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/chat.md#what-the-host-can-read) and [account guide](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/account.md#in-a-browser) for the full privacy model.
