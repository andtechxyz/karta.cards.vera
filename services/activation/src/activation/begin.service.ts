import { generateRegistrationOptions } from '@simplewebauthn/server';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/types';
import { CardStatus } from '@prisma/client';
import { prisma } from '@vera/db';
import { notFound, conflict } from '@vera/core';
import { buildNfcCardRegistrationOptions } from '@vera/webauthn';
import { loadActiveSession } from './session.js';

// First leg of the activation ceremony.
// Browser POSTs the session token (from the handoff → begin exchange);
// we resolve it to the Card and decide which path to take:
//
//   1. Card has a preregistered FIDO credential (perso scripted the FIDO
//      applet to generate one before shipping):
//         → return { mode: "confirm" }
//      The frontend skips startRegistration() and POSTs to /finish with
//      { confirm: true }.  The pre-registered cred + the SUN-verified tap
//      together flip the card to ACTIVATED.
//
//   2. Card has no preregistered credential:
//         → return { mode: "register", options }
//      The frontend runs the WebAuthn registration ceremony as before.
//      /finish verifies attestation, inserts the cred, flips ACTIVATED.

/** Discriminated response so the frontend knows which path to take. */
export type BeginActivationResponse =
  | { mode: 'register'; options: PublicKeyCredentialCreationOptionsJSON }
  | { mode: 'confirm' };

export async function beginActivationRegistration(
  sessionToken: string,
): Promise<BeginActivationResponse> {
  const session = await loadActiveSession(sessionToken);
  const card = await prisma.card.findUnique({
    where: { id: session.cardId },
    select: {
      id: true,
      status: true,
      credentials: {
        select: { credentialId: true, kind: true, preregistered: true },
      },
    },
  });
  if (!card) throw notFound('card_not_found', 'Card not found for session');
  if (card.status === CardStatus.ACTIVATED) {
    throw conflict('card_already_activated', 'Card is already activated');
  }

  // Confirm path — at most one preregistered cred per card (DB-enforced).
  const hasPreregistered = card.credentials.some((c) => c.preregistered);
  if (hasPreregistered) {
    // Clear any stale challenge so a previously-aborted register attempt
    // can't accidentally still verify.  No new challenge needed for confirm.
    await prisma.activationSession.update({
      where: { id: session.id },
      data: { challenge: null },
    });
    return { mode: 'confirm' };
  }

  // Register path — exclude any non-preregistered creds (avoid double-
  // registering the same authenticator) and issue a fresh challenge.
  const excludeCredentialIds = card.credentials
    .filter((c) => c.kind === 'CROSS_PLATFORM' && !c.preregistered)
    .map((c) => c.credentialId);

  const opts = buildNfcCardRegistrationOptions({
    userHandle: card.id,
    userLabel: `card_${card.id.slice(0, 8)}`,
    excludeCredentialIds,
  });
  const options = await generateRegistrationOptions(opts);

  await prisma.activationSession.update({
    where: { id: session.id },
    data: { challenge: options.challenge },
  });

  return { mode: 'register', options };
}
