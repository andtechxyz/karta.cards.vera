import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api } from './api';

// -----------------------------------------------------------------------------
// Browser-side WebAuthn.
//
// Everything goes through @simplewebauthn/browser v10's startRegistration /
// startAuthentication helpers.  We never hand-roll base64url conversion —
// that's what fixes the Android Chrome double-encoding bug New T4T debugged.
//
// The caller supplies the card and kind (PLATFORM vs CROSS_PLATFORM / NFC).
// The server's canonical option builders (src/webauthn/config.ts) apply the
// CTAP1-compatible NFC settings where required — the browser does not need
// to know which ceremony is happening, it just hands the options to the
// library.
// -----------------------------------------------------------------------------

export type CredentialKind = 'PLATFORM' | 'CROSS_PLATFORM';

/** Runtime array of every CredentialKind — for UI loops that need one row per kind. */
export const CREDENTIAL_KINDS: readonly CredentialKind[] = ['PLATFORM', 'CROSS_PLATFORM'] as const;

export async function registerCredential(input: {
  cardId: string;
  kind: CredentialKind;
  deviceName?: string;
}): Promise<{ id: string; credentialId: string }> {
  // userHandle / userLabel are derived server-side from the Card's opaque
  // cuid — the browser must not influence them (would leak PII otherwise).
  const options = await api.post<Parameters<typeof startRegistration>[0]>(
    '/auth/register/options',
    { cardId: input.cardId, kind: input.kind },
  );

  // The library handles ArrayBuffer ↔ base64url conversions internally,
  // matching the shape the server emits via @simplewebauthn/server v10.
  const attResp = await startRegistration(options);

  return api.post('/auth/register/verify', {
    cardId: input.cardId,
    response: attResp,
    deviceName: input.deviceName,
  });
}

export async function authenticate(input: {
  rlid: string;
  kinds?: CredentialKind[];
}): Promise<unknown> {
  const options = await api.post<Parameters<typeof startAuthentication>[0]>(
    '/auth/authenticate/options',
    { rlid: input.rlid, kinds: input.kinds },
  );

  const assertion = await startAuthentication(options);

  return api.post('/auth/authenticate/verify', {
    rlid: input.rlid,
    response: assertion,
  });
}

/**
 * Activation ceremony — runs on the cardholder's phone after the SUN-tap
 * landed them on /activate?session=<token>.  The session token is the only
 * handle the page sees; the server resolves it to the underlying card.
 *
 * Two paths, decided by the /begin response:
 *
 *   1. mode=register (no preregistered cred):
 *      a. /begin returns CTAP1 NFC registration options
 *      b. user taps the FIDO2 applet on the same physical card
 *      c. /finish verifies the attestation + activates
 *
 *   2. mode=confirm (perso pre-loaded a FIDO credential):
 *      a. /begin returns { mode: "confirm" } — no WebAuthn options
 *      b. /finish is called with { confirm: true } — no second NFC tap
 *      c. server flips the card to ACTIVATED, returns the same shape
 *
 * The cardholder UX in confirm mode is one tap to the SUN URL → page
 * loads → page calls /begin → /finish → success — no authenticator
 * prompt at all.  Faster + sidesteps Android Chrome's CTAP1-NFC quirks.
 */
type BeginResponse =
  | { mode: 'register'; options: Parameters<typeof startRegistration>[0] }
  | { mode: 'confirm' };

export async function activateWithSession(input: {
  sessionToken: string;
  deviceLabel?: string;
}): Promise<{
  credentialId: string;
  cardActivated: true;
  mode: 'register' | 'confirm';
  micrositeUrl: string | null;
}> {
  const path = `/activation/sessions/${encodeURIComponent(input.sessionToken)}`;
  const begin = await api.post<BeginResponse>(`${path}/begin`);

  if (begin.mode === 'confirm') {
    return api.post(`${path}/finish`, {
      confirm: true,
      deviceLabel: input.deviceLabel,
    });
  }

  const attResp = await startRegistration(begin.options);
  return api.post(`${path}/finish`, {
    response: attResp,
    deviceLabel: input.deviceLabel,
  });
}
