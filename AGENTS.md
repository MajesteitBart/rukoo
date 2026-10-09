# Rukoo agent guide

Rukoo Mail is an open-source Windows email client built with Electron. The mail interface and agent chat panel use plain HTML, CSS, and JavaScript modules. Read `README.md` for setup and architecture, and `docs/agents.md` for the app's agent integrations.

## GitHub and workflow

- Code, issues, and PRs live in `MajesteitBart/rukoo`. Use existing issues and their acceptance criteria to guide work. An issue is not a prerequisite for starting a feature or pushing code.
- Work on feature branches. After the relevant checks pass, you may commit, push, and open PRs without asking. Merging requires an explicit request.
- Link relevant issues in the PR description. Use closing links only for issues the PR fully completes; describe remaining work for partial contributions. Check acceptance criteria before declaring completion.
- Fix small adjacent problems in files you are already changing when the diff stays reviewable. Create GitHub issues for larger problems.
- Write short, imperative commit messages. In issues and PRs, lead with the result, describe the change plainly, and state what was verified and what remains unverified.
- Do not mention AI tools or add agent attribution, co-author lines, generated-with footers, or session links in commits, issues, or PRs.
- Do not spawn subagents unless the user explicitly requests them.
- Put temporary plans, investigation notes, and verification captures in ignored `tmp/`. Record lasting findings in issues, PRs, or project docs.

## Where changes belong

The renderer calls the preload bridge (`src/main/preload.js`) and the IPC handlers in `src/main/main.js`. Mail operations and state live in `src/main/engine.js`; `imap.js` handles real mail and `demo.js` supplies the demo account. Account and message data are local files, not a hosted application database.

Agent integrations live in `src/main/agents/`, with the chat interface in `src/renderer/agent/`. When changing shared agent behavior, check the Hermes, Claude Code, and Codex paths that use it. The inline composer and separate compose window share `src/renderer/composer.js`; changes there may affect both surfaces.

Development skills live in `.agents/skills/`. The top-level `skills/` directory contains skills shipped to Rukoo's users; these are different purposes.

## Running and real data

- Use `npm install` and `npm start`. The start script clears `ELECTRON_RUN_AS_NODE`, which Electron-based terminals can export; launching Electron directly without clearing it can start Node instead of the app.
- Real accounts may be used for verification. Sending mail or changing real mailbox contents requires an explicit request. This includes test actions that mark messages read, save drafts, move or delete mail, or unsubscribe.
- The normal profile is under `%APPDATA%\Rukoo Mail`; `SEM_DATA_DIR` selects a separate profile. Use demo accounts and isolated profiles for tests that mutate mail. Existing Electron tests demonstrate this setup.
- Reuse a running app when suitable. Never kill Node or Electron processes by name; close only an identified instance when necessary. Do not overwrite or delete the user's normal profile to reset a test.
- This repository is public. Keep credentials, account data, real email content, and private screenshots out of commits and GitHub posts. Use demo data or remove private details before uploading evidence.
- For a persistent development server on Bart's Windows computer, use `%USERPROFILE%\.t3\dev-server.ps1` with this project's directory, its port, and an explicit localhost binding. Reuse healthy servers, verify the URL over HTTP, and leave them running. Use the helper's `stop` action only when requested or replacing a verified broken server. See `%USERPROFILE%\.t3\dev-servers\README.md`. The Electron app itself starts with `npm start`.

## UI work and screenshots

Read and apply [rukoo-design](.agents/skills/rukoo-design/SKILL.md) for UI work. Reuse the existing components where appropriate. The agent panel's Beautiful UI components are local ports in `src/renderer/agent/bui.js` and `src/renderer/agent.css`; the main application styles live in `src/renderer/styles.css`. The visual design may evolve as features develop.

Visible strings belong in the English and Dutch catalogs under `src/i18n/`. Follow `src/i18n/AGENTS.md` and `docs/translations.md` for catalog changes.

Any work that touches or affects the UI, including backend changes with user-visible effects, requires verification in the running Electron app and screenshots attached to the corresponding GitHub issue before completion. If there is no issue, create one by that point. Capture the affected screens and states, include before-and-after screenshots when useful, and briefly explain what was verified. Follow the design skill's theme, language, and layout checks.

Store local verification screenshots in ignored `tmp/` and upload them as GitHub issue attachments. Never commit verification screenshots. Documentation screenshots used by the README or other docs may remain tracked.

`node scripts/screenshots.js tmp/screenshots` captures the existing demo screens in light and dark themes using an isolated profile. Add targeted captures for changed states that the script does not cover. `npm run screenshots` writes to tracked `docs/screenshots/`, so use that command only when intentionally updating documentation images.

## Verification

Run checks relevant to the change during development and before pushing finished work:

- Unit tests: `node --test test/<file>.test.js`.
- Electron end-to-end tests: `npx playwright test test/e2e/<file>.spec.js`.
- Translation catalogs: `npm run i18n:check`.
- For changes affecting several parts of the app, run both full suites: `npm test` and `npm run test:e2e`.
- For packaging changes, verify the Windows build with `npm run dist`.

Add or update focused tests when behavior changes. UI screenshots supplement functional checks; they do not establish that sending, sync, persistence, or agent integrations work. Scripted test agents (`SEM_AGENT_FAKE=1`) do not verify live provider connections. Live IMAP tests use a throwaway Ethereal mailbox and may skip when the service is unreachable; report skipped coverage as unverified.

Do not invent lint, typecheck, or build commands from another project. Use the scripts available in `package.json`. Documentation-only changes need link and command checks, not application test suites.
