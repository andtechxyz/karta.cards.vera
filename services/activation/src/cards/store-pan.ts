import crypto from 'node:crypto';
import { prisma } from '@vera/db';
import { encrypt, conflict, badRequest, getCryptoConfig } from '@vera/core';

// Inline PAN storage for the provisioning-agent path.
// Activation has the same vault keys, so it can store PANs without going
// over HTTP to vault.  The vault service owns the retrieval/consumption path.

interface StorePanInput {
  pan: string;
  cvc?: string;
  expiryMonth: string;
  expiryYear: string;
  cardholderName: string;
  actor: string;
  purpose: string;
  ip?: string;
  ua?: string;
  onDuplicate?: 'error' | 'reuse';
}

interface StorePanResult {
  vaultEntryId: string;
  panLast4: string;
  deduped: boolean;
}

function fingerprintPan(rawPan: string): string {
  const normalised = rawPan.replace(/[\s-]/g, '').toLowerCase();
  const key = Buffer.from(getCryptoConfig().VAULT_FINGERPRINT_KEY, 'hex');
  return crypto.createHmac('sha256', key).update(normalised).digest('hex');
}

function luhnValid(pan: string): boolean {
  const digits = pan.replace(/[\s-]/g, '');
  if (!/^[0-9]+$/.test(digits) || digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export async function storeCardPan(input: StorePanInput): Promise<StorePanResult> {
  const pan = input.pan.replace(/[\s-]/g, '');
  if (!luhnValid(pan)) throw badRequest('invalid_pan', 'PAN failed Luhn check');
  if (!/^(0[1-9]|1[0-2])$/.test(input.expiryMonth)) {
    throw badRequest('invalid_expiry', 'expiryMonth must be 01..12');
  }
  const expYear = input.expiryYear.length === 4 ? input.expiryYear.slice(2) : input.expiryYear;
  if (!/^[0-9]{2}$/.test(expYear)) {
    throw badRequest('invalid_expiry', 'expiryYear must be 2 or 4 digits');
  }

  const fp = fingerprintPan(pan);
  const panLast4 = pan.slice(-4);
  const panBin = pan.slice(0, 6);

  const existing = await prisma.vaultEntry.findUnique({ where: { panFingerprint: fp } });
  if (existing) {
    if ((input.onDuplicate ?? 'reuse') === 'error') {
      throw conflict('vault_duplicate', 'Card already vaulted', {
        vaultEntryId: existing.id,
        panLast4: existing.panLast4,
      });
    }
    return { vaultEntryId: existing.id, panLast4: existing.panLast4, deduped: true };
  }

  const payload = JSON.stringify({ pan, cvc: input.cvc });
  const enc = encrypt(payload);

  const row = await prisma.vaultEntry.create({
    data: {
      panLast4,
      panBin,
      cardholderName: input.cardholderName,
      panExpiryMonth: input.expiryMonth,
      panExpiryYear: expYear,
      encryptedPan: enc.ciphertext,
      keyVersion: enc.keyVersion,
      panFingerprint: fp,
    },
  });

  return { vaultEntryId: row.id, panLast4, deduped: false };
}
