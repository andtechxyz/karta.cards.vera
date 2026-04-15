import { generateRegistrationOptions } from '@simplewebauthn/server';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/types';
import { CardStatus } from '@prisma/client';
import { prisma } from '@vera/db';
import { notFound, conflict } from '@vera/core';
import { buildNfcCardRegistrationOptions } from '@vera/webauthn';
import { loadActiveSession } from './session.js';

// First leg of the activation ceremony.
// Browser POSTs the session token (from the handoff → begin exchange);
// we resolve it to the Card, generate WebAuthn NFC-card registration options,
// and stash the challenge on the session row.

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

  const excludeCredentialIds = card.credentials
    .filter((c) => c.kind === 'CROSS_PLATFORM')
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

  return options;
}
