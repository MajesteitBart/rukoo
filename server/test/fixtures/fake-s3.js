// An S3-compatible service in memory, for the S3 store's tests (test/s3-*.test.js). installFakeS3() points the
// runtime's fetch at it for requests to its endpoint, and lets every other request through: the Worker, the Durable
// Objects and the tests share one isolate, so the server's own requests reach it too.
//
// It checks what a real service checks, with its own code: every request is signed with AWS Signature Version 4 for
// its key, region and the s3 service, within 15 minutes of its x-amz-date, and signs every x-amz-* header it sends;
// an upload's bytes match its x-amz-content-sha256 and its user metadata stays within 2 KB. A refused signature is answered the way AWS answers it, with the
// string it expected to sign in the body. checkDigest = false makes it a service that stores whatever it gets, for
// the store's own digest check. intercept(request, op) may answer instead of it.

const enc = new TextEncoder();

// The stand-ins vitest.config.js gives the s3 project. None of them is a credential.
export const FAKE_S3 = {
  endpoint: 'https://objects.s3-fake.test',
  region: 'test-region-1',
  bucket: 'rukoo-files-test',
  accessKeyId: 'TESTKEYIDNOTREAL0001',
  secretAccessKey: 'test-secret-key-not-a-real-credential'
};

// The five settings for a settings object like FAKE_S3, as the Worker reads them from its environment.
export function s3Vars(s = FAKE_S3) {
  return {
    WORKSPACE_FILES_S3_ENDPOINT: s.endpoint,
    WORKSPACE_FILES_S3_REGION: s.region,
    WORKSPACE_FILES_S3_BUCKET: s.bucket,
    WORKSPACE_FILES_S3_ACCESS_KEY_ID: s.accessKeyId,
    WORKSPACE_FILES_S3_SECRET_ACCESS_KEY: s.secretAccessKey
  };
}

const toHex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (data) => toHex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));

async function hmac(key, text) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(text)));
}

const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function xmlError(status, code, extra = '') {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${code}</Message>${extra}</Error>`, {
    status,
    headers: { 'content-type': 'application/xml' }
  });
}

export class FakeS3 {
  constructor(settings = FAKE_S3) {
    this.settings = settings;
    this.origin = new URL(settings.endpoint).origin;
    this.objects = new Map();
    // { method, op, key, query, sha256 } of every request that passed the signature check.
    this.log = [];
    // Signatures checked, and refused.
    this.signed = 0;
    this.refused = 0;
    this.checkDigest = true;
    this.intercept = null;
  }

  // Keys in the bucket under a prefix, in order.
  keys(prefix = '') {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  // Puts an object straight into the bucket, as a write the server never recorded.
  plant(key, text, type = 'application/octet-stream') {
    this.objects.set(key, { bytes: enc.encode(text), type, name: null });
  }

  ops(op) {
    return this.log.filter((entry) => entry.op === op);
  }

  async handle(request) {
    const url = new URL(request.url);
    const problem = await this.#checkSignature(request, url);
    if (problem) {
      this.refused += 1;
      return problem;
    }
    this.signed += 1;
    const [bucket, ...segments] = url.pathname.slice(1).split('/');
    if (decodeURIComponent(bucket) !== this.settings.bucket) return xmlError(404, 'NoSuchBucket');
    const key = segments.length ? segments.map(decodeURIComponent).join('/') : null;
    const query = Object.fromEntries(url.searchParams);
    const op = key === null ? (request.method === 'GET' && query['list-type'] === '2' ? 'LIST' : 'BUCKET') : request.method;
    this.log.push({ method: request.method, op, key, query, sha256: request.headers.get('x-amz-content-sha256') });
    const answer = this.intercept && (await this.intercept(request, op, key));
    if (answer) return answer;
    switch (op) {
      case 'PUT':
        return this.#put(request, key);
      case 'GET':
        return this.#get(key);
      case 'DELETE':
        this.objects.delete(key);
        return new Response(null, { status: 204 });
      case 'LIST':
        return this.#list(query);
      default:
        return xmlError(405, 'MethodNotAllowed');
    }
  }

  async #put(request, key) {
    const declared = request.headers.get('x-amz-content-sha256');
    if (!/^[0-9a-f]{64}$/.test(declared ?? '')) return xmlError(400, 'InvalidArgument');
    // AWS and MinIO cap user metadata at 2 KB. Counted as MinIO counts it: each x-amz-meta-* header's name and value.
    let meta = 0;
    for (const [name, value] of request.headers) if (name.startsWith('x-amz-meta-')) meta += enc.encode(name).length + enc.encode(value).length;
    if (meta > 2048) return xmlError(400, 'MetadataTooLarge');
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (this.checkDigest && (await sha256Hex(bytes)) !== declared) return xmlError(400, 'XAmzContentSHA256Mismatch');
    this.objects.set(key, { bytes, type: request.headers.get('content-type'), name: request.headers.get('x-amz-meta-name') });
    return new Response(null, { status: 200, headers: { etag: `"${(await sha256Hex(bytes)).slice(0, 32)}"` } });
  }

  #get(key) {
    const object = this.objects.get(key);
    if (!object) return xmlError(404, 'NoSuchKey');
    const headers = { 'content-length': String(object.bytes.length), 'content-type': object.type || 'binary/octet-stream' };
    if (object.name !== null) headers['x-amz-meta-name'] = object.name;
    return new Response(object.bytes, { headers });
  }

  // ListObjectsV2. The continuation token names the last key of the page, as S3's does in its own form: keys deleted
  // before it don't move the next page. It holds characters XML escapes, so a client that doesn't decode it sends back
  // another one.
  #list(query) {
    const prefix = query.prefix ?? '';
    const max = Math.min(1000, Number(query['max-keys'] ?? 1000));
    let all = this.keys(prefix);
    if (query['continuation-token'] !== undefined) {
      const match = /^next&<([A-Za-z0-9+/=]+)>$/.exec(query['continuation-token']);
      if (!match) return xmlError(400, 'InvalidArgument');
      const after = new TextDecoder().decode(Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0)));
      all = all.filter((key) => key > after);
    }
    const page = all.slice(0, max);
    const truncated = max < all.length;
    const contents = page.map((key) => `<Contents><Key>${xmlEscape(key)}</Key><Size>${this.objects.get(key).bytes.length}</Size></Contents>`).join('');
    const last = btoa(String.fromCharCode(...enc.encode(page.at(-1) ?? '')));
    const next = truncated ? `<NextContinuationToken>${xmlEscape(`next&<${last}>`)}</NextContinuationToken>` : '';
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${this.settings.bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`;
    return new Response(body, { headers: { 'content-type': 'application/xml' } });
  }

  // The signature check, written apart from src/sigv4.js.
  async #checkSignature(request, url) {
    const s = this.settings;
    const auth = request.headers.get('authorization') ?? '';
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
    if (!m) return xmlError(400, 'AuthorizationHeaderMalformed');
    const [, keyId, day, region, signedList, given] = m;
    if (keyId !== s.accessKeyId) return xmlError(403, 'InvalidAccessKeyId');
    if (region !== s.region) return xmlError(400, 'AuthorizationHeaderMalformed');
    const date = request.headers.get('x-amz-date') ?? '';
    const at = Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    if (!Number.isFinite(at) || date.slice(0, 8) !== day || Math.abs(Date.now() - at) > 15 * 60 * 1000) return xmlError(403, 'RequestTimeTooSkewed');
    const signed = signedList.split(';');
    if ([...signed].sort().join(';') !== signedList) return xmlError(400, 'AuthorizationHeaderMalformed');
    for (const needed of ['host', 'x-amz-date', 'x-amz-content-sha256']) if (!signed.includes(needed)) return xmlError(403, 'AccessDenied');
    for (const [name] of request.headers) if (name.startsWith('x-amz-') && !signed.includes(name)) return xmlError(403, 'AccessDenied');
    const payload = request.headers.get('x-amz-content-sha256');
    if (!payload) return xmlError(400, 'InvalidRequest');
    const headerLines = signed.map((name) => `${name}:${(name === 'host' ? url.host : request.headers.get(name) ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
    const query = url.search
      .slice(1)
      .split('&')
      .filter(Boolean)
      .map((pair) => {
        const [k, v = ''] = pair.split('=');
        return [uriEncode(decodeURIComponent(k)), uriEncode(decodeURIComponent(v))];
      })
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const canonical = `${request.method}\n${url.pathname}\n${query}\n${headerLines}\n${signedList}\n${payload}`;
    const toSign = `AWS4-HMAC-SHA256\n${date}\n${day}/${region}/s3/aws4_request\n${await sha256Hex(canonical)}`;
    const key = await hmac(await hmac(await hmac(await hmac(`AWS4${s.secretAccessKey}`, day), region), 's3'), 'aws4_request');
    const expected = toHex(await hmac(key, toSign));
    if (expected !== given) {
      return xmlError(403, 'SignatureDoesNotMatch', `<StringToSign>${xmlEscape(toSign)}</StringToSign><SignatureProvided>${given}</SignatureProvided><CanonicalRequest>${xmlEscape(canonical)}</CanonicalRequest>`);
    }
    return null;
  }
}

// Sends the runtime's requests to fake's endpoint to fake, and every other request on as before. Returns the function
// that puts fetch back. Like fetch, a request rejects with its signal's reason once the signal aborts, whatever the
// fake is still doing.
export function installFakeS3(fake) {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(address).origin !== fake.origin) return real(input, init);
    const signal = init?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const answer = fake.handle(new Request(input, init));
    if (!signal) return answer;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      answer.then(resolve, reject);
    });
  };
  return () => {
    globalThis.fetch = real;
  };
}
