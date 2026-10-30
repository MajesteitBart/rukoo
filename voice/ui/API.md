# Rukoo Voice UI: commands and events

The pill (`pill.html`) and Settings (`settings.html`) are plain HTML, CSS and JavaScript modules in this folder, with no bundler. They talk to the Rust app (`voice/crates/voice-app`) only through the Tauri commands and events below. The app implements exactly this list. A change to a name or a payload changes this file, the page that uses it and `mock/`, in the same pull request.

## How the pages call the app

- `tauri.conf.json` sets `app.withGlobalTauri: true`. The pages use `window.__TAURI__.core.invoke(command, args)` and `window.__TAURI__.event.listen(name, handler)`; `lib/bridge.js` wraps both.
- `frontendDist` is this folder. The pages load `i18n/en.json` and `i18n/nl.json` with `fetch`, so the asset protocol must serve `.json`. Nothing is fetched from the network; Inter is bundled in `fonts/`. `dev/` and `mock/` are development tools and may be left out of the bundle.
- Arguments are camelCase objects. Tauri maps a top-level argument name to the Rust parameter of the same name in snake_case, so `invoke('pill_ack', { seq })` calls `fn pill_ack(seq: u64)`. Where a command takes one struct, the page passes it under one name (`layout`, `save`, `request`, `preview`), and the Rust parameter has that name. Structs use `#[serde(rename_all = "camelCase")]`.
- A command that fails returns `Err(CommandError)`, which rejects the page's promise with `{ "code": "<code>", "message": "<English text>" }`. The pages show their own text for a known `code` and put `message` behind Error details. Codes: `invalid_value`, `same_key`, `dev_mode`, `need_endpoint_model`, `not_found`, `not_removable`, `config`, `auth`, `network`, `timeout`, `provider`, `failed`.
- Both windows need `core:event:default` in their capability. App commands registered with `invoke_handler` are allowed for every window unless the app defines command permissions; if it does, allow the `pill_*` commands for the `pill` window and the `settings_*` commands for the `settings` window only.
- Suggested CSP for both windows: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost`. The pages set custom properties in `style` attributes, hence `'unsafe-inline'` for styles only.

Outside Tauri, or with `?mock` in the URL, `mock/pill.js` and `mock/settings.js` answer instead. [Mock pages](#mock-pages) lists the URLs.

---

## The pill

Window `pill`, `pill.html`, 384 × 100 logical pixels, transparent and click-through (pill-settings-design.md 3.2). The pill draws itself 24 px from the window's top, centred, at most 320 px wide and 36 px tall. The page renders snapshots and does nothing else: the Rust state machine decides the phase, the holds and when to hide.

### Event `pill://snapshot`

One complete state per change, never a patch. The page ignores a snapshot whose `seq` isn't newer than the last one it applied, and one that fails its shape check.

```json
{
  "seq": 418,
  "visible": true,
  "phase": "meeting",
  "activity": "dictate",
  "notice": null,
  "words": null,
  "meeting": {
    "state": "recording",
    "atMs": 724000,
    "screen": "off",
    "compact": false,
    "confirmStop": false,
    "stopEnabled": true,
    "rukooConnected": true
  },
  "edge": "bottom",
  "theme": "dark",
  "locale": "en",
  "dev": false
}
```

| Field | Type | Meaning |
|---|---|---|
| `seq` | integer | +1 per snapshot. The page acks it with `pill_ack` after painting it. |
| `visible` | bool | `false` plays the exit (140 ms) and renders nothing. The app hides the window 180 ms after a hidden snapshot, unless a newer visible one came. |
| `phase` | string | `hidden`, `arming`, `listening`, `transcribing`, `rewriting`, `inserted`, `rewrote`, `nothingHeard`, `warning`, `error`, `meeting` |
| `activity` | string | `dictate` or `rewrite`. While listening, `rewrite` shows "Say the edit". |
| `notice` | object or null | `{ "key": "<catalog key>", "args": {} }`, from the table below. An unknown key is ignored; in the `error` phase it shows "Try again". |
| `words` | integer or null | Words inserted, with `phase: "inserted"`. |
| `meeting` | object or null | Present while a meeting records, is paused or has just ended. |
| `meeting.state` | string | `recording`, `paused`, `processing` (shows "Saving"), `done` (not shown) or `failed` |
| `meeting.atMs` | integer | Meeting time when the app sent the snapshot. The page adds the time since it received the snapshot and ticks every second, also while paused, because the meeting clock keeps running (PROTOCOL.md). Resend every 60 s to correct drift. |
| `meeting.screen` | string | `off`, `frames` or `video`; always `off` in 0.1. |
| `meeting.compact` | bool | Hide the label and show the time only. The app sets it 4000 ms after the last meeting change, never while paused or while a notice shows. |
| `meeting.confirmStop` | bool | The stop button shows "Stop?" after the first click. The app clears it after 3000 ms. |
| `meeting.stopEnabled` | bool | Draw the stop button. `false` during a dictation in a meeting and in `processing` and `failed`. |
| `meeting.rukooConnected` | bool | Not drawn in 0.1. |
| `edge` | string | `bottom` or `top`: the direction of the entry animation. |
| `theme` | string | `light` or `dark`, resolved from Settings (System follows Windows). |
| `locale` | string | `en` or `nl`, resolved from Settings. |
| `dev` | bool, optional | Shows a small "Dev" tag, so a development pill can't be mistaken for the installed one. Send `true` when `RUKOO_VOICE_DATA_DIR` is set. |

What the page shows:

| `phase` | `notice.key` | Shows |
|---|---|---|
| `arming` | | grey rippling bars, "Starting" |
| `listening` | none | orange bars following `pill://level`, "Listening" or "Say the edit" |
| `listening` | `pill.noAudio` | breathing bars, "No audio detected" |
| `warning` | `pill.selectTextBox` | info icon, "Select a text box" |
| `transcribing` | none or `pill.loadingModel` | bouncing bars, shimmering "Transcribing" or "Loading model" |
| `rewriting` | | bouncing bars, shimmering "Rewriting" |
| `inserted` | | green check, "Inserted {words} words" |
| `rewrote` | | green check, "Rewrote the selection" |
| `nothingHeard` | | no icon, "Nothing heard" |
| `error` | `pill.error.offline`, `.noKey`, `.auth`, `.timeout`, `.mic`, `.model`, `.modelMissing`, `.blocked`, `.selectText`, `.selectionTooLong`, `.generic` | red x on a red tint, the short error. The full text goes to a tray notification. |
| `meeting`, `recording` | none | pulsing dot, "Recording" (or nothing when `compact`), time, stop button |
| `meeting`, `recording` or `paused` | `pill.micLost`, `pill.micBack` | microphone icon in orange or green, the notice, time, stop button |
| `meeting`, `recording` | `pill.videoDropped.disk`, `pill.videoDropped.encoder` | screen icon, the notice (later than 0.1) |
| `meeting`, `paused` | | pause glyph, "Paused", grey time, stop button |
| `meeting`, `processing` | | spinner, "Saving" |
| `meeting`, `failed` | `pill.meetingFailed` | red x on a red tint, "Couldn't save the meeting" |

`ProviderError` kinds map to error notices like this: `auth` → `pill.error.auth`, `network` → `pill.error.offline`, `timeout` → `pill.error.timeout`, `config` for a missing key → `pill.error.noKey`, `local_missing_model` → `pill.error.modelMissing`, anything else → `pill.error.generic`. Decision 7's `SendInput` shortfall → `pill.error.blocked`.

### Event `pill://level`

`{ "level": 0.42 }`, a number from 0 to 1 after Ownkey's level pipeline (pill-settings-design.md 1.9). At most every 20 ms, only while `phase` is `listening`. It stays out of the snapshot so a level tick never re-renders the pill.

### Event `pill://pointer`

`{ "hover": true, "pressed": false }`, from the native stop window: hover on `WM_MOUSEMOVE`, pressed between `WM_LBUTTONDOWN` and `WM_LBUTTONUP`, both false on `WM_MOUSELEAVE`. The page only colours the button; Rust handles the click.

### Command `pill_snapshot`

`invoke('pill_snapshot')` → the current snapshot. The page calls it on load and then every 1000 ms as a safety net, and applies it only when `seq` is newer.

### Command `pill_ack`

`invoke('pill_ack', { seq })` → nothing. Called two animation frames after the page applied snapshot `seq`, so the frame with it was painted. The app's watchdog nudges the window when no ack arrives within 500 ms of a show and rebuilds it after 2 s (pill-settings-design.md 3.2, step 5).

### Command `pill_layout`

`invoke('pill_layout', { layout })` → nothing. Where the pill and the stop button are, so the app can put its native stop window exactly over the button.

```json
{ "seq": 418, "pill": { "x": 96, "y": 24, "width": 193, "height": 36 }, "button": { "x": 257, "y": 28, "width": 28, "height": 28 } }
```

- Rectangles are in CSS pixels from the window's top left, rounded outwards to whole pixels. At the page's 100% zoom a CSS pixel is a logical pixel; multiply by the monitor's scale for physical pixels.
- `button` is `null` when no stop button is drawn: no meeting, `stopEnabled` false, the pill hidden or leaving. Hide the stop window then.
- `pill` is `null` while nothing is drawn.
- `seq` is the snapshot the layout was measured for. Ignore a layout whose `seq` is older than the newest snapshot that has a stop button.
- The page reports after every change: a new snapshot, the end of the entry animation, every frame of a width transition (the label sliding to 0 when the pill compacts, the button widening to "Stop?") and when Inter finishes loading. It never sends the same layout twice in a row.

### Strings the app reads from the catalogs

The app has text of its own and reads it from `i18n/en.json` (the `message` field) and `i18n/nl.json`, in the language Settings resolves:

- `pill.stopButton`: the title of the native stop window, which screen readers announce.
- `settings.title`: the Settings window's title.
- `app.tray.tooltip`, `app.tray.tooltipRecording`, `app.tray.settings`, `app.tray.startMeeting`, `app.tray.pauseMeeting`, `app.tray.resumeMeeting`, `app.tray.stopMeeting`, `app.tray.quit`: the tray.

`test/voice-ui-i18n.test.js` checks that every key in this list exists in both catalogs.

---

## Settings

Window `settings`, `settings.html`, 760 × 680, minimum 480 × 480, native decorations. The app sets the window's background to the theme's `--bg` (`#141519` dark, `#f3f4f6` light) before the page loads, so it doesn't flash white.

The page can open at a page or a group: `settings.html?page=<page>`, where `<page>` is `transcription`, `dictionary`, `fillers`, `rewriting`, `meetingTranscription`, `speakers`, `storage`, `rukoo` or `import`, or one of the top page's groups `status`, `dictation`, `meetings`, `general`, `about`. The app can use it to open Settings at the import after the first start.

### Command `settings_state`

`invoke('settings_state')` → `SettingsState`, the whole state. The page calls it once on load.

### Event `settings://state`

A whole `SettingsState` with a higher `seq`, sent whenever anything in it changes: a saved setting, a model's download progress (at most 10 per second), the bridge status, the update check, the Ownkey import, a resolved theme or language. The page redraws only the cards whose content changed, so text the user is typing is never reset.

### `SettingsState`

```json
{
  "seq": 57,
  "version": "0.1.0",
  "devMode": false,
  "platform": "windows",
  "theme": "dark",
  "locale": "en",
  "config": {
    "dictation": { "hotkey": "right alt", "rewriteHotkey": "right ctrl", "pasteMode": true, "readyChime": false, "startAtLogin": true },
    "transcription": { "provider": "orukeet", "endpoint": "", "model": "orukeet-onnx-int8", "language": "auto", "keySaved": false },
    "local": { "modelFolder": "", "idleMinutes": 20 },
    "dictionary": { "vocabulary": ["Rukoo"], "corrections": [{ "from": "rocco", "to": "Rukoo" }] },
    "fillers": { "enabled": true, "languages": ["en", "nl"], "custom": "" },
    "rewriting": { "provider": "mistral", "endpoint": "https://api.mistral.ai/v1/chat/completions", "model": "mistral-small-latest", "keySaved": true, "auto": false, "tone": "auto", "formatting": true, "instructions": "" },
    "meetings": { "provider": "orukeet", "endpoint": "", "model": "orukeet-onnx-int8", "keySaved": false, "consent": null, "retention": "days7", "stopKey": "off", "screen": "off", "liveSpeakers": false },
    "ui": { "language": "system", "theme": "system", "pillEdge": "bottom", "hidePillFromCapture": true },
    "updates": { "check": false },
    "storage": { "sync": { "enabled": false, "service": "upcloud", "endpoint": "", "region": "", "bucket": "", "prefix": "", "accessKeyId": "", "secret": "" } }
  },
  "providers": {
    "audio": [{ "id": "openai", "endpoints": ["https://api.openai.com/v1/audio/transcriptions"] }],
    "rewrite": [{ "id": "openai", "endpoints": ["https://api.openai.com/v1/responses", "https://api.openai.com/v1/chat/completions"] }]
  },
  "dictation": { "status": "ready" },
  "rukoo": { "state": "connected", "clientVersion": "2.2.0", "protocol": 1, "port": 49821, "discoveryPath": "C:\\Users\\…\\Rukoo Voice\\bridge.json", "behind": 0 },
  "models": { "orukeet": "ModelState", "nemotron": "ModelState" },
  "storage": { "folder": "C:\\Users\\…\\Rukoo Voice\\meetings", "usedBytes": 2400000000, "freeBytes": 182000000000 },
  "updates": { "state": "idle", "version": null },
  "ownkey": "OwnkeyState",
  "sync": { "lastUpload": null, "waiting": 0 }
}
```

| Field | Meaning |
|---|---|
| `seq` | +1 per state. The page drops a state older than the one it has. |
| `version` | Voice's version, shown under About. |
| `devMode` | `RUKOO_VOICE_DATA_DIR` is set. The page disables Start at login and the import button, with a note, and key lists say development copies use F13 and F14. |
| `platform` | `windows`, `macos` or `linux`. |
| `theme`, `locale` | `ui.theme` and `ui.language` resolved: `light` or `dark`, `en` or `nl`. The page follows these, never the raw setting. |
| `config` | Every setting, see below. API keys and the bucket secret appear only as `keySaved` flags; `secret` is always `""`. |
| `providers` | Voice-core's provider registry in Ownkey's order (ownkey-providers.md 2): `audio` is OpenAI, Google, Mistral, Custom, Orukeet; `rewrite` is OpenAI, Anthropic, Google, Mistral, Ollama, OpenRouter, Custom. `endpoints` are the presets, the first is the default. The page translates the labels of `custom` and `orukeet` and shows the brand names for the rest. |
| `dictation.status` | `ready`, `loadingModel`, `modelMissing`, `noKey` or `noMic`: the status on the top page. |
| `rukoo.state` | `connected`, `notRunning`, `rukooOutdated` or `voiceOutdated` (from `unsupported_protocol`, PROTOCOL.md Versioning), `refused` (a client sent a wrong token). |
| `rukoo.clientVersion`, `rukoo.protocol` | From the connected client's `hello`, or `null`. |
| `rukoo.port` | The bridge's port on 127.0.0.1, or `null` before it listens. |
| `rukoo.discoveryPath` | The discovery file's full path (PROTOCOL.md, Where the file is). |
| `rukoo.behind` | The event log's head minus the connected client's `after`, or `null`. |
| `models` | A `ModelState` for `orukeet`, and for `nemotron` later than 0.1. |
| `storage` | The recordings folder, the bytes meetings use and the free bytes on its drive. |
| `updates.state` | `idle`, `checking`, `available` (with `version`), `upToDate` or `failed`. |
| `ownkey` | An `OwnkeyState`, below. |
| `sync` | Later than 0.1: the last upload (epoch ms) and the files waiting. |

`config`, by the key `settings_set` takes for each field:

| Key | Values | Default | From Ownkey's |
|---|---|---|---|
| `dictation.hotkey` | `right alt`, `right ctrl`, `right shift`, `f13`, `f14`, `f15`, `pause`, `scroll lock` | `right alt`; `f13` in dev mode | `hotkey` |
| `dictation.rewriteHotkey` | `off` or a key above | `right ctrl`; `f14` in dev mode | `rewrite_hotkey` |
| `dictation.pasteMode` | bool | `true` | `paste_mode` |
| `dictation.readyChime` | bool | `false` | `ready_chime` |
| `dictation.startAtLogin` | bool; `dev_mode` error in dev mode | `true` for an installed copy | the Run key |
| `ui.pillEdge` | `bottom`, `top`: where the pill appears | `bottom` | new |
| `ui.hidePillFromCapture` | bool: excludes the pill and its stop window from screen capture | `true` | new |
| `transcription.*` | read-only here; saved with `settings_save_provider` | Orukeet | `audio_*`, `language` |
| `local.modelFolder` | a path, or `""` for automatic: Ownkey's folder first, then Voice's own | `""` | `local_model_directory` |
| `local.idleMinutes` | integer 0 to 1440; 0 never unloads | `20` | `local_model_idle_timeout_minutes` |
| `dictionary.vocabulary` | the whole list of words | `[]` | `vocabulary` |
| `dictionary.corrections` | the whole list of `{ "from", "to" }` | `[]` | `corrections` |
| `fillers.enabled` | bool | `true` | `remove_fillers` |
| `fillers.languages` | subset of `en`, `nl`, `de`, `fr`, `es`; an empty list stays empty | `["en", "nl"]` | `filler_languages` |
| `fillers.custom` | comma-separated words | `""` | `custom_fillers` |
| `rewriting.provider`, `endpoint`, `model`, `keySaved` | read-only here; saved with `settings_save_provider` | Mistral | `rewrite_*` |
| `rewriting.auto` | bool | `false` | `auto_rewrite` |
| `rewriting.tone` | `auto`, `professional`, `casual`, `friendly`, `concise` | `auto` | `rewrite_tone` |
| `rewriting.formatting` | bool | `true` | `rewrite_formatting` |
| `rewriting.instructions` | string | `""` | `rewrite_custom_instructions` |
| `meetings.provider`, `endpoint`, `model`, `keySaved`, `consent` | read-only here; saved with `settings_save_provider` | Orukeet | `meetings_audio_*` |
| `meetings.retention` | `days7`, `keep`, `after_transcription` | `days7` | `meetings_retention` |
| `meetings.stopKey` | `off` or a key | `off` | new |
| `meetings.screen` | `off`, `frames`, `video` (later) | `off` | new |
| `meetings.liveSpeakers` | bool (later) | `false` | `meetings_auto_speakers` |
| `ui.language` | `system`, `en`, `nl` | `system` | new |
| `ui.theme` | `system`, `light`, `dark` | `system` | new |
| `updates.check` | bool | `false` | new |
| `storage.sync.*` | later than 0.1 | | new |

The provider objects carry `provider`, `endpoint`, `model` and `keySaved`. `transcription` adds `language` (`auto`, `en`, `nl`, `de`, `fr`, `es`, `it`, `pt`, `pl`, `ja`, `zh`). `meetings` adds `consent`: `{ "provider": "mistral", "host": "api.mistral.ai" }` or `null`.

Meeting transcription has no "Same as dictation" choice. Decision 10 makes it Orukeet (the default) or a cloud provider with consent per provider and host, and a "same" choice would move meeting audio to the cloud whenever someone changed the dictation provider. The import resolves Ownkey's `same` to the provider it pointed at.

`ModelState`:

```json
{
  "id": "orukeet", "name": "Orukeet", "sizeBytes": 487000000,
  "stage": "installed", "percent": null,
  "location": "ownkey", "path": "C:\\Users\\…\\Ownkey\\models\\orukeet-onnx-int8",
  "removable": false, "active": "loaded", "error": null
}
```

| Field | Meaning |
|---|---|
| `stage` | `missing`, `downloading`, `verifying`, `extracting`, `installed`, `failed` (the download or its check failed), `unavailable` (installed, but the runtime can't use it) |
| `percent` | 0 to 100 during a stage that knows it, else `null` |
| `location` | `ownkey` (Ownkey's shared folder), `voice` (Voice's own `models/`), `folder` (the folder chosen in Settings), or `null` while the files aren't there |
| `removable` | `true` only for files in Voice's own `models/`. Never for Ownkey's folder (decision 13); the page says "Shared with Ownkey. Remove it in Ownkey." instead. |
| `active` | When this model is the chosen provider: `unloaded`, `loading`, `loaded` or `error`; otherwise `null` |
| `error` | The last download or load error in English, or `null`. The page cuts it at 180 characters and shows all of it behind Error details. |

`OwnkeyState`:

```json
{
  "running": false, "keys": ["right alt", "right ctrl"],
  "configFound": true, "configPath": "%APPDATA%\\Ownkey\\config.json",
  "lastImport": 1793000000000,
  "models": [{ "id": "orukeet", "name": "Orukeet", "sizeBytes": 487000000 }],
  "report": {
    "hotkeys": { "dictation": "right alt", "rewrite": "right ctrl" },
    "transcription": { "provider": "orukeet", "model": "orukeet-onnx-int8", "keyImported": false },
    "rewriting": { "provider": "mistral", "model": "mistral-small-latest", "keyImported": true },
    "dictionary": { "words": 12, "corrections": 3 },
    "fillers": { "enabled": true, "languages": ["en", "nl"] },
    "meetings": { "provider": "orukeet", "keyImported": false, "retention": "days7", "consent": false },
    "skipped": ["summaries"]
  }
}
```

- `running`: an Ownkey process runs. Reading the process list is fine; Voice never stops it. `keys`: the dictation and rewrite keys in Ownkey's config, read-only. The top page warns when they overlap Voice's keys.
- `configPath` is shown as it is, so use the `%APPDATA%` form rather than the user's real path.
- `lastImport` is epoch ms, or `null`.
- `models` are the models found in Ownkey's model folder.
- `report` is the last import's result, or `null` before any import. Each area is `null` when Ownkey's config didn't have it. `keyImported` says a key came over; the key never reaches the page. `meetings.consent` is `true` only when Ownkey had `meetings_live_transcription_policy == "allow"` for a cloud provider (decision 10). `skipped` lists settings Voice doesn't take over: `summaries` covers `meetings_auto_summary` and `meetings_remote_policy`.

### Command `settings_set`

`invoke('settings_set', { key, value })` → nothing. Saves one value from the table above, applies it at once and emits `settings://state`. A key change restarts the hotkey poller; `ui.language` and `ui.theme` re-resolve the language and theme for Settings and the pill at once; `ui.pillEdge` and `ui.hidePillFromCapture` take effect at the pill's next show; `startAtLogin` writes or removes the Run value.

Errors: `same_key` when the key is already the dictation, rewrite or stop key (the page greys those out, the app checks again), `dev_mode` for `startAtLogin` in dev mode, `invalid_value` for a value outside the table.

### Command `settings_save_provider`

`invoke('settings_save_provider', { save })` → nothing, once saved. One provider form, checked and saved as a whole, like Ownkey's Save.

```json
{ "target": "meetings", "provider": "mistral", "endpoint": "https://api.mistral.ai/v1/audio/transcriptions", "model": "voxtral-mini-latest", "apiKey": null, "consent": true }
```

| Field | Meaning |
|---|---|
| `target` | `transcription`, `rewriting` or `meetings` |
| `provider` | An id from `providers.audio` (transcription, meetings) or `providers.rewrite` (rewriting) |
| `endpoint`, `model` | Trimmed. For `orukeet`: `""` and `orukeet-onnx-int8`. |
| `apiKey` | `null` keeps the saved key, `""` saves none, a string replaces it. A key is never carried to another provider: when `provider` differs from the saved one, `null` means no key. |
| `language` | `transcription` only; `auto` for Orukeet. |
| `consent` | `meetings` only. `true` saves `consent: { provider, host }` with the host of `endpoint`; `false` clears it. |

The app repeats Ownkey's checks (ownkey-dictation.md 13.8) and rejects with `need_endpoint_model` when a cloud provider lacks an endpoint or a model. For `transcription` with Orukeet it loads and checks the model before it commits, so a broken model never becomes active; the page shows "Loading Orukeet" until the promise settles. A failure keeps the old settings and rejects with the reason in `message`.

Consent: the page shows the disclosure and its checkbox when the provider isn't Orukeet and the endpoint's host isn't `localhost`, `127.0.0.1`, `::1` or `0.0.0.0`, which is Ownkey's rule for when to ask. The app uses the same rule to decide whether a meeting's transcription may start: valid consent names the saved provider and the host of the saved endpoint. Without it, the meeting records and its transcription waits.

### Command `settings_remove_key`

`invoke('settings_remove_key', { target })` → nothing. Deletes the saved key of `transcription`, `rewriting` or `meetings` at once.

### Command `settings_list_models`

`invoke('settings_list_models', { request })` → `["mistral-small-latest", …]`, sorted, without duplicates (ownkey-providers.md 6).

`request` is `{ "target", "provider", "endpoint", "apiKey" }`. `apiKey: null` uses the saved key, but only when `provider` is the saved provider of `target`. Rejects with `auth`, `network`, `timeout`, `provider` or `config`. The page drops a result that arrives after the user changed the provider, endpoint or key.

### Command `settings_model`

`invoke('settings_model', { model, action })` → nothing; progress arrives through `settings://state`.

- `model`: `orukeet`, and `nemotron` later.
- `action`: `download` (into the chosen model folder, or Voice's own `models/`), `cancel`, `remove`. `remove` rejects with `not_removable` unless the model's `removable` is true.

### Command `settings_choose_folder`

`invoke('settings_choose_folder', { purpose })` → the chosen path, or `null` when the user cancelled. Opens the system's folder picker and saves the choice itself: `models` sets `local.modelFolder` (Ownkey's dialog title was "Choose model download or existing model folder"); `recordings` sets where new meetings are stored.

### Command `settings_open_folder`

`invoke('settings_open_folder', { folder })` → nothing. Opens Explorer at `logs`, `bridge` (the discovery file's folder), `recordings` or `models`.

### Command `settings_open_link`

`invoke('settings_open_link', { link })` → nothing. Opens a fixed address in the browser. The page never sends a URL; the app keeps the table: `orukeet` → `https://huggingface.co/oruk/orukeet`, `nemotron` → `https://huggingface.co/nvidia/Nemotron-3-Diarization`.

### Command `settings_clean_preview`

`invoke('settings_clean_preview', { preview })` → the cleaned text. `preview` is `{ "text", "enabled", "languages", "custom" }`. The app runs `voice_core::cleanup` with those values without saving them, so the Filler words preview shows the real cleanup.

### Command `settings_check_updates`

`invoke('settings_check_updates')` → the new `updates` object, `{ "state", "version" }`. Checks now, also when `updates.check` is off, because the user asked. Reads only `voice-v` tags.

### Command `settings_new_token`

`invoke('settings_new_token')` → nothing. Makes a new bridge token, rewrites the discovery file and closes the connected clients, which reconnect with the new file (PROTOCOL.md, Connecting).

### Command `settings_import_ownkey`

`invoke('settings_import_ownkey')` → the new `report`. Reads `%APPDATA%\Ownkey\config.json` and never writes to Ownkey's folders. Rejects with `dev_mode` in dev mode, where the import runs only with `--import-ownkey <copy>`, and with `not_found` when Ownkey's config is missing. The page asks before it imports over an earlier import.

### Command `settings_sync_test` (later than 0.1)

`invoke('settings_sync_test')` → nothing when Voice can write to the bucket in `config.storage.sync`; rejects with the reason otherwise. Only the bucket sync card uses it, and that card shows only with `?later=1`.

### Command `settings_close`

`invoke('settings_close')` → nothing. Escape on the top page closes the window.

---

## Mock pages

`node voice/ui/dev/serve.js` serves this folder on 127.0.0.1 and prints the address. The pages need a server: they are ES modules and load their catalogs with `fetch`, and neither works from `file://`.

| URL | Shows |
|---|---|
| `pill.html?mock=<state>&theme=light&lang=nl&backdrop=1` | One pill state; `<state>` is a key of `STATES` in `mock/pill.js`. `backdrop=1` draws a document behind the pill, `hit=1` outlines the stop window from the last `pill_layout`, `edge=top`, `dev=1`. |
| `pill.html?mock=dictation`, `mock=meeting`, `mock=cycle` | A dictation; a meeting with a two-step stop you can click; every state in turn |
| `dev/gallery.html?theme=dark&lang=en` | Every pill state side by side |
| `settings.html?mock=1&page=meetings&theme=dark&lang=nl` | Settings at a page or group |
| `&scenario=fresh`, `busy`, `cloud`, `failed`, `dev` | First start; a download with Ownkey on the same keys; cloud meeting transcription without consent; failures; a development copy |
| `&later=1` | The rows designed for later releases: screen recording, speaker labels, bucket sync (`&sync=1` turns sync on) |

`node voice/ui/dev/screenshots.js <outDir>` saves every pill state and every Settings page in both themes and languages, a narrow window and the dialogs, through the repository's Electron, without taking focus. Keep the images out of Git; they go on the GitHub issue.

`node voice/ui/dev/check.js` runs behavior checks against the mocks the same way: typed text surviving redraws, consent asked again for another provider or host, keys never carried to another provider, the stop button's layout report, the snapshot shape check and reduced motion. `test/voice-ui-tokens.test.js` and `test/voice-ui-i18n.test.js` run with `npm test`.
