import crypto from 'node:crypto';

/**
 * HKDF-SHA256.  Node has `crypto.hkdfSync` as of v15, which is exactly what
 * we need.  Wrapping for type-friendliness and so we can swap for a
 * pure-JS impl if this ever needs to run in a constrained runtime.
 */
export function hkdf(
  ikm: Buffer,
  salt: Buffer,
  info: Buffer,
  length: number,
): Buffer {
  // crypto.hkdfSync returns an ArrayBuffer; cast to Buffer.
  const out = crypto.hkdfSync('sha256', ikm, salt, info, length);
  return Buffer.from(out);
}
