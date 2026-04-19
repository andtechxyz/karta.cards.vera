import { prisma } from '@vera/db';
import { conflict, badRequest, encrypt } from '@vera/core';
import { fingerprintPan, luhnValid } from './fingerprint.js';
import { vaultEvents } from './events.js';
import { getVaultPanKeyProvider } from './key-provider.js';
import type { StoreInput, StoreResult, CardMetadata } from './types.js';

/**
 * Store a PAN in the vault.
 *
 * - Normalises PAN (strip spaces/dashes).
 * - Validates Luhn (rejects obvious typos).
 * - Computes fingerprint (HMAC-SHA256) and handles dedup per `onDuplicate`.
 * - Encrypts (AES-256-GCM) and writes the VaultEntry.
 * - Emits CREATE or DUPLICATE_REJECTED event.
 */
export async function storeCard(input: StoreInput): Promise<StoreResult> {
  const pan = input.pan.replace(/[\s-]/g, '');
  if (!luhnValid(pan)) {
    throw badRequest('invalid_pan', 'PAN failed Luhn check');
  }
  if (!/^(0[1-9]|1[0-2])$/.test(input.expiryMonth)) {
    throw badRequest('invalid_expiry', 'expiryMonth must be 01..12');
  }
  const expYear =
    input.expiryYear.length === 4 ? input.expiryYear.slice(2) : input.expiryYear;
  if (!/^[0-9]{2}$/.test(expYear)) {
    throw badRequest('invalid_expiry', 'expiryYear must be 2 or 4 digits');
  }

  const fp = fingerprintPan(pan);
  const panLast4 = pan.slice(-4);
  const panBin = pan.slice(0, 6);

  // Idempotency-key lookup takes precedence over fingerprint dedup.  A caller
  // (Palisade) that retries with the same idempotencyKey gets back the exact
  // same vault entry, independent of fingerprint / onDuplicate policy.
  if (input.idempotencyKey) {
    const prior = await prisma.vaultEntry.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (prior) {
      return {
        vaultEntryId: prior.id,
        panLast4: prior.panLast4,
        deduped: true,
      };
    }
  }

  // Dedup check.
  const existing = await prisma.vaultEntry.findUnique({
    where: { panFingerprint: fp },
  });
  if (existing) {
    const mode = input.onDuplicate ?? 'reuse';
    if (mode === 'error') {
      vaultEvents.emit({
        type: 'DUPLICATE_REJECTED',
        existingVaultEntryId: existing.id,
        actor: input.actor,
        purpose: input.purpose,
        ip: input.ip,
        ua: input.ua,
      });
      throw conflict('vault_duplicate', 'Card already vaulted', {
        vaultEntryId: existing.id,
        panLast4: existing.panLast4,
      });
    }
    return {
      vaultEntryId: existing.id,
      panLast4: existing.panLast4,
      deduped: true,
    };
  }

  // CVC stored encrypted alongside PAN — this vault IS the tokenisation service
  // (architecturally equivalent to Basis Theory / VGS / TokenEx).  Every payment
  // creates a fresh retrieval token → decrypts PAN+CVC → creates a new provider
  // PaymentMethod → charges.  CVC is required for every tokenised payment.
  //
  // PCI DSS 3.2.2 exemption: entities that perform issuing or support issuing
  // services may store SAD if there is a documented business justification and
  // the data is stored securely (AES-256-GCM, keys in Secrets Manager, vault
  // on internal-only ALB behind HMAC auth).
  const payload = JSON.stringify({ pan, cvc: input.cvc });
  const enc = encrypt(payload, getVaultPanKeyProvider());

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
      idempotencyKey: input.idempotencyKey,
    },
  });

  vaultEvents.emit({
    type: 'CREATE',
    vaultEntryId: row.id,
    actor: input.actor,
    purpose: input.purpose,
    ip: input.ip,
    ua: input.ua,
  });

  return { vaultEntryId: row.id, panLast4, deduped: false };
}

export async function getCardMetadata(vaultEntryId: string): Promise<CardMetadata | null> {
  return prisma.vaultEntry.findUnique({
    where: { id: vaultEntryId },
    select: {
      id: true,
      panLast4: true,
      panBin: true,
      panExpiryMonth: true,
      panExpiryYear: true,
      cardholderName: true,
      createdAt: true,
    },
  });
}
