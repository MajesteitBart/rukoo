// Link cards: which addresses the server fetches, how it reads a page and its image, and how cards reach a message
// and leave it (WORKSPACES.md, Rich messages). The pages come from test/fixtures/preview-pages.cjs on 127.0.0.1, which
// WORKSPACE_PREVIEW_HOSTS lets the Worker reach.

import { env } from 'cloudflare:workers';
import { describe, expect, inject, it } from 'vitest';
import { allowed, clean, decodeEntities, imageInfo, previewAddresses, trimAddress } from '../src/previews.js';
import {
  api,
  askDownload,
  events,
  fileRequest,
  newMember,
  newWorkspace,
  sendAndWait,
  sync,
  uuidv7,
  workspaceSql,
  workspaceStub
} from './workspace-helpers.js';

const ORIGIN = inject('previewOrigin');
const HERE = { WORKSPACE_PREVIEW_HOSTS: inject('previewHost') };
const RULES = { own: new Set(['accounts.example']), exempt: new Set() };

// A page on the fixture server, from a spec as preview-pages.cjs takes it.
async function page(spec) {
  const res = await fetch(`${ORIGIN}/pages`, { method: 'POST', body: JSON.stringify(spec) });
  return (await res.json()).url;
}

const hits = async (url) => (await (await fetch(`${ORIGIN}/hits?path=${encodeURIComponent(new URL(url).pathname)}`)).json()).hits;

// Posts text with the fixture reachable and waits until the cards are made: the message and its cards.
async function postLinks(ws, text, vars = {}, person = ws.person) {
  const sent = await sendAndWait(person, ws.id, ws.general, { text }, { ...HERE, ...vars });
  expect(sent.status).toBe(201);
  const log = (await events(person, ws.id, ws.general)).body.events;
  const message = log.find((e) => e.id === sent.body.messageId);
  const previewed = log.filter((e) => e.kind === 'message.previewed' && e.target === sent.body.messageId);
  return { sent: sent.body, message, previewed, log };
}

describe('which addresses', () => {
  it('finds http and https addresses that end at white space, without the punctuation after them', () => {
    const text =
      'See https://example.com/a. Also (https://example.org/b), "https://example.net/c?x=1"! ' +
      'and https://en.wikipedia.org/wiki/Foo_(bar) https://example.com/d';
    expect(previewAddresses(text, RULES)).toEqual(['https://example.com/a', 'https://example.org/b', 'https://example.net/c?x=1']);
    expect(previewAddresses('[the plan](https://example.com/plan) <https://example.org/x>', RULES)).toEqual(['https://example.com/plan', 'https://example.org/x']);
    expect(trimAddress('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(trimAddress("https://example.com/x)]}>.,:;!?'\"")).toBe('https://example.com/x');
    // Not in the middle of a word, and each address once.
    expect(previewAddresses('foohttps://example.com x', RULES)).toEqual([]);
    expect(previewAddresses('https://example.com https://EXAMPLE.com/ https://example.com/#top', RULES)).toEqual(['https://example.com', 'https://example.com/#top']);
    // Three at most, counting only the ones that may be fetched.
    expect(previewAddresses('http://localhost/ https://a.example/ https://b.example/ https://c.example/ https://d.example/', RULES)).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://c.example/'
    ]);
  });

  it('refuses local, private and odd addresses, and this server itself', () => {
    const refused = [
      'ftp://example.com/',
      'http://user:pass@example.com/',
      'http://user@example.com/',
      'https://example.com:8443/',
      'http://example.com:443/',
      'http://localhost/',
      'http://localhost./',
      'http://app.localhost/',
      'http://printer.local/',
      'http://db.internal/',
      'http://intranet/',
      'http://127.0.0.1/',
      'http://127.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://0.0.0.0/',
      'http://10.1.2.3/',
      'http://100.64.0.1/',
      'http://100.127.255.255/',
      'http://169.254.169.254/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.1/',
      'http://224.0.0.1/',
      'http://255.255.255.255/',
      'http://[::]/',
      'http://[::1]/',
      'http://[fc00::1]/',
      'http://[fd12:3456::1]/',
      'http://[fe80::1]/',
      'http://[ff02::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:10.0.0.1]/',
      'http://[64:ff9b::a00:1]/',
      'http://[2002:a00:1::]/',
      'https://accounts.example/v1/info',
      'https://ACCOUNTS.example./x'
    ];
    for (const address of refused) expect(allowed(new URL(address), RULES), address).toBe(false);
    const fine = [
      'https://example.com/',
      'http://example.com:80/',
      'https://93.184.215.14/',
      'http://172.32.0.1/',
      'http://100.128.0.1/',
      'http://[2606:4700::1111]/',
      'http://[::ffff:8.8.8.8]/',
      'https://www.rukoo.io/'
    ];
    for (const address of fine) expect(allowed(new URL(address), RULES), address).toBe(true);
    // The test exemption names a host and port, and nothing else.
    const exempt = { own: RULES.own, exempt: new Set(['127.0.0.1:8080']) };
    expect(allowed(new URL('http://127.0.0.1:8080/page'), exempt)).toBe(true);
    expect(allowed(new URL('http://127.0.0.1:8081/page'), exempt)).toBe(false);
    expect(allowed(new URL('http://127.0.0.1/page'), exempt)).toBe(false);
  });
});

describe('reading a page', () => {
  it('decodes character references and keeps text short and on one line', () => {
    expect(decodeEntities('A &amp; B &lt;b&gt; &quot;q&quot; &#39;s &#x1F600; &eacute;t&eacute; &bogus; &#0;')).toBe('A & B <b> "q" \'s 😀 été &bogus; \ufffd');
    expect(clean('  Two\n\tlines &amp;\u0007 more  ', 100)).toBe('Two lines & more');
    const cut = clean('word '.repeat(60), 200);
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut.endsWith('…')).toBe(true);
    expect(clean('😀'.repeat(150), 100)).toBe(`${'😀'.repeat(99)}…`);
    expect(clean('exactly', 7)).toBe('exactly');
  });

  it('reads the size of PNG, GIF, JPEG and WebP images from their headers', () => {
    const bytes = (...parts) => Uint8Array.from(parts.flat());
    const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), ascii('IHDR'), be32(1200), be32(630), [8, 2, 0, 0, 0]);
    expect(imageInfo(png)).toEqual({ type: 'image/png', width: 1200, height: 630 });
    const gif = bytes(ascii('GIF89a'), [0x40, 0x01, 0xf0, 0x00], [0, 0, 0]);
    expect(imageInfo(gif)).toEqual({ type: 'image/gif', width: 320, height: 240 });
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const sof = [0xff, 0xc2, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    expect(imageInfo(bytes([0xff, 0xd8], app0, sof, [0xff, 0xd9]))).toEqual({ type: 'image/jpeg', width: 640, height: 480 });
    const riff = (chunk, body) => bytes(ascii('RIFF'), [0, 0, 0, 0], ascii('WEBP'), ascii(chunk), [0, 0, 0, 0], body);
    expect(imageInfo(riff('VP8X', [0, 0, 0, 0, 0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]))).toEqual({ type: 'image/webp', width: 640, height: 480 });
    const lossless = 799 | (599 << 14);
    expect(imageInfo(riff('VP8L', [0x2f, lossless & 255, (lossless >> 8) & 255, (lossless >> 16) & 255, (lossless >>> 24) & 255, 0, 0, 0, 0, 0]))).toEqual({
      type: 'image/webp',
      width: 800,
      height: 600
    });
    expect(imageInfo(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]))).toEqual({ type: 'image/webp', width: 640, height: 480 });
    expect(imageInfo(bytes(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBeNull();
  });
});

describe('making cards', () => {
  it('makes a card of a page, with its image as a file of the message', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const url = await page({ title: 'Q3 &amp; the plan', description: 'All &quot;about&quot; it', site: 'Example News', image: { width: 1200, height: 630 } });
    const before = (await sync(mila.person, ws.id)).rooms.get(ws.general);
    const { sent, message, previewed } = await postLinks(ws, `Read this: ${url}.`);
    const card = {
      url,
      title: 'Q3 & the plan',
      description: 'All "about" it',
      site: 'Example News',
      image: { id: expect.stringMatching(/^f_/), name: 'preview.png', type: 'image/png', size: expect.any(Number), width: 1200, height: 630 },
      video: false
    };
    expect(message.previews).toEqual([card]);
    // The image is no attachment of the message.
    expect(message.attachments).toEqual([]);
    expect(previewed).toEqual([
      { seq: sent.seq + 1, id: expect.stringMatching(/^e_/), kind: 'message.previewed', actor: ws.me.id, at: expect.any(Number), target: sent.messageId, targetSeq: sent.seq, previews: [card] }
    ]);
    // A card is no activity: Mila's room has the message unread, and lastAt is the message's.
    const after = (await sync(mila.person, ws.id)).rooms.get(ws.general);
    expect(after).toMatchObject({ unread: before.unread + 1, head: sent.seq + 1, lastAt: message.at });
    // Any member downloads the image like a file.
    const link = await askDownload(mila.person, ws.id, ws.general, message.previews[0].image.id);
    expect(link.body).toMatchObject({ name: 'preview.png', type: 'image/png', size: message.previews[0].image.size });
    const got = await fileRequest(link.body.url);
    expect([...got.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect((await workspaceSql(ws.id, 'SELECT fileBytes FROM workspace'))[0].fileBytes).toBe(message.previews[0].image.size);
  });

  it('falls back to the title tag and the host, cuts long text and marks a video', async () => {
    const ws = await newWorkspace();
    const plain = await page({ titleTag: 'Only a &lt;title&gt;' });
    const long = await page({ title: 'T'.repeat(300), description: 'd '.repeat(400), site: 'S'.repeat(150) });
    const video = await page({ title: 'A clip', type: 'video.other' });
    const { message } = await postLinks(ws, `${plain} ${long} ${video}`);
    expect(message.previews.map((p) => p.url)).toEqual([plain, long, video]);
    expect(message.previews[0]).toEqual({ url: plain, title: 'Only a <title>', description: '', site: '127.0.0.1', image: null, video: false });
    expect(Array.from(message.previews[1].title)).toHaveLength(200);
    expect(Array.from(message.previews[1].description)).toHaveLength(500);
    expect(Array.from(message.previews[1].site)).toHaveLength(100);
    expect(message.previews[1].title.endsWith('…')).toBe(true);
    expect(message.previews[2].video).toBe(true);
    const tagged = await page({ title: 'Another clip', video: true });
    expect((await postLinks(ws, tagged)).message.previews[0].video).toBe(true);
  });

  it('makes no card of a page without a title, a page that is no HTML, or a page that failed', async () => {
    const ws = await newWorkspace();
    const untitled = await page({ description: 'No title here' });
    const { message, previewed } = await postLinks(ws, `${untitled} ${ORIGIN}/text ${ORIGIN}/missing`);
    expect(previewed).toEqual([]);
    expect(message.previews).toEqual([]);
  });

  it('makes cards of the first three distinct addresses, in their order', async () => {
    const ws = await newWorkspace();
    const urls = [];
    for (const n of [1, 2, 3, 4]) urls.push(await page({ title: `Page ${n}` }));
    const { message } = await postLinks(ws, `${urls[0]} ${urls[1]} ${urls[0]} ${urls[2]} ${urls[3]}`);
    expect(message.previews.map((p) => p.title)).toEqual(['Page 1', 'Page 2', 'Page 3']);
    expect(await hits(urls[3])).toBe(0);
  });

  it('follows three redirects, each checked by the same rules', async () => {
    const ws = await newWorkspace();
    const target = await page({ title: 'Moved here' });
    const redirect = `${ORIGIN}/redirect?to=${encodeURIComponent(target)}`;
    const { message } = await postLinks(ws, `${ORIGIN}/chain/3 ${redirect}`);
    expect(message.previews.map((p) => [p.url, p.title])).toEqual([
      [`${ORIGIN}/chain/3`, 'End of the chain'],
      [redirect, 'Moved here']
    ]);
    const refused = await postLinks(ws, `${ORIGIN}/chain/4 ${ORIGIN}/redirect?to=${encodeURIComponent('http://10.0.0.1/')} ${ORIGIN}/redirect?to=${encodeURIComponent('https://accounts.example/v1/info')}`);
    expect(refused.previewed).toEqual([]);
  });

  it('keeps an image only when it is a small PNG, JPEG, GIF or WebP that may be fetched', async () => {
    const ws = await newWorkspace();
    const original = await page({ title: 'Has an image', image: true });
    const imagePath = new URL(original).pathname + '.png';
    const relative = await page({ title: 'Relative image', image: imagePath });
    const svg = await page({ title: 'SVG image', image: `${ORIGIN}/image.svg` });
    const big = await page({ title: 'Big image', image: `${ORIGIN}/big.png` });
    const { message } = await postLinks(ws, `${relative} ${svg} ${big}`);
    expect(message.previews.map((p) => [p.title, p.image && [p.image.width, p.image.height]])).toEqual([
      ['Relative image', [64, 32]],
      ['SVG image', null],
      ['Big image', null]
    ]);
    const local = await page({ title: 'Local image', image: 'http://10.0.0.1/x.png' });
    expect((await postLinks(ws, local)).message.previews[0].image).toBeNull();
  });

  it('makes cards without images when files are off or the workspace is out of room', async () => {
    const ws = await newWorkspace();
    const url = await page({ title: 'Pictured', image: true });
    expect((await postLinks(ws, url, { WORKSPACE_FILES: undefined })).message.previews[0]).toMatchObject({ title: 'Pictured', image: null });
    await workspaceSql(ws.id, 'UPDATE workspace SET fileBytes = ?', 5368709120 - 10);
    expect((await postLinks(ws, url)).message.previews[0]).toMatchObject({ title: 'Pictured', image: null });
    expect(await workspaceSql(ws.id, 'SELECT * FROM attempt')).toEqual([]);
  });

  it('fetches nothing when cards are off, for a retry, or for this server', async () => {
    const ws = await newWorkspace();
    const url = await page({ title: 'Quiet' });
    const off = await postLinks(ws, url, { WORKSPACE_PREVIEWS: 'off' });
    expect(off.previewed).toEqual([]);
    expect(await hits(url)).toBe(0);

    const operationId = uuidv7();
    const first = await sendAndWait(ws.person, ws.id, ws.general, { text: url, operationId }, HERE);
    expect(first.status).toBe(201);
    expect(await hits(url)).toBe(1);
    const retry = await sendAndWait(ws.person, ws.id, ws.general, { text: url, operationId }, HERE);
    expect(retry.status).toBe(200);
    expect(await hits(url)).toBe(1);

    expect((await postLinks(ws, 'https://accounts.example/v1/info')).previewed).toEqual([]);
  });
});

describe('cards on a message', () => {
  it('lets the author take a card off, and its image goes', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const first = await page({ title: 'First', image: true });
    const second = await page({ title: 'Second' });
    const { sent, message } = await postLinks(ws, `${first} ${second}`);
    const remove = (person, url) =>
      api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${sent.messageId}/previews`, { token: person.token, body: { remove: url } });

    const theirs = await remove(mila.person, first);
    expect(theirs.status).toBe(403);
    expect(theirs.body.error).toBe('forbidden');

    const head = (await events(ws.person, ws.id, ws.general)).body.head;
    const res = await remove(ws.person, first);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ previews: [message.previews[1]] });
    const log = (await events(ws.person, ws.id, ws.general, `?after=${head}`)).body.events;
    expect(log).toEqual([
      expect.objectContaining({ kind: 'message.previewed', actor: ws.me.id, target: sent.messageId, targetSeq: sent.seq, previews: [message.previews[1]] })
    ]);
    expect((await askDownload(ws.person, ws.id, ws.general, message.previews[0].image.id)).status).toBe(404);
    expect(await workspaceSql(ws.id, 'SELECT size FROM trash')).toEqual([{ size: message.previews[0].image.size }]);
    // Taking away a card that isn't there changes nothing.
    expect((await remove(ws.person, first)).body).toEqual({ previews: [message.previews[1]] });
    expect((await events(ws.person, ws.id, ws.general)).body.head).toBe(head + 1);
    expect((await remove(ws.person, 7)).body.field).toBe('remove');
  });

  it('never gives cards to a message that was removed, or whose author took one away', async () => {
    const ws = await newWorkspace();
    const stub = workspaceStub(ws.id);
    const card = (image) => ({ url: 'https://example.com/', title: 'Late', description: '', site: 'example.com', video: false, image });

    // Cards still being made when the message is removed: the image they stored goes to the trash.
    const gone = (await sendAndWait(ws.person, ws.id, ws.general, { text: 'soon gone' })).body;
    const key = await stub.previewKey(ws.general, gone.messageId, 3);
    expect(key).toMatch(new RegExp(`^ws/${ws.id}/`));
    await env.WORKSPACE_FILES.put(key, 'png');
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${gone.messageId}/redact`, { token: ws.person.token });
    expect(await stub.previewKey(ws.general, gone.messageId, 3)).toBeNull();
    const image = { key, type: 'image/png', ext: 'png', size: 3, sha256: '0'.repeat(64), width: 1, height: 1 };
    expect(await stub.publishPreviews(ws.general, gone.messageId, [card(image)], [])).toEqual({ published: false });
    expect(await workspaceSql(ws.id, 'SELECT key FROM trash')).toEqual([{ key }]);
    expect(await workspaceSql(ws.id, 'SELECT * FROM attempt')).toEqual([]);

    // The author took cards away before any came.
    const kept = (await sendAndWait(ws.person, ws.id, ws.general, { text: 'no cards please' })).body;
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${kept.messageId}/previews`, { token: ws.person.token, body: { remove: 'https://example.com/' } });
    expect(await stub.publishPreviews(ws.general, kept.messageId, [card(null)], [])).toEqual({ published: false });
    const log = (await events(ws.person, ws.id, ws.general)).body.events;
    expect(log.filter((e) => e.kind === 'message.previewed')).toEqual([]);

    // Cards come once.
    const once = (await sendAndWait(ws.person, ws.id, ws.general, { text: 'once' })).body;
    expect((await stub.publishPreviews(ws.general, once.messageId, [card(null)], [])).published).toBe(true);
    expect((await stub.publishPreviews(ws.general, once.messageId, [card(null)], [])).published).toBe(false);
  });

  it('removes the cards and their images with the message', async () => {
    const ws = await newWorkspace();
    const url = await page({ title: 'With image', image: true });
    const { sent, message } = await postLinks(ws, url);
    expect(message.previews[0].image).not.toBeNull();
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${sent.messageId}/redact`, { token: ws.person.token });
    expect(await workspaceSql(ws.id, 'SELECT * FROM upload')).toEqual([]);
    expect(await workspaceSql(ws.id, 'SELECT size FROM trash')).toEqual([{ size: message.previews[0].image.size }]);
    const log = (await events(ws.person, ws.id, ws.general)).body.events;
    expect(log.find((e) => e.id === sent.messageId)).toEqual({ seq: sent.seq, id: sent.messageId, kind: 'message.posted', actor: ws.me.id, at: message.at, redacted: true });
    // The event that announced the cards keeps its place and loses the address and title they held.
    const announced = log.filter((e) => e.kind === 'message.previewed');
    expect(announced).toEqual([expect.objectContaining({ target: sent.messageId, targetSeq: sent.seq, previews: [] })]);
    expect(JSON.stringify(log)).not.toContain(url);
  });
});
