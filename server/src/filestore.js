// Where the files of team chat live (WORKSPACES.md, Files): an R2 bucket bound as WORKSPACE_FILES, or a bucket in any
// S3-compatible service named by the five WORKSPACE_FILES_S3_* settings. The binding wins when both are there.
// Without either, files are off. fileStore(env) answers null then, or an object every caller uses the same way:
//
//   put(key, body, { size, sha256, contentType, name })  body is a stream of exactly size bytes, or the bytes
//                                                        themselves. Throws DigestMismatch when they don't have the
//                                                        declared SHA-256, and then leaves no object under key.
//   get(key)                                             { body, size, contentType, name }, or null when it's gone.
//                                                        size is null when the store doesn't say it.
//   delete(keys)                                         Deletes every key; a key that is already gone counts as
//                                                        deleted. Throws when any delete failed, with the keys that
//                                                        failed in err.failed when the store knows them.
//   list({ prefix, cursor, limit })                      { keys, cursor }: one page, and the cursor of the next or
//                                                        null.
//   batch                                                The most keys one delete call and one list page should hold.
//   kind                                                 'r2' or 's3': which kind of store it is.
//
// The S3 store signs every request with AWS Signature Version 4 (sigv4.js). Its errors and logs never hold the secret
// key, an Authorization header or a signature, and never an error body, in which S3 may repeat what it signed.

import { fromBase64url, toBase64url, utf8 } from './bytes.js';
import { EMPTY_SHA256, encodeRfc3986, sign } from './sigv4.js';

export const S3_SETTINGS = [
  'WORKSPACE_FILES_S3_ENDPOINT',
  'WORKSPACE_FILES_S3_REGION',
  'WORKSPACE_FILES_S3_BUCKET',
  'WORKSPACE_FILES_S3_ACCESS_KEY_ID',
  'WORKSPACE_FILES_S3_SECRET_ACCESS_KEY'
];

// R2 deletes up to 1,000 keys in one call. S3 takes one request per key, eight at a time, so its batch stays under the
// 50 subrequests a Worker on the Free plan may make in one invocation: one alarm can always delete a whole batch.
const R2_BATCH = 1000;
const S3_BATCH = 40;
const DELETES_AT_ONCE = 8;
// How long S3 may take. request: a list, a delete, the headers of a download, and the answer to an upload once its
// last byte went. idle: how long an upload may go without a byte moving. error: the body of a refusal, read for its
// code. upload: all of an upload, from its first byte to S3's answer, which lets 25 MiB through at 8 KB/s. It must
// stay well below the two hours a workspace counts an upload's attempt as under way (ATTEMPT_TIME in workspace.js):
// deleting a workspace waits for every attempt younger than that, and an upload still writing after it could land
// once the deletion has listed the bucket, and outlive the workspace. The hour between them leaves time for the
// attempt's ending to reach the workspace. Nothing caps how long a device takes to fetch a file, which R2 doesn't
// either. Tests shorten them.
export const S3_TIME = { request: 30 * 1000, idle: 60 * 1000, error: 5 * 1000, upload: 60 * 60 * 1000 };
// Bytes the Worker holds itself, such as a link card's image, go to S3 within a minute plus a second per 64 KiB, and
// within S3_TIME.upload.
const putTime = (size) => 60 * 1000 + Math.ceil(size / 65536) * 1000;
// Bytes of an error answer read for its code, at most.
const ERROR_BYTES = 16384;

// The bytes didn't have the SHA-256 they were declared with. files.js answers it the same way for every store.
export class DigestMismatch extends Error {
  constructor(message = 'The bytes do not match the SHA-256 they were declared with.') {
    super(message);
    this.name = 'DigestMismatch';
  }
}

// An answer from the S3 service that refused a request: the operation, the status and S3's error code, nothing else.
export class S3Error extends Error {
  constructor(op, status, code) {
    super(`S3 ${op} answered ${status}${code ? ` ${code}` : ''}`);
    this.name = 'S3Error';
    this.status = status;
    this.code = code;
  }
}

// A request to the S3 service that got no answer: the connection failed, or S3_TIME ran out. Like an S3Error, it is
// the store's failure and never a sign that the device sent the wrong bytes.
export class S3Unreachable extends Error {
  constructor(op, reason) {
    super(`S3 ${op} failed: ${reason}`);
    this.name = 'S3Unreachable';
  }
}

// A download's 404 says the object is gone when S3 calls it NoSuchKey or says nothing more. NoSuchBucket, from a wrong
// bucket name or endpoint, is a refusal like any other: the objects may well still be there. A delete asks more: only
// NoSuchKey counts (store.delete).
const missing = (err) => err.status === 404 && (err.code === null || err.code === 'NoSuchKey');

export function fileStore(env) {
  if (env.WORKSPACE_FILES) return r2Store(env.WORKSPACE_FILES);
  const { settings, problem } = s3Settings(env);
  if (problem) {
    tellOnce(problem);
    return null;
  }
  return settings ? s3Store(settings) : null;
}

// The S3 settings: { settings } when all five are there and make sense, { problem } when only some are or one is
// wrong, and {} when none is set. A problem names settings, never their values.
export function s3Settings(env) {
  const values = S3_SETTINGS.map((name) => (env[name] === undefined || env[name] === null ? '' : String(env[name]).trim()));
  const missing = S3_SETTINGS.filter((name, i) => !values[i]);
  if (missing.length === S3_SETTINGS.length) return {};
  if (missing.length) {
    const names = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`;
    return {
      problem: `Files in team chat are off: an S3 store needs all five WORKSPACE_FILES_S3_* settings, and ${names} ${missing.length === 1 ? 'is' : 'are'} not set.`
    };
  }
  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = values;
  const base = URL.parse(endpoint);
  // http only to this machine, for a local stand-in; everything else goes over https.
  const local = base && base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (!base || !(base.protocol === 'https:' || local) || base.search || base.hash || base.username || base.password) {
    return { problem: 'Files in team chat are off: WORKSPACE_FILES_S3_ENDPOINT must be an https address, such as https://objects.example.com, without a query.' };
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    return { problem: 'Files in team chat are off: WORKSPACE_FILES_S3_BUCKET must be a bucket name of 3 to 63 lowercase letters, digits, dots and hyphens.' };
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(region)) {
    return { problem: 'Files in team chat are off: WORKSPACE_FILES_S3_REGION must be a region name such as europe-2.' };
  }
  return {
    settings: { origin: base.origin, host: base.host, basePath: base.pathname.replace(/\/+$/, ''), region, bucket, accessKeyId, secretAccessKey }
  };
}

// Each problem is logged once per isolate, not on every request that asks whether files are on.
const told = new Set();
function tellOnce(problem) {
  if (told.has(problem)) return;
  told.add(problem);
  console.error(problem);
}

// ---- R2 ----

// The binding as it was used before there were other stores: R2 checks the SHA-256 itself and names a digest that
// didn't match with error 10037.
function r2Store(bucket) {
  return {
    kind: 'r2',
    batch: R2_BATCH,
    async put(key, body, { sha256, contentType, name }) {
      try {
        await bucket.put(key, body, { sha256, httpMetadata: { contentType }, customMetadata: { name } });
      } catch (err) {
        if (/\(10037\)|checksum/i.test(String(err?.message))) throw new DigestMismatch(String(err.message));
        throw err;
      }
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return { body: object.body, size: object.size, contentType: object.httpMetadata?.contentType ?? null, name: object.customMetadata?.name ?? null };
    },
    async delete(keys) {
      if (keys.length) await bucket.delete(keys);
    },
    async list({ prefix, cursor = null, limit = R2_BATCH }) {
      const page = await bucket.list({ prefix, cursor: cursor ?? undefined, limit });
      return { keys: page.objects.map((object) => object.key), cursor: page.truncated ? page.cursor : null };
    }
  };
}

// ---- S3 ----

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

// A file's name travels as S3 user metadata, which takes ASCII only and which AWS and MinIO cap at 2 KB: base64url of
// the UTF-8, at most 1,360 characters for the longest name a reservation takes (255 code points of 4 bytes each).
// Percent-encoding would take up to 3,060.
function nameHeader(name) {
  return toBase64url(utf8(String(name ?? '')));
}

function nameFrom(header) {
  const bytes = header === null ? null : fromBase64url(header);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

function bytesOf(body) {
  if (typeof body === 'string') return utf8(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('A file body must be a stream or bytes.');
}

// An S3 error code is a name such as NoSuchKey or XAmzContentSHA256Mismatch: a letter, then letters and digits.
// Anything else in <Code>, such as a hex string a service repeated from the request, is dropped, so a signature never
// reaches an error message or a log.
function s3Code(text) {
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(text) && !/^[0-9A-Fa-f]+$/.test(text) ? text : null;
}

// The first ERROR_BYTES of an error answer, for its <Code>, within S3_TIME.error. Only those are copied, whatever the
// size of the chunks they come in. The rest, which can repeat the string S3 signed, is dropped unread. A body that
// doesn't arrive in time, or breaks off, has no code.
async function errorCode(res) {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const head = new Uint8Array(ERROR_BYTES);
  let length = 0;
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), S3_TIME.error);
  });
  try {
    while (length < ERROR_BYTES) {
      const step = await Promise.race([reader.read(), late]);
      if (step === null) return null;
      if (step.done) break;
      const chunk = step.value.subarray(0, ERROR_BYTES - length);
      head.set(chunk, length);
      length += chunk.byteLength;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  const text = new TextDecoder().decode(head.subarray(0, length));
  const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
  return code === undefined ? null : s3Code(code);
}

async function refusal(op, res) {
  return new S3Error(op, res.status, await errorCode(res));
}

// S3 names a body that didn't match x-amz-content-sha256 XAmzContentSHA256Mismatch; some services say BadDigest.
function mismatchOr(err) {
  return err.code === 'XAmzContentSHA256Mismatch' || err.code === 'BadDigest' ? new DigestMismatch(err.message) : err;
}

// What XML escapes in text: the five named entities and numeric references.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (whole, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity];
    const point = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : whole;
  });
}

// A ListObjectsV2 answer: the keys of its <Contents>, and the continuation token when <IsTruncated> says there is
// more. Only a whole answer counts: one cut short would pass for the last page, and deleting a workspace would then
// leave objects behind. It must end its <ListBucketResult>, give every entry exactly one key that isn't empty, agree
// with its <KeyCount> when it has one, and say true or false in <IsTruncated>, with a continuation token when true.
// An element counts with or without attributes and whitespace in its tags, as in <Contents xmlns="…">: missing one
// would leave its object behind. Anything else throws.
const opening = (name) => new RegExp(`<${name}(?=[\\s>/])`, 'g');
const element = (name) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'g');
export function readList(xml) {
  if (!/<ListBucketResult[\s>]/.test(xml)) throw new Error('S3 LIST answered something other than a list.');
  if (!/<\/ListBucketResult>\s*$/.test(xml)) throw new Error('S3 LIST answered a list that ends too soon.');
  const entries = [...xml.matchAll(element('Contents'))].map((match) => match[1]);
  const keys = entries.map((entry) => {
    const found = [...entry.matchAll(element('Key'))];
    return found.length === 1 && (entry.match(opening('Key')) ?? []).length === 1 && found[0][1] ? decodeXml(found[0][1]) : null;
  });
  if (keys.includes(null) || keys.length !== (xml.match(opening('Contents')) ?? []).length) throw new Error('S3 LIST answered an entry without a key.');
  const counts = [...xml.matchAll(element('KeyCount'))].map((match) => match[1].trim());
  if (counts.length > 1 || (counts.length === 1 && counts[0] !== String(keys.length))) {
    throw new Error('S3 LIST answered a KeyCount that is not the number of its entries.');
  }
  const truncated = /<IsTruncated>\s*(true|false)\s*<\/IsTruncated>/.exec(xml)?.[1];
  if (!truncated) throw new Error('S3 LIST did not say whether there is more.');
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  if (truncated === 'true' && !token?.trim()) throw new Error('S3 LIST said there is more without a continuation token.');
  return { keys, cursor: truncated === 'true' ? decodeXml(token) : null };
}

function s3Store(s) {
  const bucketPath = `${s.basePath}/${encodeRfc3986(s.bucket)}`;

  // Path-style: <endpoint>/<bucket>/<key>, each segment of the key encoded. A key with an empty, . or .. segment would
  // change on its way through a URL; this server never makes one.
  function objectPath(key) {
    const segments = String(key).split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error('This key cannot be stored in an S3 bucket.');
    }
    return `${bucketPath}/${segments.map(encodeRfc3986).join('/')}`;
  }

  async function request(op, method, path, { query = [], headers = {}, payloadHash = EMPTY_SHA256, body, signal }) {
    const signed = await sign({
      method,
      host: s.host,
      path,
      query,
      headers,
      payloadHash,
      region: s.region,
      accessKeyId: s.accessKeyId,
      secretAccessKey: s.secretAccessKey
    });
    const url = `${s.origin}${path}${signed.query ? `?${signed.query}` : ''}`;
    try {
      return await fetch(url, { method, headers: signed.headers, body, signal, redirect: 'manual' });
    } catch (err) {
      // Only the kind of failure: the error's own text could hold anything, and it goes on to the log.
      const late = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new S3Unreachable(op, late ? 'no answer in time' : 'the request did not complete');
    }
  }

  const store = {
    kind: 's3',
    batch: S3_BATCH,

    // The service checks x-amz-content-sha256 against the bytes. The bytes are hashed here as well, as they stream,
    // and an object whose bytes turn out different is deleted again: the answer doesn't rest on the service's check.
    async put(key, body, { size, sha256, contentType, name }) {
      const path = objectPath(key);
      const headers = { 'content-type': contentType || 'application/octet-stream', 'x-amz-meta-name': nameHeader(name) };
      if (!(body instanceof ReadableStream)) {
        const bytes = bytesOf(body);
        if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== sha256) throw new DigestMismatch();
        const time = Math.min(putTime(bytes.byteLength), S3_TIME.upload);
        const res = await request('PUT', 'PUT', path, { headers, payloadHash: sha256, body: bytes, signal: AbortSignal.timeout(time) });
        if (!res.ok) throw mismatchOr(await refusal('PUT', res));
        await res.body?.cancel();
        return;
      }
      // The body goes to S3 with its exact length, and every chunk passes through a digest on its way. Stopping cancels
      // the body, which ends the device's upload too. The chunks are copied by hand rather than piped: the runtime
      // can't pipe one of its own streams, such as a tee branch of a FixedLengthStream's output, into another of its
      // own, such as a DigestStream or a second FixedLengthStream, and a pipe from a stream that waits for a device
      // doesn't stop until the device sends again.
      //
      // The request stops when no byte moved for S3_TIME.idle, S3 hasn't answered S3_TIME.request after the last one,
      // or the whole of it took S3_TIME.upload.
      const late = new AbortController();
      const stop = () => late.abort(new DOMException('No answer in time.', 'TimeoutError'));
      let timer = null;
      let settled = false;
      const watch = (ms) => {
        clearTimeout(timer);
        if (!settled) timer = setTimeout(stop, ms);
      };
      const deadline = setTimeout(stop, S3_TIME.upload);
      const digest = new crypto.DigestStream('SHA-256');
      // Rejects once the digest is aborted, which nobody waits for then.
      digest.digest.catch(() => {});
      const hasher = digest.getWriter();
      const reader = body.getReader();
      const sized = new FixedLengthStream(size);
      const writer = sized.writable.getWriter();
      // The body's own failure, such as a device that hung up halfway. It breaks the request to S3 as well, but it is
      // what happened, and it is what put throws.
      let broken = null;
      let stopping = false;
      const feeding = (async () => {
        try {
          for (;;) {
            let step;
            try {
              step = await reader.read();
            } catch (err) {
              if (!stopping) broken = err ?? new Error('The body broke off.');
              throw err;
            }
            if (step.done) break;
            watch(S3_TIME.idle);
            await hasher.write(step.value);
            await writer.write(step.value);
            watch(S3_TIME.idle);
          }
          await hasher.close();
          await writer.close();
          watch(S3_TIME.request);
        } catch (err) {
          reader.cancel(err).catch(() => {});
          writer.abort(err).catch(() => {});
          await hasher.abort(err).catch(() => {});
        }
      })();
      const halt = async () => {
        stopping = true;
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});
        await feeding;
        await hasher.abort().catch(() => {});
      };
      let res;
      watch(S3_TIME.idle);
      try {
        res = await request('PUT', 'PUT', path, { headers, payloadHash: sha256, body: sized.readable, signal: late.signal });
      } catch (err) {
        await halt();
        throw broken ?? err;
      } finally {
        settled = true;
        clearTimeout(timer);
        clearTimeout(deadline);
      }
      if (!res.ok) {
        await halt();
        throw mismatchOr(await refusal('PUT', res));
      }
      await res.body?.cancel();
      await feeding;
      let actual = null;
      try {
        actual = hex(await digest.digest);
      } catch {
        // No digest means no proof: the object goes like one that didn't match.
      }
      if (actual !== sha256) {
        await store.delete([key]).catch(() => {});
        throw new DigestMismatch();
      }
    },

    async get(key) {
      const path = objectPath(key);
      // Only the answer's headers are timed. The body goes on to a device, which takes as long as it needs, as with R2.
      const waiting = new AbortController();
      const timer = setTimeout(() => waiting.abort(new DOMException('No answer in time.', 'TimeoutError')), S3_TIME.request);
      let res;
      try {
        res = await request('GET', 'GET', path, { signal: waiting.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const err = await refusal('GET', res);
        if (missing(err)) return null;
        throw err;
      }
      // An answer without a Content-Length, or with one that is no number, leaves the size unknown, and the download
      // then goes without one.
      const length = res.headers.get('content-length');
      return {
        body: res.body,
        size: /^\d{1,15}$/.test(length ?? '') ? Number(length) : null,
        contentType: res.headers.get('content-type'),
        name: nameFrom(res.headers.get('x-amz-meta-name'))
      };
    },

    // One DELETE per key, eight at a time. S3 answers 204 for a key that isn't there; some services answer 404
    // NoSuchKey, which counts as gone too. Any other answer fails, a 404 without a code or with a body that couldn't
    // be read among them: the bucket or endpoint may be wrong, and the key stays in the trash for another try.
    async delete(keys) {
      const all = [...new Set(keys)];
      const failures = [];
      let next = 0;
      const lane = async () => {
        while (next < all.length) {
          const key = all[next++];
          try {
            const res = await request('DELETE', 'DELETE', objectPath(key), { signal: AbortSignal.timeout(S3_TIME.request) });
            if (res.ok) await res.body?.cancel();
            else {
              const err = await refusal('DELETE', res);
              if (!(err.status === 404 && err.code === 'NoSuchKey')) failures.push({ key, err });
            }
          } catch (err) {
            failures.push({ key, err });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(DELETES_AT_ONCE, all.length) }, lane));
      if (failures.length) {
        const err = new Error(`S3 could not delete ${failures.length} of ${all.length} objects, the first because ${failures[0].err.message}`);
        err.failed = failures.map((failure) => failure.key);
        throw err;
      }
    },

    async list({ prefix, cursor = null, limit = S3_BATCH }) {
      const query = [
        ['list-type', '2'],
        ['prefix', prefix],
        ['max-keys', String(Math.max(1, Math.min(1000, limit)))]
      ];
      if (cursor) query.push(['continuation-token', cursor]);
      const res = await request('LIST', 'GET', bucketPath, { query, signal: AbortSignal.timeout(S3_TIME.request) });
      if (!res.ok) throw await refusal('LIST', res);
      return readList(await res.text());
    }
  };
  return store;
}
