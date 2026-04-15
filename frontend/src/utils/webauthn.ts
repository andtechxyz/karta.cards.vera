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

export async function registerCredential(input: {
  cardId: string;
  kind: CredentialKind;
  userName: string;
  deviceName?: string;
}): Promise<{ id: string; credentialId: string }> {
  const options = await api.post<Parameters<typeof startRegistration>[0]>(
    '/auth/register/options',
    { cardId: input.cardId, kind: input.kind, userName: input.userName },
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
