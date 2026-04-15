import { generateRegistrationOptions } from '@simplewebauthn/server';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/types';
import { CardStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { notFound, conflict } from '../middleware/error.js';
import { buildNfcCardRegistrationOptions } from '../webauthn/config.js';
import { loadActiveSession } from './session.js';

// First leg of the activation ceremony.
//
// Browser hands us the opaque session token (from the SUN-tap redirect);
// we resolve it to the underlying Card, generate WebAuthn registration
// options for the NFC-card (cross-platform) profile, and stash the challenge
// on the session row.  Returns the options for the browser to forward into
// `startRegistration()`.

export async function beginActivationRegistration(
  sessionToken: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const session = await loadActiveSession(sessionToken);
  const card = await prisma.card.findUnique({
    where: { id: session.cardId },
    select: {
      id: true,
      status: true,
      credentials: { select: { credentialId: true, kind: true } },
    },
  });
  if (!card) throw notFound('card_not_found', 'Card not found for session');
  if (card.status === CardStatus.ACTIVATED) {
    throw conflict('card_already_activated', 'Card is already activated');
  }

  // Exclude any cross-platform creds already registered for this card so the
  // same physical card+device can't be re-bound on retry.
  const excludeCredentialIds = card.credentials
    .filter((c) => c.kind === 'CROSS_PLATFORM')
    .map((c) => c.credentialId);

  const opts = buildNfcCardRegistrationOptions({
    userHandle: card.id,
    userLabel: `card_${card.id.slice(0, 8)}`,
    excludeCredentialIds,
  });
  const options = await generateRegistrationOptions(opts);

  // Bind the challenge to the session (overwriting any prior begin-call
  // challenge — the most-recent begin wins, matching browser-retry UX).
  await prisma.activationSession.update({
    where: { id: session.id },
    data: { challenge: options.challenge },
  });

  return options;
}
