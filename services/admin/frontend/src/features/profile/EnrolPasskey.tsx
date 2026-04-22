import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';

// In-app passkey enrolment for already-authenticated admins.
//
// Flow (Cognito native WebAuthn, Dec 2024+):
//   1. StartWebAuthnRegistration(AccessToken)
//      → CredentialCreationOptions (JSON with base64url fields)
//   2. navigator.credentials.create() via startRegistration()
//      → PublicKeyCredential with attestation
//   3. CompleteWebAuthnRegistration(AccessToken, Credential)
//      → 200 OK; credential is now linked to the user
//
// The user's access token is needed for both start + complete, which
// is why this flow runs POST-login — Cognito requires the access
// token specifically (not the id token).  The RP ID + UV preference
// come from the pool's WebAuthnConfiguration (server-side) — no
// client-side policy negotiation.
//
// Onboarding rules we enforce here:
// - Friendly name is required (helps admins identify their devices
//   later when listing / deleting credentials)
// - A single successful registration keeps the component in "done"
//   state; operator can open it again to add another device

const COGNITO_REGION = 'ap-southeast-2';
const COGNITO_ENDPOINT = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;

async function cognitoCall(action: string, params: Record<string, unknown>) {
  const resp = await fetch(COGNITO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(params),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.message || data.__type || `${action} failed`);
  }
  return data;
}

export function EnrolPasskey({ accessToken, onClose }: { accessToken: string; onClose: () => void }) {
  const [status, setStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  const enrol = async () => {
    setStatus('pending');
    setError('');
    try {
      // Step 1 — ask Cognito for creation options
      const startResp = await cognitoCall('StartWebAuthnRegistration', {
        AccessToken: accessToken,
      });
      // Cognito returns CredentialCreationOptions as a JSON string under
      // CredentialCreationOptions.  startRegistration accepts the parsed
      // object directly.
      const createOpts = JSON.parse(
        startResp.CredentialCreationOptions as string,
      );

      // Step 2 — browser ceremony.  User confirms on their authenticator
      // (FIDO2 card via NFC on Android Chrome, platform passkey on iOS,
      // Touch ID / Windows Hello on laptops, etc.).  startRegistration
      // handles base64url ↔ ArrayBuffer translation + origin binding.
      const credential = await startRegistration(createOpts);

      // Step 3 — complete.  Cognito stores the credential linked to the
      // user identified by AccessToken; subsequent
      // InitiateAuth(AuthFlow=USER_AUTH, PREFERRED_CHALLENGE=WEB_AUTHN)
      // calls for this user will accept an assertion from this device.
      await cognitoCall('CompleteWebAuthnRegistration', {
        AccessToken: accessToken,
        Credential: JSON.stringify(credential),
      });

      setStatus('done');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Enrolment cancelled.');
      } else if (err instanceof DOMException && err.name === 'InvalidStateError') {
        setError('This authenticator is already registered to your account.');
      } else {
        setError(err instanceof Error ? err.message : 'Enrolment failed');
      }
      setStatus('error');
    }
  };

  return (
    <div className="panel" style={{ maxWidth: 480, padding: 16 }}>
      <h3 style={{ marginTop: 0 }}>🔑 Register a passkey</h3>
      {status === 'idle' && (
        <>
          <p className="small" style={{ marginBottom: 12 }}>
            A passkey lets you sign in without a password or TOTP code — one
            touch on your authenticator.  PCI-compliant two-factor in a single
            ceremony: the device itself (something you have) plus PIN or
            biometric (something you know or are).
          </p>
          <p className="small" style={{ marginBottom: 12, color: '#666' }}>
            Works with: your karta.cards FIDO2 card (tap to Android Chrome over
            NFC), Touch ID / Face ID on Mac or iOS, Windows Hello, or any
            USB/NFC/BLE FIDO2 security key.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={enrol}>
              Register this device
            </button>
            <button className="btn ghost" onClick={onClose}>
              Not now
            </button>
          </div>
        </>
      )}

      {status === 'pending' && (
        <p className="small">Waiting for your authenticator… follow the prompt on your device.</p>
      )}

      {status === 'done' && (
        <>
          <p style={{ color: '#2ecc71', marginBottom: 12 }}>
            ✓ Passkey registered.  Next time you sign in, click "Sign in with
            passkey" on the login screen.
          </p>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      )}

      {status === 'error' && (
        <>
          <p style={{ color: '#e74c3c', marginBottom: 12 }}>{error}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={enrol}>
              Try again
            </button>
            <button className="btn ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}
