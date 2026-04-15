import { describe, it, expect } from 'vitest';
import { hkdf } from './kdf.js';

// RFC 5869 Appendix A.1 — basic test case (SHA-256).

describe('hkdf — RFC 5869 vector A.1', () => {
  const ikm = Buffer.from('0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b'.slice(0, 22 * 2), 'hex'); // 22 bytes
  // Above slice is awkward — use the exact RFC vector explicitly:
  const ikmA1 = Buffer.from('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b', 'hex'); // 22 × 0x0b
  const salt = Buffer.from('000102030405060708090a0b0c', 'hex');
  const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex');
  const expected =
    '3cb25f25faacd57a90434f64d0362f2a' +
    '2d2d0a90cf1a5a4c5db02d56ecc4c5bf' +
    '34007208d5b887185865';

  it('produces the RFC vector for L=42', () => {
    expect(hkdf(ikmA1, salt, info, 42).toString('hex')).toBe(expected);
    void ikm; // silence unused — leave for future readers tracing the constant
  });

  it('different info produces different output', () => {
    const a = hkdf(ikmA1, salt, Buffer.from('a'), 32);
    const b = hkdf(ikmA1, salt, Buffer.from('b'), 32);
    expect(a.toString('hex')).not.toBe(b.toString('hex'));
  });

  it('different salt produces different output', () => {
    const a = hkdf(ikmA1, Buffer.from('s1'), info, 32);
    const b = hkdf(ikmA1, Buffer.from('s2'), info, 32);
    expect(a.toString('hex')).not.toBe(b.toString('hex'));
  });

  it('honours requested length', () => {
    expect(hkdf(ikmA1, salt, info, 16).length).toBe(16);
    expect(hkdf(ikmA1, salt, info, 64).length).toBe(64);
  });
});
