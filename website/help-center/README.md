# Rukoo help center

A local, English-first static help center, published at https://rukoo.io/help/. Astro Starlight supplies Markdown routing, responsive navigation and Pagefind search. The help center has 60 pages. It covers setup, daily mail, accounts and team chat, calendar and booking, meetings with Rukoo Voice, and everyday agent tasks. Supplemental guides are labeled as GitHub destinations.

## Run

Use Node 24 or newer with npm 11. Tested with Node 24.21.0 and Node 26.2.0.

```sh
npm ci
npm test
npm run build
npm run preview -- --port 4321
# Open http://127.0.0.1:4321/help/
```

For editing: `npm run dev -- --port 4321`. Search works on the built preview; Pagefind indexes static output during the build. `npm run build` validates the Markdown, builds into `dist/`, copies the build to `../site/help/` with a script policy on every page, and then checks output links, those policies and private-data patterns.

The Astro preview serves the help center alone, so the Inter font and the links to the rest of rukoo.io don't load there. To see the help center inside the whole site, with the Worker and its headers, run `npx wrangler@4 dev` in `website/` after a build and open http://127.0.0.1:8787/help/. `npm run serve` there shows the same files without the Worker.

## Why Starlight

Markdown remains the content source. Starlight provides routing, mobile navigation and local static search in one maintained integration. Exact direct versions and package-lock.json lock the toolchain. The tradeoff is a Node build and a larger dependency tree than a handwritten HTML site; the deployed output is static files.

## Structure

- `src/content/docs/`: the only authored public page tree.
- `navigation.json`: product/task navigation, shared with the validator.
- `page-registry.json`: persistent page IDs and URLs.
- `editorial/`: four templates, schema, tone and PR rules. These files are outside the published content and asset directories.
- `public/`: reviewed public assets only. Rukoo wordmarks come from the public v2.4.0 tag; see THIRD-PARTY-NOTICES.md.
- `scripts/`: deterministic content/output validation and negative tests, plus the build steps: `astro.mjs` runs Astro with telemetry off, `markdown-base.mjs` adds `/help` to links in the Markdown, and `publish.mjs` copies the build into the site.
- `src/components/SiteTitle.astro`: the header title. The Rukoo wordmark links to the rukoo.io home page and "Help" to the help home.

Keep the actual source map in a separate private directory outside this project and outside the delivery archive. The schema and fictional example in editorial/ describe its shape.

## Source and release boundary

Pages follow Mail 2.4.0 desktop. Android 0.6.0 differences and the Voice 0.2.0 pairing are stated where needed. Mail sources and exact English labels are pinned to v2.4.0; Voice sources use voice-v0.2.0. `reviewed` records source review. Fill `behaviorChecked` after following the page on the applicable released app. See REVIEW.md for the walkthrough checklist.

Use REVIEW.md to follow the instructions on the released apps and record the result by page ID. The visual pass follows publication of the full initial text corpus. Weekly maintenance follows that visual pass.

## URL policy

A title edit never changes pageId or slug. New pages add one registry entry. Treat published URLs as permanent. Page URLs in the registry, the navigation and the Markdown leave out the `/help` base; the build adds it, so `/mail/write/` is published as https://rukoo.io/help/mail/write/. A necessary URL move needs an explicit old-to-new redirect, a retained registry history and a reviewed link migration. Put the redirect in `../site/_redirects` (an HTTP redirect, with the full `/help/...` paths) or in astro.config.mjs (an HTML redirect).

## Checks and packaging

`npm test` injects duplicate/invalid IDs, broken links, internal ticket links and template markers into temporary content, and checks rejection. It restores the files before exiting. `npm run check:output` scans generated HTML and checks local assets, page links and fragments. Pattern scans catch known mistakes; human review checks for confidential material that lacks a recognizable marker.

The delivery ZIP contained source files from this project only. It excludes node_modules, dist, .astro, private evidence, source downloads and local planning logs.

## Deploying

The help center ships with the rest of rukoo.io. The `rukoo-site` Worker serves `../site/`, and the build puts the help center in `../site/help/`, which isn't committed. The Website workflow (`.github/workflows/website.yml`) runs `npm run help:build` and `npm run help:test` from `website/` on every pull request that touches `website/`. On `main` the deploy job takes the help center from that build, together with the browser app, and deploys the site. `npm run deploy` in `website/` builds both too, for a deploy by hand.

`../cloudflare/help-center.js` answers everything under /help/ from those files. A missing page gets the help center's 404 page with a 404 status and never reaches the account server. It replaces the main site's Content-Security-Policy with the help center's, which allows inline scripts and Pagefind's WebAssembly. `publish.mjs` gives every page a second policy in a `<meta>` tag that lists the hashes of that page's own inline scripts. The browser enforces both, so only Starlight's own scripts run. `check-output.mjs` fails the build when a page lacks that policy or an inline script lacks its hash.
