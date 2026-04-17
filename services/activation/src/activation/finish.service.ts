import { CardStatus, CredentialKind } from '@prisma/client';
import type { RegistrationResponseJSON } from '@simplewebauthn/types';
import { prisma } from '@vera/db';
import { badRequest, unauthorized } from '@vera/core';
import { verifyRegistration } from '@vera/webauthn';
import { renderNdefUrls } from '../programs/ndef.js';
import { getActivationConfig } from '../env.js';
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
  /**
   * Absolute URL of the program's microsite, if the program has a microsite
   * enabled and an active version published.  Null otherwise — the frontend
   * falls back to its built-in success screen.
   */
  micrositeUrl: string | null;
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
            id: true,
            preActivationNdefUrlTemplate: true,
            postActivationNdefUrlTemplate: true,
            micrositeEnabled: true,
            micrositeActiveVersion: true,
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

  // If the program has a microsite enabled with an active version, build the
  // redirect URL.  `card` + `activated` params give the microsite enough
  // context to render a personalised landing without needing backend calls.
  const config = getActivationConfig();
  const program = updatedCard.program;
  const micrositeUrl =
    program?.micrositeEnabled && program.micrositeActiveVersion
      ? `${config.MICROSITE_CDN_URL.replace(/\/$/, '')}/programs/${program.id}/?card=${encodeURIComponent(
          updatedCard.cardRef,
        )}&activated=true`
      : null;

  return {
    cardActivated: true,
    credentialId,
    postActivationNdefUrl: postActivation,
    micrositeUrl,
  };
}
