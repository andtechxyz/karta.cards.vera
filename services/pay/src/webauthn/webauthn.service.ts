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
import {
  createWebAuthnCredential,
  getWebAuthnCredentialByCredentialId,
  listWebAuthnCredentials,
  lookupCard,
  updateWebAuthnCredentialCounter,
  type PalisadeClientOptions,
  type WebAuthnCredential,
} from '../cards/index.js';
import { getPayConfig } from '../env.js';

// -----------------------------------------------------------------------------
// Pay service WebAuthn service — registration (for admin/dev path) + auth.
//
// Post Vera/Palisade split:
//   - WebAuthnCredential rows live in Palisade (Card-adjacent).  Pay
//     accesses them over HTTP via services/pay/src/cards/palisade-client.ts.
//   - RegistrationChallenge rows stay on Vera's local DB — they're a
//     per-pay-request nonce that never leaves the pay transaction flow, so
//     there's no benefit to a cross-repo round-trip.  Pay reads them via
//     local `prisma.registrationChallenge.*`.
// -----------------------------------------------------------------------------

/**
 * Pay's Palisade credentials, resolved once per request from config.  Shared
 * helper so every webauthn operation uses the same baseUrl + HMAC key.
 */
function palisadeOpts(): PalisadeClientOptions {
  const cfg = getPayConfig();
  return {
    baseUrl: cfg.PALISADE_BASE_URL,
    keyId: 'pay',
    secret: cfg.SERVICE_AUTH_PALISADE_SECRET,
  };
}

export interface BeginRegistrationInput {
  cardId: string;
  kind: CredentialKind;
}

export async function beginRegistration(
  input: BeginRegistrationInput,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const opts = palisadeOpts();

  // Confirm the card exists (Palisade is the source of truth now).  lookupCard
  // throws notFound('card_not_found') on 404, which we let propagate — same
  // 404 the previous prisma.card.findUnique miss produced.
  const card = await lookupCard(input.cardId, opts);

  // excludeCredentialIds comes from the already-registered same-kind credentials
  // on Palisade.  We ask Palisade for the full list and filter locally — the
  // list is always small (one or two credentials per card).
  const existing = await listWebAuthnCredentials(card.id, opts);
  const excludeCredentialIds = existing
    .filter((c) => c.kind === input.kind)
    .map((c) => c.credentialId);

  const builderInput = {
    userHandle: card.id,
    userLabel: `card_${card.id.slice(0, 8)}`,
    excludeCredentialIds,
  };
  const builderOpts =
    input.kind === CredentialKind.CROSS_PLATFORM
      ? buildNfcCardRegistrationOptions(builderInput)
      : buildPlatformRegistrationOptions(builderInput);
  const options = await generateRegistrationOptions(builderOpts);

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
  const opts = palisadeOpts();

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

  const credential = await createWebAuthnCredential(
    input.cardId,
    {
      credentialId,
      publicKey,
      counter: BigInt(info.counter),
      kind: challengeRow.kind,
      transports,
      deviceName: input.deviceName,
    },
    opts,
  );

  // Consume the single-use challenge.  Swallow P2025 (row not found) in case
  // a retention sweeper raced us — either way the challenge is gone.
  try {
    await prisma.registrationChallenge.delete({
      where: { challenge: challengeRow.challenge },
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== 'P2025') throw err;
  }

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
  const opts = palisadeOpts();

  const all = await listWebAuthnCredentials(input.cardId, opts);
  const creds = input.kinds
    ? all.filter((c) => input.kinds!.includes(c.kind as CredentialKind))
    : all;
  if (creds.length === 0) {
    throw notFound('no_credentials', 'No WebAuthn credentials registered for this card');
  }

  const builderOpts = buildAuthenticationOptions({
    credentials: creds.map((c: WebAuthnCredential) => ({
      id: c.credentialId,
      kind: c.kind as CredentialKind,
      transports: c.transports,
    })),
  });

  const options = await generateAuthenticationOptions({
    ...builderOpts,
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
  const opts = palisadeOpts();

  const rawCredId = input.response.id;
  const credential = await getWebAuthnCredentialByCredentialId(rawCredId, opts);
  if (!credential) {
    throw notFound('credential_not_found', 'Credential not recognised');
  }

  if (
    input.allowedKinds &&
    !input.allowedKinds.includes(credential.kind as CredentialKind)
  ) {
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
  // Palisade stores counter as Int; the authenticator bumps it by 1 so it
  // comfortably fits a JS number even for very active credentials.
  await updateWebAuthnCredentialCounter(
    credential.credentialId,
    Number(newCounter),
    opts,
  );

  return {
    credentialId: credential.credentialId,
    cardId: credential.cardId,
    kind: credential.kind as CredentialKind,
    newCounter,
  };
}
