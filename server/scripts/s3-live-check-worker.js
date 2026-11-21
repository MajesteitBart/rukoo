// The Worker scripts/s3-live-check.mjs runs, because the S3 store needs the Workers runtime (FixedLengthStream,
// crypto.DigestStream). GET /run puts a few small objects under live-check/<random>/ in the configured bucket, checks
// each step and deletes them again. Its answer names each step and whether it passed, nothing else: no key, no
// setting, no error text.

import { DigestMismatch, fileStore } from '../src/filestore.js';

const text = (s) => new TextEncoder().encode(s);
const hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

// A stream of exactly these bytes, as files.js hands an upload to the store.
function streamOf(bytes) {
  const fixed = new FixedLengthStream(bytes.length);
  const writer = fixed.writable.getWriter();
  writer.write(bytes).then(() => writer.close());
  return fixed.readable;
}

async function listAll(store, prefix, limit) {
  const keys = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await store.list({ prefix, cursor, limit });
    keys.push(...page.keys);
    cursor = page.cursor;
    pages += 1;
  } while (cursor && pages < 50);
  return { keys, pages };
}

function check(condition) {
  if (!condition) throw new Error('check failed');
}

async function checks(env) {
  const results = [];
  const step = async (name, work) => {
    try {
      await work();
      results.push({ step: name, ok: true });
    } catch {
      results.push({ step: name, ok: false });
    }
  };
  const store = env.WORKSPACE_FILES ? null : fileStore(env);
  await step('the five settings make an S3 store', () => check(store !== null));
  if (!store) return results;

  const random = [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const prefix = `live-check/${random}/`;
  const first = text('Rukoo live check: the first object.');
  const firstKey = `${prefix}first`;
  const wrongKey = `${prefix}wrong-digest`;
  const others = [1, 2, 3, 4].map((n) => [`${prefix}page-${n}`, text(`Rukoo live check: object ${n}.`)]);
  try {
    await step('put with the right SHA-256', async () => {
      await store.put(firstKey, streamOf(first), { size: first.length, sha256: await hex(first), contentType: 'text/plain', name: 'live check ✓.txt' });
    });
    await step('put with a wrong SHA-256 is refused', async () => {
      const bytes = text('Rukoo live check: bytes that do not match.');
      const refused = await store
        .put(wrongKey, streamOf(bytes), { size: bytes.length, sha256: await hex(text('other bytes')), contentType: 'text/plain', name: 'wrong.txt' })
        .then(() => false)
        .catch((err) => err instanceof DigestMismatch);
      check(refused);
    });
    await step('the refused put left no object', async () => check((await store.get(wrongKey)) === null));
    await step('get returns the bytes, type and name', async () => {
      const object = await store.get(firstKey);
      check(object !== null);
      const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
      check(object.size === first.length && bytes.length === first.length && bytes.every((b, i) => b === first[i]));
      check(object.contentType === 'text/plain' && object.name === 'live check ✓.txt');
    });
    await step('get of a missing key returns nothing', async () => check((await store.get(`${prefix}missing`)) === null));
    await step('put four more objects from bytes', async () => {
      for (const [key, bytes] of others) await store.put(key, bytes, { size: bytes.length, sha256: await hex(bytes), contentType: 'text/plain', name: 'page.txt' });
    });
    await step('list pages through the prefix two keys at a time', async () => {
      const { keys, pages } = await listAll(store, prefix, 2);
      const expected = [firstKey, ...others.map(([key]) => key)].sort();
      check(pages >= 3 && JSON.stringify([...keys].sort()) === JSON.stringify(expected));
    });
    await step('delete every object, and a key that is already gone', async () => {
      await store.delete([firstKey, ...others.map(([key]) => key), `${prefix}missing`]);
    });
    await step('the prefix is empty afterwards', async () => check((await listAll(store, prefix, 2)).keys.length === 0));
  } finally {
    // Whatever a failed step left behind goes too.
    try {
      const { keys } = await listAll(store, prefix, 100);
      if (keys.length) await store.delete(keys);
    } catch {
      // The steps already say what failed.
    }
  }
  return results;
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/run') return new Response('Not found', { status: 404 });
    return Response.json(await checks(env));
  }
};
