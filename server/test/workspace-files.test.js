// Files in messages: reserving, uploading through the Worker into the bucket, sending, downloading with a signed link,
// and every way a file's bytes leave the bucket again (WORKSPACES.md, Rich messages).

import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { hmac, toBase64url, utf8 } from '../src/bytes.js';
import {
  access,
  api,
  askDownload,
  bucketKeys,
  changes,
  events,
  fileRequest,
  newMember,
  newWorkspace,
  post,
  reserve,
  sha256hex,
  until,
  upload,
  uuidv7,
  workspaceSql,
  workspaceStub
} from './workspace-helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const OFF = { WORKSPACE_FILES: undefined };
const text = (s) => new TextEncoder().encode(s);

const fileBytes = async (id) => (await workspaceSql(id, 'SELECT fileBytes FROM workspace'))[0].fileBytes;
const alarm = (id) => runDurableObjectAlarm(workspaceStub(id));
const alarmAt = (id) => runInDurableObject(workspaceStub(id), (instance, state) => state.storage.getAlarm());
const messageIn = async (person, ws, id, version = 2) => (await events(person, ws.id, ws.general, '', version)).body.events.find((e) => e.id === id);

// A file link signed like the server's, with claims of the test's choosing.
async function signed(id, claims) {
  const payload = toBase64url(utf8(JSON.stringify({ w: id, ...claims })));
  const mac = toBase64url(await hmac(env.PEPPER, `workspace-file\n${payload}`));
  return `https://accounts.example/v1/workspaces/${id}/files/${payload}.${mac}`;
}

describe('reserving an upload', () => {
  it('answers an upload id and a link to put the bytes at', async () => {
    const ws = await newWorkspace();
    const bytes = text('hello');
    const res = await reserve(ws.person, ws.id, ws.general, { bytes, name: '  notes.txt ' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      upload: { id: expect.stringMatching(/^f_[A-Za-z0-9_-]{22}$/), expiresAt: expect.any(Number) },
      put: { url: expect.stringMatching(new RegExp(`^https://accounts\\.example/v1/workspaces/${ws.id}/files/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$`)), expiresAt: res.body.upload.expiresAt }
    });
    expect(res.body.upload.expiresAt - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect(res.body.upload.expiresAt - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    const [row] = await workspaceSql(ws.id, 'SELECT name, type, size, state, key FROM upload');
    expect(row).toEqual({ name: 'notes.txt', type: 'text/plain', size: 5, state: 'reserved', key: null });
    expect(await fileBytes(ws.id)).toBe(5);
    // WORKSPACE_FILES_ORIGIN moves the links elsewhere.
    const moved = await reserve(ws.person, ws.id, ws.general, { bytes }, { WORKSPACE_FILES_ORIGIN: 'https://files.example' });
    expect(moved.body.put.url.startsWith(`https://files.example/v1/workspaces/${ws.id}/files/`)).toBe(true);
  });

  it('checks the name, type, size, digest and an image size', async () => {
    const ws = await newWorkspace();
    const bad = async (fields, field, status = 400) => {
      const res = await reserve(ws.person, ws.id, ws.general, fields);
      expect(res.status, JSON.stringify(fields).slice(0, 60)).toBe(status);
      expect(res.body.field ?? res.body.limit).toBe(field);
    };
    await bad({ name: '' }, 'name');
    await bad({ name: '   ' }, 'name');
    await bad({ name: 'a/b.txt' }, 'name');
    await bad({ name: 'a\\b.txt' }, 'name');
    await bad({ name: 'line\nbreak.txt' }, 'name');
    await bad({ name: 'gpj\u202e.exe' }, 'name');
    await bad({ name: 'x'.repeat(256) }, 'name');
    await bad({ type: 'Text/Plain' }, 'type');
    await bad({ type: 'text' }, 'type');
    await bad({ type: 'text/plain; charset=utf-8' }, 'type');
    await bad({ size: 0 }, 'size');
    await bad({ size: 1.5 }, 'size');
    await bad({ size: 26214401 }, 'fileBytes', 413);
    await bad({ sha256: 'A'.repeat(64) }, 'sha256');
    await bad({ sha256: 'ab' }, 'sha256');
    await bad({ width: 10, height: 10 }, 'width');
    await bad({ type: 'image/png', width: 10 }, 'height');
    await bad({ type: 'image/png', width: 0, height: 10 }, 'width');
    await bad({ type: 'image/png', width: 10, height: 65536 }, 'height');
    const big = await reserve(ws.person, ws.id, ws.general, { size: 26214401 });
    expect(big.body).toMatchObject({ error: 'too_large', limit: 'fileBytes' });
    // The largest file, a name of 255 characters, no type and an image size are fine.
    expect((await reserve(ws.person, ws.id, ws.general, { size: 26214400, name: 'é'.repeat(255), type: undefined })).status).toBe(201);
    expect((await reserve(ws.person, ws.id, ws.general, { type: 'image/png', width: 1200, height: 630 })).status).toBe(201);
    const [untyped] = await workspaceSql(ws.id, "SELECT type FROM upload WHERE size = 26214400");
    expect(untyped.type).toBe('application/octet-stream');
  });

  it('holds a member to twenty open uploads and a workspace to its file bytes', async () => {
    const ws = await newWorkspace();
    for (let i = 0; i < 20; i++) expect((await reserve(ws.person, ws.id, ws.general)).status).toBe(201);
    const many = await reserve(ws.person, ws.id, ws.general);
    expect(many.status).toBe(429);
    expect(many.body).toMatchObject({ error: 'rate_limited', limit: 'uploads' });
    expect(Number(many.headers.get('retry-after'))).toBeGreaterThan(3000);
    // Someone else has twenty of their own.
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    expect((await reserve(mila.person, ws.id, ws.general)).status).toBe(201);
    // An expired one doesn't count.
    await workspaceSql(ws.id, 'UPDATE upload SET expiresAt = ? WHERE n = (SELECT MIN(n) FROM upload)', Date.now() - 1);
    expect((await reserve(ws.person, ws.id, ws.general)).status).toBe(201);

    await workspaceSql(ws.id, 'UPDATE workspace SET fileBytes = ?', 5368709120 - 4);
    const full = await reserve(mila.person, ws.id, ws.general);
    expect(full.status).toBe(413);
    expect(full.body).toMatchObject({ error: 'quota', limit: 'files', scope: 'workspace' });
    expect((await reserve(mila.person, ws.id, ws.general, { bytes: text('four') })).status).toBe(201);
  });

  it('needs a grant in a room that is open', async () => {
    const ws = await newWorkspace();
    const outsider = await newMember(ws, 'Tess');
    await api('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/me`, { token: outsider.person.token });
    expect((await reserve(outsider.person, ws.id, ws.general)).body).toMatchObject({ error: 'not_found', scope: 'conversation' });
    await api('PATCH', `/v1/workspaces/${ws.id}/channels/${ws.general}`, { token: ws.person.token, body: { archived: true } });
    expect((await reserve(ws.person, ws.id, ws.general)).body).toMatchObject({ error: 'archived' });
  });
});

describe('uploading', () => {
  it('streams the bytes into the bucket and makes the upload ready', async () => {
    const ws = await newWorkspace();
    const bytes = text('The quarterly numbers');
    const reserved = (await reserve(ws.person, ws.id, ws.general, { bytes, name: 'numbers.txt' })).body;
    const put = await fileRequest(reserved.put.url, { method: 'PUT', body: bytes });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ upload: { id: reserved.upload.id, ready: true } });
    const [row] = await workspaceSql(ws.id, 'SELECT state, key FROM upload');
    expect(row.state).toBe('ready');
    expect(row.key).toMatch(new RegExp(`^ws/${ws.id}/[A-Za-z0-9_-]{22}$`));
    const stored = await env.WORKSPACE_FILES.get(row.key);
    expect(new TextDecoder().decode(await stored.arrayBuffer())).toBe('The quarterly numbers');
    expect(stored.httpMetadata.contentType).toBe('text/plain');
    expect(await workspaceSql(ws.id, 'SELECT * FROM attempt')).toEqual([]);
    expect(await fileBytes(ws.id)).toBe(bytes.length);
    // A ready upload takes no other PUT.
    const again = await fileRequest(reserved.put.url, { method: 'PUT', body: bytes });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('invalid_state');
  });

  it('refuses bytes of another length and bytes with another digest', async () => {
    const ws = await newWorkspace();
    const bytes = text('exactly this');
    const reserved = (await reserve(ws.person, ws.id, ws.general, { bytes })).body;
    const short = await fileRequest(reserved.put.url, { method: 'PUT', body: text('exactly') });
    expect(short.status).toBe(400);
    expect(short.body.field).toBe('size');
    // Nothing was started for it.
    expect(await workspaceSql(ws.id, 'SELECT * FROM attempt')).toEqual([]);

    const other = text('exactly that');
    const wrong = await fileRequest(reserved.put.url, { method: 'PUT', body: other });
    expect(wrong.status).toBe(400);
    expect(wrong.body.field).toBe('sha256');
    // The attempt's key went to the trash, and is counted there until the alarm deleted it.
    const trash = await workspaceSql(ws.id, 'SELECT key, size FROM trash');
    expect(trash).toEqual([{ key: expect.stringMatching(/^ws\//), size: bytes.length }]);
    expect(await fileBytes(ws.id)).toBe(2 * bytes.length);
    expect(await env.WORKSPACE_FILES.head(trash[0].key)).toBeNull();
    // A failed write's key waits until its object can no longer land, and is counted meanwhile.
    await alarm(ws.id);
    expect(await workspaceSql(ws.id, 'SELECT size FROM trash')).toEqual([{ size: bytes.length }]);
    expect(await fileBytes(ws.id)).toBe(2 * bytes.length);
    await workspaceSql(ws.id, 'UPDATE trash SET at = ?', Date.now() - 1);
    await alarm(ws.id);
    expect(await workspaceSql(ws.id, 'SELECT * FROM trash')).toEqual([]);
    expect(await fileBytes(ws.id)).toBe(bytes.length);
    // The upload can still be put right.
    expect((await fileRequest(reserved.put.url, { method: 'PUT', body: bytes })).status).toBe(200);
  });

  it('lets one of two attempts at once win and trashes the other', async () => {
    const ws = await newWorkspace();
    const bytes = text('two writers, one file');
    const reserved = (await reserve(ws.person, ws.id, ws.general, { bytes })).body;
    // The first attempt starts and then waits on its body.
    const slow = new FixedLengthStream(bytes.length);
    const first = fileRequest(reserved.put.url, { method: 'PUT', body: slow.readable, length: bytes.length });
    expect(await until(async () => (await workspaceSql(ws.id, 'SELECT * FROM attempt')).length === 1)).toBe(true);
    // A second one finishes meanwhile.
    const second = await fileRequest(reserved.put.url, { method: 'PUT', body: bytes });
    expect(second.status).toBe(200);
    const [{ key: winner }] = await workspaceSql(ws.id, 'SELECT key FROM upload');
    // The first was covered by the reservation; with the second won, it is counted by itself.
    expect(await fileBytes(ws.id)).toBe(2 * bytes.length);
    // Once it is ready, the upload takes no new attempt.
    expect((await fileRequest(reserved.put.url, { method: 'PUT', body: bytes })).status).toBe(409);

    const writer = slow.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    const late = await first;
    expect(late.status).toBe(200);
    expect(late.body).toEqual({ upload: { id: reserved.upload.id, ready: true } });
    expect((await workspaceSql(ws.id, 'SELECT key FROM upload'))[0].key).toBe(winner);
    const trash = await workspaceSql(ws.id, 'SELECT key FROM trash');
    expect(trash).toHaveLength(1);
    expect(trash[0].key).not.toBe(winner);
    await alarm(ws.id);
    expect(await bucketKeys(ws.id)).toEqual([winner]);
    expect(await fileBytes(ws.id)).toBe(bytes.length);
  });

  it('refuses a link that is expired, forged or for another workspace, and an expired upload', async () => {
    const ws = await newWorkspace();
    const bytes = text('late');
    const reserved = (await reserve(ws.person, ws.id, ws.general, { bytes })).body;
    const f = reserved.upload.id;
    expect((await fileRequest(await signed(ws.id, { k: 'put', f, key: null, exp: Date.now() - 1 }), { method: 'PUT', body: bytes })).body.error).toBe('expired');
    const [payload, mac] = reserved.put.url.split('/files/')[1].split('.');
    // Another first character always changes the MAC's bytes; the last one carries only two bits, so "AA" there
    // could still decode to the real MAC.
    const forged = `https://accounts.example/v1/workspaces/${ws.id}/files/${payload}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
    expect((await fileRequest(forged, { method: 'PUT', body: bytes })).status).toBe(404);
    const other = await newWorkspace();
    const elsewhere = reserved.put.url.replace(ws.id, other.id);
    expect((await fileRequest(elsewhere, { method: 'PUT', body: bytes })).status).toBe(404);
    // A put link doesn't download, nor a get link upload.
    expect((await fileRequest(reserved.put.url)).status).toBe(404);

    await workspaceSql(ws.id, 'UPDATE upload SET expiresAt = ?', Date.now() - 1);
    const expired = await fileRequest(reserved.put.url, { method: 'PUT', body: bytes });
    expect(expired.status).toBe(409);
    expect(expired.body.error).toBe('invalid_state');
  });

  it('cancels an upload and its bytes leave the bucket', async () => {
    const ws = await newWorkspace();
    const bytes = text('never mind');
    const made = await upload(ws.person, ws.id, ws.general, { bytes });
    expect((await bucketKeys(ws.id)).length).toBe(1);
    const cancel = () => api('DELETE', `/v1/workspaces/${ws.id}/conversations/${ws.general}/uploads/${made.id}`, { token: ws.person.token });
    // Someone else's cancel does nothing.
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    expect((await api('DELETE', `/v1/workspaces/${ws.id}/conversations/${ws.general}/uploads/${made.id}`, { token: mila.person.token })).status).toBe(204);
    expect(await workspaceSql(ws.id, 'SELECT id FROM upload')).toHaveLength(1);
    expect((await cancel()).status).toBe(204);
    expect(await workspaceSql(ws.id, 'SELECT id FROM upload')).toEqual([]);
    expect((await cancel()).status).toBe(204);
    expect(await fileBytes(ws.id)).toBe(bytes.length);
    await alarm(ws.id);
    expect(await bucketKeys(ws.id)).toEqual([]);
    expect(await fileBytes(ws.id)).toBe(0);
    expect((await fileRequest(made.put.url, { method: 'PUT', body: bytes })).status).toBe(409);
  });

  it('lets an upload that nobody sent expire, and frees its bytes', async () => {
    const ws = await newWorkspace();
    const bytes = text('forgotten');
    await upload(ws.person, ws.id, ws.general, { bytes });
    await reserve(ws.person, ws.id, ws.general, { bytes });
    expect(await fileBytes(ws.id)).toBe(2 * bytes.length);
    // The reservation asked the alarm to come once it expires.
    const [{ expiresAt }] = await workspaceSql(ws.id, 'SELECT MAX(expiresAt) AS expiresAt FROM upload');
    expect(await alarmAt(ws.id)).toBeLessThanOrEqual(expiresAt + 1000);
    await workspaceSql(ws.id, 'UPDATE upload SET expiresAt = ?', Date.now() - 1);
    await alarm(ws.id);
    expect(await workspaceSql(ws.id, 'SELECT * FROM upload')).toEqual([]);
    expect(await bucketKeys(ws.id)).toEqual([]);
    expect(await fileBytes(ws.id)).toBe(0);
  });
});

describe('sending files', () => {
  it('binds ready uploads to a message, in order, and shows them on it', async () => {
    const ws = await newWorkspace();
    const image = await upload(ws.person, ws.id, ws.general, { bytes: text('png bytes'), name: 'chart.png', type: 'image/png', width: 1200, height: 630 });
    const pdf = await upload(ws.person, ws.id, ws.general, { bytes: text('%PDF-1.7'), name: 'report.pdf', type: 'application/pdf' });
    // A message of files alone may have no text.
    const sent = await post(ws.person, ws.id, ws.general, '', { attachments: [pdf.id, image.id] });
    expect(sent.status).toBe(201);
    const message = await messageIn(ws.person, ws, sent.body.messageId);
    expect(message).toMatchObject({
      text: '',
      attachments: [
        { id: pdf.id, name: 'report.pdf', type: 'application/pdf', size: 8 },
        { id: image.id, name: 'chart.png', type: 'image/png', size: 9, width: 1200, height: 630 }
      ],
      previews: [],
      reactions: []
    });
    expect(message.attachments[0]).not.toHaveProperty('width');
    expect(await workspaceSql(ws.id, 'SELECT state, pos FROM upload ORDER BY pos')).toEqual([
      { state: 'bound', pos: 0 },
      { state: 'bound', pos: 1 }
    ]);
    // Text alone still needs a byte.
    expect((await post(ws.person, ws.id, ws.general, '')).body.field).toBe('text');
  });

  it("gives a reader of version 1 the files' names as the text of a message without text", async () => {
    const ws = await newWorkspace();
    const pdf = await upload(ws.person, ws.id, ws.general, { bytes: text('%PDF-1.7'), name: 'report.pdf', type: 'application/pdf' });
    const image = await upload(ws.person, ws.id, ws.general, { bytes: text('png bytes'), name: 'chart.png', type: 'image/png' });
    const sent = (await post(ws.person, ws.id, ws.general, '', { attachments: [pdf.id, image.id] })).body;
    const withText = await upload(ws.person, ws.id, ws.general, { name: 'notes.txt' });
    const captioned = (await post(ws.person, ws.id, ws.general, 'The notes', { attachments: [withText.id] })).body;
    const named = { text: '📎 report.pdf, chart.png', mentions: [], attachments: [{ id: pdf.id }, { id: image.id }] };
    // No version named means 1.
    expect(await messageIn(ws.person, ws, sent.messageId, null)).toMatchObject(named);
    expect(await messageIn(ws.person, ws, sent.messageId, 1)).toMatchObject(named);
    expect(await messageIn(ws.person, ws, sent.messageId, 2)).toMatchObject({ text: '', mentions: [], attachments: named.attachments });
    expect((await messageIn(ws.person, ws, captioned.messageId, 1)).text).toBe('The notes');
    // The feed's events of the open room too.
    const inline = async (version) =>
      (await changes(ws.person, ws.id, `?active=${ws.general}`, version)).body.inlineEvents.find((e) => e.id === sent.messageId);
    expect((await inline(null)).text).toBe(named.text);
    expect((await inline(2)).text).toBe('');
    // What is stored doesn't change, and a removed message stays without text for either version.
    expect(await workspaceSql(ws.id, 'SELECT text FROM event WHERE seq = ?', sent.seq)).toEqual([{ text: '' }]);
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${sent.messageId}/redact`, { token: ws.person.token });
    expect(await messageIn(ws.person, ws, sent.messageId, 1)).not.toHaveProperty('text');
  });

  it('takes a post and a read from a Worker of an older build, and serves it version 1', async () => {
    const ws = await newWorkspace();
    const known = await access(ws.person, ws.id, ws.general);
    const operationId = uuidv7();
    const op = Uint8Array.from(operationId.replace(/-/g, '').match(/../g), (h) => parseInt(h, 16));
    const words = 'from before files';
    // What the Worker sent before files existed: no attachments.
    const posted = await workspaceStub(ws.id).request(ws.person.token, 'post', {
      conversation: ws.general,
      operationId,
      op,
      opTime: Date.now(),
      ...known,
      text: words,
      size: words.length,
      mentions: [],
      root: null
    });
    expect(posted.status).toBe(201);
    // And a read without readMark, and events without a version.
    const read = await workspaceStub(ws.id).request(ws.person.token, 'read', { conversation: ws.general, seq: posted.body.seq });
    expect(read.body).toEqual({ read: posted.body.seq, readMark: 0 });
    const files = await upload(ws.person, ws.id, ws.general, { name: 'a.txt' });
    const bare = (await post(ws.person, ws.id, ws.general, '', { attachments: [files.id] })).body;
    const page = await workspaceStub(ws.id).request(ws.person.token, 'events', { conversation: ws.general, after: 0, before: null, limit: 50 });
    expect(page.body.events.find((e) => e.id === posted.body.messageId)).toMatchObject({ text: words, attachments: [] });
    expect(page.body.events.find((e) => e.id === bare.messageId).text).toBe('📎 a.txt');
  });

  it('checks the list of files', async () => {
    const ws = await newWorkspace();
    const made = await upload(ws.person, ws.id, ws.general);
    for (const attachments of [made.id, [made.id, made.id], ['f_short'], [7], Array.from({ length: 11 }, () => made.id)]) {
      const res = await post(ws.person, ws.id, ws.general, 'x', { attachments });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('attachments');
    }
  });

  it('refuses files that are not ready, sent already, expired, for another room or someone else, and posts nothing', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const design = (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'design', visibility: 'workspace' } })).body.channel.id;
    const ready = await upload(ws.person, ws.id, ws.general);
    const waiting = (await reserve(ws.person, ws.id, ws.general)).body.upload.id;
    const theirs = (await upload(mila.person, ws.id, ws.general)).id;
    const otherRoom = (await upload(ws.person, ws.id, design)).id;
    const expired = (await upload(ws.person, ws.id, ws.general)).id;
    await workspaceSql(ws.id, 'UPDATE upload SET expiresAt = ? WHERE id = ?', Date.now() - 1, expired);
    const head = (await events(ws.person, ws.id, ws.general)).body.head;

    const res = await post(ws.person, ws.id, ws.general, 'files', { attachments: [ready.id, waiting, theirs, otherRoom, expired, 'f_AAAAAAAAAAAAAAAAAAAAAA'] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'files_unavailable', files: [waiting, theirs, otherRoom, expired, 'f_AAAAAAAAAAAAAAAAAAAAAA'] });
    expect((await events(ws.person, ws.id, ws.general)).body.head).toBe(head);
    expect((await workspaceSql(ws.id, 'SELECT state FROM upload WHERE id = ?', ready.id))[0].state).toBe('ready');

    // Sent once, a file is gone for a second message, but the retry of the first gets its first answer.
    const operationId = uuidv7();
    const first = await post(ws.person, ws.id, ws.general, 'once', { attachments: [ready.id], operationId });
    expect(first.status).toBe(201);
    const retry = await post(ws.person, ws.id, ws.general, 'once', { attachments: [ready.id], operationId });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    // The same operation with other files is a different message.
    expect((await post(ws.person, ws.id, ws.general, 'once', { operationId })).body.error).toBe('operation_conflict');
    const twice = await post(ws.person, ws.id, ws.general, 'twice', { attachments: [ready.id] });
    expect(twice.body).toMatchObject({ error: 'files_unavailable', files: [ready.id] });
  });

  it('keeps the retry of a message without files matching what it sent before files existed', async () => {
    const ws = await newWorkspace();
    const operationId = uuidv7();
    const first = await post(ws.person, ws.id, ws.general, 'plain', { operationId });
    // Its hash covers what it covered before: conversation, text, mentions and root.
    const [{ opHash }] = await workspaceSql(ws.id, 'SELECT opHash FROM event WHERE seq = ? AND conversation = (SELECT n FROM conversation WHERE id = ?)', first.body.seq, ws.general);
    const before = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(JSON.stringify([ws.general, 'plain', [], null])))).slice(0, 16);
    expect(new Uint8Array(opHash)).toEqual(before);
    expect((await post(ws.person, ws.id, ws.general, 'plain', { operationId, attachments: [] })).status).toBe(200);
  });
});

describe('downloading', () => {
  it('gives a member a link for 60 seconds, which serves the file as an attachment', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const bytes = text('%PDF-1.7 a report');
    const made = await upload(ws.person, ws.id, ws.general, { bytes, name: 'Résumé "final" ✓.pdf', type: 'application/pdf' });
    await post(ws.person, ws.id, ws.general, 'The report', { attachments: [made.id] });

    const link = await askDownload(mila.person, ws.id, ws.general, made.id);
    expect(link.status).toBe(200);
    expect(link.body).toEqual({
      url: expect.stringMatching(new RegExp(`^https://accounts\\.example/v1/workspaces/${ws.id}/files/`)),
      expiresAt: expect.any(Number),
      name: 'Résumé "final" ✓.pdf',
      type: 'application/pdf',
      size: bytes.length,
      sha256: await sha256hex(bytes)
    });
    expect(link.body.expiresAt - Date.now()).toBeGreaterThan(55 * 1000);
    expect(link.body.expiresAt - Date.now()).toBeLessThanOrEqual(60 * 1000);

    const got = await fileRequest(link.body.url);
    expect(got.status).toBe(200);
    expect(new TextDecoder().decode(got.bytes)).toBe('%PDF-1.7 a report');
    expect(Object.fromEntries(['content-type', 'content-disposition', 'content-length', 'x-content-type-options', 'content-security-policy', 'cache-control'].map((h) => [h, got.headers.get(h)]))).toEqual({
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="R_sum_ _final_ _.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22%20%E2%9C%93.pdf`,
      'content-length': String(bytes.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store'
    });
    // A link past its time says so; one that was never signed is nothing.
    const [, claims] = /\/files\/([^.]+)\./.exec(link.body.url);
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(claims.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
    expect(parsed).toMatchObject({ k: 'get', w: ws.id, f: made.id, exp: link.body.expiresAt });
    expect((await fileRequest(await signed(ws.id, { ...parsed, exp: Date.now() - 1 }))).status).toBe(410);
  });

  it('serves a type that could run in a browser as plain bytes', async () => {
    const ws = await newWorkspace();
    const html = await upload(ws.person, ws.id, ws.general, { bytes: text('<script>alert(1)</script>'), name: 'page.html', type: 'text/html' });
    const svg = await upload(ws.person, ws.id, ws.general, { bytes: text('<svg/>'), name: 'icon.svg', type: 'image/svg+xml' });
    const png = await upload(ws.person, ws.id, ws.general, { bytes: text('png'), name: 'a.png', type: 'image/png' });
    await post(ws.person, ws.id, ws.general, 'files', { attachments: [html.id, svg.id, png.id] });
    const typeOf = async (id) => (await fileRequest((await askDownload(ws.person, ws.id, ws.general, id)).body.url)).headers.get('content-type');
    expect(await typeOf(html.id)).toBe('application/octet-stream');
    expect(await typeOf(svg.id)).toBe('application/octet-stream');
    expect(await typeOf(png.id)).toBe('image/png');
  });

  it('gives no link for a file nobody can see', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const unsent = await upload(ws.person, ws.id, ws.general);
    expect((await askDownload(ws.person, ws.id, ws.general, unsent.id)).status).toBe(404);
    const made = await upload(ws.person, ws.id, ws.general);
    const sent = (await post(ws.person, ws.id, ws.general, 'see this', { attachments: [made.id] })).body;
    // Not through another room.
    const design = (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'design', visibility: 'workspace' } })).body.channel.id;
    expect((await askDownload(ws.person, ws.id, design, made.id)).status).toBe(404);
    // Not for someone outside the room.
    await api('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/me`, { token: mila.person.token });
    expect((await askDownload(mila.person, ws.id, ws.general, made.id)).body).toMatchObject({ error: 'not_found', scope: 'conversation' });
    // Not below the floor.
    await workspaceSql(ws.id, 'UPDATE conversation SET floor = ? WHERE id = ?', sent.seq + 1, ws.general);
    expect((await askDownload(ws.person, ws.id, ws.general, made.id)).status).toBe(404);
    await workspaceSql(ws.id, 'UPDATE conversation SET floor = 1 WHERE id = ?', ws.general);
    expect((await askDownload(ws.person, ws.id, ws.general, made.id)).status).toBe(200);
  });
});

describe('the trash', () => {
  it('takes the files of a removed message, and the bucket deletes them on the alarm', async () => {
    const ws = await newWorkspace();
    const bytes = text('soon gone');
    const made = await upload(ws.person, ws.id, ws.general, { bytes });
    const sent = (await post(ws.person, ws.id, ws.general, 'oops', { attachments: [made.id] })).body;
    const link = (await askDownload(ws.person, ws.id, ws.general, made.id)).body.url;
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${sent.messageId}/redact`, { token: ws.person.token });
    expect(await workspaceSql(ws.id, 'SELECT * FROM upload')).toEqual([]);
    expect(await workspaceSql(ws.id, 'SELECT size FROM trash')).toEqual([{ size: bytes.length }]);
    // Still counted until the delete happened.
    expect(await fileBytes(ws.id)).toBe(bytes.length);
    expect((await askDownload(ws.person, ws.id, ws.general, made.id)).status).toBe(404);
    // The removal asked for the alarm soon.
    expect((await alarmAt(ws.id)) - Date.now()).toBeLessThan(15 * 1000);
    await alarm(ws.id);
    expect(await bucketKeys(ws.id)).toEqual([]);
    expect(await fileBytes(ws.id)).toBe(0);
    expect((await fileRequest(link)).status).toBe(404);
  });

  it('keeps the trash and its count when the bucket fails, and tries again', async () => {
    const ws = await newWorkspace();
    const made = await upload(ws.person, ws.id, ws.general);
    await api('DELETE', `/v1/workspaces/${ws.id}/conversations/${ws.general}/uploads/${made.id}`, { token: ws.person.token });
    const next = await runInDurableObject(workspaceStub(ws.id), async (instance, state) => {
      const real = instance.env;
      const failing = {
        delete: async () => {
          throw new Error('bucket down');
        }
      };
      instance.env = { ...real, WORKSPACE_FILES: failing };
      try {
        await instance.alarm();
      } finally {
        instance.env = real;
      }
      return state.storage.getAlarm();
    });
    expect(await workspaceSql(ws.id, 'SELECT size FROM trash')).toEqual([{ size: 5 }]);
    expect(await fileBytes(ws.id)).toBe(5);
    expect(next - Date.now()).toBeGreaterThan(4 * 60 * 1000);
    await alarm(ws.id);
    expect(await workspaceSql(ws.id, 'SELECT * FROM trash')).toEqual([]);
    expect(await fileBytes(ws.id)).toBe(0);
  });

  it('takes the files of messages retention removes', async () => {
    const ws = await newWorkspace();
    const made = await upload(ws.person, ws.id, ws.general);
    await post(ws.person, ws.id, ws.general, 'old', { attachments: [made.id] });
    await workspaceSql(ws.id, 'UPDATE event SET at = ?', Date.now() - 100 * DAY);
    await alarm(ws.id);
    expect(await workspaceSql(ws.id, 'SELECT * FROM upload')).toEqual([]);
    expect(await bucketKeys(ws.id)).toEqual([]);
    expect(await fileBytes(ws.id)).toBe(0);
  });

  it('takes every file when the workspace is deleted', async () => {
    const ws = await newWorkspace();
    const sent = await upload(ws.person, ws.id, ws.general);
    await post(ws.person, ws.id, ws.general, 'kept', { attachments: [sent.id] });
    await upload(ws.person, ws.id, ws.general);
    const trashed = await upload(ws.person, ws.id, ws.general);
    await api('DELETE', `/v1/workspaces/${ws.id}/conversations/${ws.general}/uploads/${trashed.id}`, { token: ws.person.token });
    // And something under its prefix that no row names, such as a write that landed late.
    await env.WORKSPACE_FILES.put(`ws/${ws.id}/stray`, 'stray');
    expect((await bucketKeys(ws.id)).length).toBe(4);
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
    expect(await bucketKeys(ws.id)).toEqual([]);
  });

  it('keeps the workspace when the bucket fails while it is deleted, so the owner can try again', async () => {
    const ws = await newWorkspace();
    const made = await upload(ws.person, ws.id, ws.general);
    await post(ws.person, ws.id, ws.general, 'kept', { attachments: [made.id] });
    await env.WORKSPACE_FILES.put(`ws/${ws.id}/stray`, 'stray');
    // A bucket that lists one object a page and fails on its second delete, when the owner is still a member.
    await runInDurableObject(workspaceStub(ws.id), (instance) => {
      instance.realEnv = instance.env;
      const bucket = instance.env.WORKSPACE_FILES;
      let deletes = 0;
      const failing = {
        list: (options) => bucket.list({ ...options, limit: 1 }),
        delete: async (keys) => {
          if (++deletes === 1) return bucket.delete(keys);
          instance.during = await instance.membership(instance.sql.exec('SELECT incarnation FROM member').one().incarnation);
          throw new Error('bucket down');
        }
      };
      instance.env = { ...instance.env, WORKSPACE_FILES: failing };
    });
    const failed = await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
    const during = await runInDurableObject(workspaceStub(ws.id), (instance) => {
      instance.env = instance.realEnv;
      return instance.during;
    });
    expect(failed.status).toBe(503);
    expect(failed.body.error).toBe('unavailable');
    expect(failed.headers.get('retry-after')).toBe('30');
    expect(during.state).toBe('active');
    // Only the first batch went: the workspace, the owner's list and its routes still work.
    expect((await bucketKeys(ws.id)).length).toBe(1);
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(200);
    expect((await api('GET', '/v1/workspaces', { token: ws.person.token })).body.workspaces.map((w) => w.id)).toEqual([ws.id]);
    expect((await post(ws.person, ws.id, ws.general, 'still here')).status).toBe(201);
    // The next try deletes the files, then the workspace.
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
    expect(await bucketKeys(ws.id)).toEqual([]);
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(404);
  });

  it('answers 503 and changes nothing while a file of the workspace is being uploaded', async () => {
    const ws = await newWorkspace();
    await api('POST', `/v1/workspaces/${ws.id}/invites`, { token: ws.person.token, body: { role: 'member', channels: [ws.general] } });
    const bytes = text('on its way');
    const reserved = (await reserve(ws.person, ws.id, ws.general, { bytes })).body;
    const stuck = new FixedLengthStream(bytes.length);
    const pending = fileRequest(reserved.put.url, { method: 'PUT', body: stuck.readable, length: bytes.length });
    expect(await until(async () => (await workspaceSql(ws.id, 'SELECT * FROM attempt')).length === 1)).toBe(true);
    const busy = await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
    expect(busy.status).toBe(503);
    expect(busy.body.error).toBe('unavailable');
    expect(busy.headers.get('retry-after')).toBe('30');
    expect(await workspaceSql(ws.id, 'SELECT revokedAt FROM invite')).toEqual([{ revokedAt: null }]);
    const writer = stuck.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    expect((await pending).status).toBe(200);
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
    expect(await bucketKeys(ws.id)).toEqual([]);
  });

  it('counts an attempt that never reported back as dead after two hours', async () => {
    const ws = await newWorkspace();
    const bytes = text('abandoned');
    const reserved = (await reserve(ws.person, ws.id, ws.general, { bytes })).body;
    const stuck = new FixedLengthStream(bytes.length);
    const pending = fileRequest(reserved.put.url, { method: 'PUT', body: stuck.readable, length: bytes.length });
    expect(await until(async () => (await workspaceSql(ws.id, 'SELECT * FROM attempt')).length === 1)).toBe(true);
    await workspaceSql(ws.id, 'UPDATE attempt SET at = ?', Date.now() - 3 * 60 * 60 * 1000);
    await alarm(ws.id);
    expect(await workspaceSql(ws.id, 'SELECT * FROM attempt')).toEqual([]);
    // Its write lands after all: the key goes to the trash again, so it leaves nothing behind.
    const writer = stuck.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    const late = await pending;
    expect(late.status).toBe(409);
    expect((await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM trash'))[0].n).toBe(1);
    await alarm(ws.id);
    expect(await bucketKeys(ws.id)).toEqual([]);
  });

  it('deletes a write that lands while the workspace is deleted, after the listing went past its key', async () => {
    const ws = await newWorkspace();
    const bytes = text('later than two hours');
    const reserved = (await reserve(ws.person, ws.id, ws.general, { bytes })).body;
    const stuck = new FixedLengthStream(bytes.length);
    const pending = fileRequest(reserved.put.url, { method: 'PUT', body: stuck.readable, length: bytes.length });
    expect(await until(async () => (await workspaceSql(ws.id, 'SELECT * FROM attempt')).length === 1)).toBe(true);
    // Given up on as dead, which no longer holds a deletion back, and its key deleted from the trash.
    await workspaceSql(ws.id, 'UPDATE attempt SET at = ?', Date.now() - 3 * 60 * 60 * 1000);
    await alarm(ws.id);
    expect(await workspaceSql(ws.id, 'SELECT key FROM attempt UNION ALL SELECT key FROM trash')).toEqual([]);
    // A bucket whose listing, once it has listed, waits for the write to land and the workspace to hear how it ended.
    await runInDurableObject(workspaceStub(ws.id), (instance) => {
      const bucket = instance.env.WORKSPACE_FILES;
      const waiting = {
        list: async (options) => {
          const page = await bucket.list(options);
          instance.listed = true;
          while (instance.sql.exec('SELECT 1 FROM trash').toArray().length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
          return page;
        },
        delete: (keys) => bucket.delete(keys)
      };
      instance.env = { ...instance.env, WORKSPACE_FILES: waiting };
    });
    const deleted = api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
    expect(await until(() => runInDurableObject(workspaceStub(ws.id), (instance) => instance.listed === true))).toBe(true);
    const writer = stuck.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    expect((await deleted).status).toBe(204);
    // The workspace answered gone, so the Worker deleted the key itself.
    expect((await pending).status).toBe(409);
    expect(await bucketKeys(ws.id)).toEqual([]);
  });

  it('publishes no link cards while the workspace is deleted, and leaves their images to the Worker to delete', async () => {
    const ws = await newWorkspace();
    const sent = (await post(ws.person, ws.id, ws.general, 'cards soon')).body;
    const stub = workspaceStub(ws.id);
    const image = await stub.previewKey(ws.general, sent.messageId, 3);
    const failed = await stub.previewKey(ws.general, sent.messageId, 2);
    const card = {
      url: 'https://example.com/',
      title: 'Example',
      description: null,
      site: null,
      image: { key: image, type: 'image/png', ext: 'png', size: 3, sha256: 'a'.repeat(64), width: 1, height: 1 },
      video: false
    };
    const answer = await runInDurableObject(stub, async (instance) => {
      instance.deleting += 1;
      try {
        return await instance.publishPreviews(ws.general, sent.messageId, [card], [{ key: failed, size: 2 }]);
      } finally {
        instance.deleting -= 1;
      }
    });
    expect(answer).toEqual({ published: false, gone: true });
    expect(await workspaceSql(ws.id, "SELECT previews FROM event WHERE kind = 'message.posted'")).toEqual([{ previews: null }]);
    expect(await workspaceSql(ws.id, 'SELECT key FROM attempt')).toEqual([]);
    expect(await workspaceSql(ws.id, 'SELECT key FROM trash ORDER BY key')).toEqual([image, failed].sort().map((key) => ({ key })));
  });
});

describe('without a bucket', () => {
  it('offers no files and answers files_off on every file route', async () => {
    const info = await api('GET', '/v1/info', { vars: OFF });
    expect(info.body.workspace.capabilities).toEqual(['reactions', 'unread', 'previews', 'agents', 'push-wake']);
    expect(info.body.workspace).not.toHaveProperty('files');
    expect((await api('GET', '/v1/info', { vars: { ...OFF, WORKSPACE_PREVIEWS: 'off' } })).body.workspace.capabilities).toEqual(['reactions', 'unread', 'agents', 'push-wake']);

    const ws = await newWorkspace();
    const made = await upload(ws.person, ws.id, ws.general);
    const off = async (res) => {
      const r = await res;
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('files_off');
    };
    await off(reserve(ws.person, ws.id, ws.general, {}, OFF));
    await off(api('DELETE', `/v1/workspaces/${ws.id}/conversations/${ws.general}/uploads/${made.id}`, { token: ws.person.token, vars: OFF }));
    await off(askDownload(ws.person, ws.id, ws.general, made.id, OFF));
    await off(fileRequest(made.put.url, { method: 'PUT', body: text('hello'), vars: OFF }));
    await off(fileRequest(made.put.url, { vars: OFF }));
    const body = { ...(await access(ws.person, ws.id, ws.general)), operationId: uuidv7(), text: 'with a file', attachments: [made.id] };
    await off(api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages`, { token: ws.person.token, body, vars: OFF }));
    // Without files, messages work as before.
    const plain = { ...body, operationId: uuidv7(), attachments: [] };
    expect((await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages`, { token: ws.person.token, body: plain, vars: OFF })).status).toBe(201);
  });
});
