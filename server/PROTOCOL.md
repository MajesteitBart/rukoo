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
| `authKey` | `HKDF(masterKey, "rukoo/v1/auth\n" + server)` |
| `wrapKey` | `HKDF(masterKey, "rukoo/v1/wrap")` |
| `dataKey` | 32 random bytes, made once at sign-up; it never changes |
| `recordKey` | `HKDF(dataKey, "rukoo/v1/records")` |
| `indexKey` | `HKDF(dataKey, "rukoo/v1/index")` |
| `recoveryKey` | 20 random bytes, made at sign-up and shown to the person once |
| `recoveryAuth` | `HKDF(recoveryKey, "rukoo/v1/recovery-auth\n" + server)` |
| `recoveryWrap` | `HKDF(recoveryKey, "rukoo/v1/recovery-wrap")` |

`server` is the server's address as the device uses it: scheme, host, port only when it isn't the default one, and path, without a trailing slash, in lowercase apart from the path, such as `https://rukoo-account.bvdm.ai`. With it in `authKey` and `recoveryAuth`, a proof made for one server is no good at another. A server someone was tricked into using can't pass a person's sign-in on to their real server. The other side of this: an account belongs to the address it was made at, so a server that moves to another address has to keep answering at the old one.

`HKDF(ikm, info)` is HKDF-SHA256 (RFC 5869) with an empty salt, which gives the same keys as a salt of 32 zero bytes, and 32 bytes of output. `info` is the label's UTF-8 bytes.

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

- `c` is the collection, `k` the record's key in it, `v` any JSON value and `t` when the device changed it. A deleted record has `v` null and `d` true.
- The record's id is `base64url(HMAC-SHA256(indexKey, c + "\n" + k))`, 43 characters. The server can match a record to its id, but not learn the collection or the key.
- The record's `data` is `seal(recordKey, JSON of the record, "rukoo/v1/record:" + id)`. Binding the id into the tag stops the server from swapping the contents of two records.
- A device deletes a record by writing it again with `d` true, sealed like any other. The deletion then carries its time and settles against changes on other devices like any write. The server also knows deletion without contents (`data` null, a tombstone); a device that receives one drops the record unless it has its own change waiting to go up.

A device that opens a record checks that its `c` and `k` give the id it arrived under, and drops it otherwise.

### When two devices change the same record

The server keeps whatever reaches it last, so devices settle the order themselves. A device that receives a record it has a newer version of keeps its own and sends it again. Newer means a later `t`; on equal `t`, the larger JSON text of `[d ? 1 : 0, v]`, so every device picks the same one. Records written with `ifAbsent` (a first write) are the exception: the server keeps the first one it got, and a device takes that one whatever the times say.

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
| 401 | `unauthorized` (no session or an ended session; on `login` and `recover/*`, a wrong password or recovery key) |
| 403 | `signups_closed` (also when the server holds as many accounts as it takes), `invite_required`, `wrong_password` (a signed-in request whose `authKey` doesn't match) |
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

`{ "email", "authKey", "device" }` → `{ "token", "wrappedKey", "account" }`.

Ten failed attempts on one account within 15 minutes of the first lock it for 15 minutes. The tenth attempt already gets `429 locked`, and so does every attempt during the lock, also with the right password. A successful attempt resets the count. Every 429 carries `Retry-After` in seconds. Apart from this lock, a server may limit how often one network address calls `prelogin`, `signup`, `login`, `recover/*` and `POST /v1/records` (`429 rate_limited`).

An account keeps at most 100 sessions; a new one past that ends the session seen longest ago.

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

This call, `POST /v1/recovery` and `DELETE /v1/account` check the password again with `authKey`. A wrong one gives `403 wrong_password`, never 401, so the device can tell a typo from a session that ended. These attempts count toward the same lock as sign-ins.


`{ "authKey", "kdf", "salt", "newAuthKey", "wrappedKey" }`, where `authKey` proves the current password and `wrappedKey` is the data key wrapped with the new one. Signs out every other device. → `204`.

### `POST /v1/recovery`

`{ "authKey", "recoveryAuth", "recoveryWrappedKey" }`: replaces the recovery key. → `204`.

### `POST /v1/recover/start` and `POST /v1/recover/finish`

For a forgotten password. `start` takes `{ "email", "recoveryAuth" }` and returns `{ "recoveryWrappedKey", "kdf" }`. `finish` takes `{ "email", "recoveryAuth", "kdf", "salt", "authKey", "wrappedKey", "device" }`, sets the new password, signs out every device and returns `{ "token", "account" }`. Failed attempts count toward the same lock as sign-ins.

### `DELETE /v1/account`

`{ "authKey" }` → `204`. Deletes the account and every record at once.

### `GET /v1/records?since=<seq>&limit=<n>`

Records changed after `since`, oldest first, at most `limit` (default and maximum 1000; a larger `limit` counts as 1000). A page also ends early once it holds about 4 MiB, with `more` true.

```json
{ "records": [{ "id": "…", "seq": 12, "data": "…" }], "seq": 40, "more": true }
```

`seq` is the newest change on the server. Keep asking with the last record's `seq` while `more` is true.

### `POST /v1/records`

```json
{ "records": [{ "id": "…", "data": "…", "ifAbsent": true }] }
```

At most 500 records per request (`413 too_large` above that), each `data` at most 16 KiB once decoded. `data` null deletes the record. With `ifAbsent` the record is stored only when the server has no live record under that id. A push is stored whole or not at all.

Every stored write gets the next `seq`, also a delete. A tombstone stays so devices that pull later learn of the delete. Deleting what is already deleted, or was never stored, changes nothing: the result says `stored` true with the current `seq`, and no row is made. A push that would take the account past `limits.records` live records, `limits.bytes`, or `limits.records` tombstones gets `413 quota`, unless it makes an account that is already over a limit smaller.

→ `{ "results": [{ "id": "…", "seq": 41, "stored": true }], "seq": 41 }`. A record that wasn't stored comes back with the `seq` of the one the server kept; the device fetches that one on its next pull.

## What the server can see

- The account's email address, when it was made and the `kdf` parameters.
- Device names and platforms, and when each device last connected.
- How many records there are, their sizes and when they change.
- IP addresses, in Cloudflare's request logs and in the rate limiter.

It can't see what a record holds: no category names, no senders, no Message-IDs and nothing about the mail.

## What can't be recovered

The server can't reset a password: it never has the key. A forgotten password plus a lost recovery key means the account's records are gone. Rukoo can sort the mail again, but corrections and custom categories are lost.
