import { CardStatus, CredentialKind } from '@prisma/client';
import type { RegistrationResponseJSON } from '@simplewebauthn/types';
import { prisma } from '@vera/db';
import { badRequest, unauthorized } from '@vera/core';
import { verifyRegistration } from '@vera/webauthn';
import { renderNdefUrls } from '../programs/ndef.js';
import { loadActiveSession } from './session.js';

// Second leg of the activation ceremony.
// Browser POSTs the AttestationResponse from startRegistration().

export interface FinishInput {
  sessionToken: string;
  response: RegistrationResponseJSON;
  deviceLabel?: string;
}

export interface FinishResult {
  cardActivated: true;
  credentialId: string;
  postActivationNdefUrl: string;
}

export async function finishActivationRegistration(input: FinishInput): Promise<FinishResult> {
  const session = await loadActiveSession(input.sessionToken);
  if (!session.challenge) {
    throw badRequest('no_pending_challenge', 'Call /begin first to issue a registration challenge');
  }

  const verification = await verifyRegistration({
    response: input.response,
    expectedChallenge: session.challenge,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw unauthorized('registration_verify_failed', 'WebAuthn registration failed');
  }

  const info = verification.registrationInfo;
  const credentialId = info.credentialID;
  const publicKey = Buffer.from(info.credentialPublicKey).toString('base64url');
  const transports = input.response.response?.transports ?? ['nfc'];

  const [, updatedCard] = await prisma.$transaction([
    prisma.webAuthnCredential.create({
      data: {
        credentialId,
        publicKey,
        counter: BigInt(info.counter),
        kind: CredentialKind.CROSS_PLATFORM,
        transports,
        deviceName: input.deviceLabel,
        cardId: session.cardId,
      },
    }),
    prisma.card.update({
      where: { id: session.cardId },
      data: { status: CardStatus.ACTIVATED },
      select: {
        cardRef: true,
        program: {
          select: {
            preActivationNdefUrlTemplate: true,
            postActivationNdefUrlTemplate: true,
          },
        },
      },
    }),
    prisma.activationSession.update({
      where: { id: session.id },
      data: {
        consumedAt: new Date(),
        consumedDeviceLabel: input.deviceLabel,
        challenge: null,
      },
    }),
  ]);

  const { postActivation } = renderNdefUrls({
    cardRef: updatedCard.cardRef,
    preActivationTemplate: updatedCard.program?.preActivationNdefUrlTemplate ?? null,
    postActivationTemplate: updatedCard.program?.postActivationNdefUrlTemplate ?? null,
  });
  return { cardActivated: true, credentialId, postActivationNdefUrl: postActivation };
}
