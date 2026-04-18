import { useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { api, setRefreshToken } from '../utils/api';

// Cognito login flow — handles USER_PASSWORD_AUTH plus the NEW_PASSWORD,
// MFA_SETUP (TOTP via QR), and SOFTWARE_TOKEN_MFA challenges.  The `onAuth`
// callback runs with the ID token once the full ceremony completes.

const COGNITO_REGION = 'ap-southeast-2';
const COGNITO_CLIENT_ID = '7pj9230obhsa6h6vrvk9tru7do';
const COGNITO_ENDPOINT = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;

async function cognitoAuth(action: string, params: Record<string, unknown>) {
  const resp = await fetch(COGNITO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(params),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || data.__type || 'Auth failed');
  return data;
}

export function Login({ onAuth }: { onAuth: (idToken: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [phase, setPhase] = useState<'credentials' | 'new_password' | 'mfa_setup' | 'mfa_verify'>('credentials');
  const [session, setSession] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const finish = (idToken: string, refreshToken?: string) => {
    if (refreshToken) setRefreshToken(refreshToken);
    api.setAuthToken(idToken);
    onAuth(idToken);
  };

  const handleLogin = async () => {
    setError('');
    setLoading(true);
    try {
      const result = await cognitoAuth('InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      });
      if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        setSession(result.Session);
        setPhase('new_password');
      } else if (result.ChallengeName === 'MFA_SETUP') {
        setSession(result.Session);
        const assocResult = await cognitoAuth('AssociateSoftwareToken', { Session: result.Session });
        setMfaSecret(assocResult.SecretCode);
        setSession(assocResult.Session);
        setPhase('mfa_setup');
      } else if (result.ChallengeName === 'SOFTWARE_TOKEN_MFA') {
        setSession(result.Session);
        setPhase('mfa_verify');
      } else if (result.AuthenticationResult) {
        finish(result.AuthenticationResult.IdToken, result.AuthenticationResult.RefreshToken);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleNewPassword = async () => {
    setError('');
    setLoading(true);
    try {
      const result = await cognitoAuth('RespondToAuthChallenge', {
        ClientId: COGNITO_CLIENT_ID,
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        Session: session,
        ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
      });
      if (result.ChallengeName === 'MFA_SETUP') {
        const assocResult = await cognitoAuth('AssociateSoftwareToken', { Session: result.Session });
        setMfaSecret(assocResult.SecretCode);
        setSession(assocResult.Session);
        setPhase('mfa_setup');
      } else if (result.ChallengeName === 'SOFTWARE_TOKEN_MFA') {
        setSession(result.Session);
        setPhase('mfa_verify');
      } else if (result.AuthenticationResult) {
        finish(result.AuthenticationResult.IdToken, result.AuthenticationResult.RefreshToken);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password change failed');
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSetup = async () => {
    setError('');
    setLoading(true);
    try {
      const verifyResp = await cognitoAuth('VerifySoftwareToken', {
        Session: session,
        UserCode: mfaCode,
        FriendlyDeviceName: 'Admin MFA',
      });
      if (verifyResp.Session) {
        const authResult = await cognitoAuth('RespondToAuthChallenge', {
          ClientId: COGNITO_CLIENT_ID,
          ChallengeName: 'MFA_SETUP',
          Session: verifyResp.Session,
          ChallengeResponses: { USERNAME: email },
        });
        if (authResult.AuthenticationResult) {
          finish(authResult.AuthenticationResult.IdToken, authResult.AuthenticationResult.RefreshToken);
          return;
        }
      }
      setMfaCode('');
      setPhase('credentials');
      setError('MFA configured! Sign in with your new password — you\'ll be asked for the code.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MFA setup failed');
    } finally {
      setLoading(false);
    }
  };

  const handleMfaVerify = async () => {
    setError('');
    setLoading(true);
    try {
      const result = await cognitoAuth('RespondToAuthChallenge', {
        ClientId: COGNITO_CLIENT_ID,
        ChallengeName: 'SOFTWARE_TOKEN_MFA',
        Session: session,
        ChallengeResponses: { USERNAME: email, SOFTWARE_TOKEN_MFA_CODE: mfaCode },
      });
      if (result.AuthenticationResult) {
        finish(result.AuthenticationResult.IdToken, result.AuthenticationResult.RefreshToken);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MFA verification failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <div className="panel" style={{ maxWidth: 400, margin: '40px auto' }}>
        <h2>karta.cards Admin</h2>

        {phase === 'credentials' && (
          <>
            <p className="small">Sign in with your Cognito credentials</p>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" style={{ width: '100%', marginBottom: 8, padding: 8 }} />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" style={{ width: '100%', marginBottom: 8, padding: 8 }} onKeyDown={(e) => e.key === 'Enter' && handleLogin()} />
            <button className="btn primary" onClick={handleLogin} disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </>
        )}

        {phase === 'new_password' && (
          <>
            <p className="small">Set a new password (min 32 characters)</p>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password" style={{ width: '100%', marginBottom: 8, padding: 8 }} onKeyDown={(e) => e.key === 'Enter' && handleNewPassword()} />
            <button className="btn primary" onClick={handleNewPassword} disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Setting...' : 'Set Password'}
            </button>
          </>
        )}

        {phase === 'mfa_setup' && (
          <>
            <p className="small">Scan this QR code in your authenticator app:</p>
            <div style={{ display: 'flex', justifyContent: 'center', padding: 16, background: '#fff', borderRadius: 8, marginBottom: 12 }}>
              <QRCodeCanvas
                value={`otpauth://totp/karta.cards:${encodeURIComponent(email)}?secret=${mfaSecret}&issuer=karta.cards&algorithm=SHA1&digits=6&period=30`}
                size={200}
              />
            </div>
            <details style={{ marginBottom: 8 }}>
              <summary className="small" style={{ cursor: 'pointer' }}>Can't scan? Enter manually</summary>
              <code style={{ display: 'block', padding: 8, background: '#f5f5f5', wordBreak: 'break-all', marginTop: 4, fontSize: 12 }}>{mfaSecret}</code>
            </details>
            <p className="small">Then enter the 6-digit code:</p>
            <input type="text" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="123456" style={{ width: '100%', marginBottom: 8, padding: 8, textAlign: 'center', fontSize: 20, letterSpacing: 8 }} maxLength={6} onKeyDown={(e) => e.key === 'Enter' && handleMfaSetup()} />
            <button className="btn primary" onClick={handleMfaSetup} disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Verifying...' : 'Verify & Enable MFA'}
            </button>
          </>
        )}

        {phase === 'mfa_verify' && (
          <>
            <p className="small">Enter your authenticator code</p>
            <input type="text" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="123456" style={{ width: '100%', marginBottom: 8, padding: 8, textAlign: 'center', fontSize: 20, letterSpacing: 8 }} maxLength={6} onKeyDown={(e) => e.key === 'Enter' && handleMfaVerify()} />
            <button className="btn primary" onClick={handleMfaVerify} disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Verifying...' : 'Verify'}
            </button>
          </>
        )}

        {error && <p style={{ color: '#e74c3c', marginTop: 8, fontSize: 14 }}>{error}</p>}
      </div>
    </div>
  );
}
