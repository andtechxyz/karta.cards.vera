import { CardStatus, CredentialKind } from '@prisma/client';
import type { RegistrationResponseJSON } from '@simplewebauthn/types';
import { prisma } from '@vera/db';
import { badRequest, unauthorized } from '@vera/core';
import { verifyRegistration } from '@vera/webauthn';
import { renderNdefUrls } from '../programs/ndef.js';
import { getActivationConfig } from '../env.js';
import { loadActiveSession } from './session.js';

// Second leg of the activation ceremony.  Two paths:
//
//   register mode:  Browser POSTs the AttestationResponse from
//                   startRegistration().  We verify, insert the cred row,
//                   flip the card to ACTIVATED.
//
//   confirm mode:   Browser POSTs { confirm: true }.  Card already has a
//                   preregistered FIDO credential (loaded by perso); the
//                   SUN-verified tap that got us here is the only proof
//                   needed.  We just flip the card to ACTIVATED.

export interface FinishInput {
  sessionToken: string;
  /** Present in register mode only. */
  response?: RegistrationResponseJSON;
  /** Present in confirm mode only. */
  confirm?: true;
  deviceLabel?: string;
}

export interface FinishResult {
  cardActivated: true;
  credentialId: string;
  postActivationNdefUrl: string;
  /** Source of the credentialId in the response — 'attestation' (register
   *  mode) or 'preregistered' (confirm mode).  Useful for client-side
   *  display + audit. */
  mode: 'register' | 'confirm';
  /**
   * Absolute URL of the program's microsite, if the program has a microsite
   * enabled and an active version published.  Null otherwise — the frontend
   * falls back to its built-in success screen.
   */
  micrositeUrl: string | null;
}

export async function finishActivationRegistration(input: FinishInput): Promise<FinishResult> {
  const session = await loadActiveSession(input.sessionToken);

  if (input.confirm === true) {
    return finishConfirm(session, input.deviceLabel);
  }
  if (!input.response) {
    throw badRequest(
      'missing_response',
      'Either { response } (register mode) or { confirm: true } (confirm mode) is required',
    );
  }
  return finishRegister(session, input.response, input.deviceLabel);
}

// ---------------------------------------------------------------------------
// register mode — original WebAuthn ceremony
// ---------------------------------------------------------------------------

async function finishRegister(
  session: { id: string; cardId: string; challenge: string | null },
  response: RegistrationResponseJSON,
  deviceLabel: string | undefined,
): Promise<FinishResult> {
  if (!session.challenge) {
    throw badRequest('no_pending_challenge', 'Call /begin first to issue a registration challenge');
  }

  const verification = await verifyRegistration({
    response,
    expectedChallenge: session.challenge,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw unauthorized('registration_verify_failed', 'WebAuthn registration failed');
  }

  const info = verification.registrationInfo;
  const credentialId = info.credentialID;
  const publicKey = Buffer.from(info.credentialPublicKey).toString('base64url');
  const transports = response.response?.transports ?? ['nfc'];

  const [, updatedCard] = await prisma.$transaction([
    prisma.webAuthnCredential.create({
      data: {
        credentialId,
        publicKey,
        counter: BigInt(info.counter),
        kind: CredentialKind.CROSS_PLATFORM,
        transports,
        deviceName: deviceLabel,
        cardId: session.cardId,
      },
    }),
    prisma.card.update({
      where: { id: session.cardId },
      data: { status: CardStatus.ACTIVATED },
      select: micrositeProgramSelect,
    }),
    prisma.activationSession.update({
      where: { id: session.id },
      data: {
        consumedAt: new Date(),
        consumedDeviceLabel: deviceLabel,
        challenge: null,
      },
    }),
  ]);

  return buildResult({
    cardRef: updatedCard.cardRef,
    credentialId,
    program: updatedCard.program,
    mode: 'register',
  });
}

// ---------------------------------------------------------------------------
// confirm mode — pre-registered credential, no WebAuthn ceremony at runtime
// ---------------------------------------------------------------------------

async function finishConfirm(
  session: { id: string; cardId: string; challenge: string | null },
  deviceLabel: string | undefined,
): Promise<FinishResult> {
  // Defensive: a confirm-mode finish is only valid if a preregistered cred
  // exists for the card.  /begin already enforces this (it returns
  // mode=confirm only when a preregistered cred is present), but the gap
  // between /begin and /finish is unbounded — if an admin races to delete
  // the cred between the two calls, we should refuse rather than silently
  // ACTIVATE without any credential at all.
  const cred = await prisma.webAuthnCredential.findFirst({
    where: { cardId: session.cardId, preregistered: true },
    select: { id: true, credentialId: true },
  });
  if (!cred) {
    throw badRequest(
      'no_preregistered_credential',
      'Card has no preregistered credential — call /begin again for register mode',
    );
  }

  const [, updatedCard] = await prisma.$transaction([
    prisma.webAuthnCredential.update({
      where: { id: cred.id },
      data: { lastUsedAt: new Date(), deviceName: deviceLabel ?? undefined },
    }),
    prisma.card.update({
      where: { id: session.cardId },
      data: { status: CardStatus.ACTIVATED },
      select: micrositeProgramSelect,
    }),
    prisma.activationSession.update({
      where: { id: session.id },
      data: {
        consumedAt: new Date(),
        consumedDeviceLabel: deviceLabel,
        challenge: null,
      },
    }),
  ]);

  return buildResult({
    cardRef: updatedCard.cardRef,
    credentialId: cred.credentialId,
    program: updatedCard.program,
    mode: 'confirm',
  });
}

// ---------------------------------------------------------------------------
// Shared helpers — selectors + result builder
// ---------------------------------------------------------------------------

const micrositeProgramSelect = {
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
} as const;

interface ProgramFields {
  id: string;
  preActivationNdefUrlTemplate: string | null;
  postActivationNdefUrlTemplate: string | null;
  micrositeEnabled: boolean;
  micrositeActiveVersion: string | null;
}

function buildResult(input: {
  cardRef: string;
  credentialId: string;
  program: ProgramFields | null;
  mode: 'register' | 'confirm';
}): FinishResult {
  const config = getActivationConfig();
  const { postActivation } = renderNdefUrls({
    cardRef: input.cardRef,
    preActivationTemplate: input.program?.preActivationNdefUrlTemplate ?? null,
    postActivationTemplate: input.program?.postActivationNdefUrlTemplate ?? null,
  });

  const micrositeUrl =
    input.program?.micrositeEnabled && input.program.micrositeActiveVersion
      ? `${config.MICROSITE_CDN_URL.replace(/\/$/, '')}/programs/${input.program.id}/?card=${encodeURIComponent(
          input.cardRef,
        )}&activated=true`
      : null;

  return {
    cardActivated: true,
    credentialId: input.credentialId,
    postActivationNdefUrl: postActivation,
    mode: input.mode,
    micrositeUrl,
  };
}
