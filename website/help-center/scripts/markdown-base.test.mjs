// node --test scripts/markdown-base.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownBase, withBase } from './markdown-base.mjs';

test('root-relative URLs get the /help base; everything else stays', () => {
  const cases = {
    '/mail/write/': '/help/mail/write/',
    '/mail/write/#start-the-message': '/help/mail/write/#start-the-message',
    '/': '/help/',
    '/help/start/install/': '/help/start/install/',
    '/help': '/help',
    '/helpful/': '/help/helpful/',
    'https://github.com/MajesteitBart/rukoo': 'https://github.com/MajesteitBart/rukoo',
    '//cdn.example.com/x': '//cdn.example.com/x',
    '#local': '#local',
    '../relative/': '../relative/',
  };
  for (const [from, to] of Object.entries(cases)) assert.equal(withBase(from, '/help'), to, from);
  assert.equal(withBase('/start/install/', '/help/'), '/help/start/install/');
  assert.equal(withBase(undefined, '/help'), undefined);
});

test('the plugin rewrites href on links and src on images', () => {
  const plugin = markdownBase('/help');
  assert.deepEqual(plugin.element.filter, ['a', 'img']);
  const set = [];
  const ctx = { setProperty: (node, key, value) => set.push([node.tagName, key, value]) };
  plugin.element.visit({ type: 'element', tagName: 'a', properties: { href: '/mail/search/' } }, ctx);
  plugin.element.visit({ type: 'element', tagName: 'img', properties: { src: '/img/shot.png' } }, ctx);
  plugin.element.visit({ type: 'element', tagName: 'a', properties: { href: 'https://rukoo.io/' } }, ctx);
  assert.deepEqual(set, [['a', 'href', '/help/mail/search/'], ['img', 'src', '/help/img/shot.png']]);
});
