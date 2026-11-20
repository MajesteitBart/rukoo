# Rukoo account server

This folder holds the server for Rukoo accounts. A Rukoo account keeps a few of Rukoo's own things in step between a person's devices: their inbox categories, the category each email got, and their corrections. You can run your own copy on your own Cloudflare account by following this page.

## What it is and isn't

The server is a sync relay for small encrypted records. Each device encrypts a record before sending it, with a key the server never gets. The server stores the encrypted bytes and hands them to the person's other devices.

It is not a mail server. No mail, no mail passwords and no Google tokens pass through it. It never sees what a record holds. What it can see is listed in [PROTOCOL.md](PROTOCOL.md#what-the-server-can-see): the email address of each account, device names, record counts and sizes, and IP addresses.

It also serves booking pages: an account holder can turn one on in Rukoo, and other people and their AI assistants then book time with them at `/meet/<handle>`, or at `/<handle>` on a booking address you set up (`BOOKING_ORIGIN`). A page that is on is readable by the server, and so are a guest's details at the moment they book. [Booking pages](#booking-pages) below covers what that means for running the server.

It can also host team chat: workspaces with channels that people on your server make and invite others into. That is off until you turn it on, and it is the one part where your server holds readable content. [Team chat](#team-chat) below covers it.

It can't reset a password either. A person who forgets their password needs their recovery key. Without both, their synced data is gone. Their mail is not affected.

The server is a Cloudflare Worker with one Durable Object per account. Each object has its own small SQLite database. There is no shared table of accounts or sessions. [PROTOCOL.md](PROTOCOL.md) describes the API and the encryption.

## Cost

The Workers Free plan is enough for a few people. It includes Durable Objects with SQLite storage, within daily limits that a family or a small team won't reach.

For more people, the Workers Paid plan costs $5 a month. On top of that, expect about $0.01 to $0.02 per active person per month for requests and storage. See Cloudflare's [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Before you start

You need:

- A Cloudflare account.
- Node.js 22 or newer.
- A fork or clone of the Rukoo repository.

All commands below run in the `server` folder.

## Deploy your own

### 1. Install

```sh
cd server
npm install
```

### 2. Sign in to Cloudflare

```sh
npx wrangler login
```

This opens a browser window where you allow Wrangler to manage Workers on your account.

### 3. Choose where accounts are stored

Open `wrangler.jsonc` and set `JURISDICTION`:

| Value | Where accounts are stored and run |
|---|---|
| `"eu"` (the default) | In the European Union |
| `"us"` | In the United States |
| `"fedramp"` | In FedRAMP-Moderate data centers |
| `""` | Anywhere: Cloudflare puts each account near the device that first used it |

Choose this before the first person signs up, and don't change it afterwards. Cloudflare gives an object a different ID in each jurisdiction. If you change the setting, the server looks for every account under a new ID, finds nothing, and every existing account seems to vanish. The old data stays at Cloudflare, but the server can't reach it. Moving to another jurisdiction means everyone makes a new account.

Cloudflare, Inc. is a US company. US law applies to it even when the data stays in the EU. Because records are end-to-end encrypted, what Cloudflare holds is what the server can see, as listed above.

### 4. Fill in the rest of `wrangler.jsonc`

The `vars` block holds the server's settings:

| Setting | What it does |
|---|---|
| `OPERATOR_NAME` | Your name or your organization's. The app shows it before sign-up. |
| `OPERATOR_URL` | Your website. |
| `OPERATOR_CONTACT` | An email address or web page where people can reach you. |
| `PRIVACY_URL` | Your own privacy statement. Leave it empty to use the one the server shows at `/privacy` (step 8). |
| `JURISDICTION` | See step 3. |
| `INVITE_USES` | How many accounts one invite code may make: `1` by default, `0` for any number. A used-up code is refused like a wrong one. Needs the `REGISTRY` binding, which keeps the count. |
| `SIGNUPS` | `"open"` lets anyone make an account. `"invite"` needs a code from `INVITE_CODES` (step 7). `"closed"` takes no new accounts. Existing accounts keep working in every mode. |
| `MAX_RECORDS` | The most records one account may keep. |
| `MAX_BYTES` | The most bytes of records one account may keep. |
| `MAX_ACCOUNTS` | The most accounts the server holds (`0` for no cap). Past it, sign-ups get "This server has no room for new accounts". With open sign-ups this is what bounds the storage strangers can take: at most `MAX_ACCOUNTS` × `MAX_BYTES`. The flip side: someone who signs up with invented addresses can use up the cap, and then nobody else gets in. The server doesn't check addresses yet, so invite codes are the safer choice for a server on the internet. |

The defaults (250,000 records and 100 MiB per account) are far more than one person uses.

The booking page settings are in the same block; see [Booking pages](#booking-pages).

The `ratelimits` block limits sign-up, sign-in and recovery calls to 30 a minute per IP address (`RATE_LIMITER`), writing records to 120 pushes a minute (`PUSH_LIMITER`), and every public write on booking pages (bookings, cancellations, moves, form posts) to 20 a minute (`BOOKING_LIMITER`). Their `namespace_id`s can be any numbers that no other rate limiter in your Cloudflare account uses. To turn a limit off, delete its entry. The locks after ten wrong passwords, on an account's sign-ins and on a signed-in device's password checks, apply either way.

### 5. Deploy

```sh
npm run deploy
```

Wrangler prints the server's address, such as `https://rukoo-account.<your-subdomain>.workers.dev`. Until you set the pepper in the next step, every call except `/v1/info` answers `500 not_configured`.

### 6. Set the pepper

The pepper is a random secret. The server uses it to turn an email address into the ID of that account's object, and to answer questions about unknown addresses the same way as about real ones.

Make one:

```sh
openssl rand -base64 32
```

Or, without OpenSSL (on Windows, for example):

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Then store it as a secret and paste the value when Wrangler asks:

```sh
npx wrangler secret put PEPPER
```

Keep a copy in your password manager. Cloudflare won't show it to you again. Never change it once people have signed up: like the jurisdiction, it decides where each account is found, so a new pepper makes every account vanish.

### 7. Add invite codes (optional)

With `SIGNUPS` set to `"invite"`, a new account needs one of your invite codes. Store them as a secret, separated by commas:

```sh
npx wrangler secret put INVITE_CODES
```

For example `family-2026,team-lisbon`. Any code in the list works, as often as it is used. To retire a code, put the list again without it.

### 8. Check it

Open the server's address in a browser. You should see a short page that says who runs the server and what it can see. `https://<your address>/v1/info` shows the same settings as JSON.

`https://<your address>/privacy` is a privacy statement in English and Dutch (`?lang=nl`), filled in from your `vars`: who runs the server, what it keeps and why, Cloudflare's part, how long data stays and people's rights. You're responsible for what it says. Read it before people sign up, and change `src/privacy.js`, or set `PRIVACY_URL` to a statement of your own, where it doesn't match how you run the server.

### 9. Add your own domain (optional)

Your domain has to be on Cloudflare. Add a route to `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "accounts.example.org", "custom_domain": true }]
```

Then run `npm run deploy` again. You can also add it in the Cloudflare dashboard: open the Worker, then Settings, then Domains & Routes.

Once people use your domain, you can turn off the `workers.dev` address by adding `"workers_dev": false` to `wrangler.jsonc`.

### 10. Point Rukoo at your server

This is a setting in the app. In Rukoo, open Settings → Rukoo account, choose the server row and enter your server's address, such as `https://accounts.example.org`. The app shows who runs the server before anyone signs up.

To make your server the default in your own build of Rukoo, set `rukoo.accountServer` in the repository's `package.json`.

## Booking pages

A booking page is off until an account holder turns it on in Rukoo. Then the server offers times from what the holder's computer published, takes bookings from people, from assistants that read the page or call the JSON API, and from MCP clients at `/meet/mcp` (`/mcp` on a booking address), and keeps each booking until the holder's Rukoo picks it up and puts it in their calendar. The server never sends mail and holds no calendar access. [PROTOCOL.md](PROTOCOL.md#booking-pages) has the details; the privacy statement at `/privacy` has a Booking pages section that guests are pointed to under the booking form.

What `wrangler.jsonc` already sets up, in the top level and in every environment you add:

- **`BOOKINGS`**, a Durable Object binding with one object per handle. The `v3` migration (`new_sqlite_classes: ["Booking"]`) creates the class. Keep it, like the other migrations.
- **`BOOKING_LIMITER`**, a rate limiter (`namespace_id` 1003 in the file) that allows 20 public writes a minute per address. On top of it each page takes at most 3 new bookings a day from one network and its own daily cap.

The settings in `vars`:

| Setting | What it does |
|---|---|
| `BOOKING_STALE_HOURS` | Hours after the holder's computer last published before every meeting type waits for the holder's confirmation. Default 24. |
| `BOOKING_DARK_DAYS` | Days after the last publish before a page offers no times at all. Default 7. |
| `BOOKING_ORIGIN` | An address booking pages live at the root of, such as `https://meet.example.org`, so a page is `https://meet.example.org/<handle>`. Empty means each page lives under `/meet` on the address it was opened on. See below. |
| `BOOKING_ALIASES` | Addresses your booking pages used to live at, as origins separated by commas, such as `https://accounts.example.org`. The MCP endpoint takes a `/meet/<handle>` link on one of them as the same page, so links people saved before a move still work there. Empty by default. |
| `BOOKING_FORMER_ROOTS` | Addresses whose root held your booking pages before `BOOKING_ORIGIN`, as origins separated by commas. Reads there redirect to the same path on `BOOKING_ORIGIN`; posts, MCP calls, reads with a manage key, guests' manage pages and the pages' script, icons and fonts are still answered there, so a page or client from before the move keeps working, and MCP takes links to those addresses as the same pages. It does nothing without `BOOKING_ORIGIN`. Empty by default. |
| `BLOCKED_HANDLES` | Handles you took down, separated by commas. They answer like a handle nobody has and can't be claimed. |

Set `OPERATOR_CONTACT` before you let people turn pages on. Every booking page has a "Report this page" link, and it goes there: an email address becomes a mail with the page's address in the subject, a web address is linked as it is. Without it the link isn't shown, and `BLOCKED_HANDLES` is how you act on a report.

### A short address for booking pages

Booking links end up in email footers, so a short domain helps. Route it to this same Worker and tell the server to use it:

```jsonc
"routes": [
  { "pattern": "accounts.example.org", "custom_domain": true },
  { "pattern": "meet.example.org", "custom_domain": true }
],
"vars": { "BOOKING_ORIGIN": "https://meet.example.org" }
```

Pages then live at the root of that address, without `/meet`: `https://meet.example.org/<handle>`, with the MCP endpoint at `/mcp`, the pages' script at `/booker.js`, their icon at `/favicon.ico`, `/favicon.svg` and `/apple-touch-icon.png`, and a guide for assistants at `/llms.txt`. The app shows that address, and every link the pages, `llms.txt`, the JSON API and MCP hand out uses it. Any other path there counts as a handle, so an unknown one gets the booking pages' 404. The account API (`/v1/…`) and `/privacy` work on both domains.

`/meet/…` on any address redirects to the same path on `BOOKING_ORIGIN` (301 for reads, 308 for posts), so links handed out before you set it keep working. An assistant that passes such a link to MCP doesn't follow the redirect, so list the old address in `BOOKING_ALIASES` if it was your own. If the pages lived at the root of another address before, list that one in `BOOKING_FORMER_ROOTS` instead: its links redirect the same way, without `/meet`. A booking's calendar UID keeps the host it was made under, so changing `BOOKING_ORIGIN` later doesn't split anyone's calendar entries.

[PROTOCOL.md](PROTOCOL.md#where-public-routes-live) lists the routes on each kind of address.

### Let assistants through

The point of a booking page is that someone can paste it into their assistant. Chat assistants such as ChatGPT, Gemini and Perplexity fetch it from their own servers, and coding agents use curl or Python. Cloudflare's bot protection can answer those fetches with a challenge page, which the assistant then reports as "the page didn't load". Nothing in the Worker can see or undo that, because it happens before the request reaches it. On the zone that serves the pages, check:

- **Bot Fight Mode.** It challenges clients it thinks are bots and can't be skipped for some paths. Turn it off on that zone.
- **Super Bot Fight Mode** (paid plans). Add a WAF custom rule that skips it for `/meet/*`, or for the whole booking address with `BOOKING_ORIGIN`, or set definitely automated traffic to Allow.
- **AI Crawl Control and "Block AI bots".** Allow the assistants' fetchers, at least for the booking pages' paths.
- **WAF managed rules and challenges.** Don't put a managed challenge on the booking pages' paths.

Then try it: paste a page into an assistant and ask for the open times, and fetch it with `curl https://<your address>/meet/<handle>` (or `curl https://<booking address>/<handle>`). A Cloudflare challenge page instead of the booking page means one of the settings above still blocks it. `wrangler dev` skips all of this, so only a deployed address shows it.

## Team chat

Team chat lets the people with an account on your server make workspaces, invite others into them and talk in channels. It is being built in steps: the server side of text channels and direct messages is here, and the Rukoo apps have no Chat or Channels yet, so turning it on today is for trying the API. [WORKSPACES.md](WORKSPACES.md#gate-1-routes) lists what the server answers, and [the architecture](../docs/workspace-architecture.md) what is planned.

**You can read it.** A workspace's messages and files are stored as they were written. Whoever runs the server, and Cloudflare under it, can read and change them. The records accounts sync stay encrypted as before. Say so in your privacy statement before you turn it on.

What `wrangler.jsonc` already sets up:

- **`WORKSPACES`**, a Durable Object binding with one object per workspace, holding its members, channels and messages in its own SQLite database. The `v4` migration (`new_sqlite_classes: ["Workspace"]`) creates the class.
- **`WORKSPACE_FILES`**, commented out: the R2 bucket for files in messages. See "Files need a bucket" below.

The settings in `vars`:

| Setting | What it does |
|---|---|
| `WORKSPACE_MODE` | `on` or `off`. Off by default: the routes answer 404 and `GET /v1/info` doesn't mention workspaces. |
| `WORKSPACE_ORIGIN` | The one address workspaces on this server are known by, such as `https://accounts.example.org`. Empty means the address each request came in on. Set it when your server answers on more than one address. |
| `WORKSPACE_SIGNUPS` | `on` or `off`. With `SIGNUPS` on `invite`, `on` lets an open workspace invitation stand in for an invite code when someone signs up, once per invitation. That lets every workspace owner and admin bring new accounts onto your server, within `MAX_ACCOUNTS`. `off` keeps sign-ups to your own codes. On by default. |
| `MAX_WORKSPACES` | The most workspaces the server holds. Default 100. |
| `MAX_WORKSPACES_PER_ACCOUNT` | How many workspaces one account may make. Default 3. |
| `MAX_WORKSPACE_MEMBERSHIPS` | How many workspaces one account may be in at once. Default 50. |
| `WORKSPACE_MEMBERS` | Members per workspace. Default 100. |
| `WORKSPACE_SOCKETS` | Open connections per workspace, which devices wait on for new messages. Default 200. |
| `WORKSPACE_CONVERSATIONS` | Channels per workspace, archived ones included until their history is gone. Default 8192. |
| `WORKSPACE_BYTES` | Bytes of message text a workspace keeps. Past it, posting answers "This workspace is full". Default 1 GiB. A workspace is one Durable Object, which holds 10 GB on Workers Paid and 1 GB on Workers Free, and each message takes about 100 bytes on top of its text, so set this to `268435456` on Workers Free. |
| `WORKSPACE_RETENTION_DAYS` | Days a message is kept before the server deletes it. Default 90. |
| `WORKSPACE_FILE_BYTES` | The largest file someone can send, in bytes. Default 25 MiB. |
| `WORKSPACE_FILES_BYTES` | Bytes of files one workspace may keep, counting files that are still uploading. Past it, an upload answers "This workspace has no room for more files". Default 5 GiB. This is separate from `WORKSPACE_BYTES`, because files live in the bucket, not in the workspace's database. |
| `WORKSPACE_PREVIEWS` | `on` or `off`. With `on`, the server fetches up to three web addresses in a message and adds a link card with the page's title, description and image. Your server fetches the page, so the site sees your server's address and never a member's. It refuses local and private addresses and your server's own. On by default. |
| `WORKSPACE_FILES_ORIGIN` | A separate address for upload and download links, such as `https://files.example.org`, routed to this Worker as a custom domain or route. Empty means links use the workspace's own address. |
| `WORKSPACE_PREVIEW_HOSTS` | For tests only: `host:port` pairs that link cards may fetch although they are local. Leave it empty. |

**Files need a bucket.** People send files and images in chat only when the Worker has a private R2 bucket bound as `WORKSPACE_FILES`. `wrangler.jsonc` has that binding commented out, so a deploy without a bucket keeps working: the server then lists no `files` capability, every file route answers `403 files_off`, and the apps hide Attach, drag and drop and pasting files. Reactions, marking unread and link cards work without a bucket, but link cards then come without their image. To turn files on, make the bucket in the jurisdiction of your accounts and remove the comment marks around `r2_buckets`, with the same `jurisdiction`:

```bash
npx wrangler r2 bucket create rukoo-workspace-files --jurisdiction eu
```

Leave the bucket private, without a public bucket address. Devices upload through this Worker, which streams each file into the bucket with the exact size and SHA-256 the device declared, and download with a link the Worker signs, valid for 60 seconds. Files of a removed message and of messages retention removes are deleted from the bucket by the workspace's alarm, usually within a minute. Deleting a workspace deletes its files first; when the bucket fails, the workspace stays and its owner can try again. R2 bills storage and operations separately from Workers ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)).

Anyone with an account on your server can make a workspace, within those limits, so invite codes for sign-up are also what decides who can. A workspace's owners and admins invite the others, who need an account on your server too. A new member also gets the workspace's first open channel, normally `general`. An owner who is the only one left in a workspace can delete it.

**Invitation links.** An invitation link is `https://<your address>/join#w=…&i=…`. Opened in a browser, `/join` is a page in English or Dutch that says how to use the link in Rukoo: paste it into Chat's Join dialog, or, without an account, into the invite code field of the sign-up form. The part after `#` holds the invitation and never reaches your server. The page names the operator from `OPERATOR_NAME`, runs no script and sends no referrer, and answers 404 while `WORKSPACE_MODE` is `off`. With `WORKSPACE_SIGNUPS` on, such a link makes one account on your server even when sign-ups need an invite code ([PROTOCOL.md](PROTOCOL.md#post-v1signup)).

**Turn it on in two deploys.** Deploy this version with `WORKSPACE_MODE` still `off` and wait until every address of your server runs it. Then set it to `on` and deploy again. The order matters when you roll back as well: a version from before team chat deletes an account without telling the workspaces it was in, and its messages there would then keep its name. Once a workspace exists, don't go back to such a version.

**Don't roll a workspace back.** Cloudflare can restore a Durable Object's database to any point in the last 30 days. For a workspace that would bring back every member who was removed and every message that was deleted since. A device that was up to date notices, and stops with "this workspace is behind what this device has seen"; a device that wasn't doesn't. If a workspace's data is lost or damaged, have its owner start a new one.

Cloudflare keeps that 30-day history whether you use it or not, so a message someone removed can be restored by you for 30 days. `GET /v1/info` tells the apps so, as `platformHistoryDays`.

## The server Rukoo uses

The `bvdm` environment in `wrangler.jsonc` is the server the Rukoo app uses by default, at `https://rukoo.io`, run by Rukoo's maintainer. It takes new accounts by invite code. It is deployed with `npm run deploy -- --env bvdm`. A fork ignores it: `npm run deploy` without `--env` deploys the settings at the top of the file.

### How rukoo.io is set up

rukoo.io serves Rukoo's website and this server's account API; the booking pages are on meet.rukoo.io. Two Workers do it:

1. `rukoo-site`, from [`website/`](../website/README.md) in this repository, has the custom domains `rukoo.io` and `www.rukoo.io` (www redirects to the apex). It serves the website's static files first. A request that matches no file, and every request under `/v1`, goes on, unchanged, through a service binding named `ACCOUNT` to the `rukoo-account` Worker: the same method, URL and headers, so this server sees `https://rukoo.io/...` addresses, the client's `cf-connecting-ip` for its rate limits, and the `Origin` and `Sec-Fetch-Site` headers its write checks read.
2. `rukoo-account`, this folder, deployed with `--env bvdm`. It has the custom domain `meet.rukoo.io`, which is its `BOOKING_ORIGIN`, so booking pages are `https://meet.rukoo.io/<handle>` and MCP is `https://meet.rukoo.io/mcp`. The account API is `https://rukoo.io/v1/...`, through the site Worker. A booking's calendar UID ends in `@meet.rukoo.io`, or `@rukoo.io` for one made before the move.

The pages lived at the root of rukoo.io at first. `BOOKING_FORMER_ROOTS` is `https://rukoo.io`, so a page link there that reaches this server redirects to the same path on meet.rukoo.io, and MCP takes rukoo.io links as the same pages. Posts, MCP calls, reads with a manage key and guests' manage pages are still answered on rukoo.io, for pages and clients from before the move.

`/join` reaches this server the same way, because the website has no such file.

The website's paths (`/`, `/index.html`, `/404.html`, `/app.js`, `/styles.css`, `/assets/*`, `/img/*`, `/media/*`, and its redirects `/download/*`, `/releases` and `/github`) always win on rukoo.io, because the site Worker answers them before anything reaches this server. The server keeps those names and likely future ones reserved as handles, from when the pages shared rukoo.io with the website. `/` on rukoo.io is the website; on meet.rukoo.io it is this server's own page.

The Worker keeps its old custom domain `rukoo-account.bvdm.ai`. Devices that still sync with that address keep working, since the account API answers on every address, and its `/meet/...` links redirect to the same page on meet.rukoo.io. `BOOKING_ALIASES` is `https://rukoo-account.bvdm.ai`, so MCP takes those old links too.

All three addresses reach the same Worker and the same storage, so they hold the same accounts and booking pages. Signing in still needs the address an account was made at, because the password proof includes it ([PROTOCOL.md](PROTOCOL.md#keys)). A device signed in at the old address keeps using it until it signs out or deletes the account.

## What lands in Cloudflare's logs

The server never logs request bodies, tokens, keys or email addresses. When a request fails in a way it didn't expect, it logs the error.

`wrangler.jsonc` turns on Workers Logs for those error messages and turns off invocation logs. Invocation logs would store a line for every request, with its URL and request details. If you turn them on, keep that in mind for your privacy statement. With booking pages this matters more: a guest's manage page has the key to their booking in its address (`?k=`), and a filled-in booking link can carry a name and an email address. The server never logs them; invocation logs, or Logpush on the zone, would. The pages send `Referrer-Policy: same-origin`, so the same address also arrives in the `Referer` header of the page's own requests (its script, its form posts), which Logpush's referer field would record too. Other websites never get it.

Apart from that:

- Cloudflare sees each request's IP address and headers while handling it, like any host does.
- The dashboard shows request counts, status codes and errors, but not who made them.
- The rate limiter counts requests per IP address for a minute at a time.
- `npx wrangler tail` streams live requests, including their IP addresses and headers, to whoever runs it. Nothing from it is stored.

## Local development

```sh
cp .dev.vars.example .dev.vars
```

Put a pepper in `.dev.vars`. Leave `JURISDICTION` empty there: the local runtime can't place objects in a jurisdiction. Then:

```sh
npm run dev
```

The server runs at `http://localhost:8787` and keeps its data in `.wrangler/`. Neither `.dev.vars` nor `.wrangler/` is committed. Put an invite code in `INVITE_CODES` there too if you want to sign up from the app. A booking page you turn on from a Rukoo pointed at this address is at `http://localhost:8787/meet/<handle>`. To try the root layout rukoo.io uses, start it with `npx wrangler dev --var BOOKING_ORIGIN:http://localhost:8787`; the page is then at `http://localhost:8787/<handle>`, and `/meet/<handle>` redirects there.

Run the tests with:

```sh
npm test
```

They run against the real Worker and Durable Object in the local Workers runtime and don't need a Cloudflare account. They bind a local files bucket themselves, and serve the pages link cards are made of from `test/fixtures/preview-pages.cjs` on `127.0.0.1`. `npm run dev` has no files bucket unless you uncomment `r2_buckets` in `wrangler.jsonc`, which then uses a local one in `.wrangler/`. To check that the server bundles without deploying it:

```sh
npx wrangler deploy --dry-run --outdir /tmp/rukoo-account-dry
```

## Updating

Pull the new version, then:

```sh
npm install
npm test
npm run deploy
```

Keep the `migrations` entries in `wrangler.jsonc` as they are. Cloudflare applies them in order and remembers which ones it has applied, so don't edit or remove them.
