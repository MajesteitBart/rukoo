// Writes test/fixtures/booking-vectors.json: fixed key pairs, nonces and plaintexts with the blobs the server's
// seal() makes from them. The server's tests reproduce every blob; the desktop's tests open them. Run it again only
// when the sealing format changes on purpose: node scripts/booking-vectors.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { guestJson, keyId, seal } from '../src/seal.js';
import { sha256, toBase64url, utf8 } from '../src/bytes.js';

const P256 = { name: 'ECDH', namedCurve: 'P-256' };
const b64 = (bytes) => toBase64url(new Uint8Array(bytes));

async function pair() {
  const keys = await crypto.subtle.generateKey(P256, true, ['deriveBits']);
  return {
    privatePkcs8: new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey)),
    publicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
  };
}

const manageKey = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const bookingId = () => b64(crypto.getRandomValues(new Uint8Array(16)));

const cases = [
  {
    name: 'basic',
    handle: 'bart',
    bookingId: 'Rf63vMqqWdS0MICDAHKmrw',
    plaintext: {
      name: 'Jane Doe',
      email: 'jane@example.com',
      notes: 'Kickoff',
      timeZone: 'Europe/Amsterdam',
      locale: 'en',
      via: '',
      manageKey: manageKey(),
      type: '30min',
      start: 1793696400000,
      end: 1793698200000
    }
  },
  {
    name: 'unicode',
    handle: 'b-v-m',
    bookingId: bookingId(),
    plaintext: {
      name: 'Zoë Ångström-Müller 日本',
      email: 'zoe.angstrom@example.nl',
      notes: 'Bespreking over de ‘offerte’ 🚀\nTweede regel met "aanhalingstekens" en \\ backslash',
      timeZone: 'Australia/Lord_Howe',
      locale: 'nl',
      via: 'ChatGPT',
      manageKey: manageKey(),
      type: 'intro-call',
      start: 1794560400000,
      end: 1794564000000
    }
  },
  {
    name: 'empty',
    handle: 'abc',
    bookingId: bookingId(),
    plaintext: {
      name: 'Al',
      email: 'al+cal@example.org',
      notes: '',
      timeZone: 'UTC',
      locale: 'en',
      via: '',
      manageKey: manageKey(),
      type: '30min',
      start: 1793782800000,
      end: 1793784600000
    }
  }
];

const seals = [];
for (const c of cases) {
  const owner = await pair();
  const ephemeral = await pair();
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const result = await seal({ publicRaw: owner.publicRaw, handle: c.handle, bookingId: c.bookingId, plaintext: c.plaintext, ephemeral, nonce });
  seals.push({
    name: c.name,
    handle: c.handle,
    bookingId: c.bookingId,
    owner: { privatePkcs8: b64(owner.privatePkcs8), publicRaw: b64(owner.publicRaw), keyId: b64(await keyId(owner.publicRaw)) },
    ephemeral: { privatePkcs8: b64(ephemeral.privatePkcs8), publicRaw: b64(ephemeral.publicRaw) },
    nonce: b64(nonce),
    plaintext: c.plaintext,
    plaintextJson: guestJson(c.plaintext),
    aad: `rukoo/v1/booking:${c.handle}:${c.bookingId}`,
    ikm: b64(result.ikm),
    key: b64(result.key),
    blob: b64(result.blob)
  });
}

// <acct>: the first 16 characters of base64url(SHA-256(the trimmed, lowercased account email)). The second address
// has spaces around it, so a device that forgets to trim fails this vector.
const acct = [];
for (const email of ['Bart@Example.com', ' jane.doe@Example.NL ']) {
  acct.push({ email, acct: b64(await sha256(utf8(email.trim().toLowerCase()))).slice(0, 16) });
}

const vectors = {
  version: 1,
  seal: seals,
  handles: {
    valid: ['bart', 'b-v-m', 'abc', 'a1b2c3', 'x'.repeat(32)],
    invalid: ['ab', '-bart', 'bart-', 'b--m', 'Bart', 'bärt', 'x'.repeat(33), 'bart.vdm', 'bart_vdm', ''],
    reserved: ['api', 'mcp', 'meet', 'llms', 'well-known', 'bvdm']
  },
  slugs: {
    valid: ['30min', 'intro-call', 'x', 'a'.repeat(40)],
    invalid: ['', '-x', '30_min', 'x-', 'Intro', 'a'.repeat(41)],
    reserved: ['api', 'ics', 'mcp', 'manage', 'prepare']
  },
  acct
};

const target = fileURLToPath(new URL('../test/fixtures/booking-vectors.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`Wrote ${seals.length} seal vectors to ${target}`);
