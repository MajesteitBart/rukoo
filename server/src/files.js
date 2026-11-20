// Files in team chat (WORKSPACES.md, Rich messages): the links devices upload and download with, and the two routes
// those links lead to. A file's bytes go between the device and the WORKSPACE_FILES bucket through this Worker and
// never through the workspace's object, which only keeps track of uploads and keys (workspace.js).
//
// A link is <files origin>/v1/workspaces/{w}/files/<token>. The token is the capability: a PUT or GET with it needs no
// session. It is <payload>.<mac>, the payload base64url JSON { k: 'put' | 'get', w, f, key, exp } and the mac an HMAC of
// it under PEPPER, signed and checked the way socket tickets are (workspaces.js). A put link names the upload and lives
// as long as its reservation. A get link names the file's bucket key and lives 60 seconds, so a download that started
// can finish while a new one needs a member's access again.

import { fromBase64url, hmac, sameBytes, toBase64url, utf8 } from './bytes.js';
import { filesOn, filesOrigin, workspaceObject } from './config.js';
import { json, send } from './http.js';
import { HttpError, invalid } from './input.js';

export const DOWNLOAD_TIME = 60 * 1000;

// Types a download keeps. Anything else is sent as application/octet-stream, so no stored file is ever served as HTML,
// SVG or a script.
const SERVED = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'text/plain',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/webm',
  'audio/wav'
]);

export function filesOff() {
  return new HttpError(403, 'files_off', 'This server has no storage for files in team chat.');
}

// The 403 every file route answers on a server without the bucket.
export function needFiles(env) {
  if (!filesOn(env)) throw filesOff();
}

async function mac(env, payload) {
  return hmac(env.PEPPER, `workspace-file\n${payload}`);
}

// A signed link for claims, at the files origin.
export async function fileLink(env, url, claims) {
  const payload = toBase64url(utf8(JSON.stringify(claims)));
  const token = `${payload}.${toBase64url(await mac(env, payload))}`;
  return `${filesOrigin(env, url)}/v1/workspaces/${claims.w}/files/${token}`;
}

// The claims of a token that this server signed for this workspace and kind, or null. Its expiry is the caller's to
// check, so an expired link can say so.
async function claimsOf(env, id, token, kind) {
  const [payload, signature, ...more] = String(token).split('.');
  const given = fromBase64url(signature ?? '');
  if (more.length > 0 || !payload || !given) return null;
  if (!sameBytes(given, await mac(env, payload))) return null;
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
  } catch {
    return null;
  }
  if (!claims || claims.w !== id || claims.k !== kind || typeof claims.f !== 'string' || !Number.isSafeInteger(claims.exp)) return null;
  return claims;
}

// PUT or GET on a file link. ctx keeps an upload's ending alive when the device hangs up halfway.
export async function fileRoute(request, env, id, token, ctx) {
  needFiles(env);
  const kind = request.method === 'PUT' ? 'put' : 'get';
  const claims = await claimsOf(env, id, token, kind);
  if (!claims || (kind === 'get' && typeof claims.key !== 'string')) throw new HttpError(404, 'not_found', 'There is nothing here.');
  if (claims.exp <= Date.now()) throw new HttpError(410, 'expired', 'This link has expired. Ask for a new one.');
  return kind === 'put' ? upload(request, env, id, claims, ctx) : download(env, claims);
}

// An upload: the workspace starts an attempt and names its key, the body streams into the bucket with exactly the
// declared length and the declared SHA-256, which the bucket checks, and the workspace hears how it ended.
async function upload(request, env, id, claims, ctx) {
  const declared = request.headers.get('content-length');
  const length = declared === null ? NaN : Number(declared);
  if (!/^\d+$/.test(declared ?? '') || !Number.isSafeInteger(length) || !request.body) {
    throw invalid('Content-Length must give the size of the file.', 'size');
  }
  const stub = workspaceObject(env, id);
  const started = await stub.startAttempt(claims.f, length);
  if (started.status !== 200) return send(started);
  const { key, size, type, name, sha256 } = started.attempt;

  const work = (async () => {
    let received = 0;
    const counter = new TransformStream({
      transform(chunk, controller) {
        received += chunk.byteLength;
        controller.enqueue(chunk);
      }
    });
    const fixed = new FixedLengthStream(size);
    // When the bucket refuses the bytes it stops reading, which fails the pipe too. The put's error is the one that
    // says what happened.
    const piping = request.body.pipeThrough(counter).pipeTo(fixed.writable).catch(() => {});
    let failure = null;
    try {
      await env.WORKSPACE_FILES.put(key, fixed.readable, { sha256, httpMetadata: { contentType: type }, customMetadata: { name } });
    } catch (err) {
      failure = err;
    }
    await piping;
    const done = await stub.finishAttempt(claims.f, key, size, failure === null);
    if (done.gone) await env.WORKSPACE_FILES.delete(key).catch(() => {});
    if (failure === null) return send(done);
    // R2 names a digest that didn't match with error 10037.
    if (received === size && /\(10037\)|checksum/i.test(String(failure?.message))) {
      throw invalid('The file does not match the SHA-256 it was reserved with.', 'sha256');
    }
    if (received !== size) throw invalid('The file was not the size it was reserved with.', 'size');
    throw failure;
  })();
  ctx?.waitUntil(work.catch(() => {}));
  return work;
}

// A download, streamed from the bucket. The headers keep a browser from showing or running it: it is always an
// attachment, of a type that can't be a page, under a policy that allows nothing.
async function download(env, claims) {
  const object = await env.WORKSPACE_FILES.get(claims.key);
  if (!object) throw new HttpError(404, 'not_found', 'This file is gone.');
  const stored = object.httpMetadata?.contentType;
  return new Response(object.body, {
    headers: {
      'content-type': SERVED.has(stored) ? stored : 'application/octet-stream',
      'content-disposition': disposition(object.customMetadata?.name || 'file'),
      'content-length': String(object.size),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store'
    }
  });
}

// attachment, with the name twice: plain ASCII for old clients, and UTF-8 (RFC 6266 and 8187) for the rest.
export function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// The answer to a reservation: the workspace's, with the link the bytes go to.
export async function reserved(env, url, id, result) {
  if (result.status !== 201) return send(result);
  const { id: f, expiresAt } = result.file;
  const link = await fileLink(env, url, { k: 'put', w: id, f, key: null, exp: expiresAt });
  return json(201, { ...result.body, put: { url: link, expiresAt } });
}

// The answer to a download request: what the file is, and a link to it for the next 60 seconds.
export async function downloadable(env, url, id, result) {
  if (result.status !== 200) return send(result);
  const expiresAt = Date.now() + DOWNLOAD_TIME;
  const link = await fileLink(env, url, { k: 'get', w: id, f: result.file.id, key: result.file.key, exp: expiresAt });
  return json(200, { url: link, expiresAt, ...result.body });
}
