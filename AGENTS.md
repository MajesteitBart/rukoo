# Rukoo agent guide

## Project intro

Rukoo Mail is an open-source Windows desktop email client built with Electron. It combines a folder sidebar, message list, reading pane and composer with a calendar and an agent chat panel. Users connect their own mail accounts and their own Hermes, Claude Code or Codex agents. The interface is English by default and also supports Dutch.

The main process handles accounts, mail, calendar data, local storage and agent connections. The renderer uses plain HTML, CSS and JavaScript modules, without a frontend framework or bundler. Start with [README.md](README.md) for the product and architecture, and [docs/agents.md](docs/agents.md) for agent integrations.

## What makes this project special?

- **It is a desktop client connected to real accounts.** A test can change a real mailbox, even when the app runs locally. Choose the profile and account deliberately; use the test-data rules below.
- **One interface serves several integrations.** Mail has real and demo implementations; agent chat supports Hermes, Claude Code and Codex. A shared change needs checking at the affected adapters, not just in the provider used during development.
- **Several surfaces share behavior.** Composing works inline and in a separate window. Theme, language and zoom affect multiple windows. A change that works in the main window can still be incomplete.
- **The repository is public.** Code, documentation and evidence must be usable without Bart's credentials, private mail or local machine state. Keep private data out of GitHub and retain third-party license notices when adapting components.

These are development considerations, not a list of immutable product policies. Product behavior is documented in the README and feature docs; do not turn today's MCP tool limitations into permanent restrictions on what agents can do through their own integrations.

## A note from the maintainer

Use GitHub issues as guidance when they exist, but don't make creating an issue a gate before starting a feature or pushing code. New ideas can emerge while working. Fix small adjacent problems in files you already touch when the diff stays reviewable; create issues for larger problems. You are free to explore new visual styles and let Rukoo's design evolve. Use the design skill as the starting point and show the result in screenshots. Run tests that can catch failures in the work you changed; save full-suite runs for changes affecting several parts of the app. You may use subagents whenever useful, including for implementation, investigation and review, without asking first.

## Glossary

- **Mail provider** means an account's mail service or its implementation, such as IMAP or the demo account. **Agent provider** means Hermes, Claude Code or Codex. Check which is meant before changing provider handling.
- **Profile** means the Electron user-data directory containing accounts, settings, caches and conversations. A separate checkout does not automatically give you a separate profile.
- **Development skills** live in `.agents/skills/`. The top-level `skills/` directory contains skills shipped to Rukoo users. Changes to one do not automatically belong in the other.
- **Verification screenshots** are evidence attached to GitHub issues. **Documentation screenshots** are images maintained for the README and other docs. Only the latter belong in Git.

## The ways to hurt yourself

- **Local does not mean disposable.** The normal profile is `%APPDATA%\Rukoo Mail`. Do not delete or overwrite it to reset a test. Use `SEM_DATA_DIR` to select a separate profile.
- **Verification can mutate a mailbox.** Real accounts may be used for verification, but sending mail or changing real mailbox contents requires an explicit request. Opening a message can mark it read; composing can save a server draft. Use a demo or throwaway account for those test actions unless authorized.
- **Public evidence can expose private data.** Do not commit credentials, account files, real email content or private screenshots. Use demo data for captures, or remove private details before uploading them to GitHub.
- **Process names are shared across projects.** Never kill Node or Electron processes by name. Close only an identified app instance; use the managed helper for persistent development servers.
- **Electron terminals export `ELECTRON_RUN_AS_NODE`.** Launching Electron with it set runs Node instead of the app. Use `npm start`, whose wrapper clears it; Electron test launchers must clear it too.
- **The default screenshot command changes tracked files.** `npm run screenshots` writes documentation images to `docs/screenshots/`. For verification evidence, use `node scripts/screenshots.js tmp/screenshots` or a targeted capture under `tmp/`.

## Hit every surface

Choose the checks that correspond to the change:

- **Mail operations:** check `engine.js`, the real IMAP implementation, the demo implementation, and renderer callers. For moves and deletion, check the undo path as well as the initial action.
- **Composer:** exercise both the inline editor and separate compose window. Check draft saving and reopening when changing editor state or persistence.
- **Agent chat:** check shared hub/tool behavior, affected Hermes/Claude Code/Codex adapters, and the renderer's streamed and completed states. A fake-agent test does not verify a live provider connection.
- **Calendar:** check the main-process service, Google and demo adapters, and week/day/upcoming views when affected. For event changes, consider account selection, time zones, recurring occurrences and invitation responses. See the current limits in the README.
- **Shared UI:** check dark and light themes, English and Dutch, narrow windows, and relevant zoom levels. Settings shared between windows must work in each affected window.
- **Translations:** update English and Dutch together. Follow [src/i18n/AGENTS.md](src/i18n/AGENTS.md), including registration and both HTML entry points when adding a language.
- **Persistent state:** verify reopening or restarting where the change promises persistence. An updated control on screen is not proof that its setting, draft or conversation was saved.

## Dev servers

Rukoo is an Electron app, not a web app served on a development port. Use `npm install` for dependencies and `npm start` to launch it. Reuse a running app when suitable; launch test instances with their own profiles. Close test instances you started without disturbing the user's normal app.

`SEM_DATA_DIR` selects an isolated profile. Existing Electron tests demonstrate launching with that variable and clearing `ELECTRON_RUN_AS_NODE`. `SEM_HIDDEN=1` is used by automated tests and captures; it changes window behavior and exposes test helpers, so do not assume it represents every normal desktop behavior.

If you introduce a persistent development server on Bart's Windows computer, use the Task Scheduler helper rather than an agent-owned background process:

```powershell
& "$env:USERPROFILE\.t3\dev-server.ps1" start -Project 'E:\Development\rukoo' -Port <port> -Command '<normal dev command with an explicit localhost binding>'
& "$env:USERPROFILE\.t3\dev-server.ps1" status -Project 'E:\Development\rukoo'
```

Replace the placeholders with the actual server command and port. Reuse an existing healthy server. Check the reported URL over HTTP before calling it ready; a Running task alone is not a health check. Leave it running at handoff. Stop it through the helper only when requested or when replacing a verified stale or broken server. Status reports local log paths. See `%USERPROFILE%\.t3\dev-servers\README.md` for the machine-specific helper.

## Test data

The demo account provides sample mail and calendar data without mailbox credentials. Electron tests create temporary profiles and select this account; use that pattern for repeatable tests that change state. Keep local investigation profiles and captures under ignored `tmp/` when they need to survive a test run.

Real accounts are allowed for verification. Sending mail or changing real mailbox contents needs an explicit request, including marking read, saving drafts, moving, deleting and unsubscribing. A request to verify a screen alone is not authorization for those actions.

The live IMAP tests use a throwaway Ethereal mailbox and can skip when the service is unreachable. `SEM_AGENT_FAKE=1` supplies scripted agents for UI tests. Report these limits: demo mail does not prove real synchronization, and a scripted agent does not prove a provider's authentication, transport or tool execution.

For public evidence, use representative demo states: opened messages, drafts, attachments, populated lists, expanded details and the affected agent or calendar state. A screenshot of an empty screen does not demonstrate a populated workflow.

## Verifying

Run focused checks during development and before pushing finished work. Run both full suites when the change affects several parts of the app; do not run both automatically for every small change.

- **Mail and state behavior:** run the relevant files with `node --test test/<file>.test.js`. Examples include `engine.test.js`, `mailutil.test.js`, `undo.test.js` and `google.test.js`.
- **Agent behavior:** select the affected `test/agent-*.test.js` files for adapters, tools, MCP, skills or the shared core. Add Electron coverage when the behavior reaches the chat UI.
- **Calendar:** run `node --test test/calendar.test.js` and the affected cases in `npx playwright test test/e2e/calendar.spec.js`.
- **Renderer interactions:** run the relevant Electron suite with `npx playwright test test/e2e/<file>.spec.js`. These tests drive the actual desktop app.
- **Translations:** run `npm run i18n:check`; add the relevant Electron checks when labels or language changes affect layout or behavior.
- **Changes across several areas:** run `npm test` and `npm run test:e2e` once the focused checks pass.
- **Packaging:** run `npm run dist` for installer or packaging changes. Outputs belong in ignored `dist/`.
- **Documentation only:** check referenced files, links and commands. Application suites are not required.

Add or update focused tests for changed behavior. Check the actual outcome of asynchronous work, such as the saved draft, synchronized state or completed agent turn. Report failures, skipped tests and unavailable live integrations separately from passing checks. Use the commands in `package.json`; this repo has no lint or typecheck script to borrow from RevenueOS.

## Test it like a user

Any work that touches or impacts the UI requires verification in the running Electron app, including backend changes with user-visible effects. Use the repository's Playwright Electron workflow for automated interaction and captures. A standalone browser rendering of HTML is not enough to verify Electron IPC, separate windows or desktop behavior.

Exercise the affected workflow and states, not just the first screen. Check errors, loading and completion where the change affects them. For persistence changes, reopen the relevant view or restart the test instance. For motion and timing, observe the transition; a still screenshot only records one moment.

Before declaring UI-impacting work complete:

- Attach screenshots to the corresponding GitHub issue, even if work started without an issue. Create the issue by this point when needed; it was not a prerequisite for coding or pushing.
- Show the affected screens and states. Include before-and-after captures when useful and a short explanation of what was verified.
- Follow the design skill's checks for themes, languages, window width and zoom.
- Upload images as GitHub issue attachments so they remain outside Git history. A local file path or screenshots only in a PR do not satisfy the issue requirement.

`node scripts/screenshots.js tmp/screenshots` captures the existing demo screens in both themes using an isolated profile. Capture additional states specifically when the script does not cover the change. Keep verification captures in ignored `tmp/`; never commit them. Documentation screenshots may remain tracked and can be updated intentionally with `npm run screenshots`.

## Pull requests

- GitHub repository: `MajesteitBart/rukoo`. GitHub is used for code, issues, PRs and project tracking. Use issues as guidance when available; do not require an issue before starting or pushing an emerging feature.
- Work on feature branches. After relevant verification, you may commit, push and open PRs without asking. Merging requires an explicit request.
- Use short imperative commit messages. Do not mention AI tools or include agent attribution, co-author lines, generated-with footers or session links in commits, issues or PRs.
- Lead descriptions and updates with the result. Explain the behavior change and the verification that supports it. Distinguish automated checks from live observations and state what remains unverified.
- Link the relevant issues in the PR description. Use closing links for work that fully completes an issue; use references for partial contributions and describe what remains.
- Before declaring an issue complete, check its acceptance criteria and update checked items to match the evidence. After an authorized merge, verify that completed issues closed; leave unfinished issues open.
- For UI-impacting work, link to the issue containing screenshots. Screenshots are required before completion even when coding and pushes preceded the issue.
- Fix small adjacent problems in touched files while keeping the diff reviewable. Create GitHub issues for larger discoveries rather than silently expanding the task.

## Plans and work artifacts

Put temporary plans, research, investigation notes, local test profiles and verification screenshots in ignored `tmp/`. Do not commit scratch plans as permanent documentation.

Record lasting findings and decisions in GitHub issues, PRs or the relevant project docs. Update the README or feature documentation when behavior described there changes. Keep the useful explanation with the implementation instead of leaving it only in temporary notes.

Documentation screenshots in `docs/screenshots/` and README images may be tracked. Development verification screenshots are GitHub attachments. Credentials, real account data, runtime logs and private captures belong in neither category of published material.

## How it works

The renderer calls `window.mail` from `src/main/preload.js`. The preload bridge sends requests to the IPC table in `src/main/main.js`; main-process services execute them and send state updates back. The renderer runs sandboxed with context isolation. Keep privileged filesystem, account and network operations in the main process rather than bypassing this boundary.

`src/main/engine.js` coordinates mail accounts, cached messages and operations. `imap.js` provides real IMAP/SMTP access; `demo.js` provides the demo equivalent. Calendar coordination and caching live in `src/main/calendar/`, with Google and demo implementations. Profile data lives on the local filesystem.

The agent hub coordinates conversations and providers, and Rukoo exposes its own tools over MCP. Read [docs/agents.md](docs/agents.md) before changing these flows and [integrations/hermes/README.md](integrations/hermes/README.md) for the remote Hermes bridge. Provider-owned tools can reach systems independently of Rukoo's MCP tool list; do not infer their capabilities solely from Rukoo's tools.

## Where code lives

- `src/main/main.js` and `preload.js`: windows, IPC and the renderer bridge. Check every affected renderer caller when changing an IPC method or event.
- `src/main/engine.js`, `imap.js`, `demo.js`, `google.js`: mail state, real/demo transport and Google authentication. Check focused mail tests and relevant account or sync flows.
- `src/main/calendar/`: calendar coordination, cache and provider implementations. Its UI is `src/renderer/calendar.js`; tests are `test/calendar.test.js` and `test/e2e/calendar.spec.js`.
- `src/main/agents/`: conversations, provider adapters, MCP tools and skill loading. `test/agent-*.test.js` covers these boundaries; `test/e2e/agent.spec.js` covers the panel.
- `src/renderer/app.js`, `composer.js`, `compose.js`: main mail interface, shared editor and separate compose window. Check both compose entry points when changing the shared editor.
- `src/renderer/agent/bui.js` and `src/renderer/agent.css`: locally maintained Beautiful UI ports. These are editable source, not an installed component package. Preserve license notices. Main-app styles live in `src/renderer/styles.css`.
- `src/i18n/`: English source catalog, Dutch translations and locale registry. Read its nested `AGENTS.md` and [docs/translations.md](docs/translations.md) before catalog work.
- `.agents/skills/rukoo-design/`: development design guidance and references. `skills/` contains user-facing skills shipped with the app; follow [skills/README.md](skills/README.md) for those.
- `scripts/`: launch and capture helpers. `dist/`, `test-results/`, `playwright-report/` and `tmp/` are local outputs, not implementation source.

## Taste

Read and apply [rukoo-design](.agents/skills/rukoo-design/SKILL.md) for UI work. Use its tokens, component inventory and Beautiful UI references before inventing a parallel component. Agents are free to discover new visual styles and evolve the design; there is no blanket requirement to ask before a visual change. Keep shared components and design guidance consistent with the resulting implementation, and show the result through issue screenshots.

Keep interface text in the English and Dutch catalogs. Reuse shared editor and component implementations where they already serve multiple surfaces. Do not import RevenueOS's Next.js, database, shadcn or repository-layout rules into this Electron project.
