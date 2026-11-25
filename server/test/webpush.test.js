// The Web Push pieces of push wakes (src/webpush.js): encryption against RFC 8291's own example, the VAPID key and
// token, and the rules an endpoint is held to.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fromBase64url, toBase64url, utf8 } from '../src/bytes.js';
import { PUSH_ORIGINS, WAKE_WORKSPACES, encrypt, postable, pushOrigins, vapidAuthorization, vapidContact, vapidKeys, vapidPublicKey, wakeText } from '../src/webpush.js';
import { decryptPush } from './fixtures/fake-push.js';

const b64 = (text) => fromBase64url(text);

// RFC 8291, section 5 and appendix A.
const EXAMPLE = {
  plaintext: 'When I grow up, I want to be a watermelon',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
};

// An ECDH key from its raw private and public parts, as the example gives them.
async function ecdhKey(privateText, publicText, usages = ['deriveBits']) {
  const pub = b64(publicText);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: privateText,
    x: toBase64url(pub.slice(1, 33)),
    y: toBase64url(pub.slice(33)),
    ext: true
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, usages);
}

describe('encryption', () => {
  it('makes the body of RFC 8291’s example from its keys and salt', async () => {
    const sender = { privateKey: await ecdhKey(EXAMPLE.asPrivate, EXAMPLE.asPublic), publicKey: b64(EXAMPLE.asPublic) };
    const body = await encrypt(b64(EXAMPLE.uaPublic), b64(EXAMPLE.auth), utf8(EXAMPLE.plaintext), { sender, salt: b64(EXAMPLE.salt) });
    expect(toBase64url(body)).toBe(EXAMPLE.body);
  });

  it('makes a fresh key and salt for every message, which the phone decrypts', async () => {
    const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const one = await encrypt(uaPublic, auth, utf8('{"t":"wake"}'));
    const two = await encrypt(uaPublic, auth, utf8('{"t":"wake"}'));
    expect(toBase64url(one.slice(0, 16))).not.toBe(toBase64url(two.slice(0, 16)));
    expect(toBase64url(one.slice(21, 86))).not.toBe(toBase64url(two.slice(21, 86)));
    // Within UnifiedPush's 4,096 bytes, the same size every time.
    expect(one.length).toBe(two.length);
    expect(one.length).toBe(115);
    expect(one.length).toBeLessThanOrEqual(4096);
    expect(await decryptPush(one, ua.privateKey, uaPublic, auth)).toEqual({ text: '{"t":"wake"}', rs: 4096 });
  });
});

describe('VAPID', () => {
  it('derives one key pair from PEPPER, the same every time', async () => {
    const key = await vapidPublicKey(env);
    const bytes = fromBase64url(key);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
    expect(key.length).toBe(87);
    expect(await vapidPublicKey(env)).toBe(key);
    expect(await vapidPublicKey({ ...env, PEPPER: 'another-pepper-0123456789abcdef' })).not.toBe(key);
  });

  it('signs a token for the endpoint’s origin that the public key verifies', async () => {
    const now = Date.UTC(2026, 10, 25, 12);
    const header = await vapidAuthorization({ ...env, OPERATOR_CONTACT: 'mailto:ops@example.com' }, 'https://push.example/up/abc?x=1', now);
    const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(k).toBe(await vapidPublicKey(env));
    const [h, c, s] = token.split('.');
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(h)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(c)))).toEqual({
      aud: 'https://push.example',
      exp: now / 1000 + 12 * 60 * 60,
      sub: 'mailto:ops@example.com'
    });
    const raw = fromBase64url(k);
    const verify = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verify, fromBase64url(s), utf8(`${h}.${c}`));
    expect(ok).toBe(true);
    expect((await vapidKeys(env)).publicKey).toEqual(raw);
  });

  it('names the operator as sub when it has an https or mailto address, and nobody otherwise', () => {
    expect(vapidContact({ OPERATOR_CONTACT: 'https://example.com/contact', OPERATOR_URL: '' })).toBe('https://example.com/contact');
    expect(vapidContact({ OPERATOR_CONTACT: 'Call us', OPERATOR_URL: 'https://example.com' })).toBe('https://example.com/');
    expect(vapidContact({ OPERATOR_CONTACT: 'mailto:a@b.example', OPERATOR_URL: '' })).toBe('mailto:a@b.example');
    expect(vapidContact({ OPERATOR_CONTACT: 'http://example.com', OPERATOR_URL: '' })).toBeNull();
    expect(vapidContact({})).toBeNull();
  });
});

describe('endpoint rules', () => {
  const origins = pushOrigins({ WORKSPACE_PUSH_ORIGINS: 'https://ntfy.example.org, https://push.example.net:8443, http://plain.example, https://x.example/path, nonsense' });

  it('takes the known push services and the origins the operator lists', () => {
    expect([...origins].sort()).toEqual(
      [...PUSH_ORIGINS, 'https://ntfy.example.org', 'https://push.example.net:8443'].sort()
    );
    expect(postable('https://ntfy.sh/upAbCdEf?up=1', origins)).toBe(true);
    expect(postable('https://fcm.googleapis.com/fcm/send/abc:def', origins)).toBe(true);
    expect(postable('https://updates.push.services.mozilla.com/wpush/v2/abc', origins)).toBe(true);
    expect(postable('https://ntfy.example.org/upX?up=1', origins)).toBe(true);
    expect(postable('https://push.example.net:8443/up/1', origins)).toBe(true);
  });

  it('refuses everything else', () => {
    for (const address of [
      'http://ntfy.sh/up1',
      'https://ntfy.sh:8443/up1',
      'https://user:pass@ntfy.sh/up1',
      'https://ntfy.sh/up1#frag',
      'https://push.example.net/up/1',
      'https://plain.example/up',
      'https://x.example/path/up',
      'https://ntfy.sh.evil.example/up',
      'https://127.0.0.1/up',
      'not a url',
      42
    ]) {
      expect(postable(address, origins), String(address)).toBe(false);
    }
  });
});

describe('what a wake says', () => {
  it('names the workspaces, up to ten, and nothing else', () => {
    expect(wakeText()).toBe('{"t":"wake"}');
    expect(wakeText(['w_a', 'w_b', 'w_a'])).toBe('{"t":"wake","w":["w_a","w_b"]}');
    const many = Array.from({ length: WAKE_WORKSPACES + 1 }, (_, i) => `w_${i}`);
    expect(wakeText(many)).toBe('{"t":"wake"}');
  });

  it('stays small: ten workspace IDs fit easily in one 4,096-byte record', async () => {
    const ten = Array.from({ length: 10 }, () => `w_${'A'.repeat(22)}`);
    const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
    const body = await encrypt(uaPublic, crypto.getRandomValues(new Uint8Array(16)), utf8(wakeText(ten)));
    expect(body.length).toBeLessThan(500);
  });
});
