# Rukoo Voice meeting folder, version 1

A meeting recording is a folder of plain files: a journal of what happened, and the audio in short WAV segments. The recorder, `rukoo-voice-recorder`, writes them, and nothing else does. It runs as its own process, so transcription, the app and Rukoo can crash while the recording goes on. A hard kill at any moment leaves files that open in any WAV reader and lose at most about the last 0.2 s of audio.

The recorder lives in `voice/crates/voice-recorder`, the segment writer and reader in `voice/crates/voice-audio`. The app reads the folder through `voice/crates/voice-meetings`.

## Layout

```
<data>/meetings/<meeting id>/
  meeting.json      written once by the app before the recorder starts
  timeline.jsonl    the journal; the recorder is its only writer
  recorder.json     how to reach the live recorder; removed on a clean stop
  audio/mic/000001.wav, 000002.wav, ...
  audio/call/000001.wav, ...
  transcript.db     the app's transcript; the recorder never opens it
```

`<data>` is Voice's data folder and the meeting id has the form in [PROTOCOL.md](PROTOCOL.md#encoding). `mic` is the user's microphone and `call` the computer's audio output, which holds the other people in a call.

`meeting.json` is the app's description of the meeting. The app writes it to a temporary name and renames it into place. The recorder doesn't read it.

```json
{ "id": "m-20261030-171203-4f2a", "title": "Weekly with Anna", "createdAt": 1793000000000, "tracks": ["mic", "call"], "sources": { "mic": "default-input", "call": "default-output" }, "screen": "off", "startedBy": "voice", "context": null, "version": 1 }
```

## Audio segments

Every segment is 16 kHz, mono, signed 16-bit little-endian PCM with the canonical 44-byte WAV header, the format of Ownkey's meeting chunks and of the speech models. The recorder captures each device in its own format and converts it.

- A segment holds contiguous audio that starts at the meeting time in its `segment` line. It ends at that time plus its samples divided by 16, in whole milliseconds.
- Each track numbers its segments from `000001`. Numbering continues across sessions and a number is never used twice. A resumed recorder continues after the highest number in the timeline or in the folder, whichever is higher, and it never overwrites a file.
- A new segment starts after every 30 s of audio, and after a device change or loss, a pause, a resume, a suspend, the start of a session, and when the recorder fell so far behind that it dropped audio.
- After 30 s, the next segment starts exactly where the previous one ended. When the device's clock has drifted more than 100 ms from the meeting clock, it starts at the clock's time instead, so two neighbouring segments of a track can overlap or leave a gap of about 0.1 s. After any other break, a segment never starts before the end of the track's previous one.

### Writing, in crash-safe order

1. The recorder creates the file, refusing an existing one, with a header that counts 0 samples: RIFF size 36, data size 0.
2. It writes the `segment` line.
3. Every 100 to 200 ms it appends the new samples, then rewrites the RIFF size (offset 4) and the data size (offset 40) in a single write. The samples come first, so the header never counts samples that aren't on disk.
4. It syncs the file to disk every 5 s, and when the segment closes.
5. It closes the segment and writes the `segment_end` line.

A hard kill can leave three things: a file the timeline doesn't name, holding only its header; samples at the end of a file that the header doesn't count yet, at most one append; and half a sample. A power cut can lose up to the last 5 s.

While it records on Windows, the recorder holds the timeline and the open segment with read and delete sharing only. Other processes can read them, and a second writer can't open them.

### Reading

- When the header's data size is smaller than the file, it wins: the rest is an append the writer hadn't counted.
- A data size of 0 or `0xFFFFFFFF` means unknown. Use the file length, rounded down to whole samples.
- `finalize` and `--resume` repair the header from the file length. That recovers an uncounted last append and drops a half sample.

### Silence

The recorder never writes silence to cover a gap: a lost device, a crash, a pause, a suspend or dropped audio stays a gap, and the timeline says why.

The one exception is real silence on a loopback track (`default-output` or `output:<id>`). The loopback endpoint delivers nothing while nothing plays, so while its device is healthy, the recorder pads the track with zeros from the clock once it trails the clock by more than 0.5 s, and again up to the moment of a pause or stop. This is what Ownkey does (`meetings/capture.py:414-418`). Padding stops the moment the device reports an error, and it never trims a track that runs ahead.

## The timeline

`timeline.jsonl` holds one JSON object per line. The recorder writes each line with a single write and a trailing newline, and starts every object with `kind`.

- A reader ignores a last line without a newline, any line that doesn't parse, and kinds and fields it doesn't know. Before a recorder or `finalize` writes to a timeline, it cuts off a last line without a newline.
- `t` is meeting time in milliseconds. Session 1 starts at `t = 0`; its `session` line holds the wall time of that moment. A later session starts at `t` = the wall time now minus that of session 1, but never earlier than anything already recorded, even when the wall clock went back. Within a session `t` follows the monotonic clock, and after a suspend it jumps ahead by the time the computer slept. Pauses don't stop the clock.
- Lines appear in the order they were written, which is close to the order of `t` but not exactly: `segment_end` carries the end computed from the samples, a padded loopback track writes its `segment` line up to 0.5 s after the segment's `t`, and `mark` and `dictation` carry the moment their request arrived.

| `kind` | Fields | When |
|---|---|---|
| `session` | `t`, `wall`, `session`, `pid`, `resumed`, `version`, `recorder` | A recorder starts recording into the meeting. `session` counts from 1, `version` is the format version 1, `recorder` the recorder's version |
| `track` | `t`, `track`, `source`, `device`, `deviceId`, `nativeRate`, `nativeChannels` | A track opened a device: at the start, after a loss, after a move and after a suspend. `device` is its name |
| `segment` | `t`, `track`, `seq`, `file` | A segment starts at `t`. `file` is relative to the meeting folder, with forward slashes |
| `segment_end` | `t`, `track`, `seq`, `samples` | A segment closed; `t` is its end |
| `heartbeat` | `t`, `wall`, `samples` | Every second. `samples` maps each track with an open segment to the samples on disk in it; a track without one is missing |
| `device_lost` | `t`, `track`, `error` | A track has no device: it failed to open, the device failed, a microphone sent nothing for 5 s, or the disk refused the audio. Its segment closed |
| `device` | `t`, `track`, `device`, `reason` | A track got a device back, `reconnected`, or moved to another one, `default`. A `track` line follows |
| `pause`, `resume` | `t` | The user paused or resumed |
| `mark` | `t`, `id`, `label` | A user mark. `id` is `k-<n>` and `n` keeps counting across sessions; `label` is `null` without one |
| `dictation` | `t`, `state` | The app reports dictation on the microphone: `start` or `end` |
| `suspend` | `t`, `until` | The wall clock jumped more than 3 s past the heartbeat interval, so the computer slept. `t` is the last heartbeat before it, `until` the meeting time after it. The segments closed before the line; `track` lines follow as the devices reopen |
| `crash` | `t`, `lastSeen` | Written by a resumed session: the previous one died, and audio is missing from `lastSeen` to `t` |
| `stop` | `t`, `wall`, `reason` | Recording ended: `user`, `rukoo`, `limit` or `interrupted`. Nothing follows |

A microphone that was unplugged for two seconds, with the heartbeats after the first left out:

```json
{"kind":"session","t":0,"wall":1793384408939,"session":1,"pid":14152,"resumed":false,"version":1,"recorder":"0.1.0"}
{"kind":"track","t":33,"track":"mic","source":"default-input","device":"Microphone (USB Audio CODEC)","deviceId":"wasapi:{0.0.1.00000000}.{00000000-0000-0000-0000-000000000001}","nativeRate":48000,"nativeChannels":2}
{"kind":"segment","t":41,"track":"mic","seq":1,"file":"audio/mic/000001.wav"}
{"kind":"heartbeat","t":1050,"wall":1793384409989,"samples":{"mic":16144}}
{"kind":"segment_end","t":1985,"track":"mic","seq":1,"samples":31104}
{"kind":"device_lost","t":2002,"track":"mic","error":"The requested audio device is not available. It may have been disconnected."}
{"kind":"device","t":4076,"track":"mic","device":"Microphone (USB Audio CODEC)","reason":"reconnected"}
{"kind":"track","t":4076,"track":"mic","source":"default-input","device":"Microphone (USB Audio CODEC)","deviceId":"wasapi:{0.0.1.00000000}.{00000000-0000-0000-0000-000000000001}","nativeRate":48000,"nativeChannels":2}
{"kind":"segment","t":4089,"track":"mic","seq":2,"file":"audio/mic/000002.wav"}
{"kind":"segment_end","t":8153,"track":"mic","seq":2,"samples":65024}
{"kind":"stop","t":8160,"wall":1793384417099,"reason":"user"}
```

`reconnected` means the track opened the same device id as before, or its first device. `default` means the id changed: the default device moved, or the track came back on a different default.

`lastSeen` is the highest of: the dead session's start, its last heartbeat `t`, its last `segment_end` `t`, and for each track the last segment's `t` plus its samples on disk divided by 16.

A resumed session writes, in this order: `segment_end` for every segment the dead session left open, after repairing its header; `session` with `resumed` true; `crash`; `pause` when the meeting was paused, because a restart must not record a user who paused; then `track` for each device.

## The recorder

```
rukoo-voice-recorder record --meeting <dir> [--resume] --track mic=<source> [--track call=<source>]
rukoo-voice-recorder finalize --meeting <dir> [--reason interrupted]
rukoo-voice-recorder devices
```

| Source | Records |
|---|---|
| `default-input` | The default microphone, moving with the default |
| `default-output` | Loopback of the default output device, moving with the default; padded |
| `input:<id>` | One microphone, by an `id` from `devices` |
| `output:<id>` | Loopback of one output device, by an `id` from `devices`; padded |
| `synthetic:tone:<hz>` | For tests: a sine at half scale, 48 kHz stereo, in real-time 10 ms blocks |
| `synthetic:idle` | For tests: a healthy loopback with nothing playing, which delivers nothing; padded |
| `file:<path>[,loop]` | A WAV file in real time, then silence, or looped. For end-to-end tests with recorded speech |

The synthetic sources take `,fail-at=<ms>` (the device disappears, reported through the same path as a real loss), `,back-at=<ms>` (it can be opened again) and `,switch-at=<ms>` (another device becomes the default). The times count from the start of the session. Device sources work on Windows only in this version; elsewhere `record` refuses them with exit code 2.

Two options exist for tests: `--limit-ms <ms>` replaces the 8-hour limit and `--segment-ms <ms>` the 30 s segment length.

| Exit code | Meaning |
|---|---|
| 0 | Done |
| 1 | Failed, for example a disk error at start |
| 2 | Wrong arguments, or a source this platform can't record |
| 3 | The meeting doesn't allow it: `record` without `--resume` into a meeting that has a recording, or any `record` after `stop` |
| 4 | Another recorder is recording into the meeting |

### `record`

- It refuses to start while `recorder.json` names a recorder that answers on its port.
- `--resume` continues a meeting whose recorder died. With an empty timeline it starts session 1.
- It captures each device in the device's own format and converts it to 16 kHz mono.
- A `default-*` track checks the default device every 2 s and moves to a new one. It also rebuilds its stream when Windows reports the default changed.
- A failed device closes the segment and writes `device_lost`. The track retries every second: a `default-*` track opens whatever is the default, an `input:` or `output:` track waits for its own device. Unplugging and Bluetooth profile switches show up this way.
- It stops on the `stop` command, when the meeting reaches 8 hours (reason `limit`), or when it's killed. It doesn't stop when its parent exits. It never reads stdin, writes nothing to stdout, and reports problems on stderr.
- On stop it pads healthy loopback tracks up to that moment, closes every segment, writes `stop`, removes `recorder.json` and only then replies.
- On Windows the app starts it detached: no console, its own process group, and outside any kill-on-close job, so it outlives the app.

### `recorder.json`

```json
{ "pid": 14152, "port": 51544, "token": "q7hR0lJ3x2b8Yc5vN1mK4sT9wE6uA0dF3gH2jL5pZ8o", "session": 1, "startedAt": 1793384408939 }
```

The recorder writes it after the `session` line, to a temporary name that it renames into place. `token` is 32 random bytes as base64url, made fresh for every session. A recorder is live only when it answers `status` on that port with that token; the file alone, or a running `pid`, proves nothing.

### `finalize`

`finalize` finishes a meeting whose recorder died: it repairs every segment header from the file length, writes `segment_end` for segments that have none, and writes `stop` at `lastSeen` with the given reason, `interrupted` by default, when the timeline has no `stop`. It removes a stale `recorder.json`. Running it again changes nothing. It refuses a live meeting with exit code 4, and prints:

```json
{ "ok": true, "ended": 2, "stopped": true, "t": 1528, "problems": [] }
```

`stopped` says whether it wrote `stop` now, and `t` is that line's time. `problems` lists segments it couldn't repair, such as a missing file.

### `devices`

```json
{ "inputs": [{ "id": "wasapi:{0.0.1.00000000}.{00000000-0000-0000-0000-000000000001}", "name": "Microphone (USB Audio CODEC)", "default": true }], "outputs": [{ "id": "wasapi:{0.0.0.00000000}.{00000000-0000-0000-0000-000000000002}", "name": "Speakers", "default": true }] }
```

## The control port

The recorder listens on `127.0.0.1` at the port in `recorder.json`. A client sends one JSON object per line and gets one line back for each. Every request carries the token, and a connection can carry several requests.

```json
{ "token": "q7hR0lJ3x2b8Yc5vN1mK4sT9wE6uA0dF3gH2jL5pZ8o", "cmd": "mark", "label": "Decision" }
```

| `cmd` | Arguments | Reply |
|---|---|---|
| `status` | | `{"ok":true,"state":"recording","t":5120,"tracks":{"mic":{"device":"…","ok":true}}}`; `state` is `recording` or `paused`; a track without a device has `"device":null,"ok":false` and an `error` |
| `stop` | `reason`: `user` (default) or `rukoo` | `{"ok":true,"t":8160}` once `stop` is written; then the recorder exits |
| `pause` | | `{"ok":true,"t":…}`, or `not_recording` when already paused |
| `resume` | | `{"ok":true,"t":…}`, or `not_recording` when not paused |
| `mark` | `label`, optional, at most 1000 characters | `{"ok":true,"id":"k-3","t":…}`; also while paused |
| `dictation` | `state`: `start` or `end` | `{"ok":true,"t":…}` |
| `tap` | `track` | `{"ok":true,"rate":16000}`, then the raw PCM of that track; `unknown_track` when the meeting doesn't record it |

Errors are `{"ok":false,"error":"<code>"}`:

| `error` | Meaning | Connection |
|---|---|---|
| `bad_token` | The token is missing or wrong | closed |
| `bad_request` | The line isn't a JSON object, or the arguments are wrong | closed for a line that isn't JSON, open otherwise |
| `unknown_command` | The recorder doesn't know `cmd` | open |
| `not_recording` | `pause` while paused, `resume` while recording | open |
| `unknown_track` | `tap` for a track the meeting doesn't record | open |

A request line is at most 64 KiB, and the recorder serves at most 16 connections at a time.

After a successful `tap` the connection carries raw signed 16-bit little-endian PCM, 16 kHz, mono, as the track captures it, until the client closes it or the recording stops. The tap carries audio also while the meeting is paused, so dictation during a pause still works, and it never carries padding. A client more than about 5 s behind is disconnected rather than handed audio with holes in it. During a meeting the app reads the microphone for dictation from this tap, so the microphone is captured once.

## Versioning

This document describes version 1, the `version` in `session` lines and in `meeting.json`. New line kinds, new fields and new values for `reason` keep the version, because readers ignore what they don't know. A change an older reader would misread, such as a renamed field or a new unit, raises it.
