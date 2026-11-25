// A Web Push service in memory, for the push wake tests (test/push-wake.test.js). installFakePush() points the
// runtime's fetch at it for requests to its hosts, and at its DNS answers for queries about them, and lets every other
// request through: the Worker, the Durable Objects and the tests share one isolate, so the server's own requests reach
// it too. Each device() is a phone's registration: an endpoint on the service, and the key pair and auth secret the
// phone made, with which the service decrypts what it receives, as the phone would.

import { concat } from '../../src/webpush.js';
import { fromBase64url, toBase64url } from '../../src/bytes.js';

const DOH = 'https://cloudflare-dns.com/dns-query';
const enc = new TextEncoder();

export class FakePush {
  // zone: the A records of each host the service is reached at. A host whose address is private stands for a push
  // service on someone's own network, which the server must refuse.
  constructor(zone = { 'push.example': ['93.184.215.14'], 'other-push.example': ['93.184.215.15'], 'inside.example': ['10.1.2.3'] }) {
    this.zone = zone;
    this.devices = new Map();
    // Every POST it took: { endpoint, headers, body, at }.
    this.log = [];
    // Status by endpoint, for a registration the service ended (404, 410) or a service that fails (500).
    this.answers = new Map();
  }

  // A phone's registration on host: { endpoint, p256dh, auth } as the phone sends them to the server, and the keys.
  async device(host = 'push.example') {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const endpoint = `https://${host}/up/${toBase64url(crypto.getRandomValues(new Uint8Array(20)))}?up=1`;
    const device = { endpoint, p256dh: toBase64url(publicKey), auth: toBase64url(auth), privateKey: pair.privateKey, publicKey, authBytes: auth };
    this.devices.set(endpoint, device);
    return device;
  }

  async handle(request) {
    const url = new URL(request.url);
    if (`${url.origin}${url.pathname}` === DOH) return this.dns(url);
    const body = new Uint8Array(await request.arrayBuffer());
    const headers = Object.fromEntries(request.headers);
    this.log.push({ endpoint: request.url, method: request.method, headers, body, at: Date.now() });
    const status = this.answers.get(request.url) ?? (this.devices.has(request.url) ? 201 : 404);
    return new Response(status === 201 ? null : 'gone', { status });
  }

  dns(url) {
    const name = url.searchParams.get('name');
    const type = url.searchParams.get('type');
    const records = this.zone[name];
    if (!records) return Response.json({ Status: 3 });
    const Answer = type === 'A' ? records.map((data) => ({ name, type: 1, TTL: 60, data })) : [];
    return Response.json({ Status: 0, Answer });
  }

  handles(url) {
    if (`${url.origin}${url.pathname}` === DOH) return url.searchParams.get('name') in this.zone;
    return url.protocol === 'https:' && url.hostname in this.zone;
  }

  // The posts to one endpoint.
  to(endpoint) {
    return this.log.filter((entry) => entry.endpoint === endpoint);
  }

  // What a post's body says once the phone decrypted it, and the record size it named.
  async open(entry) {
    const device = this.devices.get(entry.endpoint);
    return decryptPush(entry.body, device.privateKey, device.publicKey, device.authBytes);
  }
}

export function installFakePush(fake) {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = URL.parse(address);
    if (url && fake.handles(url)) return fake.handle(new Request(input, init));
    return real(input, init);
  };
  return () => {
    globalThis.fetch = real;
  };
}

// The RFC 8291 decryption a phone does, written apart from the server's code, with WebCrypto's own HKDF.
export async function decryptPush(body, uaPrivateKey, uaPublic, auth) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const sealed = body.slice(21 + idlen);
  const as = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, uaPrivateKey, 256));
  const hkdf = async (salt, ikm, info, length) => {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
  };
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, sealed));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('The last record has no delimiter 2.');
  return { text: new TextDecoder().decode(plain.slice(0, end)), rs };
}

// The claims of a VAPID Authorization header, and whether its key verifies its signature.
export async function readVapid(header) {
  const found = /^vapid t=([^,]+), k=(.+)$/.exec(header ?? '');
  if (!found) return null;
  const [h, c, s] = found[1].split('.');
  const key = await crypto.subtle.importKey('raw', fromBase64url(found[2]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64url(s), enc.encode(`${h}.${c}`));
  return { claims: JSON.parse(new TextDecoder().decode(fromBase64url(c))), key: found[2], valid };
}
