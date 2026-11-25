---
pageId: "rk-android-use"
slug: "start/android"
title: "Use Rukoo on Android"
description: "Set up phone mail, understand background sync and reach your agents."
docType: "how-to"
productArea: "platforms"
appliesTo: ["Android 0.6.0"]
reviewed: "2026-11-25"
behaviorChecked: null
---

You need Android 12 or newer. Android 0.6.0 is experimental and designed around a foldable screen.

## Start with mail

1. Install the APK from [Rukoo releases on GitHub](https://github.com/MajesteitBart/rukoo/releases/tag/v2.4.0). Android asks whether to allow installation from that source.
2. Choose **Try the demo account** for sample mail, **Add account** for a provider, or **Connect to Rukoo on your computer** to pair.
3. For Google, supply the desktop OAuth client or Google's client JSON file and complete browser sign-in. Other providers use the same [mail requirements](/mail/providers/) as desktop.
4. Open a message, write a test reply and check the sending account before sending.

To transfer your own desktop accounts and run Claude Code or Codex through the computer, follow [Pair an Android phone](/agents/pair-phone/).

## Work on either screen

A narrow screen shows the list, email, composer or agent panel one at a time. The folders button opens the accounts and views. At 600dp or wider, the list and email can sit side by side; opening the agent panel places it beside the email. Folding keeps the open email, chat and draft.

In an agent chat, the **+** button offers **Files**, **Photos** and **Add this email** where applicable. PDFs go to the agent as files without extracted text on this version.

## Sync and remote tools

Mail syncs on opening, on the interval while open and about every 15 minutes in the background. Android controls background scheduling. New mail gives one notification per account, subject to category settings.

**Settings** > **Phone tools** enables the phone's agent tools over Tailscale. On a Samsung device, its **Battery** setting opens the system page where **Unrestricted** can keep the tools reachable. Hermes needs bridge-4 or newer to discover a phone; refresh its bridge if it only lists computers.

Use desktop Rukoo for calendar, booking-page editing and meetings. Android has [team chat](/chat/roles-and-limits/) with its own rich-message limits.
