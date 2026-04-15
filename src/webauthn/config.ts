import type {
  GenerateAuthenticationOptionsOpts,
  GenerateRegistrationOptionsOpts,
} from '@simplewebauthn/server';
import { CredentialKind } from '@prisma/client';
import { getConfig } from '../config.js';

// -----------------------------------------------------------------------------
// Canonical WebAuthn option builders.
//
// These are the SINGLE source of truth for what we send to the browser.  The
// defaults are transcribed from New T4T — see
// /Users/danderson/.claude/plans/tingly-imagining-sketch.md, "WebAuthn/NFC
// requirements".
//
// Two distinct profiles:
//   1. NFC card (Tier 2) — CTAP1/U2F-compatible options; Android Chrome-safe.
//   2. Platform (Tier 1/3) — Face ID / Touch ID / Windows Hello.
//
// Do NOT merge these.  Do NOT loosen them without reading the plan first.
// -----------------------------------------------------------------------------

type RegOpts = GenerateRegistrationOptionsOpts;
type AuthOpts = GenerateAuthenticationOptionsOpts;

interface RegInputCommon {
  cardIdentifier: string; // PICC UID hex — becomes user.id / userHandle
  userName: string;
  /** Credentials already registered for this card on other devices; excluded so we don't duplicate. */
  excludeCredentialIds?: string[];
}

function rp() {
  const c = getConfig();
  return { name: c.WEBAUTHN_RP_NAME, id: c.WEBAUTHN_RP_ID };
}

// --- Registration -----------------------------------------------------------

export function buildNfcCardRegistrationOptions(input: RegInputCommon): RegOpts {
  const { id: rpID, name: rpName } = rp();
  return {
    rpName,
    rpID,
    userID: Buffer.from(input.cardIdentifier, 'utf8'),
    userName: input.userName,
    userDisplayName: input.userName,
    timeout: 120_000,
    // ES256 only.  The FIDO2 applet + CTAP1 path only sign ES256 (COSE alg = -7).
    supportedAlgorithmIDs: [-7],
    // Attestation MUST be 'none' — CTAP1/U2F attestation format is unparseable
    // by SimpleWebAuthn if we ask for 'direct'.
    attestationType: 'none',
    authenticatorSelection: {
      authenticatorAttachment: 'cross-platform',
      residentKey: 'discouraged',
      userVerification: 'discouraged',
      requireResidentKey: false,
    },
    excludeCredentials: (input.excludeCredentialIds ?? []).map((id) => ({
      id,
      transports: ['nfc'],
    })),
  };
}

export function buildPlatformRegistrationOptions(input: RegInputCommon): RegOpts {
  const { id: rpID, name: rpName } = rp();
  return {
    rpName,
    rpID,
    userID: Buffer.from(input.cardIdentifier, 'utf8'),
    userName: input.userName,
    userDisplayName: input.userName,
    timeout: 120_000,
    // ES256 first, then RS256 as a fallback for Windows Hello legacy.
    supportedAlgorithmIDs: [-7, -257],
    attestationType: 'none',
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'preferred',
      requireResidentKey: false,
    },
    excludeCredentials: (input.excludeCredentialIds ?? []).map((id) => ({
      id,
      transports: ['internal', 'hybrid'],
    })),
  };
}

// --- Authentication ---------------------------------------------------------

interface AuthInput {
  credentials: Array<{ id: string; kind: CredentialKind; transports: string[] }>;
}

export function buildAuthenticationOptions(input: AuthInput): AuthOpts {
  const { id: rpID } = rp();
  return {
    rpID,
    timeout: 120_000,
    // Discouraged, per New T4T.  Raising to 'required' on the NFC path
    // immediately fails the ceremony because the card has no PIN/UV.
    userVerification: 'discouraged',
    allowCredentials: input.credentials.map((c) => {
      // For the NFC path we MUST include transports: ['nfc'] — without it
      // Chrome silently refuses to try NFC (day-long bug in New T4T).
      const transports =
        c.kind === CredentialKind.CROSS_PLATFORM
          ? (['nfc'] as const)
          : (c.transports as AuthenticatorTransportFuture[]).length > 0
            ? (c.transports as AuthenticatorTransportFuture[])
            : (['internal', 'hybrid'] as const);
      return {
        id: c.id,
        transports: transports as unknown as AuthenticatorTransportFuture[],
      };
    }),
  };
}

// SimpleWebAuthn's own transport union (re-exported for callers that need it).
export type AuthenticatorTransportFuture =
  | 'ble'
  | 'cable'
  | 'hybrid'
  | 'internal'
  | 'nfc'
  | 'smart-card'
  | 'usb';
