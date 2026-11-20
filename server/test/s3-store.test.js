// The S3 store (src/filestore.js) on its own, against the S3 service in memory (test/fixtures/fake-s3.js), which checks
// each request's signature and an upload's x-amz-content-sha256 with code of its own.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DigestMismatch, S3Error, S3Unreachable, S3_TIME, decodeXml, fileStore, readList } from '../src/filestore.js';
import { FAKE_S3, FakeS3, installFakeS3, s3Vars } from './fixtures/fake-s3.js';

const enc = new TextEncoder();
const hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

const s3 = new FakeS3();
let restore;
beforeAll(() => {
  restore = installFakeS3(s3);
});
afterAll(() => restore());
beforeEach(() => {
  s3.objects.clear();
  s3.log = [];
  s3.checkDigest = true;
  s3.intercept = null;
  s3.signed = 0;
  s3.refused = 0;
});

const store = () => fileStore(s3Vars());

// A stream of bytes with its length known, as files.js hands an upload to the store.
function streamOf(bytes) {
  const fixed = new FixedLengthStream(bytes.length);
  const writer = fixed.writable.getWriter();
  writer.write(bytes).then(() => writer.close());
  return fixed.readable;
}

async function put(key, bytes, declared, options = {}) {
  return store().put(key, options.stream === false ? bytes : streamOf(bytes), {
    size: bytes.length,
    sha256: declared ?? (await hex(bytes)),
    contentType: 'text/plain',
    name: options.name ?? 'notes.txt'
  });
}

describe('putting and getting', () => {
  it('streams bytes in with their digest and gets them back with their type and name', async () => {
    const bytes = enc.encode('the quarterly numbers');
    const key = 'ws/w_1/a b+c é';
    await put(key, bytes, undefined, { name: 'Résumé "final" ✓.txt' });
    const [entry] = s3.ops('PUT');
    expect(entry).toMatchObject({ key, sha256: await hex(bytes) });
    expect(s3.refused).toBe(0);
    const object = await store().get(key);
    expect(object).toMatchObject({ size: bytes.length, contentType: 'text/plain', name: 'Résumé "final" ✓.txt' });
    expect(new TextDecoder().decode(await new Response(object.body).arrayBuffer())).toBe('the quarterly numbers');
    expect(await store().get('ws/w_1/nothing')).toBeNull();
  });

  it('puts bytes it holds, such as a link card image, after checking their digest itself', async () => {
    const bytes = enc.encode('png bytes');
    await put('ws/w_1/image', bytes, undefined, { stream: false });
    expect(new TextDecoder().decode(s3.objects.get('ws/w_1/image').bytes)).toBe('png bytes');
    const before = s3.log.length;
    await expect(put('ws/w_1/other', bytes, '0'.repeat(64), { stream: false })).rejects.toBeInstanceOf(DigestMismatch);
    // Refused before a request went out.
    expect(s3.log.length).toBe(before);
  });

  it('refuses a stream whose digest the service finds wrong, and leaves nothing', async () => {
    const bytes = enc.encode('exactly this');
    await expect(put('ws/w_1/wrong', bytes, await hex(enc.encode('exactly that')))).rejects.toBeInstanceOf(DigestMismatch);
    expect(s3.keys()).toEqual([]);
  });

  it("finds a wrong digest itself when the service doesn't check, and deletes the object", async () => {
    s3.checkDigest = false;
    const bytes = enc.encode('exactly this');
    await expect(put('ws/w_1/lied', bytes, await hex(enc.encode('exactly that')))).rejects.toBeInstanceOf(DigestMismatch);
    expect(s3.ops('PUT').map((entry) => entry.key)).toEqual(['ws/w_1/lied']);
    expect(s3.ops('DELETE').map((entry) => entry.key)).toEqual(['ws/w_1/lied']);
    expect(s3.keys()).toEqual([]);
    // With the right digest the same service keeps it.
    await put('ws/w_1/right', bytes);
    expect(s3.keys()).toEqual(['ws/w_1/right']);
  });

  it('stores the longest names a reservation takes within the 2 KB S3 allows for metadata', async () => {
    const bytes = enc.encode('x');
    for (const name of ['報'.repeat(255), '😀'.repeat(255), `${'é'.repeat(254)}.`]) {
      await put('ws/w_1/long', bytes, undefined, { name });
      expect((await store().get('ws/w_1/long')).name).toBe(name);
    }
    expect(s3.ops('PUT')).toHaveLength(3);
  });

  it('refuses a stream shorter than its size without storing it', async () => {
    const fixed = new FixedLengthStream(10);
    const writer = fixed.writable.getWriter();
    writer.write(enc.encode('short')).then(() => writer.close()).catch(() => {});
    await expect(store().put('ws/w_1/short', fixed.readable, { size: 10, sha256: '0'.repeat(64), contentType: 'text/plain', name: 'x' })).rejects.toThrow();
    expect(s3.keys()).toEqual([]);
  });

  it('leaves the size unknown when the service gives no Content-Length, or one that is no number', async () => {
    for (const length of [null, 'abc']) {
      s3.intercept = async (request, op) => {
        if (op !== 'GET') return undefined;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode('some bytes'));
            controller.close();
          }
        });
        return new Response(body, { headers: length === null ? {} : { 'content-length': length } });
      };
      const object = await store().get('ws/w_1/unsized');
      expect(object.size).toBeNull();
      expect(new TextDecoder().decode(await new Response(object.body).arrayBuffer())).toBe('some bytes');
    }
  });

  it('treats a redirect as a refusal and never follows it', async () => {
    s3.intercept = async () => new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/' } });
    const err = await store().get('ws/w_1/moved').catch((e) => e);
    expect(err).toBeInstanceOf(S3Error);
    expect(err.message).toBe('S3 GET answered 301');
  });
});

describe('listing', () => {
  it('pages through a prefix with continuation tokens, decoding what XML escapes', async () => {
    const keys = ['ws/w_2/a&b', 'ws/w_2/c<d>', "ws/w_2/e'f\"g", 'ws/w_2/h', 'ws/w_2/i'];
    for (const key of keys) s3.plant(key, 'x');
    s3.plant('ws/w_3/other', 'x');
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await store().list({ prefix: 'ws/w_2/', cursor, limit: 2 });
      expect(page.keys.length).toBeLessThanOrEqual(2);
      seen.push(...page.keys);
      cursor = page.cursor;
      pages += 1;
    } while (cursor);
    expect(seen).toEqual(keys);
    expect(pages).toBe(3);
    expect(s3.ops('LIST').map((entry) => entry.query['max-keys'])).toEqual(['2', '2', '2']);
    expect(await store().list({ prefix: 'ws/w_4/' })).toEqual({ keys: [], cursor: null });
  });

  it('reads a ListObjectsV2 answer and its entities', () => {
    expect(decodeXml('a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#233; &#xE9; &#x1F600; &bogus; &#xD800;')).toBe('a&b <c> "d" \'e\' é é 😀 &bogus; &#xD800;');
    const xml =
      '<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>true</IsTruncated>' +
      '<Contents><Key>a&amp;b</Key><Size>1</Size></Contents><Contents><Key>c</Key></Contents>' +
      '<NextContinuationToken>t&amp;1</NextContinuationToken></ListBucketResult>';
    expect(readList(xml)).toEqual({ keys: ['a&b', 'c'], cursor: 't&1' });
    expect(() => readList('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>')).toThrow(/continuation token/);
    expect(() => readList('<Error><Code>AccessDenied</Code></Error>')).toThrow(/other than a list/);
    expect(readList('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>\n')).toEqual({ keys: [], cursor: null });
  });

  it('throws on an answer that is not a whole list, rather than taking it for the last page', async () => {
    const head = '<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">';
    const entry = '<Contents><Key>ws/w_2/a</Key><Size>1</Size></Contents>';
    const shapes = {
      'an opening tag and nothing else': [head, /ends too soon/],
      'an empty list element': ['<ListBucketResult></ListBucketResult>', /whether there is more/],
      'entries without IsTruncated': [`${head}${entry}</ListBucketResult>`, /whether there is more/],
      'an IsTruncated that is neither true nor false': [`${head}<IsTruncated>maybe</IsTruncated>${entry}</ListBucketResult>`, /whether there is more/],
      'entries whose tail is missing': [`${head}<IsTruncated>false</IsTruncated>${entry}<Contents><Key>ws/w_2/b</Key>`, /ends too soon/],
      'an entry cut off inside a closed list': [`${head}<IsTruncated>false</IsTruncated><Contents><Key>ws/w_2/b${entry}</ListBucketResult>`, /without a key/],
      'an entry without a key': [`${head}<IsTruncated>false</IsTruncated><Contents><Size>1</Size></Contents></ListBucketResult>`, /without a key/],
      'more without a token': [`${head}<IsTruncated>true</IsTruncated>${entry}</ListBucketResult>`, /continuation token/],
      'more with an empty token': [`${head}<IsTruncated>true</IsTruncated>${entry}<NextContinuationToken> </NextContinuationToken></ListBucketResult>`, /continuation token/]
    };
    for (const [shape, [xml, error]] of Object.entries(shapes)) {
      expect(() => readList(xml), shape).toThrow(error);
    }
    // The store throws too, so nobody takes it for an empty bucket.
    s3.plant('ws/w_2/a', 'x');
    s3.intercept = async (request, op) => (op === 'LIST' ? new Response(head, { headers: { 'content-type': 'application/xml' } }) : undefined);
    await expect(store().list({ prefix: 'ws/w_2/' })).rejects.toThrow(/ends too soon/);
  });
});

describe('deleting', () => {
  it('deletes each key with at most eight requests at once, and counts a missing key as deleted', async () => {
    const keys = Array.from({ length: 30 }, (_, i) => `ws/w_5/k${i}`);
    for (const key of keys) s3.plant(key, 'x');
    let inFlight = 0;
    let most = 0;
    s3.intercept = async (request, op, key) => {
      if (op !== 'DELETE') return undefined;
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (key === 'ws/w_5/k3') return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      return undefined;
    };
    await store().delete([...keys, 'ws/w_5/k0']);
    expect(most).toBeLessThanOrEqual(8);
    expect(most).toBeGreaterThan(1);
    // Each key once.
    expect(s3.ops('DELETE')).toHaveLength(30);
    expect(s3.keys('ws/w_5/')).toEqual(['ws/w_5/k3']);
    await store().delete([]);
  });

  it('throws when any delete fails, after trying every key', async () => {
    for (const key of ['ws/w_6/a', 'ws/w_6/b', 'ws/w_6/c']) s3.plant(key, 'x');
    s3.intercept = async (request, op, key) => (op === 'DELETE' && key === 'ws/w_6/b' ? new Response('<Error><Code>InternalError</Code></Error>', { status: 500 }) : undefined);
    const err = await store()
      .delete(['ws/w_6/a', 'ws/w_6/b', 'ws/w_6/c'])
      .catch((e) => e);
    expect(err.message).toBe('S3 could not delete 1 of 3 objects, the first because S3 DELETE answered 500 InternalError');
    expect(s3.keys('ws/w_6/')).toEqual(['ws/w_6/b']);
  });

  it('takes a missing bucket for a failure, not for objects that are gone', async () => {
    s3.plant('ws/w_6/kept', 'x');
    const elsewhere = fileStore(s3Vars({ ...FAKE_S3, bucket: 'no-such-bucket-here' }));
    const deleting = await elsewhere.delete(['ws/w_6/kept']).catch((e) => e);
    expect(deleting.message).toBe('S3 could not delete 1 of 1 objects, the first because S3 DELETE answered 404 NoSuchBucket');
    const getting = await elsewhere.get('ws/w_6/kept').catch((e) => e);
    expect(getting).toBeInstanceOf(S3Error);
    expect(getting.message).toBe('S3 GET answered 404 NoSuchBucket');
    expect(s3.keys('ws/w_6/')).toEqual(['ws/w_6/kept']);
  });

  it('counts a delete as done only on a 2xx or NoSuchKey, not on a 404 that says less', async () => {
    s3.plant('ws/w_6/kept', 'x');
    // A 404 without a body, and one whose body breaks off before its code.
    const answers = [
      () => new Response(null, { status: 404 }),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(enc.encode('<Error><Code>NoSuch'));
              controller.error(new Error('connection reset'));
            }
          }),
          { status: 404 }
        )
    ];
    for (const answer of answers) {
      s3.intercept = async (request, op) => (op === 'DELETE' ? answer() : undefined);
      const err = await store()
        .delete(['ws/w_6/kept'])
        .catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('S3 could not delete 1 of 1 objects, the first because S3 DELETE answered 404');
      expect(err.failed).toEqual(['ws/w_6/kept']);
    }
    // A download's 404 without a code still means gone.
    s3.intercept = async () => new Response(null, { status: 404 });
    expect(await store().get('ws/w_6/kept')).toBeNull();
  });
});

// A stream of bytes in pieces, gap milliseconds apart; with stall, it stops for good after the first piece.
function dripping(bytes, pieces, gap, { stall = false } = {}) {
  const fixed = new FixedLengthStream(bytes.length);
  const writer = fixed.writable.getWriter();
  const step = Math.ceil(bytes.length / pieces);
  (async () => {
    for (let at = 0; at < bytes.length; at += step) {
      if (at > 0 && stall) return;
      await new Promise((resolve) => setTimeout(resolve, gap));
      await writer.write(bytes.subarray(at, at + step));
    }
    await writer.close();
  })().catch(() => {});
  return fixed.readable;
}

describe('time limits', () => {
  const saved = { ...S3_TIME };
  afterEach(() => Object.assign(S3_TIME, saved));
  const opts = async (bytes) => ({ size: bytes.length, sha256: await hex(bytes), contentType: 'text/plain', name: 'slow.txt' });

  it('lets a device send as slowly as it likes while bytes keep moving', async () => {
    S3_TIME.idle = 400;
    const bytes = enc.encode('a slow but steady upload '.repeat(500));
    const started = Date.now();
    // Twelve pieces 60 ms apart: longer in all than the idle time, never that long between two pieces.
    await store().put('ws/w_9/slow', dripping(bytes, 12, 60), await opts(bytes));
    expect(Date.now() - started).toBeGreaterThan(S3_TIME.idle);
    expect(s3.objects.get('ws/w_9/slow').bytes).toEqual(bytes);
  });

  it('gives up on an upload that stopped moving, as a store failure', async () => {
    S3_TIME.idle = 150;
    const bytes = enc.encode('first piece, then nothing');
    const err = await store()
      .put('ws/w_9/stalled', dripping(bytes, 4, 10, { stall: true }), await opts(bytes))
      .catch((e) => e);
    expect(err).toBeInstanceOf(S3Unreachable);
    expect(err.message).toBe('S3 PUT failed: no answer in time');
    expect(s3.keys()).toEqual([]);
  });

  it('waits for the answer to an upload a limited time after its last byte', async () => {
    S3_TIME.request = 150;
    s3.intercept = async (request, op) => {
      if (op !== 'PUT') return undefined;
      await request.arrayBuffer();
      return new Promise(() => {});
    };
    const bytes = enc.encode('sent, never answered');
    const err = await store()
      .put('ws/w_9/unanswered', streamOf(bytes), await opts(bytes))
      .catch((e) => e);
    expect(err).toBeInstanceOf(S3Unreachable);
    expect(err.message).toBe('S3 PUT failed: no answer in time');
  });

  it('stops reading the body of a refusal that stalls, and still refuses', async () => {
    S3_TIME.error = 100;
    // The start of an error answer, and then nothing.
    const stalled = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode('<Error><Code>SlowDown'));
          },
          pull: () => new Promise(() => {})
        }),
        { status: 503 }
      );
    s3.intercept = async (request, op) => {
      if (op === 'PUT') await request.arrayBuffer();
      return stalled();
    };
    const started = Date.now();
    const getting = await store()
      .get('ws/w_9/refused')
      .catch((e) => e);
    expect(getting).toBeInstanceOf(S3Error);
    expect(getting.message).toBe('S3 GET answered 503');
    const bytes = enc.encode('refused, slowly');
    const putting = await store()
      .put('ws/w_9/refused', streamOf(bytes), await opts(bytes))
      .catch((e) => e);
    expect(putting).toBeInstanceOf(S3Error);
    expect(putting.message).toBe('S3 PUT answered 503');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("times a download's headers, not its body", async () => {
    S3_TIME.request = 150;
    const bytes = enc.encode('a slow download '.repeat(200));
    s3.intercept = async (request, op) => (op === 'GET' ? new Response(dripping(bytes, 8, 60), { headers: { 'content-length': String(bytes.length) } }) : undefined);
    const object = await store().get('ws/w_9/slow');
    expect(new Uint8Array(await new Response(object.body).arrayBuffer())).toEqual(bytes);
  });
});

describe('what errors say', () => {
  it('names the operation, the status and the code, and nothing S3 repeats of the request', async () => {
    const wrong = fileStore(s3Vars({ ...FAKE_S3, secretAccessKey: 'another-secret-not-real-either-0002' }));
    const failures = [
      await wrong.get('ws/w_7/x').catch((e) => e),
      await wrong.put('ws/w_7/x', enc.encode('x'), { size: 1, sha256: await hex(enc.encode('x')), contentType: 'text/plain', name: 'x' }).catch((e) => e),
      await wrong.list({ prefix: 'ws/' }).catch((e) => e),
      await wrong.delete(['ws/w_7/x']).catch((e) => e)
    ];
    expect(failures.map((err) => err.message)).toEqual([
      'S3 GET answered 403 SignatureDoesNotMatch',
      'S3 PUT answered 403 SignatureDoesNotMatch',
      'S3 LIST answered 403 SignatureDoesNotMatch',
      'S3 could not delete 1 of 1 objects, the first because S3 DELETE answered 403 SignatureDoesNotMatch'
    ]);
    const said = failures.map((err) => `${err.message} ${err.stack} ${JSON.stringify(err)}`).join('\n');
    for (const secret of ['another-secret-not-real-either-0002', FAKE_S3.secretAccessKey, 'AWS4-HMAC-SHA256', 'Signature=', 'StringToSign', 'aws4_request']) {
      expect(said).not.toContain(secret);
    }
    expect(s3.refused).toBeGreaterThanOrEqual(4);
  });

  it('says that a request failed, and nothing of the error it failed with', async () => {
    const signature = '5a94b5c6676e69b84775384654c9cf3c92bac0d79cb8884d19a098dcf6f182c0';
    s3.intercept = async () => {
      throw new TypeError(`Network connection lost. Signature=${signature} ${FAKE_S3.secretAccessKey}`);
    };
    const err = await store().get('ws/w_8/x').catch((e) => e);
    expect(err).toBeInstanceOf(S3Unreachable);
    expect(err.message).toBe('S3 GET failed: the request did not complete');
    const said = `${err.message} ${err.stack} ${JSON.stringify(err)}`;
    for (const secret of [signature, FAKE_S3.secretAccessKey, 'Signature=', 'Network connection lost']) expect(said).not.toContain(secret);
  });

  it('keeps only a code that looks like an S3 error code, never a hex string such as a signature', async () => {
    // A signature, and one that happens to hold no digit.
    const signatures = ['5a94b5c6676e69b84775384654c9cf3c92bac0d79cb8884d19a098dcf6f182c0', 'abcdef'.repeat(10).concat('abcd')];
    for (const code of signatures) {
      s3.intercept = async () => new Response(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`, { status: 403 });
      const err = await store().get('ws/w_8/x').catch((e) => e);
      expect(err).toBeInstanceOf(S3Error);
      expect(err.code).toBeNull();
      expect(err.message).toBe('S3 GET answered 403');
      expect(`${err.message} ${err.stack} ${JSON.stringify(err)}`).not.toContain(code);
    }
    // Real codes, digits and all, stay.
    for (const code of ['AccessDenied', 'XAmzContentSHA256Mismatch']) {
      s3.intercept = async () => new Response(`<Error><Code>${code}</Code></Error>`, { status: 403 });
      expect((await store().get('ws/w_8/x').catch((e) => e)).code).toBe(code);
    }
  });
});
