# Rukoo website

The website at [rukoo.io](https://rukoo.io): the landing page, the pricing page, the changelog, the help center at `/help`, the early access form and Rukoo in the browser at `/app`. It runs on Cloudflare as the `rukoo-site` Worker. The Worker serves the files in `site/` and passes every other request on to the account server in [`server/`](../server/README.md#how-rukooio-is-set-up).

## What's where

- `site/`: the files the Worker serves, as they are. There is no build step for the landing page and the changelog: edit the HTML, CSS and JavaScript directly. `site/app/` and `site/help/` are the exceptions: `npm run app:build` and `npm run help:build` make them, and they aren't committed.
- `cloudflare/`: the Worker. `worker.js` redirects www, answers the site's files and forwards the rest to the account server. `early-access.js` answers the early access form. `web-app.js` serves `/app` and sends invitation links at `/join` there. `help-center.js` serves `/help`.
- `help-center/`: the help center, an Astro Starlight project with its own `package.json`, 60 Markdown pages and its own [README](help-center/README.md) and [AGENTS.md](help-center/AGENTS.md).
- `content/changelog/`: one `.mdx` file per release. `npm run changelog` builds `site/changelog/index.html` from them.
- `assets-src/`: full-size screenshots and sounds. `npm run images` and `npm run changelog:images` make the AVIF and WebP sizes in `site/img/`.
- `tools/`: the scripts behind those commands, the icon sprite, the social card and a section-by-section screenshot check. `build-app.mjs` assembles `site/app/`.
- `test/browser/`: the browser tests for `/app`.

## Commands

Run these from this folder, after `npm install`:

| Command | What it does |
| --- | --- |
| `npm run serve` | Serves `site/` at http://localhost:4321, without the Worker, so `/app` doesn't work there |
| `npm test` | Tests the Worker, the changelog builder, the app build and the app's account, database and file code |
| `npm run changelog` | Rebuilds the changelog page from `content/changelog/` |
| `npm run images` | Rebuilds the landing page images from `assets-src/shots/` |
| `npm run changelog:images` | Rebuilds the changelog images from `assets-src/changelog/` |
| `npm run app:build` | Builds Rukoo in the browser into `site/app/` |
| `npm run help:build` | Installs `help-center/` with `npm ci`, checks its pages and builds it into `site/help/` |
| `npm run help:test` | Runs the help center's validator and build-step tests |
| `npm run app:dev` | Builds the app, runs the site and the account server on your computer, and rebuilds on every change |
| `npm run test:browser` | Runs the app in headless Chromium against a local account server |
| `npm run deploy` | Builds the app and the help center and deploys the live site to rukoo.io |

A change to the template in `tools/build-changelog.mjs` also needs `npm run changelog`, or the next rebuild undoes the edit in `site/changelog/index.html`.

## Rukoo in the browser

`/app` is Chat and Channels from the desktop app, running in a browser: the same renderer files, catalogs and chat engine, so it follows every desktop change. Mail, calendar, meetings, agents and booking aren't part of it. `tools/build-app.mjs` puts it together in `site/app/`:

- `index.html` from `src/web/index.html`, which says in a comment how it differs from the desktop window's page.
- The files of `src/renderer`, as they are, without the agent gallery, and the English and Dutch catalogs from `src/i18n` in `i18n/`.
- `web/bridge.js` and `web/argon2-worker.js`, bundled by esbuild with the options in `src/web/build-options.mjs`. They hold `window.mail`, the chat engine from `src/main/workspaces` and the Rukoo account, made for the browser. The engine is the desktop's own code; what it takes from Node comes from stand-ins in `src/web/engine/shims/`: files kept in memory, SHA-256 in JavaScript, and file transfers over `fetch`, which refuses a redirect before following it and sends no cookies. `fetch` reports nothing of an upload until the server answers, so the tray shows that a file is uploading without a percentage.
- `web/sql-wasm.wasm`, SQLite for the chat engine, from the `sql.js` package, and the licenses of the two packages the app ships: `web/sql-wasm.LICENSE.txt` for sql.js and `web/hash-wasm.LICENSE.txt` for hash-wasm, which `web/argon2-worker.js` bundles. The license comments in the bundled code stay at the end of `web/bridge.js` and `web/argon2-worker.js`.

The build stops with an error when a source or one of the app's files is missing. esbuild, sql.js and hash-wasm are exact versions in this folder's `package.json`, so building needs no `npm install` at the repository root.

The Worker serves `/app/*` from `site/app/` only: a missing file is a 404 and never reaches the account server. It replaces the site's Content Security Policy with the app's own, which allows WebAssembly (`'wasm-unsafe-eval'`) for SQLite and Argon2 and connections to this address only, and sends `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, `Cross-Origin-Opener-Policy: same-origin` and `Cache-Control: no-cache`. `/app` redirects to `/app/`.

Team chat's files need nothing more from the policy. The account server's upload and download links are at `/v1/` of the workspace address (`WORKSPACE_ORIGIN`, `https://rukoo.io` there), which this Worker passes to the account server, so they are this address too. The page shows images and link card pictures from `blob:` addresses of its own, which `img-src` allows, and a file of any type outside PNG, JPEG, GIF, WebP and AVIF only ever downloads, as `application/octet-stream`, so nothing a member sends can run as a page of this site. A server with `WORKSPACE_FILES_ORIGIN` set keeps its links at another address, which the policy and the file routes, without CORS headers, keep the page from; the app then hides the paperclip and says so when a file is opened.

A workspace invitation link is `https://rukoo.io/join#w=…&i=…`. The Worker asks the account server for `/join`, and when the answer is the invitation page (the server marks it with `X-Rukoo-Workspace-Invite: 1`), it answers `302` to `/app/` instead. The browser keeps the `#w=…&i=…` part on the new address, where the app reads the invitation, takes it out of the address bar and opens it after sign-in. Any other answer at `/join` passes through as it is, such as a booking page or a server with team chat off.

The app needs team chat on the account server (`WORKSPACE_MODE`); against a server with it off, it says that team chat isn't turned on. Team chat is on at rukoo.io, without files until the account server has a bucket for them. The landing page doesn't link to the app.

## Running the app locally

`npm run app:dev` runs both Workers with Wrangler from `server/`, so install the server's packages once, and give the local server its settings in `server/.dev.vars` (never committed):

```sh
npm install --prefix ../server
cp ../server/.dev.vars.example ../server/.dev.vars
```

In `server/.dev.vars`, set `PEPPER` (make one with `openssl rand -base64 32`), leave `JURISDICTION` empty, add `WORKSPACE_MODE=on`, and put a code in `INVITE_CODES` to create the first account with. Then:

```sh
npm run app:dev
```

The site, with the app, is at http://127.0.0.1:8787/app/. The account server answers behind it through the `ACCOUNT` binding, as on rukoo.io, and keeps its data in `.wrangler/` in this folder. The command runs Wrangler with `--infer-origin-from-routes=false`: without it the Workers would see `rukoo.io` from the routes in `wrangler.jsonc` as their address, and the app's policy would name the wrong socket address. A change under `src/renderer`, `src/i18n` or `src/web`, or in the chat engine, rebuilds `site/app/`; reload the page to see it. Ctrl+C stops both Workers and the rebuilds.

Invitation links you make there point at the server's own address, so they open the local app too.

## Tests

`npm test` needs no browser. It covers the Worker with fake bindings (`cloudflare/*.test.mjs`), including the app's routing, headers and the `/join` redirect, and the scripts in `tools/` (`tools/*.test.mjs`), including a full app build into a temporary folder. `tools/web-files.test.mjs` runs the chat engine's file code on the browser's stand-ins against a server on 127.0.0.1 and compares each stand-in with Node's own.

`npm run test:browser` runs `test/browser/*.e2e.mjs`, one at a time, in headless Chromium against both Workers on your computer. It needs `npm install --prefix ../server` and `npx playwright install chromium` once. Each file builds the app into `site/app/` and starts both Workers with wrangler's test harness (`test/browser/harness.mjs`), with fresh storage and a random `PEPPER`, so `/join`, the app's headers, `/v1` and the wake socket are the real ones. `chat.e2e.mjs` follows an invitation from the owner's Invite people dialog through sign-up and Join, messages, a direct message and a thread both ways, a reload, signing out and in, Dutch and a phone width. The two pages that write to each other have the engine's catch-up timer at half an hour, so a message only arrives in time through the wake socket. It also covers the phone's back gesture, notices above the composer and 44px touch targets, a used invitation link, a cancelled Join dialog, an engine that can't start, and a sign-out in one tab reaching another. `rich.e2e.mjs` runs the account server with a files bucket and the link card pages of `server/test/fixtures/preview-pages.cjs` (`startWorkers({ files: true })`): a file through the paperclip, an image dropped on the conversation and shown, downloaded and opened in a new tab, a pasted file, another member's files arriving and downloading, reactions both ways, Markdown both ways, link cards and their removal, the same conversation on a phone in Dutch with the emoji picker, a picked file that changed on disk, a reload with files under the text, a picture that left the page's download cache, and emoji picked into the channel's and a thread's composer at the cursor. `apps.e2e.mjs` checks the notice that lists the Rukoo apps once you're signed in: in order, with the downloads for the system, in English and Dutch, light and dark, at a desktop and a phone width, and gone for good in every tab once closed. `chat-off.e2e.mjs` checks the page against a server with team chat off, and in a browser too old for the app. A test fails on any console error it doesn't provoke on purpose and on horizontal overflow. Set `RUKOO_WEB_VERIFY` to a folder, such as `../tmp/web-verify`, to save screenshots of the main states there.

## Deploying

Merging a change into `main` deploys the site when it touches `website/`, the workflow, or what the app is built from: `src/renderer/`, `src/i18n/`, `src/web/` or `src/main/workspaces/`. A server change under `server/src/` runs the website's tests on a pull request but deploys nothing here, and so does a change to the desktop's account code (`src/main/account/`) or the test fixtures the tests hold the browser's code to, such as `test/fixtures/account-vectors.json`. The `test` job in [`.github/workflows/website.yml`](../.github/workflows/website.yml) builds the app and the help center, runs the tests, the help center's tests and the browser tests, and keeps the built `site/app/` and `site/help/` as one artifact. The `deploy` job runs once those pass: it downloads that artifact into `site/`, checks that `site/app/index.html` and `site/help/index.html` are there, and runs `wrangler deploy` with `wrangler.jsonc`. A failed test means no deploy. To deploy `main` again without a change, run the Website workflow by hand on `main` from the Actions tab.

The job reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the GitHub environment `rukoo.io`, which only `main` may use. The token is limited to deploying Workers. Pull requests run the tests but never see the token. The deploy job installs no packages and builds nothing, so only Wrangler runs next to the token.

`npm run deploy` also works from your own computer, after `wrangler login` or with those two variables set. It builds `site/app/` and `site/help/` first. The early access form needs two Worker secrets, set with `wrangler secret put`: `RESEND_API_KEY` and `EARLY_ACCESS_TO`, the address the requests go to. A deploy keeps them.

The account server deploys separately, from `server/`. The site Worker reaches it through the `ACCOUNT` service binding, so merge and deploy the server first when a site change depends on a server change.

## History

The website moved here from a separate repository in November 2026. Its earlier history and the launch film projects stayed there.
