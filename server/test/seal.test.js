import { describe, expect, it } from 'vitest';
import vectors from './fixtures/booking-vectors.json' with { type: 'json' };
import { fromBase64url, sha256, toBase64url, utf8 } from '../src/bytes.js';
import { GUEST_KEYS, SEAL_OVERHEAD, guestJson, keyId, open, seal, unwrapManageKey, wrapManageKey } from '../src/seal.js';
import * as input from '../src/input.js';

const bytes = (text) => fromBase64url(text);

describe('sealed guest details', () => {
  it('has the three vectors the contract asks for', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.seal.map((v) => v.name)).toEqual(['basic', 'unicode', 'empty']);
  });

  for (const v of vectors.seal) {
    it(`reproduces the ${v.name} vector exactly`, async () => {
      expect(Object.keys(v.plaintext)).toEqual(GUEST_KEYS);
      expect(guestJson(v.plaintext)).toBe(v.plaintextJson);
      expect(v.aad).toBe(`rukoo/v1/booking:${v.handle}:${v.bookingId}`);
      expect(toBase64url(await keyId(bytes(v.owner.publicRaw)))).toBe(v.owner.keyId);
      const result = await seal({
        publicRaw: bytes(v.owner.publicRaw),
        handle: v.handle,
        bookingId: v.bookingId,
        plaintext: v.plaintext,
        ephemeral: { privatePkcs8: bytes(v.ephemeral.privatePkcs8), publicRaw: bytes(v.ephemeral.publicRaw) },
        nonce: bytes(v.nonce)
      });
      expect(toBase64url(result.ikm)).toBe(v.ikm);
      expect(toBase64url(result.key)).toBe(v.key);
      expect(toBase64url(result.blob)).toBe(v.blob);

      const blob = bytes(v.blob);
      expect(blob[0]).toBe(0x02);
      expect(toBase64url(blob.slice(1, 9))).toBe(v.owner.keyId);
      expect(toBase64url(blob.slice(9, 74))).toBe(v.ephemeral.publicRaw);
      expect(toBase64url(blob.slice(74, 86))).toBe(v.nonce);
      expect(blob.length).toBe(utf8(v.plaintextJson).length + SEAL_OVERHEAD);
      expect(SEAL_OVERHEAD).toBe(102);

      const opened = await open({ privatePkcs8: bytes(v.owner.privatePkcs8), handle: v.handle, bookingId: v.bookingId, blob });
      expect(opened).toBe(v.plaintextJson);
      expect(JSON.parse(opened)).toEqual(v.plaintext);
    });
  }

  it('binds the blob to its handle and booking id', async () => {
    const v = vectors.seal[0];
    const key = bytes(v.owner.privatePkcs8);
    await expect(open({ privatePkcs8: key, handle: 'other', bookingId: v.bookingId, blob: v.blob })).rejects.toThrow();
    await expect(open({ privatePkcs8: key, handle: v.handle, bookingId: vectors.seal[1].bookingId, blob: v.blob })).rejects.toThrow();
    const flipped = bytes(v.blob);
    flipped[flipped.length - 1] ^= 1;
    await expect(open({ privatePkcs8: key, handle: v.handle, bookingId: v.bookingId, blob: flipped })).rejects.toThrow();
    // Another vector's owner can't open it: the key id already says so.
    await expect(
      open({ privatePkcs8: bytes(vectors.seal[1].owner.privatePkcs8), handle: v.handle, bookingId: v.bookingId, blob: v.blob })
    ).rejects.toThrow('another key');
  });

  it('uses a fresh ephemeral key and nonce for every booking', async () => {
    const v = vectors.seal[0];
    const one = await seal({ publicRaw: bytes(v.owner.publicRaw), handle: v.handle, bookingId: v.bookingId, plaintext: v.plaintext });
    const two = await seal({ publicRaw: bytes(v.owner.publicRaw), handle: v.handle, bookingId: v.bookingId, plaintext: v.plaintext });
    expect(toBase64url(one.blob)).not.toBe(toBase64url(two.blob));
    expect(toBase64url(one.blob.slice(9, 74))).not.toBe(toBase64url(two.blob.slice(9, 74)));
    for (const r of [one, two]) {
      expect(await open({ privatePkcs8: bytes(v.owner.privatePkcs8), handle: v.handle, bookingId: v.bookingId, blob: r.blob })).toBe(
        v.plaintextJson
      );
    }
  });

  it('wraps a manage key so only the same Idempotency-Key opens it', async () => {
    const wrapped = await wrapManageKey('retry-key-0123456789', 'Rf63vMqqWdS0MICDAHKmrw', 'secret-manage-key');
    expect(await unwrapManageKey('retry-key-0123456789', 'Rf63vMqqWdS0MICDAHKmrw', wrapped)).toBe('secret-manage-key');
    await expect(unwrapManageKey('retry-key-0123456780', 'Rf63vMqqWdS0MICDAHKmrw', wrapped)).rejects.toThrow();
    await expect(unwrapManageKey('retry-key-0123456789', 'AAAAAAAAAAAAAAAAAAAAAA', wrapped)).rejects.toThrow();
  });
});

describe('shared vectors', () => {
  it('names each account the way the desktop does', async () => {
    for (const { email, acct } of vectors.acct) {
      expect(toBase64url(await sha256(utf8(email.trim().toLowerCase()))).slice(0, 16)).toBe(acct);
    }
    expect(vectors.acct[0]).toEqual({ email: 'Bart@Example.com', acct: 'FOZ2B43RaG2Xodx3' });
  });

  it('sorts handles and slugs as the server does', () => {
    for (const h of vectors.handles.valid) expect(input.handleCheck(h), h).toBe(null);
    for (const h of vectors.handles.invalid) expect(input.handleCheck(h), h).toBe('invalid');
    for (const h of vectors.handles.reserved) expect(input.handleCheck(h), h).toBe('reserved');
    for (const s of vectors.slugs.valid) expect(input.slugCheck(s), s).toBe(null);
    for (const s of vectors.slugs.invalid) expect(input.slugCheck(s), s).toBe('invalid');
    for (const s of vectors.slugs.reserved) expect(input.slugCheck(s), s).toBe('reserved');
  });
});
