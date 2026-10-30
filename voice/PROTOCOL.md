# Rukoo Voice bridge protocol, version 1

Rukoo Voice records meetings and Rukoo shows them. This document is the contract between the two: how Rukoo finds Voice, how it connects, and the events and commands they exchange. Voice implements it in `voice/crates/voice-protocol` and `voice/crates/voice-bridge`, Rukoo in `src/main/voice/`. A change here needs the matching change on both sides in the same pull request, and both sides test against the same examples in [fixtures/protocol-vectors.json](fixtures/protocol-vectors.json).

Your agent never talks to Voice. It reaches a meeting through Rukoo's MCP tools.

## Encoding

- Every message is one UTF-8 JSON object in one WebSocket text frame. Field names are camelCase.
- Wall times are milliseconds since the Unix epoch, in fields ending in `At`, such as `startedAt`.
- Meeting time is milliseconds since the meeting started, as an integer, in the fields `at`, `start`, `end` and `until`. Audio and screen share this clock, so a passage and a frame with the same meeting time happened together. Pauses don't stop the clock.
- A meeting id is `m-`, the start time in UTC as `YYYYMMDD-HHMMSS`, a dash and four lowercase hex digits: `m-20261030-171203-4f2a`.
- Tokens and instance ids are base64url without padding (RFC 4648 §5).
- A peer ignores fields it doesn't know.

## Finding Voice

Voice writes a discovery file when it starts and removes it when it quits:

```json
{
  "protocol": 1,
  "minProtocol": 1,
  "port": 49821,
  "token": "q7hR0lJ3x2b8Yc5vN1mK4sT9wE6uA0dF3gH2jL5pZ8o",
  "pid": 12345,
  "instance": "Vb3kQ9m2X7pL1sR4tY8wZQ",
  "voiceVersion": "0.1.0",
  "startedAt": 1793000000000
}
```

- `port` is the WebSocket port on `127.0.0.1`. Voice never listens on another address.
- `token` is 32 random bytes, made fresh every time Voice starts.
- `instance` is 16 random bytes, made once per Voice data folder. It changes only when the data folder is new, which also restarts the sequence numbers.
- `pid` is Voice's process id. Rukoo may use it to tell a stale file from a running Voice, but it decides by connecting.

Only the user's account can read the file. On Windows it lives in the user's profile and Voice gives it an access list that grants only that user. On macOS and Linux it has mode `0600` in a folder with mode `0700`. Voice writes it to a temporary name and renames it into place, so Rukoo never reads half a file.

### Where the file is

Both apps work out the same path.

1. If `RUKOO_VOICE_BRIDGE` is set, it is the full path of the file. Both apps use it.
2. Otherwise Voice uses `bridge.json` in its data folder: `RUKOO_VOICE_DATA_DIR` when set, otherwise the default folder: `%LOCALAPPDATA%\Rukoo Voice` on Windows, `~/Library/Application Support/Rukoo Voice` on macOS and `$XDG_STATE_HOME/rukoo-voice` on Linux, where `XDG_STATE_HOME` defaults to `~/.local/state`.
3. Otherwise Rukoo uses `voice-bridge.json` in its profile when `SEM_DATA_DIR` is set, and `bridge.json` in Voice's default folder when it isn't. Rukoo doesn't read `RUKOO_VOICE_DATA_DIR`.

An empty variable counts as unset. A Voice started with `RUKOO_VOICE_DATA_DIR` and a Rukoo started with `SEM_DATA_DIR` never find the installed apps. To pair two development copies, give both the same `RUKOO_VOICE_BRIDGE`.

## Connecting

Rukoo opens `ws://127.0.0.1:<port>/bridge` and sends `hello` as its first message, within 5 seconds. Voice refuses the upgrade with HTTP 403 when the request carries an `Origin` header with an `http` or `https` address, because any web page in a browser can try to open a socket on `127.0.0.1`. Rukoo connects from its main process, which sends no `Origin`.

```json
{ "type": "hello", "protocol": 1, "token": "…", "client": "rukoo", "clientVersion": "2.2.0", "instance": "Vb3kQ9m2X7pL1sR4tY8wZQ", "after": 1041 }
```

- `protocol` is the highest version Rukoo speaks that is also within the file's `minProtocol` to `protocol`.
- `instance` and `after` are the instance and the last sequence number Rukoo saw. On its first connection Rukoo sends `null` and `0`.

Voice compares the token in constant time and answers with `welcome`:

```json
{ "type": "welcome", "protocol": 1, "voiceVersion": "0.1.0", "instance": "Vb3kQ9m2X7pL1sR4tY8wZQ", "head": 1052, "oldest": 1, "replay": "partial", "status": { "recording": null, "dictating": false } }
```

Then Voice sends the events Rukoo missed, oldest first, and after them every new event as it happens. `replay` says which events follow:

| `replay` | When | What Voice sends |
|---|---|---|
| `partial` | `instance` matches and `oldest` − 1 ≤ `after` ≤ `head` | the events after `after` |
| `full` | `instance` is `null` or another instance, or `after` is above `head` | every stored event, from `oldest` |
| `gap` | `instance` matches, but `after` < `oldest` − 1: events Rukoo missed were already removed | every stored event, from `oldest` |

With no stored events, `head` is the last number Voice gave out, or 0, and `oldest` is `head` + 1.

After a `gap`, Rukoo asks `meeting.get` for each meeting it shows that isn't `done`.

A wrong token, an unsupported version or a late or missing `hello` gets an `error` message and the connection closes:

```json
{ "type": "error", "code": "bad_token", "message": "The token doesn't match." }
```

| Close code | `code` | Meaning |
|---|---|---|
| 4001 | `bad_token` | The token is wrong |
| 4002 | `unsupported_protocol` | Voice doesn't speak the requested version |
| 4003 | `hello_timeout` | No `hello` within 5 seconds, or another message first |
| 4004 | `too_many_clients` | Four clients are already connected |
| 1001 | | Voice is quitting |

Voice sends a WebSocket ping every 20 seconds and closes a connection that doesn't answer within 20 seconds. Rukoo reconnects with backoff, starting at 1 second and doubling up to 30 seconds, and starts again at once when the discovery file changes.

A message from Rukoo is at most 1 MiB. A message from Voice is at most 8 MiB.

## Events

Voice sends events. Every event has a sequence number, and Voice stores events, so Rukoo can ask for everything after the last number it saw.

```json
{ "type": "event", "seq": 1042, "event": "passage", "meeting": "m-20261030-171203-4f2a", "createdAt": 1793000000123, "data": { } }
```

- `seq` starts at 1 and goes up by one for every event, across restarts of Voice. Only a new data folder, which brings a new `instance`, starts it again.
- `meeting` is there for meeting events and missing for the others.
- Applying an event twice gives the same result. Things with an id replace the earlier version with the same id.
- Rukoo ignores event types it doesn't know.
- Voice keeps a meeting's events as long as it keeps the meeting. `oldest` in `welcome` is the lowest stored number.

### `status`

What Voice is doing right now. `welcome` carries the same object.

```json
{ "recording": "m-20261030-171203-4f2a", "dictating": false }
```

`recording` is the meeting being recorded or paused, or `null`. `dictating` is true while the user holds a dictation key.

### `meeting.started`

```json
{ "title": "Weekly with Anna", "startedAt": 1793000000000, "tracks": ["mic", "call"], "screen": "off", "startedBy": "rukoo", "context": { "calendarEvent": "abc123" } }
```

- `tracks` are the audio tracks Voice records: `mic` is the user's microphone, `call` the computer's audio output, which holds the other people in a call.
- `screen` is `off`, `frames` or `video`. Voice 0.1 always records with `off`.
- `startedBy` is `voice` or `rukoo`.
- `context` is the object `meeting.start` passed, unchanged, or `null`. Voice stores it and doesn't read it.

### `meeting.state`

```json
{ "state": "processing", "at": 3605120, "endedAt": 1793003605120, "reason": "user" }
```

| `state` | Meaning |
|---|---|
| `recording` | Voice records |
| `paused` | Voice records nothing until it resumes; the clock keeps running |
| `processing` | Recording ended; Voice is still transcribing what it recorded |
| `done` | Every recorded second is transcribed |
| `failed` | Voice can't finish the transcript; `reason` says why. The audio stays |

- `at` is the meeting time of the change.
- `endedAt` comes with `processing` and with every state after it.
- `reason` comes with `processing` and `failed`: `user` when someone pressed Stop, `rukoo` when Rukoo sent `meeting.stop`, `interrupted` when Voice found the meeting cut off at its next start, `limit` when the meeting reached Voice's length limit, or an error text for `failed`.

### `speaker`

A voice in the meeting, as Voice labels it.

```json
{ "id": "call-1", "track": "call", "label": "Speaker 1" }
```

The user's microphone is the speaker `mic` with the label `You`. Voice 0.1 labels the whole call track as one speaker, `call-1`. With speaker labels, the call gets `call-1`, `call-2` and so on. Rukoo owns the names people give speakers; Voice never learns them.

### `passage`

A stretch of transcript.

```json
{ "id": "call-000065320", "track": "call", "speaker": "call-1", "start": 65320, "end": 71880, "text": "Let's move the launch to Thursday.", "revision": 1, "dictation": false, "language": "en" }
```

- `id` is the track, a dash and the start in milliseconds as nine digits. It stays the same when Voice transcribes the passage again.
- A passage with a higher `revision` replaces the one Rukoo has. Voice sends a new revision when a better transcript or a settled speaker arrives.
- `speaker` is a speaker id, or `null` while Voice doesn't know.
- `dictation` is true when the user was dictating into another app while the meeting recorded. Those words reached the call, but weren't part of the conversation.
- `language` is a BCP 47 code when the recognizer reports one, otherwise `null`.

### `passage.removed`

```json
{ "id": "call-000065320" }
```

Voice removed a passage, for example when it transcribed a stretch again with other boundaries.

### `mark`

Something that happened at a moment in the meeting.

```json
{ "id": "k-3", "kind": "gap", "at": 120400, "until": 126900, "track": "mic", "detail": "device", "label": null }
```

| `kind` | Meaning | `until` | `detail` |
|---|---|---|---|
| `user` | Someone marked this moment | `null` | `null` |
| `dictation` | The user dictated into another app | end of the dictation | `null` |
| `gap` | The track has no audio | end of the gap | `crash`, `device` or `suspend` |
| `device` | The track moved to another device; `label` is its name | `null` | `default`, `reconnected` or `lost` |
| `dropped` | Voice stopped recording the screen, to keep recording audio | `null` | `disk` or `encoder` |

- `track` is `mic`, `call`, `screen` or `null` when the mark is about the whole meeting.
- `label` is the text the user gave a `user` mark, or the device name of a `device` mark.
- Voice sends a mark once it is complete. A gap is sent when the audio comes back or the meeting ends.
- Rukoo shows a mark of a `kind` it doesn't know as a plain mark.

### `frame`

A moment the screen changed noticeably. Voice 0.1 doesn't record the screen and never sends this.

```json
{ "id": "f-000412000", "at": 412000, "width": 1920, "height": 1080, "text": "Q3 roadmap" }
```

`text` is the text Voice read on the screen. Rukoo fetches the image with `frame.get`.

### `meeting.removed`

Voice deleted the meeting and its events. `data` is `{}`.

## Commands

Rukoo sends commands; Voice answers each with one reply.

```json
{ "type": "command", "id": "c-17", "command": "meeting.start", "args": { "title": "Weekly with Anna" } }
```

```json
{ "type": "reply", "id": "c-17", "ok": true, "result": { "meeting": "m-20261030-171203-4f2a" } }
```

```json
{ "type": "reply", "id": "c-18", "ok": false, "error": { "code": "busy", "message": "A meeting is already recording.", "meeting": "m-20261030-171203-4f2a" } }
```

`id` is Rukoo's own, at most 64 characters, and comes back unchanged. Voice answers commands in the order it gets them, and the events a command causes may arrive before its reply.

| Command | `args` | `result` | Errors |
|---|---|---|---|
| `meeting.start` | `title`?, `tracks`?, `screen`?, `context`? | `{ "meeting" }` | `busy` |
| `meeting.stop` | `meeting` | `{}` | `not_found`, `not_recording` |
| `meeting.pause` | `meeting` | `{}` | `not_found`, `not_recording` |
| `meeting.resume` | `meeting` | `{}` | `not_found`, `not_recording` |
| `meeting.mark` | `meeting`, `label`? | `{ "mark", "at" }` | `not_found`, `not_recording` |
| `meeting.list` | `limit`?, default 50 | `{ "meetings": [ … ] }` | |
| `meeting.get` | `meeting` | a snapshot, see below | `not_found` |
| `frame.get` | `meeting`, `at` | `{ "frame", "image" }` | `not_found`, `not_available` |
| `status.get` | | the `status` object | |

- `meeting.start` uses the Settings default for every argument left out. `title` is at most 200 characters, `tracks` a non-empty list of `mic` and `call`, `screen` one of the values of `meeting.started`, and `context` an object of at most 16 KiB.
- `meeting.list` returns the newest meetings first: `{ "id", "title", "startedAt", "endedAt", "state", "duration" }`, with `endedAt` `null` while recording and `duration` in milliseconds.
- `meeting.get` returns `{ "meeting", "speakers", "passages", "marks", "head" }`. `meeting` holds the fields of `meeting.started` plus `id`, `state` and `endedAt`. The lists hold the current version of everything, and `head` is the sequence number the snapshot is complete up to.
- `frame.get` returns the frame closest before `at` and the image as `{ "type": "image/jpeg", "data": "<base64>" }`. It answers `not_available` when the meeting didn't record the screen.

Errors carry a `code` and an English `message` for logs. Rukoo shows its own text for a code.

| `code` | Meaning |
|---|---|
| `bad_request` | The command or its arguments don't match this document |
| `unknown_command` | Voice doesn't know the command; a newer Rukoo may send commands an older Voice lacks |
| `not_found` | No meeting or frame with that id or time |
| `not_recording` | The meeting isn't recording, or isn't paused for `meeting.resume` |
| `busy` | A meeting is already recording; `meeting` says which |
| `not_available` | Voice can't do this for this meeting or in this version |
| `failed` | Voice tried and failed; `message` says why |

## Checking messages

Both sides check what they receive with the same rules and drop a message that breaks one. Voice answers a bad `command` with `bad_request` when it can read the `id`; Rukoo logs and skips a bad event, which never stops the events after it.

- Integers are JSON numbers without a fraction. Times, `seq`, `head` and `after` are 0 or more; `seq` and `revision` are 1 or more.
- A meeting id matches `^m-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$`, a token `^[A-Za-z0-9_-]{43}$` and an instance `^[A-Za-z0-9_-]{22}$`.
- `hello` needs `protocol`, `token`, `client` (1 to 64 characters), `instance` (an instance or `null`) and `after`. `clientVersion` is optional.
- `command` needs `id` (1 to 64 characters) and `command`; `args` defaults to `{}`. The arguments of a known command follow the table above, and its required ones must be there.
- `event` needs `seq`, `event`, `createdAt` and an object in `data`. The meeting events need `meeting`. A known event's `data` must have the fields this document lists for it, with these limits: `tracks` holds `mic` and `call` without repeats and isn't empty; `end` ≥ `start`; `until`, when not `null`, ≥ `at`; a passage's `id` is its `track`, a dash and its `start` as nine digits; `endedAt` comes with `processing`, `done` and `failed`, and `reason` with `processing` and `failed`.
- A `reply` with `ok` true has an object in `result`; with `ok` false, an `error` with `code` and `message`.
- An unknown event type or command name is not an error in itself.

## The transcript is untrusted

Everyone in a call is a third party. Passage text, speaker labels, titles, marks and the text read from the screen come from what people said or showed, and can hold instructions aimed at an agent. Voice never acts on what it hears in a meeting. Rukoo never follows instructions in this content and hands it to the agent inside `<unsafe_content>`, as it does with email.

## Versioning

`protocol` is an integer, and this document describes version 1.

- New optional fields, new event types, new commands and new values for `kind`, `detail` and `reason` keep the version. Peers ignore what they don't know, as described above.
- Anything an older peer would misread raises the version: a removed or renamed field, a changed meaning or unit, or a new field the other side must understand.
- Voice serves every version from `minProtocol` to `protocol` in its discovery file. When the ranges don't overlap, Rukoo says which app needs an update.
- A pull request that changes this document updates [fixtures/protocol-vectors.json](fixtures/protocol-vectors.json) and both sides' tests.
