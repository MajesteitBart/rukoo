// Writes voice/fixtures/sync-vectors.json, the known answers voice-sync's tests/format.rs checks:
// key derivations, object names, the recovery code and six RKV1 objects (voice/README.md, Storage).
// It shares nothing with the Rust code: HChaCha20 is written out here and ChaCha20-Poly1305 comes
// from Node's OpenSSL, both checked against draft-irtf-cfrg-xchacha-03 before anything is written.
// The material is fixed, so a run gives the same file byte for byte.
//
// Usage: node voice/scripts/sync-vectors.mjs voice/fixtures/sync-vectors.json
import crypto from 'node:crypto';
import fs from 'node:fs';

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const hmac = (key, ...parts) => {
  const h = crypto.createHmac('sha256', key);
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
  return h.digest();
};

function rotl(v, c) { return ((v << c) | (v >>> (32 - c))) >>> 0; }
function hchacha20(key, nonce16) {
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = nonce16.readUInt32LE(i * 4);
  const qr = (a, b, c, d) => {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach((w, i) => out.writeUInt32LE(s[w], i * 4));
  return out;
}

function xseal(key, nonce24, plain, aad) {
  const sub = hchacha20(key, nonce24.subarray(0, 16));
  const n12 = Buffer.concat([Buffer.alloc(4), nonce24.subarray(16, 24)]);
  const c = crypto.createCipheriv('chacha20-poly1305', sub, n12, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: plain.length });
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([body, c.getAuthTag()]);
}

// Self-checks against draft-irtf-cfrg-xchacha-03: HChaCha20 (2.2.1) and the AEAD (A.3.1).
{
  const sub = hchacha20(unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
    unhex('000000090000004a0000000031415927'));
  if (hex(sub) !== '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc') {
    throw new Error('HChaCha20 self-check failed: ' + hex(sub));
  }
  const pt = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const out = xseal(unhex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f'),
    unhex('404142434445464748494a4b4c4d4e4f5051525354555657'), pt, unhex('50515253c0c1c2c3c4c5c6c7'));
  const want = 'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e'
    + 'c0875924c1c7987947deafd8780acf49';
  if (hex(out) !== want) throw new Error('XChaCha20-Poly1305 self-check failed: ' + hex(out));
}

const MK = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255));
const kidFull = hmac(MK, 'rukoo-voice/kid/v1');
const kid = hex(kidFull).slice(0, 16);
const nameKey = hmac(MK, 'rukoo-voice/names/v1');
const wrapKey = hmac(MK, 'rukoo-voice/wrap/v1');
const meeting = 'm-20261030-171203-4f2a';
const M = hex(hmac(nameKey, 'meeting\0', meeting)).slice(0, 32);
const fileObject = (path, shaHex) =>
  `rkv1/${kid}/m/${M}/o/${hex(hmac(nameKey, 'file\0', meeting, '\0', path, '\0', shaHex)).slice(0, 32)}`;
const writer = '00112233445566778899aabbccddeeff';
const W = hex(hmac(nameKey, 'writer\0', writer)).slice(0, 32);

// Crockford base32 of MK ‖ SHA-256(MK)[0..2].
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function recovery(mk) {
  const data = Buffer.concat([mk, sha256(mk).subarray(0, 2)]);
  let bits = '';
  for (const b of data) bits += b.toString(2).padStart(8, '0');
  while (bits.length % 5) bits += '0';
  let syms = '';
  for (let i = 0; i < bits.length; i += 5) syms += ALPHA[parseInt(bits.slice(i, i + 5), 2)];
  return 'RKV1-' + syms.match(/.{5}/g).join('-');
}

const dek = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x40 + i));
const prefix = Buffer.from(Array.from({ length: 19 }, (_, i) => 0x80 + i));
const wrapNonce = Buffer.from(Array.from({ length: 24 }, (_, i) => 0xc0 + i));

function seal(object, plain) {
  const header = Buffer.alloc(115);
  header.write('RKV1', 0, 'ascii');
  header[4] = 1; header[5] = 1; header[6] = 16; header[7] = 0;
  kidFull.copy(header, 8, 0, 8);
  header.writeBigUInt64BE(BigInt(plain.length), 16);
  prefix.copy(header, 24);
  wrapNonce.copy(header, 43);
  const aad = Buffer.concat([header.subarray(0, 43), Buffer.from(object, 'utf8')]);
  const wrapped = xseal(wrapKey, wrapNonce, dek, aad);
  if (wrapped.length !== 48) throw new Error('wrap length');
  wrapped.copy(header, 67);
  const n = Math.max(1, Math.ceil(plain.length / 65536));
  const parts = [header];
  for (let i = 0; i < n; i++) {
    const nonce = Buffer.alloc(24);
    prefix.copy(nonce, 0);
    nonce.writeUInt32BE(i, 19);
    nonce[23] = i === n - 1 ? 1 : 0;
    parts.push(xseal(dek, nonce, plain.subarray(i * 65536, Math.min(plain.length, (i + 1) * 65536)), Buffer.alloc(0)));
  }
  const cipher = Buffer.concat(parts);
  if (cipher.length !== 115 + plain.length + 16 * n) throw new Error('length');
  return { header, cipher };
}

const objects = [0, 1, 65535, 65536, 65537, 200000].map((len, i) => {
  const plain = Buffer.from(Array.from({ length: len }, (_, j) => j % 251));
  const path = `audio/mic/${String(i + 1).padStart(6, '0')}.wav`;
  const plainSha = hex(sha256(plain));
  const object = fileObject(path, plainSha);
  const { header, cipher } = seal(object, plain);
  return {
    path, plainLen: len, plainSha256: plainSha, object,
    header: hex(header), cipherLen: cipher.length, cipherSha256: hex(sha256(cipher)),
  };
});

const files = [
  { path: 'meeting.json', content: '{"id":"m-20261030-171203-4f2a"}' },
  { path: 'timeline.jsonl', content: '' },
].map(({ path, content }) => {
  const sha = hex(sha256(Buffer.from(content, 'utf8')));
  return { path, sha256: sha, object: fileObject(path, sha) };
});

const out = {
  about: "Known answers for voice-sync's names, recovery code and RKV1 format (RUK-110 spec 2.4 and 2.5). Made by an implementation independent of the Rust one, on Node's crypto: HChaCha20 written out, ChaCha20-Poly1305 from OpenSSL, checked first against draft-irtf-cfrg-xchacha-03. Plaintexts are byte[i] = i mod 251; every object uses the same DEK, stream prefix and wrap nonce, which only a test may do.",
  masterKey: hex(MK),
  kid,
  nameKey: hex(nameKey),
  wrapKey: hex(wrapKey),
  meeting,
  meetingHash: M,
  manifestObject: `rkv1/${kid}/m/${M}/manifest`,
  files,
  writer,
  indexObject: `rkv1/${kid}/index/${W}`,
  indexPrefix: `rkv1/${kid}/index/`,
  recoveryCode: recovery(MK),
  material: { dek: hex(dek), prefix: hex(prefix), wrapNonce: hex(wrapNonce) },
  objects,
};
if (!process.argv[2]) throw new Error('Usage: node voice/scripts/sync-vectors.mjs <out.json>');
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + '\n');
console.log('wrote', process.argv[2], 'kid', kid, 'code', out.recoveryCode);
