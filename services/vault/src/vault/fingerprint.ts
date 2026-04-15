import crypto from 'node:crypto';
import { getVaultConfig } from '../env.js';

/**
 * Deterministic fingerprint of a PAN, for dedup without decrypt.
 *
 *   fingerprint = HMAC-SHA256(VAULT_PAN_FINGERPRINT_KEY, normalisedPan)
 *
 * Normalisation: strip spaces and dashes, lowercase.  PANs are digits-only
 * in practice but we defensively normalise for pasted values.
 */
export function fingerprintPan(rawPan: string): string {
  const normalised = rawPan.replace(/[\s-]/g, '').toLowerCase();
  const key = Buffer.from(getVaultConfig().VAULT_PAN_FINGERPRINT_KEY, 'hex');
  return crypto.createHmac('sha256', key).update(normalised).digest('hex');
}

/** Basic Luhn check — surface obviously-typoed PANs early. */
export function luhnValid(pan: string): boolean {
  const digits = pan.replace(/[\s-]/g, '');
  if (!/^[0-9]+$/.test(digits) || digits.length < 12 || digits.length > 19) {
    return false;
  }
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}
