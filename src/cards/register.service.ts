import { CardStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { encrypt, storeCard } from '../vault/index.js';
import { conflict, internal } from '../middleware/error.js';
import { fingerprintUid } from './fingerprint.js';

// Card registration — the entry point for Palisade's provisioning-agent.
// Lands a Card in PERSONALISED with a linked VaultEntry; first cardholder
// SUN-tap (separate flow) flips it to ACTIVATED and registers the passkey.
//
// PICC UID + both SDM keys are AES-256-GCM ciphertext at rest under the
// active vault key.  uidFingerprint is @unique so duplicate registrations
// fail loud rather than silently overwriting the prior card.

const ACTOR = 'provisioning-agent';

export interface RegisterCardInput {
  /** Opaque slug for the SUN URL path (`/activate/:cardRef`). */
  cardRef: string;
  /** PICC UID hex (14 chars = 7 bytes). */
  uid: string;
  /** JCOP-side chip serial (e.g. "JCOP5_00A1B2C3"). */
  chipSerial?: string;
  /** AES-128 SDM PICC-decryption key (32 hex chars = 16 bytes). */
  sdmMetaReadKey: string;
  /** AES-128 SDM CMAC session-key master (32 hex chars = 16 bytes). */
  sdmFileReadKey: string;
  /** Palisade program identifier (e.g. "prog_mc_plat_01"). */
  programId?: string;
  /** Palisade perso batch identifier (e.g. "batch_2026Q2_001"). */
  batchId?: string;
  /** Card data for the linked vault entry — vaulted in the same transaction. */
  card: {
    pan: string;
    cvc?: string;
    expiryMonth: string;
    expiryYear: string;
    cardholderName: string;
  };
  /** Audit context (forwarded into the vault store call). */
  ip?: string;
  ua?: string;
}

export interface RegisterCardResult {
  cardId: string;
  cardRef: string;
  status: CardStatus;
  vaultEntryId: string;
  panLast4: string;
}

export async function registerCard(input: RegisterCardInput): Promise<RegisterCardResult> {
  const uidNormalised = input.uid.toLowerCase();
  const uidFingerprint = fingerprintUid(uidNormalised);

  // Conflict checks before we touch the vault — fail loud, leave no trash
  // (PAN ciphertext) behind on a duplicate-registration attempt.
  const [byRef, byUid] = await Promise.all([
    prisma.card.findUnique({ where: { cardRef: input.cardRef }, select: { id: true } }),
    prisma.card.findUnique({ where: { uidFingerprint }, select: { id: true } }),
  ]);
  if (byRef) throw conflict('card_ref_taken', 'cardRef already registered');
  if (byUid) throw conflict('card_uid_taken', 'A card with this UID is already registered');

  // Vault the PAN.  `onDuplicate: 'error'` because Card↔VaultEntry is 1:1 —
  // a PAN that's already vaulted (under a different card) means the agent
  // is about to make a mistake; surface it instead of silently linking.
  const vaulted = await storeCard({
    pan: input.card.pan,
    cvc: input.card.cvc,
    expiryMonth: input.card.expiryMonth,
    expiryYear: input.card.expiryYear,
    cardholderName: input.card.cardholderName,
    actor: ACTOR,
    purpose: `card register ${input.cardRef}`,
    ip: input.ip,
    ua: input.ua,
    onDuplicate: 'error',
  });

  // Encrypt UID + SDM keys.  All three pass through the same encrypt() call,
  // which reads the active key version each invocation; we sanity-check the
  // versions match in case rotation lands mid-call.
  const uidEnc = encrypt(uidNormalised);
  const metaKeyEnc = encrypt(input.sdmMetaReadKey.toLowerCase());
  const fileKeyEnc = encrypt(input.sdmFileReadKey.toLowerCase());
  if (
    uidEnc.keyVersion !== metaKeyEnc.keyVersion ||
    metaKeyEnc.keyVersion !== fileKeyEnc.keyVersion
  ) {
    throw internal('vault_key_drift', 'vault key version drift mid-call');
  }

  const card = await prisma.card.create({
    data: {
      cardRef: input.cardRef,
      status: CardStatus.PERSONALISED,
      uidEncrypted: uidEnc.ciphertext,
      uidFingerprint,
      chipSerial: input.chipSerial,
      sdmMetaReadKeyEncrypted: metaKeyEnc.ciphertext,
      sdmFileReadKeyEncrypted: fileKeyEnc.ciphertext,
      keyVersion: uidEnc.keyVersion,
      programId: input.programId,
      batchId: input.batchId,
      vaultEntryId: vaulted.vaultEntryId,
    },
    select: { id: true, cardRef: true, status: true },
  });

  return {
    cardId: card.id,
    cardRef: card.cardRef,
    status: card.status,
    vaultEntryId: vaulted.vaultEntryId,
    panLast4: vaulted.panLast4,
  };
}
