'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { windowChrome, MailtoQueue, MacMailClient, macMenu } = require('../src/main/desktop');
const { t } = require('../src/i18n');

test('Mac windows reserve native traffic lights and do not request unsupported title overlays', () => {
  const bar = { color: '#000000', height: 40 };
  assert.deepEqual(windowChrome('darwin', bar), { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 13 } });
  for (const platform of ['win32', 'linux']) assert.equal(windowChrome(platform, bar).titleBarOverlay, bar);
});

test('email URLs arriving before ready are queued once and later URLs open immediately', () => {
  const opened = [];
  const queue = new MailtoQueue((url) => opened.push(url));
  assert.equal(queue.accept('https://example.com'), false);
  assert.equal(queue.accept(null), false);
  assert.equal(queue.accept('mailto:first@example.com'), true);
  queue.accept('mailto:second@example.com?subject=Hello');
  assert.deepEqual(opened, []);
  queue.start();
  queue.start();
  queue.accept('mailto:third@example.com');
  assert.deepEqual(opened, ['mailto:first@example.com', 'mailto:second@example.com?subject=Hello', 'mailto:third@example.com']);
});

test('Mac default mail registration is explicit and never changes a source or isolated installation', () => {
  let writes = 0;
  const app = { isPackaged: false, getApplicationNameForProtocol: () => 'Mail', isDefaultProtocolClient: () => false, setAsDefaultProtocolClient: (scheme) => { assert.equal(scheme, 'mailto'); writes++; return true; } };
  assert.equal(new MacMailClient(app).register(), false);
  app.isPackaged = true;
  assert.equal(new MacMailClient(app, true).register(), false);
  assert.equal(writes, 0);
  const client = new MacMailClient(app);
  assert.deepEqual(client.status(), { available: true, app: 'Mail', rukoo: false, platform: 'darwin' });
  assert.equal(client.register(), true);
  assert.equal(writes, 1);
});

test('Mac menus retain native quit, editing and window actions while routing mail shortcuts', () => {
  const actions = [];
  const menu = macMenu(t, (action) => actions.push(action));
  assert.equal(menu[0].role, 'appMenu');
  const edit = menu[1].submenu;
  for (const item of edit.filter((item) => item.click)) item.click();
  assert.deepEqual(actions, ['undo', 'redo', 'selectAll']);
  assert.ok(edit.some((item) => item.role === 'copy'));
  assert.ok(menu[2].submenu.some((item) => item.role === 'close'));
});
