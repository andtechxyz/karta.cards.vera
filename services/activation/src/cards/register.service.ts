import { CardStatus } from '@prisma/client';
import { prisma } from '@vera/db';
import { encrypt, conflict, internal } from '@vera/core';
import { storeCardPan } from './store-pan.js';
import { fingerprintUid } from './fingerprint.js';

// Card registration — entry point for Palisade's provisioning-agent.
// Lands a Card in PERSONALISED with a linked VaultEntry; first cardholder
// SUN-tap (separate flow) flips it to ACTIVATED and registers the passkey.

const ACTOR = 'provisioning-agent';

export interface RegisterCardInput {
  cardRef: string;
  uid: string;
  chipSerial?: string;
  sdmMetaReadKey: string;
  sdmFileReadKey: string;
  programId?: string;
  batchId?: string;
  card: {
    pan: string;
    cvc?: string;
    expiryMonth: string;
    expiryYear: string;
    cardholderName: string;
  };
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

  const [byRef, byUid] = await Promise.all([
    prisma.card.findUnique({ where: { cardRef: input.cardRef }, select: { id: true } }),
    prisma.card.findUnique({ where: { uidFingerprint }, select: { id: true } }),
  ]);
  if (byRef) throw conflict('card_ref_taken', 'cardRef already registered');
  if (byUid) throw conflict('card_uid_taken', 'A card with this UID is already registered');

  // Store the PAN (inline — activation has the same vault keys)
  const vaulted = await storeCardPan({
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

  // Encrypt UID + SDM keys under the vault key.
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
