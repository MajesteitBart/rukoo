# Rukoo website

The website at [rukoo.io](https://rukoo.io): the landing page, the changelog and the early access form. It runs on Cloudflare as the `rukoo-site` Worker. The Worker serves the files in `site/` and passes every other request on to the account server in [`server/`](../server/README.md#how-rukooio-is-set-up).

## What's where

- `site/`: the files the Worker serves, as they are. There is no build step for the page itself: edit the HTML, CSS and JavaScript directly.
- `cloudflare/`: the Worker. `worker.js` redirects www, answers the site's files and forwards the rest to the account server. `early-access.js` answers the early access form.
- `content/changelog/`: one `.mdx` file per release. `npm run changelog` builds `site/changelog/index.html` from them.
- `assets-src/`: full-size screenshots and sounds. `npm run images` and `npm run changelog:images` make the AVIF and WebP sizes in `site/img/`.
- `tools/`: the scripts behind those commands, the icon sprite, the social card and a section-by-section screenshot check.

## Commands

Run these from this folder, after `npm install`:

| Command | What it does |
| --- | --- |
| `npm run serve` | Serves `site/` at http://localhost:4321 |
| `npm test` | Tests the Worker and the changelog builder |
| `npm run changelog` | Rebuilds the changelog page from `content/changelog/` |
| `npm run images` | Rebuilds the landing page images from `assets-src/shots/` |
| `npm run changelog:images` | Rebuilds the changelog images from `assets-src/changelog/` |
| `npm run deploy` | Deploys the live site to rukoo.io |

A change to the template in `tools/build-changelog.mjs` also needs `npm run changelog`, or the next rebuild undoes the edit in `site/changelog/index.html`.

## Deploying

`npm run deploy` runs `wrangler deploy` with `wrangler.jsonc`, so it changes the live site. It needs `wrangler login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The early access form needs two Worker secrets, set with `wrangler secret put`: `RESEND_API_KEY` and `EARLY_ACCESS_TO`, the address the requests go to. Merging a change does not deploy it.

The account server deploys separately, from `server/`. The site Worker reaches it through the `ACCOUNT` service binding, so deploy the server first when a site change depends on a server change.

## History

The website moved here from a separate repository in November 2026. Its earlier history and the launch film projects stayed there.
