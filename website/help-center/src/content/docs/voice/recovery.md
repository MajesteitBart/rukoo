---
pageId: "rk-voice-recovery"
slug: "voice/recovery"
title: "Fix Voice permissions or missing meeting audio"
description: "Recover permissions, transcription and the connection to Rukoo."
docType: "how-to"
productArea: "meetings"
appliesTo: ["Mail 2.4.0 desktop with Voice 0.2.0 Windows or macOS"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Keep Mail 2.4.0 and Voice 0.2.0 together. Mail 2.3.0 uses the older bridge protocol. If the connection reports a version mismatch, update the app it names.

## The call is silent on macOS

1. Check that the call itself is producing sound. A muted call or an idle browser output can trigger the silence warning too.
2. Open **System Settings** > **Privacy & Security** and check **System Audio Recording Only** for Voice. Older macOS versions name this System Audio Recording.
3. If it is on but call audio remains silent after an update, remove the old entry, add Voice again and enable it.
4. Test with audible call audio before relying on a meeting recording.

Voice keeps recording when it warns about a silent call track. The microphone can still work while call audio is missing.

## Dictation cannot type

Check Microphone and Accessibility permissions. macOS ties grants to the app signature, so an ad-hoc signed update can require fresh grants. Voice's **Settings** > **Permissions** opens the relevant panes. macOS 27 calls Accessibility's pane **Device Control and Data Access**. Input Monitoring is not required for Voice's dictation key.

## A meeting records without a transcript

Check meeting **Transcription** in Voice. A missing local model or cloud-provider consent can leave transcription waiting while audio records. Select the provider deliberately; cloud meeting audio needs consent for that provider and server.

## Rukoo or Voice restarted

Voice can keep recording while Rukoo is closed. Reopen Rukoo to reconnect and catch up. Voice processes an interrupted meeting on its next start. Check the transcript for gap markers and compare the needed audio before treating the result as complete.

For low disk space or paused uploads, use [Meeting storage](/voice/storage/).
