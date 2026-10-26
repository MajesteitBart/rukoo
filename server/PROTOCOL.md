# Rukoo account protocol, version 1

A Rukoo account syncs small pieces of Rukoo's own data between a person's devices: inbox categories, the category each email got, and corrections. Mail, passwords and Google tokens never go through it. Everything the account stores is encrypted on the device with a key the server never sees.

This document is the contract between the server in this folder, Rukoo for desktop (`src/main/account/`) and Rukoo for Android. A change here needs the same change in all three.

## Encoding

- Binary values in JSON are base64url without padding (RFC 4648 §5).
- Text is UTF-8. Passwords are normalized to Unicode NFC before use.
- An email address is normalized by trimming spaces and lowercasing the whole address.
- Times are milliseconds since the Unix epoch.

## Keys

All key derivation happens on the device.

| Name | How it is made |
|---|---|
| `masterKey` | Argon2id (version 0x13) of the password, with the account's 16-byte `salt` and its `kdf` parameters, 32 bytes out |
| `authKey` | `HKDF(masterKey, "rukoo/v1/auth")` |
| `wrapKey` | `HKDF(masterKey, "rukoo/v1/wrap")` |
| `dataKey` | 32 random bytes, made once at sign-up; it never changes |
| `recordKey` | `HKDF(dataKey, "rukoo/v1/records")` |
| `indexKey` | `HKDF(dataKey, "rukoo/v1/index")` |
| `recoveryKey` | 20 random bytes, made at sign-up and shown to the person once |
| `recoveryAuth` | `HKDF(recoveryKey, "rukoo/v1/recovery-auth")` |
| `recoveryWrap` | `HKDF(recoveryKey, "rukoo/v1/recovery-wrap")` |

`HKDF(ikm, info)` is HKDF-SHA256 (RFC 5869) with an empty salt and 32 bytes of output.

The `kdf` parameters are `{ "alg": "argon2id", "m": 65536, "t": 3, "p": 1 }` for new accounts: 64 MiB of memory (`m` in KiB), 3 passes, 1 lane. A device refuses parameters weaker than `m` 19456 or `t` 2 when signing in, so a server can't talk it into a cheaper hash of the password.

The recovery key is written in Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), 32 characters in eight groups of four: `7K2M-9QXD-…`. When it is read back, letters are uppercased, `O` reads as `0`, `I` and `L` as `1`, and dashes and spaces are ignored.

### Sealing

`seal(key, plaintext, aad)` is AES-256-GCM with a random 12-byte nonce and a 16-byte tag. Its output is one version byte `0x01`, the nonce, the ciphertext and the tag, in that order. `open` refuses any other version byte and any tag that doesn't verify.

- `wrappedKey = seal(wrapKey, dataKey, "rukoo/v1/data-key")`
- `recoveryWrappedKey = seal(recoveryWrap, dataKey, "rukoo/v1/data-key")`

### What the server stores to check a sign-in

The server keeps `SHA-256(authKey)` and `SHA-256(recoveryAuth)`, never the keys themselves. `authKey` is already the output of Argon2id, so a stolen database still costs an attacker one Argon2id run per password guess.

## Records

Everything the account syncs is a record: a value in a collection under a key.

```json
{ "c": "category", "k": "needs-you", "v": { "name": "Needs you" }, "t": 1793000000000 }
```

- `c` is the collection, `k` the record's key in it, `v` any JSON value and `t` when the device changed it.
- The record's id is `base64url(HMAC-SHA256(indexKey, c + "\n" + k))`, 43 characters. The server can match a record to its id, but not learn the collection or the key.
- The record's `data` is `seal(recordKey, JSON of the record, "rukoo/v1/record:" + id)`. Binding the id into the tag stops the server from swapping the contents of two records.
- A deleted record is a tombstone: the id with `data` null.

A device that opens a record checks that its `c` and `k` give the id it arrived under, and drops it otherwise.

### Collections

| Collection | Key | Value | Writes |
|---|---|---|---|
| `category` | the category's id | `{ name, description, color, order, kind, fallback }` | last write wins |
| `classification` | account email + `"\n"` + the email's Message-ID, or `"h:"` + SHA-256 hex of sender, date and subject when it has none | `{ category, source, confidence, model, at }` | first write wins (`ifAbsent`) |
| `override` | the same key as `classification` | `{ category, at }` | last write wins |
| `sender` | a lowercased sender address | `{ category, at }` | last write wins |

A device ignores collections it doesn't know, so a newer app can add one without breaking older ones.

## HTTP API

The server speaks JSON over HTTPS. Requests that need a session send `Authorization: Bearer <token>`. Errors come back as `{ "error": "<code>", "message": "<text>" }` with the status below.

| Status | `error` |
|---|---|
| 400 | `invalid` (the request's shape or values are wrong) |
| 401 | `unauthorized` (no session, an ended session, or a wrong password or recovery key) |
| 403 | `signups_closed`, `invite_required` |
| 404 | `not_found` |
| 409 | `exists` (sign-up for an address that has an account) |
| 413 | `too_large`, `quota` |
| 429 | `locked` (too many failed sign-ins), `rate_limited` |
| 500 | `not_configured` (the server has no `PEPPER` secret), `server` |

### `GET /v1/info`

Who runs this server and where it keeps data. No session needed. The app shows this before sign-up.

```json
{
  "protocol": 1,
  "version": "1.0.0",
  "operator": { "name": "…", "url": "…", "contact": "…", "privacy": "…" },
  "hosting": { "provider": "Cloudflare", "company": "Cloudflare, Inc.", "country": "US", "jurisdiction": "eu" },
  "signups": "open",
  "limits": { "records": 250000, "bytes": 104857600, "recordBytes": 16384, "batch": 500 }
}
```

`jurisdiction` is `eu`, `us`, `fedramp` or null: where the account's storage lives and runs. `signups` is `open`, `invite` or `closed`.

### `POST /v1/prelogin`

`{ "email" }` → `{ "kdf", "salt" }`. For an address without an account the server returns the default `kdf` and a salt made from its secret and the address, the same each time, so this call doesn't tell anyone whether an account exists.

### `POST /v1/signup`

```json
{
  "email": "…", "invite": "…",
  "kdf": { … }, "salt": "…", "authKey": "…", "wrappedKey": "…",
  "recoveryAuth": "…", "recoveryWrappedKey": "…",
  "device": { "name": "Bart's desktop", "platform": "linux" }
}
```

→ `201 { "token", "account" }`, where `account` is what `GET /v1/account` returns. `invite` is needed only when `signups` is `invite`.

### `POST /v1/login`

`{ "email", "authKey", "device" }` → `{ "token", "wrappedKey", "account" }`. Ten failed attempts on one account within 15 minutes lock it for 15 minutes (`429 locked`).

### `POST /v1/logout`

Ends this session. → `204`.

### `GET /v1/account`

```json
{
  "email": "…", "createdAt": 0, "kdf": { … },
  "usage": { "records": 0, "bytes": 0 },
  "limits": { … },
  "devices": [{ "id": "…", "name": "…", "platform": "…", "createdAt": 0, "lastSeenAt": 0, "current": true }]
}
```

### `DELETE /v1/devices/:id`

Signs that device out. → `204`.

### `POST /v1/password`

`{ "authKey", "kdf", "salt", "newAuthKey", "wrappedKey" }`, where `authKey` proves the current password and `wrappedKey` is the data key wrapped with the new one. Signs out every other device. → `204`.

### `POST /v1/recovery`

`{ "authKey", "recoveryAuth", "recoveryWrappedKey" }`: replaces the recovery key. → `204`.

### `POST /v1/recover/start` and `POST /v1/recover/finish`

For a forgotten password. `start` takes `{ "email", "recoveryAuth" }` and returns `{ "recoveryWrappedKey", "kdf" }`. `finish` takes `{ "email", "recoveryAuth", "kdf", "salt", "authKey", "wrappedKey", "device" }`, sets the new password, signs out every device and returns `{ "token", "account" }`. Failed attempts count toward the same lock as sign-ins.

### `DELETE /v1/account`

`{ "authKey" }` → `204`. Deletes the account and every record at once.

### `GET /v1/records?since=<seq>&limit=<n>`

Records changed after `since`, oldest first, at most `limit` (default and maximum 1000).

```json
{ "records": [{ "id": "…", "seq": 12, "data": "…" }], "seq": 40, "more": true }
```

`seq` is the newest change on the server. Keep asking with the last record's `seq` while `more` is true.

### `POST /v1/records`

```json
{ "records": [{ "id": "…", "data": "…", "ifAbsent": true }] }
```

At most 500 records per request, each `data` at most 16 KiB once decoded. `data` null deletes the record. With `ifAbsent` the record is stored only when the server has no live record under that id.

→ `{ "results": [{ "id": "…", "seq": 41, "stored": true }], "seq": 41 }`. A record that wasn't stored comes back with the `seq` of the one the server kept; the device fetches that one on its next pull.

## What the server can see

- The account's email address, when it was made and the `kdf` parameters.
- Device names and platforms, and when each device last connected.
- How many records there are, their sizes and when they change.
- IP addresses, in Cloudflare's request logs and in the rate limiter.

It can't see what a record holds: no category names, no senders, no Message-IDs and nothing about the mail.

## What can't be recovered

The server can't reset a password: it never has the key. A forgotten password plus a lost recovery key means the account's records are gone. Rukoo can sort the mail again, but corrections and custom categories are lost.
