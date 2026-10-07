'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/main/engine');
const { Logos, siteOf } = require('../src/main/logos');

async function freshEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-test-'));
  const engine = new Engine({ dataDir: dir }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  return { engine, acc };
}

test('newsletters expose their unsubscribe link, personal mail does not', async () => {
  const { engine, acc } = await freshEngine();
  const inbox = engine.listMessages({ scope: acc.id, view: 'inbox' });
  const letter = await engine.getMessage(inbox.find((m) => m.from.name === 'ANWB Newsletter').id);
  assert.deepEqual(letter.unsubscribe, { url: 'https://example.com/unsubscribe', mail: null, oneClick: true });
  const personal = await engine.getMessage(inbox.find((m) => m.from.name === 'Sanne de Vries').id);
  assert.equal(personal.unsubscribe, null);
  await engine.close();
});

test('folders can be created, and names are checked', async () => {
  const { engine, acc } = await freshEngine();
  const created = await engine.createFolder(acc.id, '  Projects ');
  assert.equal(created, 'Projects');
  assert.ok(engine.state().accounts[0].folders.some((f) => f.path === 'Projects' && f.role === null));
  await engine.openFolder(acc.id, 'Projects');
  assert.deepEqual(engine.listMessages({ scope: acc.id, view: 'folder', folder: 'Projects' }), []);
  await assert.rejects(engine.createFolder(acc.id, 'projects'), /already exists/);
  await assert.rejects(engine.createFolder(acc.id, 'a/b'), /cannot contain/);
  await assert.rejects(engine.createFolder(acc.id, '   '), /name/);
  await engine.close();
});

test('logos come from the sender\'s own site; free-mail senders keep initials', () => {
  assert.equal(siteOf('newsletter@anwb.nl'), 'anwb.nl');
  assert.equal(siteOf('news@mail.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(siteOf('sanne@gmail.com'), null);
  assert.equal(siteOf('iemand@ziggo.nl'), null);
  assert.equal(siteOf('geen-adres'), null);
});

test('logos are cached, failures are remembered, and nothing but images is kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-logos-'));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
  const calls = [];
  const getImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://merk.nl/apple-touch-icon.png')) return png;
    if (url.includes('html.nl')) return Buffer.from('<html>'.padEnd(200, ' '));
    return null;
  };
  const logos = new Logos(dir, { getImpl });
  const first = await logos.get(['merk.nl', 'html.nl', 'leeg.nl']);
  assert.match(first['merk.nl'], /^data:image\/png;base64,/);
  assert.equal(first['html.nl'], null, 'an html page is not an icon');
  assert.equal(first['leeg.nl'], null);
  const before = calls.length;
  const again = await new Logos(dir, { getImpl }).get(['merk.nl', 'html.nl', 'leeg.nl']);
  assert.equal(calls.length, before, 'served from the cache, failures included');
  assert.equal(again['merk.nl'], first['merk.nl']);
});
