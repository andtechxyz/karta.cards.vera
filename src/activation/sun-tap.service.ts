import { prisma } from '../db/prisma.js';
import { decrypt } from '../vault/index.js';
import { verifySunUrl, type SunVerificationResult } from '../sun/index.js';
import { badRequest, notFound, gone, unauthorized } from '../middleware/error.js';

// SUN-tap handler — invoked by the cardholder's phone after the card emits
// its NDEF URL.  Verifies the SUN signature, advances the monotonic read
// counter atomically (replay defence), and mints a 60-second ActivationSession.
//
// The session id IS the opaque token handed to the frontend
// (`/activate?session=<id>`).  No cardRef, UID, or PII crosses back — the
// frontend is identity-blind.

const SESSION_TTL_SECONDS = 60;

export interface HandleSunTapInput {
  cardRef: string;
  /** Full URL the card emitted (scheme + host + path + query). */
  fullUrl: string;
  ip?: string;
  ua?: string;
}

export interface HandleSunTapResult {
  sessionId: string;
  expiresAt: Date;
}

export async function handleSunTap(input: HandleSunTapInput): Promise<HandleSunTapResult> {
  const card = await prisma.card.findUnique({
    where: { cardRef: input.cardRef },
    select: {
      id: true,
      status: true,
      lastReadCounter: true,
      uidEncrypted: true,
      sdmMetaReadKeyEncrypted: true,
      sdmFileReadKeyEncrypted: true,
      keyVersion: true,
    },
  });
  if (!card) throw notFound('card_not_found', 'Unknown cardRef');
  if (card.status === 'REVOKED' || card.status === 'SUSPENDED') {
    throw unauthorized('card_disabled', `Card is ${card.status}`);
  }

  const sdmMetaReadKey = Buffer.from(
    decrypt({ ciphertext: card.sdmMetaReadKeyEncrypted, keyVersion: card.keyVersion }),
    'hex',
  );
  const sdmFileReadKey = Buffer.from(
    decrypt({ ciphertext: card.sdmFileReadKeyEncrypted, keyVersion: card.keyVersion }),
    'hex',
  );

  let result: SunVerificationResult;
  try {
    result = verifySunUrl({
      url: input.fullUrl,
      sdmMetaReadKey,
      sdmFileReadKey,
    });
  } finally {
    sdmMetaReadKey.fill(0);
    sdmFileReadKey.fill(0);
  }

  if (!result.valid) {
    throw badRequest('sun_invalid', `SUN verification failed: ${result.errors.join('; ')}`);
  }

  // Atomic counter advance — only succeeds if the new counter is strictly
  // greater than the stored one.  Replay or out-of-order tap → count === 0.
  const advance = await prisma.card.updateMany({
    where: { id: card.id, lastReadCounter: { lt: result.counter } },
    data: { lastReadCounter: result.counter },
  });
  if (advance.count !== 1) {
    throw gone(
      'sun_counter_replay',
      `Counter ${result.counter} is not greater than stored ${card.lastReadCounter} (replay or stale tap)`,
    );
  }

  const session = await prisma.activationSession.create({
    data: {
      cardId: card.id,
      readCounter: result.counter,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
      createdIp: input.ip,
      createdUa: input.ua,
    },
    select: { id: true, expiresAt: true },
  });

  return { sessionId: session.id, expiresAt: session.expiresAt };
}
