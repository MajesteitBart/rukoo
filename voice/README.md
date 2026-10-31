# Rukoo Voice

Rukoo Voice is a desktop app for push-to-talk dictation that also records meetings for Rukoo. It will replace [Ownkey for Windows](https://github.com/MajesteitBart/ownkey-windows). Version 0.1 runs on Windows; [What 0.1 leaves out](#what-01-leaves-out) lists the parts of this design that come later.

## What it does

**Dictation.** Hold a key, speak and let go. Voice types the text into whichever app has focus. Hold the rewrite key over selected text to rewrite it with a spoken instruction. Audio goes to the speech provider you configured with your own key, or stays on your computer with a local model.

**Meetings.** Voice records your microphone, the call audio and, if you want, your screen. It transcribes while you talk and streams the transcript to Rukoo. Rukoo shows the meeting next to your agent, so you can ask the agent questions during the call. Afterwards the agent writes the notes with its own meeting-notes skill and stores them where you keep notes.

Voice has no meeting screens of its own. During a meeting the pill shows that it's recording and has a stop button. Meetings need Rukoo. Dictation works without it.

## How Voice and Rukoo work together

```
              commands: start, stop, pause, mark
   Rukoo  ─────────────────────────────────────────►  Rukoo Voice
          ◄─────────────────────────────────────────  mic, call audio, screen
              events: passages, speakers, frames, status
     │
     │  MCP tools: transcript since the last turn, search, notes, frame at time t
     ▼
   Your agent: Hermes, Claude Code, Codex, OpenClaw
```

- Voice sends events to Rukoo over a WebSocket on `127.0.0.1`, protected by a token. Every event has a sequence number. When Rukoo starts late, restarts or loses the connection, it asks for everything after the last number it saw.
- Voice publishes its address and token in a file that only your user account can read. That's how Rukoo finds it.
- You can start and stop a meeting from either app. Voice keeps recording when Rukoo isn't running.
- Voice owns the media: audio tracks, screen frames, video and the transcript as it was recognized. Rukoo owns what you work with: notes, corrections, speaker names, the agent chat and the agent's output. Rukoo uses the calendar event's attendees to turn "Speaker 2" into a name.
- Your agent never talks to Voice. It reaches the meeting through Rukoo's MCP tools. Everyone in the call is a third party, so Rukoo hands the transcript to the agent as untrusted content.
- Voice captures the microphone once, for dictation and the meeting together. If you dictate during a meeting, your words also reach the call. Voice marks those stretches, so the agent knows they weren't part of the conversation.

## Screen recording

Each meeting can record the screen in one of three ways: off, frames only, or the full video. Settings has the default.

- Voice records one monitor at most. It starts with the monitor that shows the call, and you can switch. Recording a single window doesn't work when you share your own screen, because you keep switching windows.
- The agent gets frames, not the video. Each time the screen changes noticeably, Voice saves a frame and the text on it, at that moment in the transcript. When the agent needs more, it asks for a clip between two times.
- Audio and video share one clock. A passage in the transcript jumps to the same moment in the video.
- Video is encoded on the graphics card where possible, because transcription and speaker labels already use more than one CPU core during a meeting. The frame rate stays low while the screen is still and goes up when it changes.

| | Screen | Call audio | Hardware encoder |
|---|---|---|---|
| Windows | Windows.Graphics.Capture | WASAPI loopback, or one app through process loopback | Media Foundation: NVENC, AMF or Quick Sync |
| macOS | ScreenCaptureKit, after the Screen Recording permission | ScreenCaptureKit audio, or Core Audio process taps | VideoToolbox |
| Linux | xdg-desktop-portal ScreenCast over PipeWire | The PipeWire monitor of the output device | VA-API or NVENC |

Rukoo can hide its window from screen capture while a meeting records, so your agent chat stays out of the recording. On Windows 10 2004 and later, that also keeps it out of Teams and Zoom screen shares. On macOS 15 and later, other apps' screen shares still show Rukoo, although Voice can leave it out of its own recording. Linux has no way to hide a window, so keep Rukoo on a monitor you don't record.

## Crash safety

A meeting can't be repeated, so losing a recording is the worst thing Voice can do.

- A small recorder process captures and writes to disk, and nothing else. Transcription, speaker labels, dictation, the tray and Rukoo can all crash while the recording goes on. Transcription reads the recorded files and can always start over from them.
- Every file survives a hard kill. Audio goes to disk in short segments, video as fragmented MP4 with a fragment every second or two, and the transcript into SQLite. A crash loses at most the last fragment.
- A watchdog restarts a crashed recorder into the same meeting and marks the gap. On the next start, Voice finishes processing any meeting that was cut off.
- When the disk fills up or the video encoder fails, Voice drops the video first, then the frames, and never the audio. It tells you what it dropped.
- Voice follows device changes: an unplugged headset, a Bluetooth headset switching profile, a new default device, sleep and resume. It marks the switch instead of recording silence.

## Storage

Everything records to your computer first. A dropped connection never costs audio. Optional sync goes to an S3-compatible bucket you own, such as UpCloud Managed Object Storage or Cloudflare R2. Voice encrypts media before upload, so the storage provider can't listen to your meetings, and uploads video after the meeting, so it doesn't compete with the call. A remote agent gets short-lived links to the files it needs.

## Coming from Ownkey for Windows

On its first start, Voice imports Ownkey's settings and uses the speech models Ownkey already downloaded, so you don't download them again. Ownkey for Windows has no update check, so Voice has an opt-in update check from its first release. Ownkey Keyboard for Android keeps its name and works on its own.

## How it's built

Voice is a Rust workspace with three processes. The recorder, `rukoo-voice-recorder`, captures audio and writes it to disk and does nothing else; [RECORDING.md](RECORDING.md) describes what it writes. The local speech worker, `rukoo-voice-local`, runs Orukeet, so a crashing model can't take dictation down. The app, `rukoo-voice`, is a Tauri shell around everything else: dictation, the pill, Settings, live transcription and the bridge to Rukoo. Its pages are plain HTML, CSS and JavaScript in `ui/`, built from Rukoo's design tokens.

The bridge between Voice and Rukoo is specified in [PROTOCOL.md](PROTOCOL.md), with examples both apps test against in `fixtures/`.

Meeting transcription runs on this computer with Orukeet unless you pick a cloud provider in Settings. A cloud provider gets meeting audio only after you agree to it for that provider and server. Without that agreement, a meeting still records and its transcription waits.

## What 0.1 leaves out

- Screen recording: frames, video and the text read from the screen. The protocol already has the `frame` event and `frame.get`, and Voice answers that it has no frames.
- Speaker labels with Nemotron 3 Diarization. Voice 0.1 labels the microphone as you and the call audio as one speaker.
- Sync to your own bucket.
- Recording a single app's audio through process loopback; Voice records everything the computer plays.
- macOS and Linux capture. The recorder, the bridge and the transcript pipeline are tested on Linux, but the app runs on Windows only.
- A signed installer and automatic updates. The opt-in update check tells you a new version exists.

## Open decisions

- In the first version the agent answers only when you ask. Letting it speak up on its own comes later.
- A ready-made line that tells the other participants their words are recorded and processed.
