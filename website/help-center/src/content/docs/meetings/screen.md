---
pageId: "rk-meeting-screen"
slug: "meetings/screen"
title: "Change screen capture during a meeting"
description: "Choose Off, Frames or Video and the monitor to capture."
docType: "how-to"
productArea: "meetings"
appliesTo: ["Mail 2.4.0 desktop with Voice 0.2.0 Windows or macOS"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Use Mail 2.4.0 with Voice 0.2.0. Both apps need the updated bridge for live capture controls. Tell participants what you will record and check the chosen monitor before starting capture.

## Change capture

1. Start [an audio meeting](/meetings/record/) or open the meeting already recording.
2. Open the screen control in Rukoo's meeting header or Voice's recording pill.
3. Choose **Off**, **Frames** or **Video**, then the monitor. Voice captures one monitor at a time.
4. Check the capture indicator and the timeline's mode-change mark.

Off stops screen capture while audio continues. You can enable capture later in the same meeting, including from an audio-only start or while paused. Voice waits for connected Rukoo apps to confirm window protection before changing mode. If confirmation is missing, the previous mode stays in effect.

On Windows, a border marks the recorded monitor. On macOS, the menu bar shows screen recording. Stopping it there ends the screen part while audio continues.

## What gets saved

Frames captures still images when the screen changes and settles, with locally recognized text where available. Video adds a recording. Without a hardware encoder, Video falls back to frames. Rukoo does not yet play the video; an agent can request frames or a clip through its meeting tools.

Other apps and their notifications can appear on the selected monitor. Keep unrelated information off it. Review the [storage and deletion settings](/voice/storage/) for the resulting media.
