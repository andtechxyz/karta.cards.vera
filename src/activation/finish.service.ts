import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/types';
import { CardStatus, CredentialKind } from '@prisma/client';
import { getConfig } from '../config.js';
import { prisma } from '../db/prisma.js';
import { badRequest, unauthorized } from '../middleware/error.js';
import { renderNdefUrls } from '../programs/index.js';
import { loadActiveSession } from './session.js';

// Second leg of the activation ceremony.
//
// Browser POSTs the AttestationResponse from `startRegistration()`.  We:
//   1. Resolve the session and the challenge it was bound to in begin().
//   2. Verify the WebAuthn response against that challenge.
//   3. In a single transaction:
//        - create the WebAuthnCredential (CROSS_PLATFORM / NFC),
//        - flip Card.status → ACTIVATED,
//        - mark the session consumed and clear its challenge.
//      Either all three land or none do — no half-activated state.

export interface FinishInput {
  sessionToken: string;
  response: RegistrationResponseJSON;
  deviceLabel?: string;
}

export interface FinishResult {
  cardActivated: true;
  credentialId: string;
  /**
   * URL template (with {cardRef} already substituted, SDM markers
   * preserved) that Palisade's NDEF updater writes to the card after this
   * response lands — switching subsequent taps away from activation and
   * into the payment-initiation flow.
   */
  postActivationNdefUrl: string;
}

export async function finishActivationRegistration(input: FinishInput): Promise<FinishResult> {
  const config = getConfig();
  const session = await loadActiveSession(input.sessionToken);
  if (!session.challenge) {
    throw badRequest(
      'no_pending_challenge',
      'Call /begin first to issue a registration challenge',
    );
  }

  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: session.challenge,
    expectedOrigin: config.WEBAUTHN_ORIGIN,
    expectedRPID: config.WEBAUTHN_RP_ID,
    requireUserVerification: false, // NFC card has no PIN/UV
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw unauthorized('registration_verify_failed', 'WebAuthn registration failed');
  }

  const info = verification.registrationInfo;
  const credentialId = info.credentialID;
  const publicKey = Buffer.from(info.credentialPublicKey).toString('base64url');
  const transports = input.response.response?.transports ?? ['nfc'];

  // Piggy-back the cardRef + program templates off the card.update return
  // so we can render the post-activation URL without a second round-trip.
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
