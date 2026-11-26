---
pageId: rk-voice-versions
slug: meetings/requirements
title: "Rukoo Voice versions and requirements"
description: "Check supported platforms and the Mail and Voice pairing for meetings."
docType: reference
productArea: meetings
appliesTo: ["Mail 2.4.0 desktop", "Voice 0.2.0 Windows and Apple Silicon macOS 15+"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Meetings use two desktop apps on the same computer: Rukoo Voice records and transcribes; Rukoo Mail shows the transcript, notes and agent chat.

## Supported pairing

| App | Version for these guides | Platform |
| --- | --- | --- |
| Rukoo Mail | 2.4.0 | Windows, or the experimental macOS build |
| Rukoo Voice | 0.2.0 | Windows or Apple Silicon Mac with macOS 15 or later |
| Rukoo for Android | 0.6.0 | Has no meeting view or recording companion |

Voice 0.2.0 uses bridge protocol 2. Mail 2.3.0 uses protocol 1 and needs an update to work with it. Start Voice yourself before opening **Meet** in Mail. Mail cannot launch it for you.

Download Voice from the [Voice 0.2.0 release on GitHub](https://github.com/MajesteitBart/rukoo/releases/tag/voice-v0.2.0). Use the package for your operating system. Voice's update check reports new versions; installation is manual.

## Audio and transcription

Voice records your microphone and the audio the computer plays. Headphones help keep the call out of the microphone track.

Meeting transcription uses a local model unless you choose a cloud provider. A cloud provider receives meeting audio only after you agree to send it to that provider and server. Without that agreement, the recording continues and transcription waits.

## macOS permissions

Voice needs **Microphone** and **System Audio Recording Only** for meeting audio. Screen capture additionally needs **Screen & System Audio Recording**. Dictation needs **Accessibility** so Voice can type in other apps.

The Mac build is ad-hoc signed. After an update, macOS can still show the old copy's permissions as on while the new copy lacks them. In **System Settings** > **Privacy & Security**, remove the old entry, add Voice again and enable the needed permissions.

If the call stays silent, check **System Audio Recording Only** first. A silent-call warning can also occur while everyone is muted, so listen for actual call audio before changing permissions.

Start with [Record an audio meeting](/meetings/record/) and then [Review the transcript and notes](/meetings/review/).

Read more: [Meetings guide (GitHub)](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/meetings.md), [Rukoo Voice guide (GitHub)](https://github.com/MajesteitBart/rukoo/blob/voice-v0.2.0/voice/README.md), [Voice 0.2.0 release (GitHub)](https://github.com/MajesteitBart/rukoo/releases/tag/voice-v0.2.0).

Next: [dictate text](/voice/dictation/), [choose screen capture](/meetings/screen/) or [check Voice permissions](/voice/recovery/).
