// Files in messages with an S3-compatible store instead of the R2 bucket, end to end: the s3 project runs the Worker
// and the workspace object without WORKSPACE_FILES and with the five S3 settings, and test/fixtures/fake-s3.js answers
// the store's requests. Each flow here is one that test/workspace-files.test.js covers with R2.

import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { fromBase64url } from '../src/bytes.js';
import { FakeS3, installFakeS3 } from './fixtures/fake-s3.js';
import {
  api,
  askDownload,
  events,
  fileRequest,
  newWorkspace,
  post,
  reserve,
  sendAndWait,
  sha256hex,
  upload,
  workspaceSql,
  workspaceStub
} from './workspace-helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const text = (s) => new TextEncoder().encode(s);

const s3 = new FakeS3();
let restore;
beforeAll(() => {
  restore = installFakeS3(s3);
});
afterAll(() => restore());
beforeEach(() => {
  s3.checkDigest = true;
  s3.intercept = null;
  s3.signed = 0;
  s3.refused = 0;
});

const keysOf = (id) => s3.keys(`ws/${id}/`);
const fileBytes = async (id) => (await workspaceSql(id, 'SELECT fileBytes FROM workspace'))[0].fileBytes;
const alarm = (id) => runDurableObjectAlarm(workspaceStub(id));
const alarmAt = (id) => runInDurableObject(workspaceStub(id), (instance, state) => state.storage.getAlarm());
const redact = (ws, message) => api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${message}/redact`, { token: ws.person.token });
const failing = (op, status = 503) => async (request, seen) => (seen === op ? new Response('<Error><Code>SlowDown</Code></Error>', { status }) : undefined);

describe('with an S3 store', () => {
  it('runs without the R2 binding and offers files', async () => {
    expect(env.WORKSPACE_FILES).toBeUndefined();
    const info = await api('GET', '/v1/info');
    expect(info.body.workspace.capabilities).toContain('files');
  });

  it('streams an upload into the bucket, signed and with its SHA-256, and serves it back as an attachment', async () => {
    const ws = await newWorkspace();
    const bytes = text('%PDF-1.7 the quarterly numbers');
    const reserved = (await reserve(ws.person, ws.id, ws.general, { bytes, name: 'Résumé "final" ✓.pdf', type: 'application/pdf' })).body;
    const signedBefore = s3.signed;
    const put = await fileRequest(reserved.put.url, { method: 'PUT', body: bytes });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ upload: { id: reserved.upload.id, ready: true } });
    const [row] = await workspaceSql(ws.id, 'SELECT state, key FROM upload');
    expect(row.state).toBe('ready');
    expect(keysOf(ws.id)).toEqual([row.key]);
    const stored = s3.objects.get(row.key);
    expect(new TextDecoder().decode(stored.bytes)).toBe('%PDF-1.7 the quarterly numbers');
    expect(stored.type).toBe('application/pdf');
    expect(new TextDecoder().decode(fromBase64url(stored.name))).toBe('Résumé "final" ✓.pdf');
    // The PUT was signed, and declared the digest the reservation named.
    const [sent] = s3.ops('PUT').filter((entry) => entry.key === row.key);
    expect(sent.sha256).toBe(await sha256hex(bytes));
    expect(s3.signed).toBeGreaterThan(signedBefore);
    expect(s3.refused).toBe(0);

    const message = (await post(ws.person, ws.id, ws.general, 'The report', { attachments: [reserved.upload.id] })).body;
    expect(message.seq).toEqual(expect.any(Number));
    const link = await askDownload(ws.person, ws.id, ws.general, reserved.upload.id);
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ name: 'Résumé "final" ✓.pdf', type: 'application/pdf', size: bytes.length, sha256: await sha256hex(bytes) });
    const got = await fileRequest(link.body.url);
    expect(got.status).toBe(200);
    expect(new TextDecoder().decode(got.bytes)).toBe('%PDF-1.7 the quarterly numbers');
    expect(Object.fromEntries(['content-type', 'content-disposition', 'content-length', 'x-content-type-options', 'cache-control'].map((h) => [h, got.headers.get(h)]))).toEqual({
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="R_sum_ _final_ _.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22%20%E2%9C%93.pdf`,
      'content-length': String(bytes.length),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store'
    });
    // A type that could run in a browser is still served as bytes.
    const html = await upload(ws.person, ws.id, ws.general, { bytes: text('<script>alert(1)</script>'), name: 'page.html', type: 'text/html' });
    await post(ws.person, ws.id, ws.general, 'a page', { attachments: [html.id] });
    const page = await fileRequest((await askDownload(ws.person, ws.id, ws.general, html.id)).body.url);
    expect(page.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('refuses bytes with another digest as it does with R2, and keeps no object', async () => {
    const ws = await newWorkspace();
    const bytes = text('exactly this');
    const reserved = (await reserve(ws.person, ws.id, ws.general, { bytes })).body;
    const short = await fileRequest(reserved.put.url, { method: 'PUT', body: text('exactly') });
    expect(short.status).toBe(400);
    expect(short.body.field).toBe('size');

    // The service checks x-amz-content-sha256 and refuses.
    const wrong = await fileRequest(reserved.put.url, { method: 'PUT', body: text('exactly that') });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ error: 'invalid', field: 'sha256' });
    const trash = await workspaceSql(ws.id, 'SELECT key, size FROM trash');
    expect(trash).toEqual([{ key: expect.stringMatching(/^ws\//), size: bytes.length }]);
    expect(keysOf(ws.id)).toEqual([]);
    await alarm(ws.id);
    expect(await workspaceSql(ws.id, 'SELECT * FROM trash')).toEqual([]);
    expect(await fileBytes(ws.id)).toBe(bytes.length);

    // A service that stores whatever it gets: the Worker's own digest finds it out and deletes the object.
    s3.checkDigest = false;
    const unchecked = await fileRequest(reserved.put.url, { method: 'PUT', body: text('exactly than') });
    expect(unchecked.status).toBe(400);
    expect(unchecked.body).toMatchObject({ error: 'invalid', field: 'sha256' });
    const [{ key: lied }] = await workspaceSql(ws.id, 'SELECT key FROM trash');
    expect(s3.ops('PUT').some((entry) => entry.key === lied)).toBe(true);
    expect(s3.ops('DELETE').some((entry) => entry.key === lied)).toBe(true);
    expect(keysOf(ws.id)).toEqual([]);
    await alarm(ws.id);

    // The upload can still be put right.
    s3.checkDigest = true;
    expect((await fileRequest(reserved.put.url, { method: 'PUT', body: bytes })).status).toBe(200);
    expect(keysOf(ws.id)).toHaveLength(1);
    expect(await fileBytes(ws.id)).toBe(bytes.length);
  });

  it('answers 500, logs no secret and keeps nothing when the service refuses the upload', async () => {
    const ws = await newWorkspace();
    const bytes = text('refused');
    const reserved = (await reserve(ws.person, ws.id, ws.general, { bytes })).body;
    s3.intercept = failing('PUT', 403);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const put = await fileRequest(reserved.put.url, { method: 'PUT', body: bytes });
    const lines = logged.mock.calls.map((args) => args.map((arg) => String(arg?.stack ?? arg)).join(' '));
    logged.mockRestore();
    expect(put.status).toBe(500);
    const said = [JSON.stringify(put.body), ...lines].join('\n');
    expect(lines.join('\n')).toContain('S3 PUT answered 403 SlowDown');
    for (const secret of [s3.settings.secretAccessKey, 'AWS4-HMAC-SHA256', 'Signature=', 'aws4_request']) expect(said).not.toContain(secret);
    expect(keysOf(ws.id)).toEqual([]);
    expect(await workspaceSql(ws.id, 'SELECT size FROM trash')).toEqual([{ size: bytes.length }]);
    s3.intercept = null;
    expect((await fileRequest(reserved.put.url, { method: 'PUT', body: bytes })).status).toBe(200);
  });

  // A device's body that never finishes: its first third at once, the second a moment later, and then nothing. The
  // Worker's pipe from a device stops at the device's next part, which a real device keeps sending. With stop, the
  // device breaks off after the first third instead.
  const unfinished = (bytes, { stop = false } = {}) => {
    const third = Math.floor(bytes.length / 3);
    let part = 0;
    return new ReadableStream({
      async pull(controller) {
        part += 1;
        if (part === 1) return controller.enqueue(bytes.slice(0, third));
        if (stop) return controller.error(new Error('The device hung up.'));
        if (part > 2) return new Promise(() => {});
        await new Promise((resolve) => setTimeout(resolve, 50));
        return controller.enqueue(bytes.slice(third, 2 * third));
      }
    });
  };

  it('answers a server error, not a wrong size, when the connection to the service breaks halfway', async () => {
    const ws = await newWorkspace();
    const bytes = text('one third, two thirds, all of it');
    const reserved = (await reserve(ws.person, ws.id, ws.general, { bytes })).body;
    s3.intercept = async (request, op) => {
      if (op !== 'PUT') return undefined;
      await request.body.getReader().read();
      throw new TypeError('Network connection lost.');
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const put = await fileRequest(reserved.put.url, { method: 'PUT', body: unfinished(bytes), length: bytes.length });
    logged.mockRestore();
    expect(put.status).toBe(500);
    expect(put.body.error).toBe('server');
    expect(keysOf(ws.id)).toEqual([]);
    s3.intercept = null;
    expect((await fileRequest(reserved.put.url, { method: 'PUT', body: bytes })).status).toBe(200);
  });

  it('answers a wrong size when the device itself stops halfway', async () => {
    const ws = await newWorkspace();
    const bytes = text('one third, two thirds, all of it');
    const reserved = (await reserve(ws.person, ws.id, ws.general, { bytes })).body;
    const put = await fileRequest(reserved.put.url, { method: 'PUT', body: unfinished(bytes, { stop: true }), length: bytes.length });
    expect(put.status).toBe(400);
    expect(put.body).toMatchObject({ error: 'invalid', field: 'size' });
    expect(keysOf(ws.id)).toEqual([]);
  });

  it("deletes at most 40 keys in one alarm, within the Free plan's 50 subrequests", async () => {
    const ws = await newWorkspace();
    const now = Date.now();
    for (let i = 0; i < 90; i++) {
      const key = `ws/${ws.id}/trash-${String(i).padStart(2, '0')}`;
      s3.plant(key, 'x');
      await workspaceSql(ws.id, 'INSERT INTO trash (key, size, at) VALUES (?, 0, ?)', key, now + i);
    }
    for (const left of [50, 10, 0]) {
      const before = s3.log.length;
      await alarm(ws.id);
      expect(s3.log.length - before).toBeLessThanOrEqual(40);
      expect((await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM trash'))[0].n).toBe(left);
    }
    expect(keysOf(ws.id)).toEqual([]);
  });

  it('empties the trash of a removed message and of messages retention removes', async () => {
    const ws = await newWorkspace();
    const bytes = text('soon gone');
    const made = await upload(ws.person, ws.id, ws.general, { bytes });
    const sent = (await post(ws.person, ws.id, ws.general, 'oops', { attachments: [made.id] })).body;
    const link = (await askDownload(ws.person, ws.id, ws.general, made.id)).body.url;
    const [{ key }] = await workspaceSql(ws.id, 'SELECT key FROM upload');
    await redact(ws, sent.messageId);
    expect(await workspaceSql(ws.id, 'SELECT size FROM trash')).toEqual([{ size: bytes.length }]);
    expect(keysOf(ws.id)).toEqual([key]);
    expect((await alarmAt(ws.id)) - Date.now()).toBeLessThan(15 * 1000);
    await alarm(ws.id);
    expect(keysOf(ws.id)).toEqual([]);
    expect(s3.ops('DELETE').map((entry) => entry.key)).toContain(key);
    expect(await fileBytes(ws.id)).toBe(0);
    expect((await fileRequest(link)).status).toBe(404);

    const old = await upload(ws.person, ws.id, ws.general);
    await post(ws.person, ws.id, ws.general, 'old', { attachments: [old.id] });
    await workspaceSql(ws.id, 'UPDATE event SET at = ?', Date.now() - 100 * DAY);
    await alarm(ws.id);
    expect(await workspaceSql(ws.id, 'SELECT * FROM upload')).toEqual([]);
    expect(keysOf(ws.id)).toEqual([]);
    expect(await fileBytes(ws.id)).toBe(0);
  });

  it('keeps the trash and its count when deletes fail, and tries again', async () => {
    const ws = await newWorkspace();
    const made = await upload(ws.person, ws.id, ws.general);
    await api('DELETE', `/v1/workspaces/${ws.id}/conversations/${ws.general}/uploads/${made.id}`, { token: ws.person.token });
    s3.intercept = failing('DELETE');
    await alarm(ws.id);
    expect(await workspaceSql(ws.id, 'SELECT size FROM trash')).toEqual([{ size: 5 }]);
    expect(await fileBytes(ws.id)).toBe(5);
    expect((await alarmAt(ws.id)) - Date.now()).toBeGreaterThan(4 * 60 * 1000);
    s3.intercept = null;
    await alarm(ws.id);
    expect(await workspaceSql(ws.id, 'SELECT * FROM trash')).toEqual([]);
    expect(keysOf(ws.id)).toEqual([]);
    expect(await fileBytes(ws.id)).toBe(0);
  });

  it('deletes the rest of a batch when one key keeps failing, and puts that key behind the others', async () => {
    const ws = await newWorkspace();
    const at = Date.now() - 1000;
    const keys = [];
    for (let i = 0; i < 45; i++) {
      const key = `ws/${ws.id}/trash-${String(i).padStart(2, '0')}`;
      keys.push(key);
      s3.plant(key, 'x');
      await workspaceSql(ws.id, 'INSERT INTO trash (key, size, at) VALUES (?, 1, ?)', key, at + i);
    }
    await workspaceSql(ws.id, 'UPDATE workspace SET fileBytes = 45');
    // The oldest key gets a 404 that doesn't say NoSuchKey, every time.
    const stuck = keys[0];
    s3.intercept = async (request, op, key) => (op === 'DELETE' && key === stuck ? new Response(null, { status: 404 }) : undefined);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await alarm(ws.id);
      // The other 39 of the batch went, with their bytes; the stuck key now waits behind the 5 left.
      expect(await workspaceSql(ws.id, 'SELECT key FROM trash ORDER BY at')).toEqual([...keys.slice(40), stuck].map((key) => ({ key })));
      expect(await fileBytes(ws.id)).toBe(6);
      expect((await alarmAt(ws.id)) - Date.now()).toBeGreaterThan(4 * 60 * 1000);
      await alarm(ws.id);
      expect(await workspaceSql(ws.id, 'SELECT key FROM trash')).toEqual([{ key: stuck }]);
      expect(await fileBytes(ws.id)).toBe(1);
      expect(keysOf(ws.id)).toEqual([stuck]);
    } finally {
      logged.mockRestore();
    }
    s3.intercept = null;
    await alarm(ws.id);
    expect(await workspaceSql(ws.id, 'SELECT * FROM trash')).toEqual([]);
    expect(keysOf(ws.id)).toEqual([]);
    expect(await fileBytes(ws.id)).toBe(0);
  });

  it('starts no write to the bucket while the workspace deletes its files', async () => {
    const ws = await newWorkspace();
    const stub = workspaceStub(ws.id);
    const bytes = text('late');
    const first = (await reserve(ws.person, ws.id, ws.general, { bytes })).body;
    const second = (await reserve(ws.person, ws.id, ws.general, { bytes })).body;
    const carded = (await sendAndWait(ws.person, ws.id, ws.general, { text: 'cards soon' })).body;
    const later = (await sendAndWait(ws.person, ws.id, ws.general, { text: 'cards later' })).body;

    // A link card's image under way holds the deletion back, as an upload's attempt does.
    const image = await stub.previewKey(ws.general, carded.messageId, 3);
    expect(image).toMatch(new RegExp(`^ws/${ws.id}/`));
    const busy = await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('30');
    await stub.publishPreviews(ws.general, carded.messageId, [], [{ key: image, size: 3 }]);

    // A deletion whose listing fails: a PUT that comes meanwhile is refused, and works once the deletion gave up.
    let during = null;
    s3.intercept = async (request, op) => {
      if (op !== 'LIST' || during) return undefined;
      during = await fileRequest(first.put.url, { method: 'PUT', body: bytes });
      return new Response('<Error><Code>SlowDown</Code></Error>', { status: 503 });
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(503);
    } finally {
      logged.mockRestore();
    }
    expect(during.status).toBe(503);
    expect(during.body.error).toBe('unavailable');
    expect(during.headers.get('retry-after')).toBe('30');
    s3.intercept = null;
    expect((await fileRequest(first.put.url, { method: 'PUT', body: bytes })).status).toBe(200);
    await post(ws.person, ws.id, ws.general, 'kept', { attachments: [first.upload.id] });

    // A deletion that goes through: the bucket is listed, and only then do a PUT and a link card try to write. Neither
    // starts, so nothing lands after the listing went past it.
    during = null;
    s3.intercept = async (request, op) => {
      if (op !== 'LIST' || during) return undefined;
      during = {};
      const listed = await s3.handle(request);
      during.put = await fileRequest(second.put.url, { method: 'PUT', body: bytes });
      during.image = await workspaceStub(ws.id).previewKey(ws.general, later.messageId, 3);
      return listed;
    };
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
    expect(during.put.status).toBe(503);
    expect(during.image).toBeNull();
    expect(keysOf(ws.id)).toEqual([]);
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(404);
  });

  it('deletes everything under the prefix, page by page, when the workspace is deleted', async () => {
    const ws = await newWorkspace();
    const sent = await upload(ws.person, ws.id, ws.general);
    await post(ws.person, ws.id, ws.general, 'kept', { attachments: [sent.id] });
    await upload(ws.person, ws.id, ws.general);
    // More objects than one page holds, which no row names, such as writes that landed late.
    for (let i = 0; i < 150; i++) s3.plant(`ws/${ws.id}/stray-${String(i).padStart(3, '0')}`, 'stray');
    const other = await newWorkspace();
    await upload(other.person, other.id, other.general);
    const lists = s3.ops('LIST').length;
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
    expect(keysOf(ws.id)).toEqual([]);
    const pages = s3.ops('LIST').slice(lists);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((entry) => entry.query.prefix === `ws/${ws.id}/`)).toBe(true);
    expect(pages.slice(1).every((entry) => entry.query['continuation-token'] !== undefined)).toBe(true);
    // Another workspace's file stays.
    expect(keysOf(other.id)).toHaveLength(1);
  });

  it('keeps the workspace when the bucket fails while it is deleted, so the owner can try again', async () => {
    const ws = await newWorkspace();
    const made = await upload(ws.person, ws.id, ws.general);
    await post(ws.person, ws.id, ws.general, 'kept', { attachments: [made.id] });
    s3.plant(`ws/${ws.id}/stray`, 'stray');
    s3.intercept = failing('DELETE');
    const failed = await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
    expect(failed.status).toBe(503);
    expect(failed.body.error).toBe('unavailable');
    expect(failed.headers.get('retry-after')).toBe('30');
    expect(keysOf(ws.id)).toHaveLength(2);
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(200);
    expect((await post(ws.person, ws.id, ws.general, 'still here')).status).toBe(201);
    // A listing that fails keeps it too.
    s3.intercept = failing('LIST', 500);
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(503);
    // So does a listing cut short, which would otherwise pass for the last page.
    s3.intercept = async (request, op) => (op === 'LIST' ? new Response('<?xml version="1.0"?><ListBucketResult>', { headers: { 'content-type': 'application/xml' } }) : undefined);
    const cut = await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
    expect(cut.status).toBe(503);
    expect(cut.headers.get('retry-after')).toBe('30');
    expect(keysOf(ws.id)).toHaveLength(2);
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(200);
    s3.intercept = null;
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
    expect(keysOf(ws.id)).toEqual([]);
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(404);
  });

  it('keeps a workspace with files while the S3 settings lack a secret, and deletes one without files', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent = await newWorkspace();
    const made = await upload(sent.person, sent.id, sent.general);
    await post(sent.person, sent.id, sent.general, 'kept', { attachments: [made.id] });
    // A key that is only in the trash, as after a cancelled upload.
    const trashed = await newWorkspace();
    const cancelled = await upload(trashed.person, trashed.id, trashed.general);
    await api('DELETE', `/v1/workspaces/${trashed.id}/conversations/${trashed.general}/uploads/${cancelled.id}`, { token: trashed.person.token });
    expect(await workspaceSql(trashed.id, 'SELECT COUNT(*) AS n FROM trash')).toEqual([{ n: 1 }]);
    const empty = await newWorkspace();
    const settings = (id, partial) =>
      runInDurableObject(workspaceStub(id), (instance) => {
        if (partial) {
          instance.realEnv = instance.env;
          instance.env = { ...instance.env, WORKSPACE_FILES_S3_SECRET_ACCESS_KEY: '' };
        } else instance.env = instance.realEnv;
      });
    for (const ws of [sent, trashed, empty]) await settings(ws.id, true);
    try {
      for (const ws of [sent, trashed]) {
        const failed = await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
        expect(failed.status).toBe(503);
        expect(failed.body.error).toBe('unavailable');
        expect(failed.headers.get('retry-after')).toBe('30');
        expect(keysOf(ws.id)).toHaveLength(1);
        expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(200);
      }
      // A workspace that knows no key in the bucket goes as before.
      expect((await api('DELETE', `/v1/workspaces/${empty.id}`, { token: empty.person.token })).status).toBe(204);
      expect((await api('GET', `/v1/workspaces/${empty.id}`, { token: empty.person.token })).status).toBe(404);
    } finally {
      for (const ws of [sent, trashed]) await settings(ws.id, false);
      logged.mockRestore();
    }
    // With all five settings back, the files go first and then the workspace.
    for (const ws of [sent, trashed]) {
      expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
      expect(keysOf(ws.id)).toEqual([]);
    }
  });

  it('sends a download without Content-Length when the service gives none', async () => {
    const ws = await newWorkspace();
    const bytes = text('a file of some length');
    const made = await upload(ws.person, ws.id, ws.general, { bytes, type: 'text/plain' });
    await post(ws.person, ws.id, ws.general, 'see attached', { attachments: [made.id] });
    const link = (await askDownload(ws.person, ws.id, ws.general, made.id)).body.url;
    // The object's bytes as a stream of unknown length, as a service answers that leaves Content-Length out.
    s3.intercept = async (request, op, key) => {
      if (op !== 'GET') return undefined;
      const object = s3.objects.get(key);
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(object.bytes);
          controller.close();
        }
      });
      return new Response(body, { headers: { 'content-type': object.type } });
    };
    const got = await fileRequest(link);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-length')).toBeNull();
    expect(new TextDecoder().decode(got.bytes)).toBe('a file of some length');
  });

  it("stores a link card's image in the bucket", async () => {
    const origin = inject('previewOrigin');
    const url = (await (await fetch(`${origin}/pages`, { method: 'POST', body: JSON.stringify({ title: 'Pictured', image: { width: 1200, height: 630 } }) })).json()).url;
    const ws = await newWorkspace();
    const sent = await sendAndWait(ws.person, ws.id, ws.general, { text: `See ${url}` }, { WORKSPACE_PREVIEW_HOSTS: inject('previewHost') });
    expect(sent.status).toBe(201);
    const message = (await events(ws.person, ws.id, ws.general)).body.events.find((e) => e.id === sent.body.messageId);
    expect(message.previews[0].image).toMatchObject({ name: 'preview.png', type: 'image/png', width: 1200, height: 630 });
    const [{ key }] = await workspaceSql(ws.id, 'SELECT key FROM upload WHERE preview = 1');
    expect(keysOf(ws.id)).toEqual([key]);
    const got = await fileRequest((await askDownload(ws.person, ws.id, ws.general, message.previews[0].image.id)).body.url);
    expect([...got.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // The image goes with its message.
    await redact(ws, sent.body.messageId);
    await alarm(ws.id);
    expect(keysOf(ws.id)).toEqual([]);
  });
});
