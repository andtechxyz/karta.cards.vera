import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { CredentialKind } from '@prisma/client';
import { getConfig } from '../config.js';
import { prisma } from '../db/prisma.js';
import { badRequest, notFound, unauthorized } from '../middleware/error.js';
import {
  buildAuthenticationOptions,
  buildNfcCardRegistrationOptions,
  buildPlatformRegistrationOptions,
} from './config.js';

// -----------------------------------------------------------------------------
// WebAuthn service.  Thin wrappers over @simplewebauthn/server that:
//   - Always pull RP ID + origin from env (never from request).
//   - Never hand-roll base64url conversion (the library does it, matching
//     @simplewebauthn/browser v10 on the frontend).
// -----------------------------------------------------------------------------

export interface BeginRegistrationInput {
  cardId: string;
  kind: CredentialKind;
  userName: string;
}

export async function beginRegistration(
  input: BeginRegistrationInput,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const card = await prisma.card.findUnique({
    where: { id: input.cardId },
    include: { credentials: { select: { credentialId: true, kind: true } } },
  });
  if (!card) throw notFound('card_not_found', 'Card not found');

  // Exclude credentials of the same kind that already exist on other devices
  // for this card — prevents duplicate registration on the same device.
  const excludeCredentialIds = card.credentials
    .filter((c) => c.kind === input.kind)
    .map((c) => c.credentialId);

  const builderInput = {
    cardIdentifier: card.cardIdentifier,
    userName: input.userName,
    excludeCredentialIds,
  };
  const opts =
    input.kind === CredentialKind.CROSS_PLATFORM
      ? buildNfcCardRegistrationOptions(builderInput)
      : buildPlatformRegistrationOptions(builderInput);
  const options = await generateRegistrationOptions(opts);

  const ttlMs = 5 * 60 * 1000;
  await prisma.registrationChallenge.create({
    data: {
      challenge: options.challenge,
      cardId: card.id,
      kind: input.kind,
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });

  return options;
}

export interface FinishRegistrationInput {
  cardId: string;
  response: RegistrationResponseJSON;
  deviceName?: string;
}

export async function finishRegistration(input: FinishRegistrationInput) {
  const config = getConfig();
  const expectedChallenge = input.response.response?.clientDataJSON
    ? JSON.parse(
        Buffer.from(input.response.response.clientDataJSON, 'base64url').toString(
          'utf8',
        ),
      ).challenge
    : null;

  if (!expectedChallenge) {
    throw badRequest('missing_challenge', 'Response is missing clientDataJSON.challenge');
  }

  const challengeRow = await prisma.registrationChallenge.findUnique({
    where: { challenge: expectedChallenge },
  });
  if (!challengeRow || challengeRow.cardId !== input.cardId) {
    throw unauthorized('bad_challenge', 'Registration challenge not found or mismatched');
  }
  if (challengeRow.expiresAt < new Date()) {
    throw unauthorized('challenge_expired', 'Registration challenge expired');
  }

  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge,
    expectedOrigin: config.WEBAUTHN_ORIGIN,
    expectedRPID: config.WEBAUTHN_RP_ID,
    requireUserVerification: false, // NFC card has no UV; platform creds optional
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw unauthorized('registration_verify_failed', 'WebAuthn registration failed');
  }

  const info = verification.registrationInfo;
  const credentialId = Buffer.from(info.credential.id).toString('base64url');
  const publicKey = Buffer.from(info.credential.publicKey).toString('base64url');

  const transports =
    input.response.response?.transports ??
    (challengeRow.kind === CredentialKind.CROSS_PLATFORM
      ? ['nfc']
      : ['internal', 'hybrid']);

  const credential = await prisma.webAuthnCredential.create({
    data: {
      credentialId,
      publicKey,
      counter: BigInt(info.credential.counter),
      kind: challengeRow.kind,
      transports,
      deviceName: input.deviceName,
      cardId: input.cardId,
    },
  });

  // Consume the challenge (registration succeeded).
  await prisma.registrationChallenge.delete({ where: { id: challengeRow.id } });

  return credential;
}

// --- Authentication --------------------------------------------------------

export interface BeginAuthenticationInput {
  cardId: string;
  /** Pre-generated challenge (bound to the transaction). */
  challenge: string;
  /** Only offer credentials matching this kind; omit for all. */
  kinds?: CredentialKind[];
}

export async function beginAuthentication(
  input: BeginAuthenticationInput,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const creds = await prisma.webAuthnCredential.findMany({
    where: {
      cardId: input.cardId,
      ...(input.kinds && { kind: { in: input.kinds } }),
    },
  });
  if (creds.length === 0) {
    throw notFound('no_credentials', 'No WebAuthn credentials registered for this card');
  }

  const opts = buildAuthenticationOptions({
    credentials: creds.map((c) => ({
      id: c.credentialId,
      kind: c.kind,
      transports: c.transports,
    })),
  });

  // Use the caller-supplied challenge so it binds to the transaction.
  const options = await generateAuthenticationOptions({
    ...opts,
    challenge: Buffer.from(input.challenge, 'base64url'),
  });

  return options;
}

export interface FinishAuthenticationInput {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
}

export interface FinishAuthenticationResult {
  credentialId: string;
  cardId: string;
  newCounter: bigint;
}

export async function finishAuthentication(
  input: FinishAuthenticationInput,
): Promise<FinishAuthenticationResult> {
  const config = getConfig();

  const rawCredId = input.response.id;
  const credential = await prisma.webAuthnCredential.findUnique({
    where: { credentialId: rawCredId },
  });
  if (!credential) {
    throw notFound('credential_not_found', 'Credential not recognised');
  }

  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: config.WEBAUTHN_ORIGIN,
    expectedRPID: config.WEBAUTHN_RP_ID,
    credential: {
      id: credential.credentialId,
      publicKey: Buffer.from(credential.publicKey, 'base64url'),
      counter: Number(credential.counter),
      transports: credential.transports as never,
    },
    // NFC cards don't always bump the counter reliably — tolerate sig_count 0.
    requireUserVerification: false,
  });

  if (!verification.verified) {
    throw unauthorized('auth_verify_failed', 'WebAuthn authentication failed');
  }

  const newCounter = BigInt(verification.authenticationInfo.newCounter);
  await prisma.webAuthnCredential.update({
    where: { id: credential.id },
    data: { counter: newCounter, lastUsedAt: new Date() },
  });

  return {
    credentialId: credential.credentialId,
    cardId: credential.cardId,
    newCounter,
  };
}
