import crypto from 'node:crypto';
import { getCryptoConfig } from '@vera/core';

/**
 * Deterministic per-card fingerprint of a PICC UID, for unique-lookup and
 * duplicate-registration prevention without storing plaintext UID.
 *
 *   fingerprint = HMAC-SHA256(VAULT_FINGERPRINT_KEY, "uid:" || lowercase(uid))
 */
export function fingerprintUid(uidHex: string): string {
  const normalised = uidHex.replace(/[\s-]/g, '').toLowerCase();
  const key = Buffer.from(getCryptoConfig().VAULT_FINGERPRINT_KEY, 'hex');
  return crypto
    .createHmac('sha256', key)
    .update('uid:')
    .update(normalised)
    .digest('hex');
}
