import { useCallback, useEffect, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { api, errorMsg, getAuthToken, clearAuthToken, setRefreshToken } from '../utils/api';
import { formatDate, formatMoney } from '../utils/format';
import { luhnValid } from '../utils/luhn';
import { CREDENTIAL_KINDS, type CredentialKind } from '../utils/webauthn';

// Admin UI — read-only view of cards, vault entries, transactions, and the
// vault audit tail.
//
// Cards are NOT created from this page in the production lifecycle —
// Palisade's provisioning-agent calls POST /api/cards/register after data-
// prep + perso.  Activation is entirely cardholder-driven: tap the card →
// SDM URL fires → /activate?session=<token>.  Admin sees the resulting
// state but cannot mint sessions or links itself.

type TabKey = 'cards' | 'vault' | 'programs' | 'transactions' | 'audit' | 'chipProfiles' | 'keyMgmt' | 'batches' | 'provMonitor';

interface ActivationSessionRow {
  id: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedDeviceLabel: string | null;
  createdAt: string;
}

interface Card {
  id: string;
  cardRef: string;
  status: 'BLANK' | 'PERSONALISED' | 'ACTIVATED' | 'SUSPENDED' | 'REVOKED';
  chipSerial: string | null;
  programId: string | null;
  program: { id: string; name: string; currency: string } | null;
  batchId: string | null;
  createdAt: string;
  vaultEntry?: { id: string; panLast4: string; panBin: string; cardholderName: string } | null;
  credentials: { id: string; kind: CredentialKind; deviceName: string | null; createdAt: string; lastUsedAt: string | null }[];
  activationSessions: ActivationSessionRow[];
}

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

export default function Admin() {
  const [tab, setTab] = useState<TabKey>('cards');
  const [authToken, setAuthToken] = useState(getAuthToken() || '');

  // Login form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [loginPhase, setLoginPhase] = useState<'credentials' | 'new_password' | 'mfa_setup' | 'mfa_verify'>('credentials');
  const [loginSession, setLoginSession] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const handleLogin = async () => {
    setLoginError('');
    setLoginLoading(true);
    try {
      const result = await cognitoAuth('InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      });

      if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        setLoginSession(result.Session);
        setLoginPhase('new_password');
      } else if (result.ChallengeName === 'MFA_SETUP') {
        // Need to set up TOTP first
        setLoginSession(result.Session);
        const assocResult = await cognitoAuth('AssociateSoftwareToken', { Session: result.Session });
        setMfaSecret(assocResult.SecretCode);
        setLoginSession(assocResult.Session);
        setLoginPhase('mfa_setup');
      } else if (result.ChallengeName === 'SOFTWARE_TOKEN_MFA') {
        setLoginSession(result.Session);
        setLoginPhase('mfa_verify');
      } else if (result.AuthenticationResult) {
        const token = result.AuthenticationResult.IdToken;
        if (result.AuthenticationResult.RefreshToken) setRefreshToken(result.AuthenticationResult.RefreshToken);
        api.setAuthToken(token);
        setAuthToken(token);
      }
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleNewPassword = async () => {
    setLoginError('');
    setLoginLoading(true);
    try {
      const result = await cognitoAuth('RespondToAuthChallenge', {
        ClientId: COGNITO_CLIENT_ID,
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        Session: loginSession,
        ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
      });

      if (result.ChallengeName === 'MFA_SETUP') {
        const assocResult = await cognitoAuth('AssociateSoftwareToken', { Session: result.Session });
        setMfaSecret(assocResult.SecretCode);
        setLoginSession(assocResult.Session);
        setLoginPhase('mfa_setup');
      } else if (result.ChallengeName === 'SOFTWARE_TOKEN_MFA') {
        setLoginSession(result.Session);
        setLoginPhase('mfa_verify');
      } else if (result.AuthenticationResult) {
        const token = result.AuthenticationResult.IdToken;
        if (result.AuthenticationResult.RefreshToken) setRefreshToken(result.AuthenticationResult.RefreshToken);
        api.setAuthToken(token);
        setAuthToken(token);
      }
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Password change failed');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleMfaSetup = async () => {
    setLoginError('');
    setLoginLoading(true);
    try {
      const verifyResp = await cognitoAuth('VerifySoftwareToken', {
        Session: loginSession,
        UserCode: mfaCode,
        FriendlyDeviceName: 'Admin MFA',
      });

      // VerifySoftwareToken returns a Session we can use to complete auth
      // via RespondToAuthChallenge with MFA_SETUP challenge
      if (verifyResp.Session) {
        const authResult = await cognitoAuth('RespondToAuthChallenge', {
          ClientId: COGNITO_CLIENT_ID,
          ChallengeName: 'MFA_SETUP',
          Session: verifyResp.Session,
          ChallengeResponses: { USERNAME: email },
        });
        if (authResult.AuthenticationResult) {
          const token = authResult.AuthenticationResult.IdToken;
          if (authResult.AuthenticationResult.RefreshToken) setRefreshToken(authResult.AuthenticationResult.RefreshToken);
          api.setAuthToken(token);
          setAuthToken(token);
          return;
        }
      }

      // Fallback: re-authenticate with the new password + MFA
      setMfaCode('');
      setLoginPhase('credentials');
      setLoginError('MFA configured! Sign in with your new password — you\'ll be asked for the code.');
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'MFA setup failed');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleMfaVerify = async () => {
    setLoginError('');
    setLoginLoading(true);
    try {
      const result = await cognitoAuth('RespondToAuthChallenge', {
        ClientId: COGNITO_CLIENT_ID,
        ChallengeName: 'SOFTWARE_TOKEN_MFA',
        Session: loginSession,
        ChallengeResponses: { USERNAME: email, SOFTWARE_TOKEN_MFA_CODE: mfaCode },
      });

      if (result.AuthenticationResult) {
        const token = result.AuthenticationResult.IdToken;
        if (result.AuthenticationResult.RefreshToken) setRefreshToken(result.AuthenticationResult.RefreshToken);
        api.setAuthToken(token);
        setAuthToken(token);
      }
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'MFA verification failed');
    } finally {
      setLoginLoading(false);
    }
  };

  if (!authToken) {
    return (
      <div className="page">
        <div className="panel" style={{ maxWidth: 400, margin: '40px auto' }}>
          <h2>karta.cards Admin</h2>

          {loginPhase === 'credentials' && (<>
            <p className="small">Sign in with your Cognito credentials</p>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" style={{ width: '100%', marginBottom: 8, padding: 8 }} />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" style={{ width: '100%', marginBottom: 8, padding: 8 }} onKeyDown={e => e.key === 'Enter' && handleLogin()} />
            <button className="btn primary" onClick={handleLogin} disabled={loginLoading} style={{ width: '100%' }}>{loginLoading ? 'Signing in...' : 'Sign In'}</button>
          </>)}

          {loginPhase === 'new_password' && (<>
            <p className="small">Set a new password (min 32 characters)</p>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="New password" style={{ width: '100%', marginBottom: 8, padding: 8 }} onKeyDown={e => e.key === 'Enter' && handleNewPassword()} />
            <button className="btn primary" onClick={handleNewPassword} disabled={loginLoading} style={{ width: '100%' }}>{loginLoading ? 'Setting...' : 'Set Password'}</button>
          </>)}

          {loginPhase === 'mfa_setup' && (<>
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
            <input type="text" value={mfaCode} onChange={e => setMfaCode(e.target.value)} placeholder="123456" style={{ width: '100%', marginBottom: 8, padding: 8, textAlign: 'center', fontSize: 20, letterSpacing: 8 }} maxLength={6} onKeyDown={e => e.key === 'Enter' && handleMfaSetup()} />
            <button className="btn primary" onClick={handleMfaSetup} disabled={loginLoading} style={{ width: '100%' }}>{loginLoading ? 'Verifying...' : 'Verify & Enable MFA'}</button>
          </>)}

          {loginPhase === 'mfa_verify' && (<>
            <p className="small">Enter your authenticator code</p>
            <input type="text" value={mfaCode} onChange={e => setMfaCode(e.target.value)} placeholder="123456" style={{ width: '100%', marginBottom: 8, padding: 8, textAlign: 'center', fontSize: 20, letterSpacing: 8 }} maxLength={6} onKeyDown={e => e.key === 'Enter' && handleMfaVerify()} />
            <button className="btn primary" onClick={handleMfaVerify} disabled={loginLoading} style={{ width: '100%' }}>{loginLoading ? 'Verifying...' : 'Verify'}</button>
          </>)}

          {loginError && <p style={{ color: '#e74c3c', marginTop: 8, fontSize: 14 }}>{loginError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Vera Admin</h1>
        <button
          className="btn ghost"
          onClick={() => {
            clearAuthToken();
            setAuthToken('');
          }}
        >
          Logout
        </button>
      </div>
      <p className="small">Cards, vault, WebAuthn credentials, transactions, audit.</p>
      <div className="tabs">
        {(['cards', 'vault', 'programs', 'transactions', 'audit', 'chipProfiles', 'keyMgmt', 'batches', 'provMonitor'] as const).map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {labels[t]}
          </button>
        ))}
      </div>
      {tab === 'cards' && <CardsTab />}
      {tab === 'vault' && <VaultTab />}
      {tab === 'programs' && <ProgramsTab />}
      {tab === 'transactions' && <TransactionsTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'chipProfiles' && <ChipProfilesTab />}
      {tab === 'keyMgmt' && <KeyMgmtTab />}
      {tab === 'batches' && <BatchesTab />}
      {tab === 'provMonitor' && <ProvMonitorTab />}
    </div>
  );
}

const labels: Record<TabKey, string> = {
  cards: 'Cards',
  vault: 'Vault',
  programs: 'Programs',
  transactions: 'Transactions',
  audit: 'Audit',
  chipProfiles: 'Chip Profiles',
  keyMgmt: 'Key Management',
  batches: 'Batches',
  provMonitor: 'Provisioning Monitor',
};

// --- Cards tab ---------------------------------------------------------------

function CardsTab() {
  const { cards, loading, reload } = useCards();
  const [programs, setPrograms] = useState<Program[]>([]);

  // Fetch programs once for the per-row program selector.  Admin is the only
  // surface that mutates Card.programId; a fresh fetch on mount is enough —
  // the selector options stay stable for the admin session.
  useEffect(() => {
    api.get<Program[]>('/programs').then(setPrograms).catch(() => setPrograms([]));
  }, []);

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Cards</h2>
      <p className="small" style={{ marginTop: 8 }}>
        Cards are registered by Palisade's provisioning-agent (POST /api/cards/register)
        and activated by the cardholder tapping the physical card. Admin can
        reassign a card to a different program; everything else is read-only.
      </p>
      {loading ? (
        <p className="small">Loading…</p>
      ) : cards.length === 0 ? (
        <p className="small">
          No cards registered yet. POST a Palisade data-prep package to /api/cards/register.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Card ref</th>
              <th>Status</th>
              <th>Vault</th>
              <th>Program</th>
              <th>Activation</th>
              <th>Credentials</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.cardRef}</td>
                <td>
                  <span className={`tag ${c.status === 'ACTIVATED' ? 'ok' : ''}`}>
                    {c.status}
                  </span>
                </td>
                <td>
                  {c.vaultEntry ? (
                    <span className="mono">•••• {c.vaultEntry.panLast4}</span>
                  ) : (
                    <span className="small">—</span>
                  )}
                </td>
                <td>
                  <ProgramCell card={c} programs={programs} onChanged={reload} />
                </td>
                <td>
                  <ActivationCell card={c} />
                </td>
                <td>
                  {c.credentials.length === 0 ? (
                    <span className="small">none</span>
                  ) : (
                    c.credentials.map((cr) => (
                      <span key={cr.id} className="tag" style={{ marginRight: 4 }}>
                        {cr.kind === 'PLATFORM' ? 'Face ID / Hello' : 'NFC'}
                      </span>
                    ))
                  )}
                </td>
                <td className="small">{formatDate(c.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Per-row program selector.  Empty string = no program (Card.programId null,
 * falls back to DEFAULT_TIER_RULES server-side).  PATCH happens inline on
 * change; failures surface below the select and the row state is reloaded
 * from the server on success so we never render optimistic-but-wrong data.
 */
function ProgramCell({
  card,
  programs,
  onChanged,
}: {
  card: Card;
  programs: Program[];
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const change = async (next: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api.patch<Card>(`/cards/${card.id}`, { programId: next === '' ? null : next });
      await onChanged();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <select
        value={card.programId ?? ''}
        onChange={(e) => change(e.target.value)}
        disabled={busy}
      >
        <option value="">(default rules)</option>
        {programs.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.currency})
          </option>
        ))}
      </select>
      {err && <div className="tag err" style={{ marginTop: 4 }}>{err}</div>}
    </div>
  );
}

/** Per-row cell rendering activation state from the latest ActivationSession. */
function ActivationCell({ card }: { card: Card }) {
  if (card.status === 'ACTIVATED') {
    const consumed = card.activationSessions.find((a) => a.consumedAt);
    return (
      <span className="small">
        ✓ activated{consumed?.consumedDeviceLabel ? ` on ${consumed.consumedDeviceLabel}` : ''}
      </span>
    );
  }
  const latest = card.activationSessions[0];
  if (!latest) {
    return <span className="small">awaiting first tap</span>;
  }
  if (latest.consumedAt) {
    return <span className="small">tap done — credential pending</span>;
  }
  return <span className="small">tap pending</span>;
}

// --- Vault tab ---------------------------------------------------------------

function VaultTab() {
  const { cards, reload } = useCards();
  const blankCards = cards.filter((c) => !c.vaultEntry);

  const [cardId, setCardId] = useState('');
  const [pan, setPan] = useState('4242424242424242');
  const [expMonth, setExpMonth] = useState('12');
  const [expYear, setExpYear] = useState('28');
  const [cvc, setCvc] = useState('123');
  const [cardholderName, setCardholderName] = useState('Test User');
  const [onDuplicate, setOnDuplicate] = useState<'error' | 'reuse'>('error');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!cardId && blankCards.length > 0) setCardId(blankCards[0].id);
  }, [blankCards, cardId]);

  const panOk = luhnValid(pan);

  const submit = async () => {
    setErr(null);
    setOk(null);
    if (!cardId) return setErr('Select a card first');
    if (!panOk) return setErr('PAN failed Luhn check');
    setBusy(true);
    try {
      const r = await api.post<{ vaultEntryId: string; panLast4: string; deduped: boolean }>(
        '/admin/vault/store',
        { cardId, pan, cvc, expiryMonth: expMonth, expiryYear: expYear, cardholderName, onDuplicate },
      );
      setOk(
        r.deduped
          ? `Reused existing vault entry for •••• ${r.panLast4}`
          : `Vaulted card •••• ${r.panLast4}`,
      );
      await reload();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Vault a card</h2>
      <p className="small">
        PANs are tokenised with AES-256-GCM, dedup'd by HMAC fingerprint, and
        never returned in plaintext to any caller.
      </p>

      <label>Card (no vault entry yet)</label>
      <select value={cardId} onChange={(e) => setCardId(e.target.value)}>
        {blankCards.length === 0 && <option value="">No unvaulted cards — register one via /api/cards/register first</option>}
        {blankCards.map((c) => (
          <option key={c.id} value={c.id}>
            {c.cardRef} ({c.status})
          </option>
        ))}
      </select>

      <label>PAN</label>
      <input
        value={pan}
        onChange={(e) => setPan(e.target.value)}
        className="mono"
        placeholder="4242 4242 4242 4242"
      />
      {!panOk && pan.length > 0 && (
        <p className="tag err" style={{ marginTop: 6 }}>Luhn check failed</p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label>Exp month (MM)</label>
          <input value={expMonth} onChange={(e) => setExpMonth(e.target.value)} />
        </div>
        <div>
          <label>Exp year (YY)</label>
          <input value={expYear} onChange={(e) => setExpYear(e.target.value)} />
        </div>
        <div>
          <label>CVC</label>
          <input value={cvc} onChange={(e) => setCvc(e.target.value)} />
        </div>
      </div>

      <label>Cardholder name</label>
      <input value={cardholderName} onChange={(e) => setCardholderName(e.target.value)} />

      <label>On duplicate fingerprint</label>
      <select value={onDuplicate} onChange={(e) => setOnDuplicate(e.target.value as 'error' | 'reuse')}>
        <option value="error">Reject (error)</option>
        <option value="reuse">Reuse existing entry</option>
      </select>

      <div style={{ marginTop: 14 }}>
        <button className="btn primary" onClick={submit} disabled={busy || !panOk || !cardId}>
          {busy ? 'Storing…' : 'Vault card'}
        </button>
      </div>
      {ok && <p className="tag ok" style={{ marginTop: 12 }}>{ok}</p>}
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
    </div>
  );
}

// --- Programs tab ------------------------------------------------------------

// Shape mirrors the server's Program prisma model + tierRuleSchema
// (see src/programs/tier-rules.ts).  Keep in sync; the backend is the
// source of truth and validates on every write.
interface TierRule {
  amountMinMinor: number;
  amountMaxMinor: number | null;
  allowedKinds: CredentialKind[];
  label?: string;
}

interface Program {
  id: string;
  name: string;
  currency: string;
  tierRules: TierRule[];
  preActivationNdefUrlTemplate: string | null;
  postActivationNdefUrlTemplate: string | null;
  createdAt: string;
  updatedAt: string;
}

function ProgramsTab() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Program | 'new' | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setPrograms(await api.get<Program[]>('/programs'));
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (editing !== null) {
    return (
      <ProgramForm
        program={editing === 'new' ? null : editing}
        onSaved={async () => {
          setEditing(null);
          await load();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Programs</h2>
        <button className="btn primary" onClick={() => setEditing('new')}>
          New program
        </button>
      </div>
      <p className="small" style={{ marginTop: 8 }}>
        Card products: currency, tier rules, and NDEF URL templates.  Palisade
        reads the templates at perso time (pre-activation URL baked into the
        card) and after Vera confirms activation (post-activation URL written
        via authenticated APDU).
      </p>
      {err && <p className="tag err" style={{ marginTop: 8 }}>{err}</p>}
      {loading ? (
        <p className="small">Loading…</p>
      ) : programs.length === 0 ? (
        <p className="small">
          No programs yet. Create one to override Vera's built-in default
          (AUD, biometric under AUD 100 / card tap at or above).
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Currency</th>
              <th>Rules</th>
              <th>NDEF templates</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {programs.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.id}</td>
                <td>{p.name}</td>
                <td className="mono">{p.currency}</td>
                <td className="small">{p.tierRules.length} rule{p.tierRules.length === 1 ? '' : 's'}</td>
                <td className="small">
                  {p.preActivationNdefUrlTemplate ? 'pre ✓' : 'pre —'}
                  {' / '}
                  {p.postActivationNdefUrlTemplate ? 'post ✓' : 'post —'}
                </td>
                <td className="small">{formatDate(p.updatedAt)}</td>
                <td>
                  <button className="btn ghost" onClick={() => setEditing(p)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Mirrors DEFAULT_TIER_RULES in src/programs/tier-rules.ts — the shape and
// threshold the server applies when a card has no linked program.
const NEW_PROGRAM_DEFAULT_RULES: readonly TierRule[] = [
  { amountMinMinor: 0, amountMaxMinor: 10_000, allowedKinds: ['PLATFORM'], label: 'Biometric' },
  { amountMinMinor: 10_000, amountMaxMinor: null, allowedKinds: ['CROSS_PLATFORM'], label: 'Card tap' },
];

function cloneRules(rules: readonly TierRule[]): TierRule[] {
  return rules.map((r) => ({ ...r, allowedKinds: [...r.allowedKinds] }));
}

function ProgramForm({
  program,
  onSaved,
  onCancel,
}: {
  program: Program | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(program?.id ?? '');
  const [name, setName] = useState(program?.name ?? '');
  const [currency, setCurrency] = useState(program?.currency ?? 'AUD');
  const [rules, setRules] = useState<TierRule[]>(() =>
    cloneRules(program?.tierRules ?? NEW_PROGRAM_DEFAULT_RULES),
  );
  const [pre, setPre] = useState(program?.preActivationNdefUrlTemplate ?? '');
  const [post, setPost] = useState(program?.postActivationNdefUrlTemplate ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const body = {
        name,
        currency,
        tierRules: rules,
        preActivationNdefUrlTemplate: pre.trim() ? pre.trim() : null,
        postActivationNdefUrlTemplate: post.trim() ? post.trim() : null,
      };
      if (program) {
        await api.patch<Program>(`/programs/${program.id}`, body);
      } else {
        await api.post<Program>('/programs', { id, ...body });
      }
      onSaved();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>{program ? `Edit ${program.id}` : 'New program'}</h2>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>

      {!program && (
        <>
          <label>Program ID</label>
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="prog_mc_plat_01"
            className="mono"
          />
          <p className="small">Palisade's programId — alphanumeric + _ - only; immutable after create.</p>
        </>
      )}

      <label>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mastercard Platinum" />

      <label>Currency (ISO 4217)</label>
      <input
        value={currency}
        onChange={(e) => setCurrency(e.target.value.toUpperCase())}
        className="mono"
        maxLength={3}
        style={{ width: 80 }}
      />

      <h3 style={{ marginTop: 20 }}>Tier rules</h3>
      <p className="small">
        Rules must be contiguous (no gaps), start at 0, and end with an
        unbounded last rule (max = blank). Amounts are in minor units — AUD
        100.00 = 10000.
      </p>
      <RuleEditor rules={rules} onChange={setRules} />

      <h3 style={{ marginTop: 20 }}>NDEF URL templates</h3>
      <p className="small">
        Must contain <span className="mono">{'{cardRef}'}</span>. SDM markers{' '}
        <span className="mono">{'{PICCData}'}</span> and{' '}
        <span className="mono">{'{CMAC}'}</span> are passed through verbatim for
        on-card substitution. Leave blank to fall back to Vera defaults.
      </p>

      <label>Pre-activation (baked at perso)</label>
      <input
        value={pre}
        onChange={(e) => setPre(e.target.value)}
        className="mono"
        placeholder="https://pay.karta.cards/activate/{cardRef}?e={PICCData}&m={CMAC}"
      />

      <label>Post-activation (written after WebAuthn registration)</label>
      <input
        value={post}
        onChange={(e) => setPost(e.target.value)}
        className="mono"
        placeholder="https://pay.karta.cards/tap/{cardRef}?e={PICCData}&m={CMAC}"
      />

      <div style={{ marginTop: 16 }}>
        <button
          className="btn primary"
          onClick={save}
          disabled={busy || (!program && !id) || !name || !currency}
        >
          {busy ? 'Saving…' : program ? 'Save changes' : 'Create program'}
        </button>
      </div>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
    </div>
  );
}

function RuleEditor({
  rules,
  onChange,
}: {
  rules: TierRule[];
  onChange: (r: TierRule[]) => void;
}) {
  const set = (i: number, patch: Partial<TierRule>) => {
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const add = () => {
    if (rules.length === 0) {
      onChange([{ amountMinMinor: 0, amountMaxMinor: null, allowedKinds: ['PLATFORM'] }]);
      return;
    }
    const last = rules[rules.length - 1];
    const nextMin = last.amountMaxMinor ?? 0;
    onChange([
      ...rules.slice(0, -1),
      { ...last, amountMaxMinor: nextMin },
      { amountMinMinor: nextMin, amountMaxMinor: null, allowedKinds: ['CROSS_PLATFORM'] },
    ]);
  };
  const remove = (i: number) => {
    if (rules.length <= 1) return;
    onChange(rules.filter((_, idx) => idx !== i));
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {rules.map((r, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 2fr 2fr auto',
            gap: 8,
            alignItems: 'end',
            padding: 8,
            border: '1px solid var(--edge)',
            borderRadius: 6,
          }}
        >
          <div>
            <label>Min (minor)</label>
            <input
              type="number"
              value={r.amountMinMinor}
              onChange={(e) => set(i, { amountMinMinor: Number(e.target.value) })}
              className="mono"
            />
          </div>
          <div>
            <label>Max (minor, blank = ∞)</label>
            <input
              type="number"
              value={r.amountMaxMinor ?? ''}
              onChange={(e) =>
                set(i, {
                  amountMaxMinor: e.target.value === '' ? null : Number(e.target.value),
                })
              }
              className="mono"
            />
          </div>
          <div>
            <label>Allowed kinds</label>
            <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
              {CREDENTIAL_KINDS.map((k) => (
                <label key={k} className="small" style={{ display: 'flex', gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={r.allowedKinds.includes(k)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...r.allowedKinds, k]
                        : r.allowedKinds.filter((x) => x !== k);
                      set(i, { allowedKinds: next });
                    }}
                  />
                  {k === 'PLATFORM' ? 'Bio' : 'NFC'}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label>Label (optional)</label>
            <input
              value={r.label ?? ''}
              onChange={(e) => set(i, { label: e.target.value || undefined })}
              placeholder="Biometric under AUD 100"
            />
          </div>
          <button
            className="btn ghost"
            onClick={() => remove(i)}
            disabled={rules.length <= 1}
            title={rules.length <= 1 ? 'At least one rule required' : 'Remove rule'}
          >
            ✕
          </button>
        </div>
      ))}
      <div>
        <button className="btn ghost" onClick={add}>+ Add rule</button>
      </div>
    </div>
  );
}

// --- Transactions tab --------------------------------------------------------

interface TxnRow {
  id: string;
  rlid: string;
  status: string;
  tier: string;
  actualTier: string | null;
  amount: number;
  currency: string;
  merchantRef: string;
  merchantName: string;
  providerName: string | null;
  providerTxnId: string | null;
  createdAt: string;
  completedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  card: { id: string; cardRef: string; vaultEntry: { panLast4: string } | null };
}

function TransactionsTab() {
  const [rows, setRows] = useState<TxnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.get<TxnRow[]>('/transactions');
      setRows(r);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Transactions</h2>
        <button className="btn ghost" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
      {rows.length === 0 ? (
        <p className="small" style={{ marginTop: 12 }}>No transactions yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>RLID</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Tier</th>
              <th>Card</th>
              <th>Provider</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.rlid}</td>
                <td className="mono">
                  {formatMoney(t.amount, t.currency)}
                </td>
                <td>
                  <span className={`tag ${statusTone(t.status)}`}>{t.status}</span>
                </td>
                <td>
                  {t.tier}
                  {t.actualTier && t.actualTier !== t.tier && ` → ${t.actualTier}`}
                </td>
                <td>
                  {t.card.vaultEntry ? (
                    <span className="mono">•••• {t.card.vaultEntry.panLast4}</span>
                  ) : (
                    <span className="mono">{t.card.cardRef}</span>
                  )}
                </td>
                <td>
                  {t.providerName ?? <span className="small">—</span>}
                  {t.providerTxnId && (
                    <div className="mono small">{t.providerTxnId.slice(0, 18)}…</div>
                  )}
                </td>
                <td className="small">{formatDate(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- Audit tab ---------------------------------------------------------------

interface AuditRow {
  id: string;
  eventType: string;
  result: 'SUCCESS' | 'FAILURE';
  actor: string;
  purpose: string;
  createdAt: string;
  errorMessage: string | null;
  vaultEntry: { panLast4: string; panBin: string; cardholderName: string } | null;
}

function AuditTab() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.get<AuditRow[]>('/admin/vault/audit?limit=200');
      setRows(r);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Vault access log</h2>
        <button className="btn ghost" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>
      <p className="small">
        Every vault touch — tokenise, mint, consume, provider hand-off, proxy —
        writes one row here. Audit is observational, not in-path.
      </p>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
      {rows.length === 0 ? (
        <p className="small">No audit events yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Result</th>
              <th>Actor</th>
              <th>Card</th>
              <th>Purpose</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <span className="tag">{r.eventType}</span>
                </td>
                <td>
                  <span className={`tag ${r.result === 'SUCCESS' ? 'ok' : 'err'}`}>
                    {r.result}
                  </span>
                </td>
                <td className="small">{r.actor}</td>
                <td>
                  {r.vaultEntry ? (
                    <span className="mono">•••• {r.vaultEntry.panLast4}</span>
                  ) : (
                    <span className="small">—</span>
                  )}
                </td>
                <td className="small">
                  {r.purpose}
                  {r.errorMessage && (
                    <div className="tag err" style={{ marginTop: 4 }}>
                      {r.errorMessage}
                    </div>
                  )}
                </td>
                <td className="small">{formatDate(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- Chip Profiles tab -------------------------------------------------------

interface ChipProfile {
  id: string;
  name: string;
  scheme: string;
  vendor: string;
  cvn: number;
  dgiDefinitions: unknown;
  elfAid: string | null;
  moduleAid: string | null;
  createdAt: string;
}

function ChipProfilesTab() {
  const [profiles, setProfiles] = useState<ChipProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setProfiles(await api.get<ChipProfile[]>('/admin/chip-profiles'));
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      const text = await file.text();
      const body = JSON.parse(text);
      await api.post('/admin/chip-profiles', body);
      setOk(`Uploaded chip profile from ${file.name}`);
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setBusy(false);
      // Reset input so the same file can be uploaded again
      e.target.value = '';
    }
  };

  const handleDelete = async (id: string) => {
    setErr(null);
    setOk(null);
    try {
      await api.delete(`/admin/chip-profiles/${id}`);
      setOk('Profile deleted');
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    }
  };

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Chip Profiles</h2>
        <label className="btn primary" style={{ cursor: 'pointer' }}>
          {busy ? 'Uploading...' : 'Upload Profile'}
          <input
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleUpload}
            disabled={busy}
          />
        </label>
      </div>
      {ok && <p className="tag ok" style={{ marginTop: 12 }}>{ok}</p>}
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
      {loading ? (
        <p className="small">Loading...</p>
      ) : profiles.length === 0 ? (
        <p className="small" style={{ marginTop: 12 }}>No chip profiles yet. Upload a JSON profile to get started.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Scheme</th>
              <th>Vendor</th>
              <th>CVN</th>
              <th>DGI count</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="mono">{p.scheme}</td>
                <td>{p.vendor}</td>
                <td className="mono">{p.cvn}</td>
                <td className="mono">
                  {Array.isArray(p.dgiDefinitions) ? p.dgiDefinitions.length : '—'}
                </td>
                <td className="small">{formatDate(p.createdAt)}</td>
                <td>
                  <button className="btn ghost" onClick={() => handleDelete(p.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- Key Management tab ------------------------------------------------------

interface IssuerProfile {
  id: string;
  programId: string;
  chipProfileId: string;
  scheme: string;
  cvn: number;
  imkAlgorithm: string | null;
  derivationMethod: string | null;
  tmkKeyArn: string | null;
  imkAcKeyArn: string | null;
  imkSmiKeyArn: string | null;
  imkSmcKeyArn: string | null;
  imkIdnKeyArn: string | null;
  issuerPkKeyArn: string | null;
  aid: string | null;
  appLabel: string | null;
  createdAt: string;
  program: { id: string; name: string } | null;
  chipProfile: { id: string; name: string } | null;
}

function KeyMgmtTab() {
  const [profiles, setProfiles] = useState<IssuerProfile[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [chipProfiles, setChipProfiles] = useState<ChipProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [ip, pg, cp] = await Promise.all([
        api.get<IssuerProfile[]>('/admin/issuer-profiles'),
        api.get<Program[]>('/programs'),
        api.get<ChipProfile[]>('/admin/chip-profiles'),
      ]);
      setProfiles(ip);
      setPrograms(pg);
      setChipProfiles(cp);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const truncateArn = (arn: string | null) => {
    if (!arn) return '—';
    return '...' + arn.slice(-8);
  };

  if (showForm) {
    return (
      <IssuerProfileForm
        programs={programs}
        chipProfiles={chipProfiles}
        onSaved={async () => {
          setShowForm(false);
          await load();
        }}
        onCancel={() => setShowForm(false)}
      />
    );
  }

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Key Management</h2>
        <button className="btn primary" onClick={() => setShowForm(true)}>
          Create Issuer Profile
        </button>
      </div>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
      {loading ? (
        <p className="small">Loading...</p>
      ) : profiles.length === 0 ? (
        <p className="small" style={{ marginTop: 12 }}>No issuer profiles yet. Create one to link a program to a chip profile with key ARNs.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Program</th>
              <th>Scheme</th>
              <th>CVN</th>
              <th>TMK</th>
              <th>IMK-AC</th>
              <th>IMK-SMI</th>
              <th>IMK-SMC</th>
              <th>IMK-IDN</th>
              <th>Issuer PK</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id}>
                <td>{p.program?.name ?? p.programId}</td>
                <td className="mono">{p.scheme}</td>
                <td className="mono">{p.cvn}</td>
                <td className="mono small">{truncateArn(p.tmkKeyArn)}</td>
                <td className="mono small">{truncateArn(p.imkAcKeyArn)}</td>
                <td className="mono small">{truncateArn(p.imkSmiKeyArn)}</td>
                <td className="mono small">{truncateArn(p.imkSmcKeyArn)}</td>
                <td className="mono small">{truncateArn(p.imkIdnKeyArn)}</td>
                <td className="mono small">{truncateArn(p.issuerPkKeyArn)}</td>
                <td className="small">{formatDate(p.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function IssuerProfileForm({
  programs,
  chipProfiles,
  onSaved,
  onCancel,
}: {
  programs: Program[];
  chipProfiles: ChipProfile[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [programId, setProgramId] = useState(programs[0]?.id ?? '');
  const [chipProfileId, setChipProfileId] = useState(chipProfiles[0]?.id ?? '');
  const [scheme, setScheme] = useState('mchip_advance');
  const [cvn, setCvn] = useState('18');
  const [imkAlgorithm, setImkAlgorithm] = useState('');
  const [derivationMethod, setDerivationMethod] = useState('');
  const [tmkKeyArn, setTmkKeyArn] = useState('');
  const [imkAcKeyArn, setImkAcKeyArn] = useState('');
  const [imkSmiKeyArn, setImkSmiKeyArn] = useState('');
  const [imkSmcKeyArn, setImkSmcKeyArn] = useState('');
  const [imkIdnKeyArn, setImkIdnKeyArn] = useState('');
  const [issuerPkKeyArn, setIssuerPkKeyArn] = useState('');
  const [aid, setAid] = useState('');
  const [appLabel, setAppLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api.post('/admin/issuer-profiles', {
        programId,
        chipProfileId,
        scheme,
        cvn: Number(cvn),
        imkAlgorithm: imkAlgorithm || undefined,
        derivationMethod: derivationMethod || undefined,
        tmkKeyArn: tmkKeyArn || undefined,
        imkAcKeyArn: imkAcKeyArn || undefined,
        imkSmiKeyArn: imkSmiKeyArn || undefined,
        imkSmcKeyArn: imkSmcKeyArn || undefined,
        imkIdnKeyArn: imkIdnKeyArn || undefined,
        issuerPkKeyArn: issuerPkKeyArn || undefined,
        aid: aid || undefined,
        appLabel: appLabel || undefined,
      });
      onSaved();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Create Issuer Profile</h2>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>

      <label>Program</label>
      <select value={programId} onChange={(e) => setProgramId(e.target.value)}>
        {programs.length === 0 && <option value="">No programs available</option>}
        {programs.map((p) => (
          <option key={p.id} value={p.id}>{p.name} ({p.currency})</option>
        ))}
      </select>

      <label>Chip Profile</label>
      <select value={chipProfileId} onChange={(e) => setChipProfileId(e.target.value)}>
        {chipProfiles.length === 0 && <option value="">No chip profiles available</option>}
        {chipProfiles.map((cp) => (
          <option key={cp.id} value={cp.id}>{cp.name} ({cp.scheme})</option>
        ))}
      </select>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label>Scheme</label>
          <select value={scheme} onChange={(e) => setScheme(e.target.value)}>
            <option value="mchip_advance">mchip_advance</option>
            <option value="vsdc">vsdc</option>
          </select>
        </div>
        <div>
          <label>CVN</label>
          <select value={cvn} onChange={(e) => setCvn(e.target.value)}>
            <option value="10">10</option>
            <option value="17">17</option>
            <option value="18">18</option>
            <option value="22">22</option>
          </select>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label>IMK Algorithm</label>
          <input value={imkAlgorithm} onChange={(e) => setImkAlgorithm(e.target.value)} className="mono" placeholder="TDES_CBC" />
        </div>
        <div>
          <label>Derivation Method</label>
          <input value={derivationMethod} onChange={(e) => setDerivationMethod(e.target.value)} className="mono" placeholder="OPTION_A" />
        </div>
      </div>

      <h3 style={{ marginTop: 20 }}>Key ARNs</h3>
      <p className="small">AWS Payment Cryptography key ARNs for each master key.</p>

      <label>TMK Key ARN</label>
      <input value={tmkKeyArn} onChange={(e) => setTmkKeyArn(e.target.value)} className="mono" placeholder="arn:aws:payment-cryptography:..." />

      <label>IMK-AC Key ARN</label>
      <input value={imkAcKeyArn} onChange={(e) => setImkAcKeyArn(e.target.value)} className="mono" placeholder="arn:aws:payment-cryptography:..." />

      <label>IMK-SMI Key ARN</label>
      <input value={imkSmiKeyArn} onChange={(e) => setImkSmiKeyArn(e.target.value)} className="mono" placeholder="arn:aws:payment-cryptography:..." />

      <label>IMK-SMC Key ARN</label>
      <input value={imkSmcKeyArn} onChange={(e) => setImkSmcKeyArn(e.target.value)} className="mono" placeholder="arn:aws:payment-cryptography:..." />

      <label>IMK-IDN Key ARN</label>
      <input value={imkIdnKeyArn} onChange={(e) => setImkIdnKeyArn(e.target.value)} className="mono" placeholder="arn:aws:payment-cryptography:..." />

      <label>Issuer PK Key ARN</label>
      <input value={issuerPkKeyArn} onChange={(e) => setIssuerPkKeyArn(e.target.value)} className="mono" placeholder="arn:aws:payment-cryptography:..." />

      <h3 style={{ marginTop: 20 }}>EMV Constants</h3>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label>AID</label>
          <input value={aid} onChange={(e) => setAid(e.target.value)} className="mono" placeholder="A0000000041010" />
        </div>
        <div>
          <label>App Label</label>
          <input value={appLabel} onChange={(e) => setAppLabel(e.target.value)} placeholder="Mastercard" />
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <button
          className="btn primary"
          onClick={save}
          disabled={busy || !programId || !chipProfileId}
        >
          {busy ? 'Creating...' : 'Create Issuer Profile'}
        </button>
      </div>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
    </div>
  );
}

// --- Batches tab -------------------------------------------------------------

interface BatchResult {
  batchId: string;
  total: number;
  succeeded: number;
  failed: number;
  errors: { row: number; cardRef: string; error: string }[];
}

function BatchesTab() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [programId, setProgramId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<Program[]>('/programs').then((p) => {
      setPrograms(p);
      if (p.length > 0 && !programId) setProgramId(p[0].id);
    }).catch(() => setPrograms([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!file || !programId) return;
    setErr(null);
    setResult(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('programId', programId);

      const adminKey = sessionStorage.getItem('vera.adminKey');
      const headers: Record<string, string> = {};
      if (adminKey) headers['x-admin-key'] = adminKey;
      const token = getAuthToken();
      if (token) headers['authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/admin/batches/ingest', {
        method: 'POST',
        headers,
        body: form,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      }
      setResult(data as BatchResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Batch CSV Ingestion</h2>
      <p className="small" style={{ marginTop: 8 }}>
        Upload a manufacturing CSV to register cards in bulk. Each row calls
        activation's card register endpoint with HMAC-signed auth.
      </p>
      <p className="small" style={{ marginTop: 4 }}>
        Required columns: card_ref, ntag_uid, chip_serial, sdm_meta_read_key,
        sdm_file_read_key, pan, expiry_month, expiry_year, cardholder_name
      </p>

      <label>Program</label>
      <select value={programId} onChange={(e) => setProgramId(e.target.value)}>
        {programs.length === 0 && <option value="">No programs available</option>}
        {programs.map((p) => (
          <option key={p.id} value={p.id}>{p.name} ({p.currency})</option>
        ))}
      </select>

      <label>Batch CSV</label>
      <input
        type="file"
        accept=".csv"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />

      <div style={{ marginTop: 14 }}>
        <button
          className="btn primary"
          onClick={submit}
          disabled={busy || !file || !programId}
        >
          {busy ? 'Processing...' : 'Upload & Process'}
        </button>
      </div>

      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}

      {result && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <div style={{ padding: 16, border: '1px solid var(--edge)', borderRadius: 8, textAlign: 'center' }}>
              <div className="mono" style={{ fontSize: 28, fontWeight: 700 }}>{result.total}</div>
              <div className="small">Total rows</div>
            </div>
            <div style={{ padding: 16, border: '1px solid var(--edge)', borderRadius: 8, textAlign: 'center' }}>
              <div className="mono" style={{ fontSize: 28, fontWeight: 700 }}>{result.succeeded}</div>
              <div className="small">Succeeded</div>
            </div>
            <div style={{ padding: 16, border: '1px solid var(--edge)', borderRadius: 8, textAlign: 'center' }}>
              <div className="mono" style={{ fontSize: 28, fontWeight: 700, color: result.failed > 0 ? 'var(--err)' : undefined }}>{result.failed}</div>
              <div className="small">Failed</div>
            </div>
            <div style={{ padding: 16, border: '1px solid var(--edge)', borderRadius: 8, textAlign: 'center' }}>
              <div className="mono small" style={{ wordBreak: 'break-all' }}>{result.batchId}</div>
              <div className="small">Batch ID</div>
            </div>
          </div>

          {result.errors.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3>Errors</h3>
              <table>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Card ref</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {result.errors.map((e, i) => (
                    <tr key={i}>
                      <td className="mono">{e.row}</td>
                      <td className="mono">{e.cardRef}</td>
                      <td><span className="tag err">{e.error}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Provisioning Monitor tab ------------------------------------------------

interface ProvStats {
  activeSessions: number;
  provisioned24h: number;
  totalProvisioned: number;
  failedSessions24h: number;
}

interface ProvSession {
  id: string;
  phase: string;
  createdAt: string;
  completedAt: string | null;
  failedAt: string | null;
  card: { id: string; cardRef: string; status: string } | null;
  sadRecord: { id: string; proxyCardId: string; status: string } | null;
}

function ProvMonitorTab() {
  const [stats, setStats] = useState<ProvStats | null>(null);
  const [sessions, setSessions] = useState<ProvSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [s, sess] = await Promise.all([
        api.get<ProvStats>('/admin/provisioning/stats'),
        api.get<ProvSession[]>('/admin/provisioning/sessions'),
      ]);
      setStats(s);
      setSessions(sess);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Provisioning Monitor</h2>
        <button className="btn ghost" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 16 }}>
          <div style={{ padding: 16, border: '1px solid var(--edge)', borderRadius: 8, textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{stats.activeSessions}</div>
            <div className="small">Active Sessions</div>
          </div>
          <div style={{ padding: 16, border: '1px solid var(--edge)', borderRadius: 8, textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{stats.provisioned24h}</div>
            <div className="small">Provisioned (24h)</div>
          </div>
          <div style={{ padding: 16, border: '1px solid var(--edge)', borderRadius: 8, textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{stats.totalProvisioned}</div>
            <div className="small">Total Provisioned</div>
          </div>
          <div style={{ padding: 16, border: '1px solid var(--edge)', borderRadius: 8, textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: stats.failedSessions24h > 0 ? 'var(--err)' : undefined }}>{stats.failedSessions24h}</div>
            <div className="small">Failed (24h)</div>
          </div>
        </div>
      )}
      {sessions.length === 0 ? (
        <p className="small" style={{ marginTop: 12 }}>No provisioning sessions yet.</p>
      ) : (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Session ID</th>
              <th>Card</th>
              <th>Phase</th>
              <th>Proxy Card ID</th>
              <th>SAD Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td className="mono small">{s.id.slice(0, 12)}...</td>
                <td className="mono">{s.card?.cardRef ?? '—'}</td>
                <td>
                  <span className={`tag ${sessionPhaseTone(s.phase)}`}>{s.phase}</span>
                </td>
                <td className="mono small">{s.sadRecord?.proxyCardId ?? '—'}</td>
                <td>
                  {s.sadRecord ? (
                    <span className={`tag ${s.sadRecord.status === 'COMPLETE' ? 'ok' : ''}`}>{s.sadRecord.status}</span>
                  ) : (
                    <span className="small">—</span>
                  )}
                </td>
                <td className="small">{formatDate(s.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function sessionPhaseTone(phase: string): 'ok' | 'err' | 'warn' | '' {
  if (phase === 'COMPLETE') return 'ok';
  if (phase === 'FAILED') return 'err';
  if (phase === 'DATA_PREP' || phase === 'PERSO' || phase === 'PENDING') return 'warn';
  return '';
}

// --- Helpers -----------------------------------------------------------------

function useCards() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const r = await api.get<Card[]>('/admin/vault/cards');
    setCards(r);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { cards, reload, loading };
}

function statusTone(s: string): 'ok' | 'err' | 'warn' | '' {
  if (s === 'COMPLETED') return 'ok';
  if (s === 'FAILED' || s === 'EXPIRED') return 'err';
  if (s === 'PENDING') return 'warn';
  return '';
}
