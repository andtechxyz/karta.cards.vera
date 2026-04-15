import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/types';
import { CredentialKind } from '@prisma/client';
import { prisma } from '@vera/db';
import { badRequest, notFound, unauthorized } from '@vera/core';
import {
  buildAuthenticationOptions,
  buildNfcCardRegistrationOptions,
  buildPlatformRegistrationOptions,
  verifyRegistration,
  verifyAuthentication,
} from '@vera/webauthn';

// Pay service WebAuthn service — registration (for admin/dev path) + auth.

export interface BeginRegistrationInput {
  cardId: string;
  kind: CredentialKind;
}

export async function beginRegistration(
  input: BeginRegistrationInput,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const card = await prisma.card.findUnique({
    where: { id: input.cardId },
    include: { credentials: { select: { credentialId: true, kind: true } } },
  });
  if (!card) throw notFound('card_not_found', 'Card not found');

  const excludeCredentialIds = card.credentials
    .filter((c) => c.kind === input.kind)
    .map((c) => c.credentialId);

  const builderInput = {
    userHandle: card.id,
    userLabel: `card_${card.id.slice(0, 8)}`,
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
  const expectedChallenge = input.response.response?.clientDataJSON
    ? JSON.parse(
        Buffer.from(input.response.response.clientDataJSON, 'base64url').toString('utf8'),
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

  const verification = await verifyRegistration({
    response: input.response,
    expectedChallenge,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw unauthorized('registration_verify_failed', 'WebAuthn registration failed');
  }

  const info = verification.registrationInfo;
  const credentialId = info.credentialID;
  const publicKey = Buffer.from(info.credentialPublicKey).toString('base64url');
  const transports =
    input.response.response?.transports ??
    (challengeRow.kind === CredentialKind.CROSS_PLATFORM
      ? ['nfc']
      : ['internal', 'hybrid']);

  const credential = await prisma.webAuthnCredential.create({
    data: {
      credentialId,
      publicKey,
      counter: BigInt(info.counter),
      kind: challengeRow.kind,
      transports,
      deviceName: input.deviceName,
      cardId: input.cardId,
    },
  });

  await prisma.registrationChallenge.delete({ where: { id: challengeRow.id } });

  return credential;
}

export interface BeginAuthenticationInput {
  cardId: string;
  challenge: string;
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

  const options = await generateAuthenticationOptions({
    ...opts,
    challenge: Buffer.from(input.challenge, 'base64url'),
  });

  return options;
}

export interface FinishAuthenticationInput {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  allowedKinds?: CredentialKind[];
}

export interface FinishAuthenticationResult {
  credentialId: string;
  cardId: string;
  kind: CredentialKind;
  newCounter: bigint;
}

export async function finishAuthentication(
  input: FinishAuthenticationInput,
): Promise<FinishAuthenticationResult> {
  const rawCredId = input.response.id;
  const credential = await prisma.webAuthnCredential.findUnique({
    where: { credentialId: rawCredId },
  });
  if (!credential) {
    throw notFound('credential_not_found', 'Credential not recognised');
  }

  if (input.allowedKinds && !input.allowedKinds.includes(credential.kind)) {
    throw unauthorized(
      'credential_kind_not_allowed',
      `Credential kind ${credential.kind} is not acceptable for this transaction`,
    );
  }

  const verification = await verifyAuthentication({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    credential: {
      credentialId: credential.credentialId,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports as AuthenticatorTransportFuture[],
    },
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
    kind: credential.kind,
    newCounter,
  };
}
