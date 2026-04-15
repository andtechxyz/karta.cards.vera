import { prisma } from '@vera/db';
import { conflict, badRequest, encrypt } from '@vera/core';
import { fingerprintPan, luhnValid } from './fingerprint.js';
import { vaultEvents } from './events.js';
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

export async function listCards(): Promise<CardMetadata[]> {
  const rows = await prisma.vaultEntry.findMany({
    orderBy: { createdAt: 'desc' },
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
  return rows;
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
