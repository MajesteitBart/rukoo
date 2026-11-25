# Rukoo help center

A local, English-first static help center for https://help.rukoo.io. Astro Starlight supplies Markdown routing, responsive navigation and Pagefind search. The help center has 60 pages. It covers setup, daily mail, accounts and team chat, calendar and booking, meetings with Rukoo Voice, and everyday agent tasks. Supplemental guides are labeled as GitHub destinations.

## Run

Use Node 24.x and npm 11.x. Tested with Node 24.21.0 and npm 11.19.0.

```sh
npm ci
npm test
npm run build
npm run preview -- --port 4321
# Open http://127.0.0.1:4321/
```

For editing: `npm run dev -- --port 4321`. Search works on the built preview; Pagefind indexes static output during the build. `npm run build` first validates Markdown, then builds, then checks output links and private-data patterns.

## Why Starlight

Markdown remains the content source. Starlight provides routing, mobile navigation and local static search in one maintained integration. Exact direct versions and package-lock.json lock the toolchain. The tradeoff is a Node build and a larger dependency tree than a handwritten HTML site; the deployed output is static files.

## Structure

- `src/content/docs/`: the only authored public page tree.
- `navigation.json`: product/task navigation, shared with the validator.
- `page-registry.json`: persistent page IDs and URLs.
- `editorial/`: four templates, schema, tone and PR rules. These files are outside the published content and asset directories.
- `public/`: reviewed public assets only. Rukoo wordmarks come from the public v2.4.0 tag; see THIRD-PARTY-NOTICES.md.
- `scripts/`: deterministic content/output validation and negative tests.

Keep the actual source map in a separate private directory outside this project and outside the delivery archive. The schema and fictional example in editorial/ describe its shape.

## Source and release boundary

Pages follow Mail 2.4.0 desktop. Android 0.6.0 differences and the Voice 0.2.0 pairing are stated where needed. Mail sources and exact English labels are pinned to v2.4.0; Voice sources use voice-v0.2.0. `reviewed` records source review. Fill `behaviorChecked` after following the page on the applicable released app. See REVIEW.md for the walkthrough checklist.

Use REVIEW.md to follow the instructions on the released apps and record the result by page ID. The visual pass follows publication of the full initial text corpus. Weekly maintenance follows that visual pass.

## URL policy

A title edit never changes pageId or slug. New pages add one registry entry. Treat published URLs as permanent. A necessary URL move needs an explicit old-to-new redirect in astro.config.mjs, a retained registry history and a reviewed link migration. Generator redirects are HTML redirects; hosting-level HTTP redirects depend on the eventual host.

## Checks and packaging

`npm test` injects duplicate/invalid IDs, broken links, internal ticket links and template markers into temporary content, and checks rejection. It restores the files before exiting. `npm run check:output` scans generated HTML and checks local assets, page links and fragments. Pattern scans catch known mistakes; human review checks for confidential material that lacks a recognizable marker.

The delivery ZIP contained source files from this project only. It excludes node_modules, dist, .astro, private evidence, source downloads and local planning logs.

## Deploying

help.rukoo.io is a Cloudflare Worker named `rukoo-help` that serves `dist/` as static assets (`wrangler.jsonc`). It is separate from the `rukoo-site` Worker behind rukoo.io. The Help center workflow (`.github/workflows/help-center.yml`) runs `npm ci`, `npm test` and `npm run build` on every pull request. A merge into `main` that touches `help-center/` also deploys the built `dist/` with Wrangler, using the Cloudflare token in the GitHub environment `rukoo.io`. A missing page returns `404.html` with a 404 status. As the URL policy says, a moved page needs an explicit redirect in `astro.config.mjs`; these are HTML redirects.
