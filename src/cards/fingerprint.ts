import crypto from 'node:crypto';
import { getConfig } from '../config.js';

/**
 * Deterministic per-card fingerprint of a PICC UID, for unique-lookup and
 * duplicate-registration prevention without storing plaintext UID.
 *
 *   fingerprint = HMAC-SHA256(VAULT_FINGERPRINT_KEY, "uid:" || lowercase(uid))
 *
 * Domain-separated from PAN fingerprints (which use the same key) by the
 * "uid:" prefix — so a UID hex string and a PAN with the same digits never
 * share a fingerprint.
 */
export function fingerprintUid(uidHex: string): string {
  const normalised = uidHex.replace(/[\s-]/g, '').toLowerCase();
  const key = Buffer.from(getConfig().VAULT_FINGERPRINT_KEY, 'hex');
  return crypto
    .createHmac('sha256', key)
    .update('uid:')
    .update(normalised)
    .digest('hex');
}
