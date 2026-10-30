# Rukoo Voice agent guide

This file adds to the [root AGENTS.md](../AGENTS.md) for work in `voice/`. The root rules for pull requests, commits, issues, public evidence and `tmp/` apply here too. The Electron parts of the root file, such as `npm start`, `SEM_DATA_DIR`, Playwright and the i18n catalogs, apply to Rukoo's side of the bridge, not to Voice itself.

## Project intro

Rukoo Voice is push-to-talk dictation plus the meeting recorder for Rukoo. It replaces [Ownkey for Windows](https://github.com/MajesteitBart/ownkey-windows). Voice records and transcribes. Rukoo shows the meeting and runs the user's agent. [README.md](README.md) describes the design and the decisions made so far.

There is no code yet. When you add the first code, add the build, run and test commands to this file in the same PR. When a design decision changes, update README.md in the same PR.

## What makes this project special?

- **A meeting can't be repeated.** Losing a recording is the worst failure Voice can have. The crash safety rules in README.md are hard requirements. The recorder never depends on transcription, the UI or Rukoo. A hard kill at any moment leaves files that open. Two CI tests prove it: one hard-kills the recorder halfway through a meeting, the other removes the microphone during one, and both check that the timeline is complete up to that point. Add them with the first recorder code, and don't merge recorder changes without them.
- **The key has to let go and the pill has to appear.** Three Ownkey fixes were about this: ownkey-windows #11 fixed recording that stuck after a lost key release, #13 a pill that vanished after a display change, #14 a pill that opened underneath other windows. A missed key-up must never leave recording on. The pill never takes focus and shows above other windows.
- **Voice and Rukoo share one protocol.** The bridge's events, commands and discovery file are implemented on both sides: here and in Rukoo's main process (`src/main/`). A change on one side needs the matching change on the other in the same PR, with the protocol version raised when old peers would misread it. Keep the spec in `voice/PROTOCOL.md` and give both sides tests that read the same fixtures, the way Android and desktop share `test/fixtures/account-vectors.json`.
- **Data goes only where the user sent it.** Voice keeps Ownkey's promise: no telemetry, no account and no relay. Audio and text go to the provider the user configured or stay on the computer, and a local model never falls back to the cloud. The only other destinations are the user's own bucket and the opt-in update check.
- **Everyone in the call is a third party.** People in a meeting can say anything, including instructions aimed at an agent. Voice never acts on what it hears in a meeting. Rukoo hands the transcript to the agent as untrusted content.

## A note from the maintainer

Ownkey for Windows is the reference for behavior that already works: providers, text cleanup, pinned and checked models, the meeting store and the consent rules. Port the behavior, not the structure. Read the [Ownkey repository](https://github.com/MajesteitBart/ownkey-windows), including its AGENTS.md, before changing hotkeys, text insertion or model loading here. Its fixes record why things are the way they are.

## The ways to hurt yourself

The installed Ownkey runs every day on the maintainer's Windows PC as `Ownkey.exe` and `ownkey-overlay.exe`, next to the installed Rukoo. Most dangers come from a dev copy of Voice touching their state.

- **Don't stop, restart or replace the installed Ownkey or Rukoo.** Never kill a process by image name. Stop only processes you started, by PID.
- **Don't answer Ownkey's hotkeys.** Ownkey listens on Right Alt and Right Ctrl, so a dev Voice on the same keys types every dictation twice. Use F13 and F14 in dev configs.
- **Read Ownkey's settings, never write them.** `%APPDATA%\Ownkey\config.json` holds the maintainer's API keys. Voice's import only reads it. Test the import against a copy.
- **Share Ownkey's models, don't delete them.** Voice reuses the models in `%LOCALAPPDATA%\Ownkey\models`: Orukeet is 487 MB and Nemotron 107 MB. Removing a model in Voice removes it for the installed Ownkey too.
- **Leave the real meeting library alone.** `%LOCALAPPDATA%\Ownkey\meetings` holds real recordings. Work on copies in a temp folder only.
- **Pair dev copies with each other, not with the installed apps.** A dev Voice that writes the default discovery file is found by the installed Rukoo, and a dev Rukoo finds the installed Voice. The discovery file location must be overridable from the first version, so a dev Voice pairs with a Rukoo started with its own `SEM_DATA_DIR`. Ownkey had this problem with its overlay port: a dev backend sent its states to the installed overlay.
- **A screen recording shows everything on that monitor.** That includes mail, notifications and chats. Test screen recording on a monitor with demo data. Real audio, transcripts, frames, video and speaker names never go into the repo, a PR or an issue.

## Test data

- The 60-second AMI meeting excerpt that ships with NeMo-Speech.cpp has three speakers. Use it for speaker labels.
- For an end-to-end meeting test, play the AMI excerpt out loud as call audio while Voice records. Check that passages and speaker labels arrive in Rukoo during the recording, not only after Stop.
- To reproduce a bug with real audio, copy the whole meeting library to a temp folder and point the dev copy at that folder.

## Pull requests and releases

- Follow the root rules for branches, commits and PR descriptions. A Voice PR says on which operating systems someone ran the change, separately from what CI ran.
- Voice has its own version. Tag its releases `voice-v<version>`, never `v<version>`. Rukoo's update check reads every release in this repository and treats a `vX.Y.Z` tag as a Rukoo version.
- Publish Voice releases without GitHub's "Latest" label. The root README's download link points to the latest release, and that has to stay Rukoo.
- Voice's opt-in update check reads only `voice-v` tags.

## Where code lives

- `voice/README.md`: the design and the decisions so far.
- `voice/AGENTS.md`: this file.
- `voice/PROTOCOL.md`, still to write: the bridge between Voice and Rukoo.
- Rukoo's side of the bridge goes in `src/main/`, next to the other main-process services. The meeting view goes in `src/renderer/`.

## Taste

Voice belongs to the Rukoo family. Start Settings and the pill from the tokens in [rukoo-design](../.agents/skills/rukoo-design/SKILL.md), and show the result in screenshots on the issue, as the root file asks.
