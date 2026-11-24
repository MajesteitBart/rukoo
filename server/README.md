# Rukoo account server

This folder holds the server for Rukoo accounts. A Rukoo account keeps a few of Rukoo's own things in step between a person's devices: their inbox categories, the category each email got, and their corrections. You can run your own copy on your own Cloudflare account by following this page.

## What it is and isn't

The server is a sync relay for small encrypted records. Each device encrypts a record before sending it, with a key the server never gets. The server stores the encrypted bytes and hands them to the person's other devices.

It is not a mail server. No one's mail, mail passwords or Google tokens pass through it. The mail it can send is its own, once you give it a Resend key: a code to an address that asks for one ([Codes by email](#codes-by-email)), and an alert to you when sign-ups need a look, if you ask for it. It never sees what a record holds. What it can see is listed in [PROTOCOL.md](PROTOCOL.md#what-the-server-can-see): the email address of each account, device names, record counts and sizes, and IP addresses.

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
| `SIGNUPS` | `"verified"` lets anyone make an account who proves their address with a code the server mails there, or who brings an invite code ([Codes by email](#codes-by-email)). A workspace invitation needs the emailed code too. `GET /v1/info` reports it as `"invite"`, so older apps keep their invite code field. `"invite"` needs a code from `INVITE_CODES` (step 7). `"open"` lets anyone make an account, unchecked. `"closed"` takes no new accounts. Existing accounts keep working in every mode. `"verified"` without mail works as `"invite"`, but takes no workspace invitations. |
| `MAIL_FROM` | The sender of the codes the server mails, such as `"Rukoo <account@example.com>"`, on a domain your Resend account has verified. Empty sends no mail ([Codes by email](#codes-by-email)). |
| `EMAIL_CODES_PER_HOUR` | The most emails sign-up code requests make the whole server send in an hour: the codes, and the notes to addresses that already have an account. `100` by default. |
| `SIGNUP_EMAILS_PER_DAY` | The same in a day (UTC): `300` by default, `0` for no limit. It keeps strangers from using up your Resend quota, which the unlock emails need too ([Sizing the mail limits](#sizing-the-mail-limits)). |
| `UNLOCK_EMAILS_PER_DAY` | The most unlock emails the whole server sends in a day to addresses that still have a long code to use: `1000` by default, `0` for no limit. An address without one gets its email regardless, twice a day at most ([Codes by email](#codes-by-email)). |
| `DOMAIN_SIGNUPS_PER_DAY` | The most accounts the addresses at one domain make with an emailed code in a day: `20` by default, `0` for no limit, and 5 at least. Large mail providers such as gmail.com aren't counted ([Limits on verified sign-ups](#limits-on-verified-sign-ups)). |
| `SIGNUP_DOMAINS_EXEMPT` | More domains that `DOMAIN_SIGNUPS_PER_DAY` doesn't count, comma-separated, such as a mail provider the built-in list misses. Empty by default. |
| `EXPIRE_UNUSED_DAYS` | Unset by default. Set to a number of days, 2 or more, it deletes an account that many days after it was made when nothing ever used it ([Accounts that are never used](#accounts-that-are-never-used)). |
| `OPERATOR_EMAIL` | An address that gets one email a day at most when sign-ups need a look: when the sign-ups with an emailed code in an hour reach `ALERT_SIGNUPS_PER_HOUR`, or the accounts reach 80% of `MAX_ACCOUNTS`. Empty by default, which sends nothing. It needs mail, as the codes do. |
| `ALERT_SIGNUPS_PER_HOUR` | See `OPERATOR_EMAIL`: `20` by default, `0` to mail only about the number of accounts. |
| `MAX_RECORDS` | The most records one account may keep. |
| `MAX_BYTES` | The most bytes of records one account may keep. |
| `MAX_ACCOUNTS` | The most accounts the server holds (`0` for no cap). Past it, sign-ups get "This server has no room for new accounts". With open sign-ups this is what bounds the storage strangers can take: at most `MAX_ACCOUNTS` × `MAX_BYTES`. The flip side: someone who signs up with invented addresses can use up the cap, and then nobody else gets in. With `"verified"` each account needs an address whose mail someone reads, and the limits in [Limits on verified sign-ups](#limits-on-verified-sign-ups) slow one person down further. For a server on the internet choose `"verified"` or `"invite"`, not `"open"`. |

The defaults (250,000 records and 100 MiB per account) are far more than one person uses.

The booking page settings are in the same block; see [Booking pages](#booking-pages).

The `ratelimits` block limits sign-up, sign-in, recovery and code requests to 30 a minute per IP address (`RATE_LIMITER`), writing records to 120 pushes a minute (`PUSH_LIMITER`), and every public write on booking pages (bookings, cancellations, moves, form posts) to 20 a minute (`BOOKING_LIMITER`). Their `namespace_id`s can be any numbers that no other rate limiter in your Cloudflare account uses. To turn a limit off, delete its entry. The locks after ten wrong passwords, on the sign-ins with an address and on a signed-in device's password checks, apply either way.

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

Invite codes work with `"verified"` sign-ups too, for people you let in without a code by email. They are the only way in there without one: a workspace invitation needs the emailed code as well.

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

## Codes by email

The server can mail codes to an address, through [Resend](https://resend.com): six digits for the device that asked, and a long code that works on any device for a day. It does so for two things:

- With `SIGNUPS` on `"verified"`, a new account needs a code sent to its address, unless it comes with one of your invite codes. A workspace invitation needs the code too, since anyone with an account can make invitations. This is what lets a server on the internet take sign-ups from anyone: each account proves that someone receives mail at its address, so nobody can take an address whose mail they don't read.
- On every server that sends mail, the owner of a locked account gets past the lock with a code. Ten wrong passwords lock the sign-ins with an address for 15 minutes, and anyone who knows the address can do that. Without the mailbox they can't get past it, and they can't keep the owner from it either: every email holds a long code the owner can use, also an email the stranger asked for. Devices that are signed in skip the lock anyway: their password changes, new recovery keys and deletions count per session.

To turn it on, verify a sending domain in Resend, set `MAIL_FROM` to an address on it, and store the API key:

```sh
npx wrangler secret put RESEND_API_KEY
```

The key needs sending access to that domain only. Until both are set, the server sends no mail, `GET /v1/info` lists no `email-codes`, and `"verified"` works as `"invite"`: it takes your invite codes, but no workspace invitations.

What a code request does, and what it never reveals, is in [PROTOCOL.md](PROTOCOL.md#post-v1email-code). In short: one address gets at most one code of each purpose a minute, five an hour and ten a day (for sign-up codes, one mailbox, as below), and the server sends at most `EMAIL_CODES_PER_HOUR` sign-up emails in an hour and `SIGNUP_EMAILS_PER_DAY` in a day, counting only emails that go out. The answer is the same whether or not the address has an account. The registry keeps only hashes, made with the pepper, and an alarm deletes them a day after each request, or after 10 minutes when no email with the codes went out. Resend sees each address and the mail it sends, and keeps it for 30 days on its standard plans; `/privacy` says so while mail is on, in English and Dutch.

Sign-up codes count per mailbox: the name before a `+tag` on any domain, and at Gmail also without dots, so `name+1@gmail.com`, `n.ame@gmail.com` and `name@gmail.com` share one address's ten emails a day. A code still works only for the address it went to, and the account is that address. Requests for unlock codes count per address as typed, so requests for other spellings, which have no account, can't use up a locked owner's. One side effect: a stranger can use up a mailbox's ten sign-up emails of the day with other spellings of it, and the owner then waits a day to sign up as `name@gmail.com`, or signs up with one of the spellings whose codes reached them.

Unlock emails go only to addresses with an account, and count where they go out:

- An unlock email goes regardless of the limits below to an address that has no long code left to use: none whose email Resend took, that is unused, has tries left and works for at least another hour (as long as the limit per hour can make its owner wait). Only the owner can use up a long code, so a stranger gets an address one such email until the owner used its code or it is about to run out. One address gets two of these a day at most, so someone who reads the mailbox can't use up codes and ask again forever.
- The others count toward ten a day per mailbox, counted when they are sent, so the accounts at the tags of one mailbox share them, and deleting an account and making it again doesn't give it ten more. Requests for spellings without an account send nothing, so they count toward nothing. They also count toward `UNLOCK_EMAILS_PER_DAY` (1,000 by default) for the whole server. Past either, a request is still answered `202`, and no email goes.

That is what keeps a stranger from turning the lock into a lockout. They can lock an address and spend the limits, but the owner holds a long code that gets them in on any device, or gets an email with one at their next request, as long as the address has requests left that day. A signed-in device needs no code at all. What the limits bound is the rest: the unlock emails of a day are at most two per address with an account, ten more per mailbox, and `UNLOCK_EMAILS_PER_DAY` over the whole server, whichever of the last two is lower.

What a stranger can still do:

- Ask for an address's ten unlock codes of the day. Every email that goes out carries a long code for the owner, but the owner can't ask for more until those requests are a day old.
- Do that once the day's unlock budget is spent. The stranger's own requests then send the owner a code only when the owner has none left to use, so the owner gets in with one long code and waits for the next until one of the stranger's requests is a day old. That can mean one new device signed in with a code in 24 hours. Devices that are already signed in aren't affected.
- Use up an hour's or a day's sign-up emails, which delays sign-ups until the next hour or day.

The server doesn't give the owner request slots back when a code is used: only addresses with an account get codes, so slots that came back would tell the stranger the address has an account. The mail can also use up Resend's own quota, which counts per Resend account: separate keys or domains in one account share it. Give the server a Resend account of its own, with its own key and sending domain, so its codes and another site's mail can't use up each other's quota, and size the limits to it.

### Sizing the mail limits

Once Resend's quota for the day or the month is gone, Resend refuses every email, unlock emails included, and even the unlock emails that go past the limits can no longer get an owner past a lock. Anyone can make the server send sign-up emails, so keep these within your plan:

- `SIGNUP_EMAILS_PER_DAY` plus `UNLOCK_EMAILS_PER_DAY`, times 31, well under the monthly quota. The rest is for the unlock emails that go regardless of the budget, two a day at most per account under attack, and for the operator's two emails a day.
- On a plan with a daily limit, the same two settings well under that limit, and `EMAIL_CODES_PER_HOUR` no more than about a tenth of `SIGNUP_EMAILS_PER_DAY`, so one hour can't take the whole day.

For example, Resend's Pro plan was 50,000 emails a month with no daily limit in November 2026. The defaults, 300 sign-up emails and 1,000 unlock emails a day, come to at most 40,300 a month, which leaves 9,700. The free plan was 3,000 a month and 100 a day: there, set `SIGNUP_EMAILS_PER_DAY` to `30`, `UNLOCK_EMAILS_PER_DAY` to `30` and `EMAIL_CODES_PER_HOUR` to `3`. Check the numbers of your own plan at resend.com/pricing.

### Limits on verified sign-ups

A code proves only that someone reads an address's mail. A catch-all domain delivers any name to one inbox, so one person with such a domain can ask codes for as many names as they like and make an account with each. At the default 100 sign-up emails an hour, that fills a `MAX_ACCOUNTS` of 1,000 in about ten hours, after which every sign-up gets "This server has no room for new accounts". Accounts are named by a hash, so you can't list them to find the ones to remove. Three settings deal with this:

- **`DOMAIN_SIGNUPS_PER_DAY`** (20 by default, `0` for no limit, and 5 at least): the most accounts the addresses at one domain make with an emailed code in a day (UTC). The domain is the registrable one, after the same reading of the address as the limits per mailbox, in its ASCII form, so `a@mail.example.com` and `b@example.com` count together, and so does every subdomain a wildcard mail record would give. Without the whole public suffix list that is an estimate: the last two labels, or three under a public suffix of two labels the server knows, such as `co.uk` or `com.au` (`PUBLIC_SECOND_LEVEL` in `src/signups.js`), or under a country domain whose second label is one registries keep for registrations, such as `co.ae`, `com.cy` or `gouv.fr` (`GENERIC_SECOND_LEVEL`). Another suffix it doesn't know, such as `pvt.k12.ma.us`, puts everyone under it in one count. Only accounts that were made count, under a hash of the domain, so asking for codes uses up nobody's domain: only someone who reads the mail there can. Past the limit, a sign-up with a code and an address at the domain gets `429 rate_limited` with `limit: "domain"` and `Retry-After` until midnight UTC. A code request there gets the same `202` as any other, but no email goes: a different answer would tell anyone that someone at the domain made an account today, which for a domain of one person says who. The minimum of 5 is there for the same reason. Addresses whose domain isn't a host name, or that hold invisible characters such as a zero-width joiner, get `400` for a sign-up and its code, so they can't each count apart from the domain they look like.
- **Exempt domains.** Large mail providers, where each address is a mailbox its owner signed up for, aren't counted, or anyone with two mailboxes there could use up the provider's day for everyone else. The built-in list, `PUBLIC_PROVIDERS` in `src/signups.js`, has the big international providers with their country domains (Gmail, Outlook.com and Hotmail, Yahoo, iCloud, Proton, GMX, Yandex, Mail.ru, QQ and others) and the large ISPs and national providers of Europe and elsewhere. Services that hand out many aliases to one person, such as duck.com or fastmail.com, aren't on it. iCloud+ can hand out extra icloud.com addresses too (Hide My Email); those still meet the limits per mailbox and `EMAIL_CODES_PER_HOUR`, not this one. Add others with **`SIGNUP_DOMAINS_EXEMPT`**, comma-separated; each counts as its registrable domain, so `mail.example.org` exempts `example.org` and its subdomains. Sign-ups with your invite codes don't count either.
- **Domains that reach the limit** are named in the Worker's log, once a day each, with a hint to add them to `SIGNUP_DOMAINS_EXEMPT` when they are a mail provider. With `OPERATOR_EMAIL` set, the first of the day is also mailed there.
- **`EXPIRE_UNUSED_DAYS`** (unset by default): deletes accounts nobody ever used, as the next section describes.
- **`OPERATOR_EMAIL`** and **`ALERT_SIGNUPS_PER_HOUR`** (empty and 20): the server mails `OPERATOR_EMAIL` when the sign-ups with an emailed code in one clock hour reach `ALERT_SIGNUPS_PER_HOUR`, or when the accounts reach 80% of `MAX_ACCOUNTS`, and when a domain reaches `DOMAIN_SIGNUPS_PER_DAY`. It sends at most one email a day about the counts and one naming a domain, through Resend like the codes; besides that domain they hold counts and nothing about anyone. Without `OPERATOR_EMAIL`, or without mail, it sends nothing.

With 20 a day per domain, one person with a catch-all domain needs 50 days, or 50 domains, to fill a cap of 1,000, and the operator hears of it within the hour it starts. Accounts they never use go again once `EXPIRE_UNUSED_DAYS` is set.

### Accounts that are never used

With `EXPIRE_UNUSED_DAYS` set, every account made from then on is checked that many days after it was made, and deleted when nothing ever used it:

- it never stored a record, also one it deleted again;
- it never made, joined or tried to join a workspace, also one that was deleted since;
- it never had a booking page;
- no device signed in to it, or connected with its session, after the day it was made.

The setting counts as 2 when it is 1, so the check always comes a day after the sign-up day and never meets a request from that day halfway. Rukoo syncs every few minutes while it runs, so an account whose app ran on any day after its first is used. Each account sets its own alarm at sign-up, so there is still no list of accounts anywhere. A deleted account gives its place under `MAX_ACCOUNTS` back before its data goes, once even when the alarm has to try again, and its address is free for a new account. The check reads the setting as it is when it runs: remove the setting and accounts that are waiting are kept; raise it and they wait for the new number of days. Accounts made while it was unset are never checked. `wrangler.jsonc` leaves it unset in every environment, so deploying this version deletes nothing. While it is set, `/privacy` says so in English and Dutch.

The tests answer Resend themselves (`test/fixtures/fake-resend.js`) and never send mail. A `RESEND_API_KEY` in `.dev.vars` does send real mail from `npm run dev`.

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
| `BOOKING_FORMER_ROOTS` | Addresses whose root held your booking pages before `BOOKING_ORIGIN`, as origins separated by commas. Reads of the pages' addresses there redirect to the same path on `BOOKING_ORIGIN`, and other reads get a 404 page that points there; posts, MCP calls, reads with a manage key, guests' manage pages and the pages' script, icons and fonts are still answered there, so a page or client from before the move keeps working, and MCP takes links to those addresses as the same pages. It does nothing without `BOOKING_ORIGIN`. Empty by default. |
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

Team chat lets the people with an account on your server make workspaces, invite others into them and talk in channels. It is being built in steps: the server side of text channels and direct messages is here. The desktop app and Rukoo for Android have Chat, which shows when the server has team chat on. [WORKSPACES.md](WORKSPACES.md#gate-1-routes) lists what the server answers, and [the architecture](../docs/workspace-architecture.md) what is planned.

**You can read it.** A workspace's messages and files are stored as they were written. Whoever runs the server, and Cloudflare under it, can read and change them, and so can the S3-compatible service when files are stored there. The records accounts sync stay encrypted as before. The statement at `/privacy` covers team chat while it is on, with the retention you set; if you use your own with `PRIVACY_URL`, say so there before you turn it on.

What `wrangler.jsonc` already sets up:

- **`WORKSPACES`**, a Durable Object binding with one object per workspace, holding its members, channels and messages in its own SQLite database. The `v4` migration (`new_sqlite_classes: ["Workspace"]`) creates the class.
- **`WORKSPACE_FILES`**, commented out: the R2 bucket for files in messages. An S3-compatible bucket can take its place. See "Files need a bucket" below.

The settings in `vars`:

| Setting | What it does |
|---|---|
| `WORKSPACE_MODE` | `on` or `off`. Off by default: the routes answer 404 and `GET /v1/info` doesn't mention workspaces. |
| `WORKSPACE_ORIGIN` | The one address workspaces on this server are known by, such as `https://accounts.example.org`. Empty means the address each request came in on. Set it when your server answers on more than one address. |
| `WORKSPACE_SIGNUPS` | `on` or `off`. With `SIGNUPS` on `invite`, `on` lets an open workspace invitation stand in for an invite code when someone signs up, once per invitation. That lets every workspace owner and admin bring new accounts onto your server, within `MAX_ACCOUNTS`. With `SIGNUPS` on `verified`, the person still confirms their address with an emailed code, and a server that can't send mail takes no invitations at sign-up. `off` takes no workspace invitations at sign-up: an `invite` server then takes only your own codes, and a `verified` server your codes and emailed codes. On by default. |
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
| `WORKSPACE_AGENTS` | How many agents one workspace may have, or `0` or `off` to turn agents off. Default 20. An agent is an account a member makes in a workspace, with a key that a runtime such as the reference runner in `integrations/agent-runner/` connects with, to answer mentions in the channels it was added to ([WORKSPACES.md](WORKSPACES.md#agents-in-channels)). |
| `WORKSPACE_AGENT_DEPTH` | How long a chain of agents answering agents may get, a person's message being 0. Default 3. Agents answer other agents only when their own settings say so. |
| `WORKSPACE_AGENT_REPLIES` | Replies one agent may post in an hour. Default 120. |
| `WORKSPACE_PREVIEWS` | `on` or `off`. With `on`, the server fetches up to three web addresses in a message and adds a link card with the page's title, description and image. Your server fetches the page, so the site sees your server's address and never a member's. It refuses local and private addresses and your server's own. On by default. |
| `WORKSPACE_FILES_ORIGIN` | A separate address for upload and download links, such as `https://files.example.org`, routed to this Worker as a custom domain or route. Empty means links use the workspace's own address. |
| `WORKSPACE_PREVIEW_HOSTS` | For tests only: `host:port` pairs that link cards may fetch although they are local. Leave it empty. |
| `WORKSPACE_FILES_S3_ENDPOINT`, `WORKSPACE_FILES_S3_REGION`, `WORKSPACE_FILES_S3_BUCKET` | An S3-compatible bucket for files instead of R2, with two secrets. Empty by default. See "Files in an S3-compatible bucket" below. |
| `WORKSPACE_FILES_S3_PROVIDER`, `WORKSPACE_FILES_S3_PLACE` | Who keeps the files of an S3 store and where, as the statement at `/privacy` names them. Empty by default. See "Files in an S3-compatible bucket" below. |

**Files need a bucket.** People send files and images in chat only when the Worker has a private bucket for them: an R2 bucket bound as `WORKSPACE_FILES`, or a bucket in an S3-compatible service named by the five `WORKSPACE_FILES_S3_*` settings (see "Files in an S3-compatible bucket" below). `wrangler.jsonc` has the R2 binding commented out and the S3 settings empty, so a deploy without a bucket keeps working: the server then lists no `files` capability, every file route answers `403 files_off`, and the apps hide Attach, drag and drop and pasting files. Reactions, marking unread and link cards work without a bucket, but link cards then come without their image. To turn files on with R2, make the bucket in the jurisdiction of your accounts and remove the comment marks around `r2_buckets`, with the same `jurisdiction`:

```bash
npx wrangler r2 bucket create rukoo-workspace-files --jurisdiction eu
```

Leave the bucket private, without a public bucket address. Devices upload through this Worker, which streams each file into the bucket with the exact size and SHA-256 the device declared, and download with a link the Worker signs, valid for 60 seconds. Files of a removed message and of messages retention removes are deleted from the bucket by the workspace's alarm, usually within a minute. Deleting a workspace deletes its files first, while the workspace stays as it is; when the bucket fails, a file is still being uploaded or failed to upload in the last five minutes, or the server has lost its file store while the workspace still has files in the bucket, the workspace stays and its owner can try again. R2 bills storage and operations separately from Workers ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)).

**Files in an S3-compatible bucket.** Instead of R2, the files can live in a bucket of any service that speaks the S3 API, such as UpCloud Managed Object Storage, MinIO or AWS S3. The Worker signs each request with AWS Signature Version 4 and uses path-style addresses (`<endpoint>/<bucket>/<key>`). Devices still upload and download only through this Worker, with the same signed links, so the bucket stays private and needs no CORS rules or public address. It takes five settings:

| Setting | Kind | What it is |
|---|---|---|
| `WORKSPACE_FILES_S3_ENDPOINT` | var | The service's `https://` address, without the bucket, such as `https://<name>.upcloudobjects.com`. |
| `WORKSPACE_FILES_S3_REGION` | var | The region the service signs with, such as `europe-2`. |
| `WORKSPACE_FILES_S3_BUCKET` | var | The bucket's name. |
| `WORKSPACE_FILES_S3_ACCESS_KEY_ID` | secret | The access key's ID. |
| `WORKSPACE_FILES_S3_SECRET_ACCESS_KEY` | secret | The access key's secret. |

Two more vars say who keeps the files and where. The statement at `/privacy` names them in its section on where data is kept and in its paragraph on files, which says that this company keeps the files on your behalf under its data processing terms and can read them, and that they pass through Cloudflare on their way. Neither turns files on or off. If you run the S3 service yourself, leave both empty: the statement then names no company and no data processing terms.

| Setting | Kind | What it is |
|---|---|---|
| `WORKSPACE_FILES_S3_PROVIDER` | var | The company or service that keeps the files, such as `UpCloud`. |
| `WORKSPACE_FILES_S3_PLACE` | var | Where it keeps them, such as `Frankfurt am Main`. |

With both set, the statement says the files are kept "in private storage at UpCloud in Frankfurt am Main" and that UpCloud keeps them under its data processing terms. With either one empty, it names neither, says "the S3-compatible service this server uses" instead and leaves out the data processing terms. With R2, the statement names Cloudflare R2 and ignores both.

Use a bucket that has never had versioning turned on. On a versioned bucket a delete without a version ID, which is the only kind the Worker sends, adds a delete marker and keeps the object as an older version. The files of removed messages and deleted workspaces would then stay in the bucket, and the statement at `/privacy` would be wrong where it says they are deleted from storage. To check, ask the bucket for its versioning state, with `aws s3api get-bucket-versioning --bucket <bucket> --endpoint-url <endpoint>` (the S3 call GetBucketVersioning) or in the provider's console: a bucket that never had versioning answers without a `Status`. `Enabled` or `Suspended` means it has or had versioning, and then the old versions of every object it held stay until you delete them; use a new bucket instead.

Give the key access to this one bucket and nothing else: `s3:ListBucket` on the bucket, and `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on its objects. Services that take IAM-style policies, UpCloud's among them, express that as:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": ["arn:aws:s3:::rukoo-workspace-files"] },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": ["arn:aws:s3:::rukoo-workspace-files/*"] }
  ]
}
```

With UpCloud, for example:

1. In the UpCloud control panel, create a Managed Object Storage instance in the region you want, such as `europe-2` (Frankfurt), and a bucket in it, here `rukoo-workspace-files`. Leave public access and versioning off.
2. Create a user for the server, attach a policy like the one above, and create an access key for that user.
3. Put the instance's public S3 address, the region and the bucket name in the three vars in `wrangler.jsonc` (in `vars`, or in your environment's `vars`), and leave `r2_buckets` commented out. For `/privacy`, set `WORKSPACE_FILES_S3_PROVIDER` to `UpCloud` and `WORKSPACE_FILES_S3_PLACE` to the city of the region's data centre, such as `Frankfurt am Main` for `europe-2`.
4. Set the key as two secrets, so it never appears in `wrangler.jsonc`:

   ```bash
   npx wrangler secret put WORKSPACE_FILES_S3_ACCESS_KEY_ID
   npx wrangler secret put WORKSPACE_FILES_S3_SECRET_ACCESS_KEY
   ```

5. Deploy. Once `WORKSPACE_MODE` is on, check that `GET /v1/info` lists the `files` capability; while it is off, `/v1/info` says nothing about workspaces, so check the bucket and key with the script below.

To check a bucket and key before you deploy, run `node scripts/s3-live-check.mjs` with the five settings in your environment. It starts a local Worker on `127.0.0.1` with wrangler, writes a few small objects under `live-check/<random>/`, checks an upload with the right SHA-256 and one with a wrong one, a download, a listing over several pages and the deletes, removes what it wrote and prints pass or fail per step.

When `WORKSPACE_FILES` is bound as well, R2 wins and the S3 settings are ignored. With only some of the five settings, files stay off and, once team chat is on, the Worker logs one error per instance that names the missing settings, never their values. An S3 store checks an upload's SHA-256 twice: the service checks the `x-amz-content-sha256` it was sent, and the Worker hashes the bytes as they pass and deletes an object that doesn't match. S3 deletes one object per request, so the trash goes 40 keys at a time, eight requests at once, which keeps each alarm within the 50 subrequests a Worker on the Free plan may make, and deleting a workspace lists and deletes its files 40 at a time. Deleting a workspace makes one request per file plus one per page of 40, all in the owner's one request, so a workspace with more files than the Workers limit on subrequests allows runs into it: it then answers 503, the files deleted so far stay deleted, and the next try goes on from there. On the Free plan that limit is 50, so each try deletes a little under 50 files, and a workspace with 500 files takes about a dozen tries.

**Agents pass on what they read.** An agent added to a channel reads what is posted there and passes it on to whatever runs it, which its sponsor chose and which your server can't see or control. Your server only checks, for every reply, that the agent may answer who mentioned it.

Anyone with an account on your server can make a workspace, within those limits, so invite codes for sign-up are also what decides who can. A workspace's owners and admins invite the others, who need an account on your server too. A new member also gets the workspace's first open channel, normally `general`. An owner who is the only one left in a workspace can delete it.

**Invitation links.** An invitation link is `https://<your address>/join#w=…&i=…`. Opened in a browser, `/join` is a page in English or Dutch that says how to use the link in Rukoo: choose Join with an invitation link in Chat or on the app's first screen and paste it. Someone without an account makes one in that flow. The part after `#` holds the invitation and never reaches your server. The page names the operator from `OPERATOR_NAME`, runs no script and sends no referrer, and answers 404 while `WORKSPACE_MODE` is `off`. With `WORKSPACE_SIGNUPS` on, such a link makes one account on your server even when sign-ups need an invite code ([PROTOCOL.md](PROTOCOL.md#post-v1signup)).

**Turn it on in two deploys.** Deploy this version with `WORKSPACE_MODE` still `off` and wait until every address of your server runs it. Then set it to `on` and deploy again. The order matters when you roll back as well: a version from before team chat deletes an account without telling the workspaces it was in, and its messages there would then keep its name. Once a workspace exists, don't go back to such a version.

**Don't roll a workspace back.** Cloudflare can restore a Durable Object's database to any point in the last 30 days. For a workspace that would bring back every member who was removed and every message that was deleted since. A device that was up to date notices, and stops with "this workspace is behind what this device has seen"; a device that wasn't doesn't. If a workspace's data is lost or damaged, have its owner start a new one.

Cloudflare keeps that 30-day history whether you use it or not, so a message someone removed can be restored by you for 30 days. `GET /v1/info` tells the apps so, as `platformHistoryDays`.

## The server Rukoo uses

The `bvdm` environment in `wrangler.jsonc` is the server the Rukoo app uses by default, at `https://rukoo.io`, run by Rukoo's maintainer. It takes new accounts by invite code until the apps ask for the emailed code at sign-up; then `SIGNUPS` there becomes `"verified"`. Its codes go out from `account@bvdm.ai` once the `RESEND_API_KEY` secret is set. A fork ignores it: `npm run deploy` without `--env` deploys the settings at the top of the file.

A change that reaches `main` deploys it. `.github/workflows/server.yml` runs when a merge touches `server/src/`, `server/package.json`, `server/package-lock.json` or `server/wrangler.jsonc`: it runs the tests again, deploys with `wrangler deploy --env bvdm`, and then checks that `GET /v1/info` answers on rukoo.io, meet.rukoo.io and rukoo-account.bvdm.ai. A failing test stops the deploy, and so does newer server code on `main`, as when an older run is rerun. The job reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the GitHub environment `rukoo.io`, the one the website's deploy uses, which only `main` may use. Run the workflow by hand on `main` to deploy again without a change. A deploy keeps the Worker's secrets, and it applies new `migrations` entries, which can't be taken back, so a merge that adds one is a migration of the live server. `npm run deploy -- --env bvdm` deploys by hand, after `wrangler login` or with those two variables set.

The switch to `"verified"` changes more than `SIGNUPS`. In the same deploy:

1. Give rukoo.io a Resend account of its own, with its own sending domain, such as `account@rukoo.io`, and update `MAIL_FROM` and the `RESEND_API_KEY` secret to it. The Resend account behind bvdm.ai also sends the site's early access mail, and Resend counts its quota per account, so a new key or domain in that same account would still share it.
2. Set `EXPIRE_UNUSED_DAYS`, for example to `30`, so accounts nobody uses go again ([Accounts that are never used](#accounts-that-are-never-used)). `/privacy` then says so.
3. Set `OPERATOR_EMAIL` to an address the maintainer reads, for the alert in [Limits on verified sign-ups](#limits-on-verified-sign-ups).
4. Check `EMAIL_CODES_PER_HOUR`, `SIGNUP_EMAILS_PER_DAY` and `UNLOCK_EMAILS_PER_DAY` against the new Resend account's plan ([Sizing the mail limits](#sizing-the-mail-limits)). The defaults fit Resend's Pro plan, not its free one.

### How rukoo.io is set up

rukoo.io serves Rukoo's website and this server's account API; the booking pages are on meet.rukoo.io. Two Workers do it:

1. `rukoo-site`, from [`website/`](../website/README.md) in this repository, has the custom domains `rukoo.io` and `www.rukoo.io` (www redirects to the apex). It serves the website's static files first. A request that matches no file, and every request under `/v1`, goes on, unchanged, through a service binding named `ACCOUNT` to the `rukoo-account` Worker: the same method, URL and headers, so this server sees `https://rukoo.io/...` addresses, the client's `cf-connecting-ip` for its rate limits, and the `Origin` and `Sec-Fetch-Site` headers its write checks read.
2. `rukoo-account`, this folder, deployed with `--env bvdm`. It has the custom domain `meet.rukoo.io`, which is its `BOOKING_ORIGIN`, so booking pages are `https://meet.rukoo.io/<handle>` and MCP is `https://meet.rukoo.io/mcp`. The account API is `https://rukoo.io/v1/...`, through the site Worker. A booking's calendar UID ends in `@meet.rukoo.io`, or `@rukoo.io` for one made before the move.

The pages lived at the root of rukoo.io at first. `BOOKING_FORMER_ROOTS` is `https://rukoo.io`, so a page link there that reaches this server redirects to the same path on meet.rukoo.io, and MCP takes rukoo.io links as the same pages. A path on rukoo.io that names no booking page, such as a mistyped one, gets a 404 page in the website's style from this server instead of the booking pages' 404. Posts, MCP calls, reads with a manage key and guests' manage pages are still answered on rukoo.io, for pages and clients from before the move.

`/join` reaches this server the same way, because the website has no such file.

The website's paths (`/`, `/index.html`, `/404.html`, `/app.js`, `/styles.css`, `/assets/*`, `/img/*`, `/media/*`, and its redirects `/download/*`, `/releases` and `/github`) always win on rukoo.io, because the site Worker answers them before anything reaches this server. The server keeps those names and likely future ones reserved as handles, from when the pages shared rukoo.io with the website. `/` on rukoo.io is the website; on meet.rukoo.io it is this server's own page.

The Worker keeps its old custom domain `rukoo-account.bvdm.ai`. Devices that still sync with that address keep working, since the account API answers on every address, and its `/meet/...` links redirect to the same page on meet.rukoo.io. `BOOKING_ALIASES` is `https://rukoo-account.bvdm.ai`, so MCP takes those old links too.

All three addresses reach the same Worker and the same storage, so they hold the same accounts and booking pages. Signing in still needs the address an account was made at, because the password proof includes it ([PROTOCOL.md](PROTOCOL.md#keys)). A device signed in at the old address keeps using it until it signs out or deletes the account.

## What lands in Cloudflare's logs

The server never logs request bodies, tokens, keys or email addresses. When a request fails in a way it didn't expect, it logs the error. With verified sign-ups it also logs the domain of the addresses that reach `DOMAIN_SIGNUPS_PER_DAY`, once a day per domain ([Limits on verified sign-ups](#limits-on-verified-sign-ups)); for a domain of one person, that is close to their address.

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

They run against the real Worker and Durable Object in the local Workers runtime and don't need a Cloudflare account. They bind a local files bucket themselves, and serve the pages link cards are made of from `test/fixtures/preview-pages.cjs` on `127.0.0.1`. A second project runs `test/s3-*.test.js` without the bucket and with an S3-compatible store instead, answered inside the runtime by the stand-in in `test/fixtures/fake-s3.js`, which checks every request's signature and every upload's digest. `npm run dev` has no files bucket unless you uncomment `r2_buckets` in `wrangler.jsonc`, which then uses a local one in `.wrangler/`. To check that the server bundles without deploying it:

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
