// node --test scripts/publish.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { inlineScripts, pagePolicies, pagePolicy, scriptHash, withPolicy } from './publish.mjs';

const sha = (s) => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
const page = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>T</title><script>a()</script>'
  + '<script type="module" src="/help/_astro/x.js"></script><script type="module">b()</script><script> </script></head>'
  + '<body><script aria-hidden="true">a()</script></body></html>';

test('inline scripts are the ones with a body and without src', () => {
  assert.deepEqual(inlineScripts(page), ['a()', 'b()', 'a()']);
  assert.equal(scriptHash('a()'), sha('a()'));
});

test('the policy lists each inline script once, sorted, after the site and WebAssembly sources', () => {
  const hashes = [sha('a()'), sha('b()')].sort();
  assert.equal(pagePolicy(page), `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`);
  assert.equal(pagePolicy('<head></head>'), "script-src 'self' 'wasm-unsafe-eval'");
});

test('the policy goes right after <meta charset>, before every script, and a rebuild replaces it', () => {
  const once = withPolicy(page);
  assert.ok(once.startsWith(`<!DOCTYPE html><html><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="${pagePolicy(page)}">`));
  assert.ok(once.indexOf('Content-Security-Policy') < once.indexOf('<script'));
  assert.deepEqual(pagePolicies(once), [pagePolicy(page)]);
  assert.equal(withPolicy(once), once);
  assert.match(withPolicy('<html><head><title>T</title></head></html>'), /^<html><head><meta http-equiv="Content-Security-Policy"/);
  assert.throws(() => withPolicy('<html><body></body></html>'), /without <head>/);
});
