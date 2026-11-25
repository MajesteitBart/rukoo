---
pageId: "rk-phone-pair"
slug: "agents/pair-phone"
title: "Pair an Android phone with your computer"
description: "Run Claude Code or Codex from the phone through desktop Rukoo."
docType: "how-to"
productArea: "agents"
appliesTo: ["Mail 2.4.0 desktop with Android 0.6.0"]
reviewed: "2026-11-25"
behaviorChecked: null
---

You need Android 0.6.0, Mail 2.4.0 open on your computer, Tailscale on both devices and Claude Code or Codex installed and signed in on the computer. A paired phone can run those agents with your computer's sign-ins and files.

## Pair the phone

1. On the computer, open **Settings** > **Agents** > **Phone** and choose **Pair a phone**.
2. Choose **Pair only** to configure accounts on the phone yourself, or **Pair and send my accounts and agent settings** to transfer them. The transfer includes mailbox credentials and agent keys. Choose it only for your own phone.
3. Enter the displayed computer address and one-time code in Rukoo on the phone. The code works for five minutes.
4. Check that the phone appears in the computer's list of paired devices.
5. Start a Claude Code or Codex chat on the phone. Keep Rukoo open on the computer; the tray is enough.

Phone turns ask before commands and file changes. Approve them on the phone. These chats stay in the phone's panel, separate from desktop chats.

## Reconnect or remove the phone

A dropped stream has 30 seconds to reconnect before the turn stops. Check Tailscale, the computer's Rukoo process and **Let my phone use this computer** if it cannot reconnect.

To repeat an account transfer, select the phone and **Send accounts and settings again**. It opens a new ten-minute window for one fetch.

For a lost phone, choose **Remove this phone** on the computer. That revokes its pairing. Credentials it already received remain there, so change the affected passwords and keys and revoke the phone's Google access too.
