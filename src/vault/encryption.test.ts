import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from './encryption.js';

describe('AES-256-GCM envelope', () => {
  it('round-trips a PAN', () => {
    const pan = '4242424242424242';
    const enc = encrypt(pan);
    expect(decrypt(enc)).toBe(pan);
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const a = encrypt('hello');
    const b = encrypt('hello');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('records the active key version', () => {
    const enc = encrypt('hello');
    expect(enc.keyVersion).toBe(1);
  });

  it('round-trips multibyte UTF-8', () => {
    const name = 'Müller — 田中';
    expect(decrypt(encrypt(name))).toBe(name);
  });

  it('rejects a tampered tag', () => {
    const enc = encrypt('hello');
    const buf = Buffer.from(enc.ciphertext, 'base64');
    // Flip the last byte (part of the auth tag).
    buf[buf.length - 1] ^= 0x01;
    const bad = { ...enc, ciphertext: buf.toString('base64') };
    expect(() => decrypt(bad)).toThrow();
  });

  it('rejects a tampered ciphertext byte', () => {
    const enc = encrypt('hello');
    const buf = Buffer.from(enc.ciphertext, 'base64');
    // Flip a byte in the middle of the ciphertext region.
    buf[1 + 12 + 1] ^= 0x01;
    const bad = { ...enc, ciphertext: buf.toString('base64') };
    expect(() => decrypt(bad)).toThrow();
  });

  it('rejects an unknown envelope version byte', () => {
    const enc = encrypt('hello');
    const buf = Buffer.from(enc.ciphertext, 'base64');
    buf[0] = 0x99;
    const bad = { ...enc, ciphertext: buf.toString('base64') };
    expect(() => decrypt(bad)).toThrow(/envelope version/);
  });

  it('rejects too-short payloads', () => {
    const bad = { ciphertext: Buffer.from([0x01, 0x02]).toString('base64'), keyVersion: 1 };
    expect(() => decrypt(bad)).toThrow();
  });
});
