import crypto from 'node:crypto';
import { getKeyProvider, type KeyProvider } from './key-provider.js';

// -----------------------------------------------------------------------------
// AES-256-GCM wrapper.
//
// Ciphertext format (single base64 string):
//   [1-byte version prefix][12-byte IV][N-byte ciphertext][16-byte tag]
//
// The leading 0x01 tag lets us evolve the envelope later without breaking
// existing entries.  The key version is stored separately on the VaultEntry
// row (keyVersion column) — that's what the KeyProvider dereferences.
// -----------------------------------------------------------------------------

const ENVELOPE_VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;

export interface EncryptedPayload {
  /** base64 of envelope | iv | ciphertext | tag */
  ciphertext: string;
  /** Key version used. */
  keyVersion: number;
}

function getKp(provided?: KeyProvider): KeyProvider {
  return provided ?? getKeyProvider();
}

export function encrypt(plaintext: string, kp?: KeyProvider): EncryptedPayload {
  const provider = getKp(kp);
  const key = provider.getKey(provider.activeVersion);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, ct, tag]);
  return {
    ciphertext: envelope.toString('base64'),
    keyVersion: provider.activeVersion,
  };
}

export function decrypt(payload: EncryptedPayload, kp?: KeyProvider): string {
  const provider = getKp(kp);
  const key = provider.getKey(payload.keyVersion);
  const buf = Buffer.from(payload.ciphertext, 'base64');
  if (buf.length < 1 + IV_LEN + TAG_LEN) {
    throw new Error('ciphertext too short');
  }
  const ver = buf[0];
  if (ver !== ENVELOPE_VERSION) {
    throw new Error(`unknown envelope version: ${ver}`);
  }
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(1 + IV_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
