---
pageId: "rk-voice-storage"
slug: "voice/storage"
title: "Manage meeting storage and deletion"
description: "Set audio retention, optional bucket sync and meeting deletion."
docType: "reference"
productArea: "meetings"
appliesTo: ["Mail 2.4.0 desktop with Voice 0.2.0"]
reviewed: "2026-11-25"
behaviorChecked: null
---

## Local recordings

Voice records media on this computer first. **Settings** > **Storage** shows the recordings folder and disk use. **Keep audio** controls audio retention for meetings recorded after the change. Text stays until you delete a meeting. Audio is needed for playback, re-transcription and splitting shared-microphone speakers.

When space runs low, Voice drops video before frames. Video stops below 4 GiB free and frames below 2 GiB. Check storage before a long recording.

## Optional bucket sync

Sync starts off. It requires your own S3-compatible bucket and a successful **Test connection**. Save the encryption key when Settings offers it. Restoring on a new computer needs that key.

| Change or condition | Result |
| --- | --- |
| Sync enabled | Voice uploads media and meeting text after encrypting files locally. The provider still sees file counts, sizes and timing. |
| New secret or corrected bucket details | Uploads pause until Test connection passes again. |
| Another bucket, endpoint or folder | Voice uploads files still on this computer again. It does not copy objects from the previous bucket. |
| Media waiting to upload | Voice normally retains it locally. Below 10 GB free, the oldest waiting media can be removed, video first. Settings reports what did not reach the bucket. |
| macOS refuses the keychain | Uploads pause. Settings offers **Try again** after access is restored. |

Configure the bucket's lifecycle to match how long you want media kept there. Confirm a restore before relying on the bucket as your only copy.

## Rename or delete a meeting

Rename a meeting in Rukoo; its changed title stays in Rukoo. Deleting a finished meeting permanently removes its local media and owned data, and queues a bucket index tombstone even offline. Encrypted bucket objects follow the bucket's lifecycle. Chats remain with a deleted-meeting label.

Check what you need to keep before confirming deletion. [Review speakers and notes](/meetings/review/) first if the recording still needs work.
