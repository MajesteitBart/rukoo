# Rukoo account server

This folder holds the server for Rukoo accounts. A Rukoo account keeps a few of Rukoo's own things in step between a person's devices: their inbox categories, the category each email got, and their corrections. You can run your own copy on your own Cloudflare account by following this page.

## What it is and isn't

The server is a sync relay for small encrypted records. Each device encrypts a record before sending it, with a key the server never gets. The server stores the encrypted bytes and hands them to the person's other devices.

It is not a mail server. No mail, no mail passwords and no Google tokens pass through it. It never sees what a record holds. What it can see is listed in [PROTOCOL.md](PROTOCOL.md#what-the-server-can-see): the email address of each account, device names, record counts and sizes, and IP addresses.

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
| `SIGNUPS` | `"open"` lets anyone make an account. `"invite"` needs a code from `INVITE_CODES` (step 7). `"closed"` takes no new accounts. Existing accounts keep working in every mode. |
| `MAX_RECORDS` | The most records one account may keep. |
| `MAX_BYTES` | The most bytes of records one account may keep. |
| `MAX_ACCOUNTS` | The most accounts the server holds (`0` for no cap). Past it, sign-ups get "This server has no room for new accounts". With open sign-ups this is what bounds the storage strangers can take: at most `MAX_ACCOUNTS` × `MAX_BYTES`. The flip side: someone who signs up with invented addresses can use up the cap, and then nobody else gets in. The server doesn't check addresses yet, so invite codes are the safer choice for a server on the internet. |

The defaults (250,000 records and 100 MiB per account) are far more than one person uses.

The `ratelimits` block limits sign-up, sign-in and recovery calls to 30 a minute per IP address (`RATE_LIMITER`), and writing records to 120 pushes a minute (`PUSH_LIMITER`). Their `namespace_id`s can be any numbers that no other rate limiter in your Cloudflare account uses. To turn a limit off, delete its entry. The account lock after ten wrong passwords applies either way.

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

## The server Rukoo uses

The `bvdm` environment in `wrangler.jsonc` is the server the Rukoo app uses by default, at `https://rukoo-account.bvdm.ai`, run by Rukoo's maintainer. It takes new accounts by invite code. It is deployed with `npm run deploy -- --env bvdm`. A fork ignores it: `npm run deploy` without `--env` deploys the settings at the top of the file.

## What lands in Cloudflare's logs

The server never logs request bodies, tokens, keys or email addresses. When a request fails in a way it didn't expect, it logs the error.

`wrangler.jsonc` turns on Workers Logs for those error messages and turns off invocation logs. Invocation logs would store a line for every request, with its URL and request details. If you turn them on, keep that in mind for your privacy statement.

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

The server runs at `http://localhost:8787` and keeps its data in `.wrangler/`. Neither `.dev.vars` nor `.wrangler/` is committed.

Run the tests with:

```sh
npm test
```

They run against the real Worker and Durable Object in the local Workers runtime and don't need a Cloudflare account. To check that the server bundles without deploying it:

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
