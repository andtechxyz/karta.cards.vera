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

type TabKey = 'financialInstitutions' | 'cards' | 'vault' | 'programs' | 'transactions' | 'audit' | 'chipProfiles' | 'keyMgmt' | 'batches' | 'provMonitor' | 'microsites' | 'embossingTemplates' | 'embossingBatches';

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
  status: 'BLANK' | 'PERSONALISED' | 'ACTIVATED' | 'PROVISIONED' | 'SUSPENDED' | 'REVOKED';
  retailSaleStatus: 'SHIPPED' | 'SOLD' | null;
  retailSoldAt: string | null;
  chipSerial: string | null;
  programId: string | null;
  program: { id: string; name: string; currency: string; programType?: string } | null;
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
        <h1 style={{ margin: 0 }}>karta.cards Admin</h1>
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
        {(['financialInstitutions', 'cards', 'vault', 'programs', 'transactions', 'audit', 'chipProfiles', 'keyMgmt', 'batches', 'provMonitor', 'microsites', 'embossingTemplates', 'embossingBatches'] as const).map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {labels[t]}
          </button>
        ))}
      </div>
      {tab === 'financialInstitutions' && <FinancialInstitutionsTab />}
      {tab === 'cards' && <CardsTab />}
      {tab === 'vault' && <VaultTab />}
      {tab === 'programs' && <ProgramsTab />}
      {tab === 'transactions' && <TransactionsTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'chipProfiles' && <ChipProfilesTab />}
      {tab === 'keyMgmt' && <KeyMgmtTab />}
      {tab === 'batches' && <BatchesTab />}
      {tab === 'provMonitor' && <ProvMonitorTab />}
      {tab === 'microsites' && <MicrositesTab />}
      {tab === 'embossingTemplates' && <EmbossingTemplatesTab />}
      {tab === 'embossingBatches' && <EmbossingBatchesTab />}
    </div>
  );
}

const labels: Record<TabKey, string> = {
  financialInstitutions: 'Financial Institutions',
  cards: 'Cards',
  vault: 'Vault',
  programs: 'Programs',
  transactions: 'Transactions',
  audit: 'Audit',
  chipProfiles: 'Chip Profiles',
  keyMgmt: 'Key Management',
  batches: 'Batches',
  provMonitor: 'Provisioning Monitor',
  microsites: 'Microsites',
  embossingTemplates: 'Embossing Templates',
  embossingBatches: 'Embossing Batches',
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
              <th>Retail sale</th>
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
                  <RetailSaleCell card={c} onChanged={reload} />
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

/**
 * Per-row cell for retail sale status.  RETAIL programs can be marked SOLD
 * from here (a one-click transition that flips the card out of its
 * microsite-only state and into the regular activation flow).  Non-retail
 * cards render an em-dash because the column doesn't apply to them.
 */
function RetailSaleCell({
  card,
  onChanged,
}: {
  card: Card;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isRetail = card.program?.programType === 'RETAIL';

  if (!isRetail) return <span className="small">—</span>;

  const markSold = async () => {
    if (!confirm(`Mark ${card.cardRef} as SOLD?  The next tap will start activation.`)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post<unknown>(`/cards/${card.cardRef}/mark-sold`, {});
      await onChanged();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (card.retailSaleStatus === 'SOLD') {
    return (
      <div>
        <span className="tag ok">SOLD</span>
        {card.retailSoldAt && (
          <div className="small" style={{ marginTop: 2 }}>{formatDate(card.retailSoldAt)}</div>
        )}
      </div>
    );
  }

  // Null or SHIPPED — offer the mark-sold action.  Null can happen for
  // retail cards registered before the programType field was set, so
  // treat it the same as SHIPPED for UI purposes.
  return (
    <div>
      <span className="tag">{card.retailSaleStatus ?? 'SHIPPED'}</span>
      <button
        className="btn ghost"
        style={{ marginLeft: 6, padding: '2px 8px', fontSize: 12 }}
        onClick={markSold}
        disabled={busy}
      >
        {busy ? '…' : 'Mark sold'}
      </button>
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

// --- Financial Institutions tab ----------------------------------------------
//
// FIs are the BIN sponsor / card issuer (e.g. "InComm") and the top-level
// scoping entity.  Programs (and therefore cards) belong to an FI.

function FinancialInstitutionsTab() {
  const [fis, setFis] = useState<FinancialInstitution[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<FinancialInstitution | 'new' | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setFis(await api.get<FinancialInstitution[]>('/admin/financial-institutions'));
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
      <FinancialInstitutionForm
        fi={editing === 'new' ? null : editing}
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
        <h2 style={{ margin: 0 }}>Financial Institutions</h2>
        <button className="btn primary" onClick={() => setEditing('new')}>
          New FI
        </button>
      </div>
      <p className="small" style={{ marginTop: 8 }}>
        Top-level issuer / BIN sponsor.  Programs belong to an FI (e.g. InComm → SecureGift).
      </p>
      {err && <p className="tag err" style={{ marginTop: 8 }}>{err}</p>}
      {loading ? (
        <p className="small">Loading…</p>
      ) : fis.length === 0 ? (
        <p className="small">No financial institutions yet. Create one to start grouping programs.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>BIN</th>
              <th>Status</th>
              <th># Programs</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {fis.map((f) => (
              <tr key={f.id}>
                <td>{f.name}</td>
                <td className="mono">{f.slug}</td>
                <td className="mono">{f.bin ?? <span className="small">—</span>}</td>
                <td>
                  <span className={`tag ${f.status === 'ACTIVE' ? 'ok' : ''}`}>{f.status}</span>
                </td>
                <td className="mono">{f._count?.programs ?? 0}</td>
                <td className="small">{formatDate(f.createdAt)}</td>
                <td>
                  <button className="btn ghost" onClick={() => setEditing(f)}>
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

function FinancialInstitutionForm({
  fi,
  onSaved,
  onCancel,
}: {
  fi: FinancialInstitution | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(fi?.name ?? '');
  const [slug, setSlug] = useState(fi?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(Boolean(fi));
  const [bin, setBin] = useState(fi?.bin ?? '');
  const [contactEmail, setContactEmail] = useState(fi?.contactEmail ?? '');
  const [contactName, setContactName] = useState(fi?.contactName ?? '');
  const [status, setStatus] = useState<'ACTIVE' | 'SUSPENDED'>(fi?.status ?? 'ACTIVE');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onNameChange = (v: string) => {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  };

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      if (fi) {
        const body: Record<string, unknown> = {
          name,
          slug,
          status,
        };
        if (bin.trim()) body.bin = bin.trim();
        if (contactEmail.trim()) body.contactEmail = contactEmail.trim();
        if (contactName.trim()) body.contactName = contactName.trim();
        await api.patch<FinancialInstitution>(`/admin/financial-institutions/${fi.id}`, body);
      } else {
        const body: Record<string, unknown> = { name, slug };
        if (bin.trim()) body.bin = bin.trim();
        if (contactEmail.trim()) body.contactEmail = contactEmail.trim();
        if (contactName.trim()) body.contactName = contactName.trim();
        await api.post<FinancialInstitution>('/admin/financial-institutions', body);
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
        <h2 style={{ margin: 0 }}>{fi ? `Edit ${fi.name}` : 'New Financial Institution'}</h2>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>

      <label>Name</label>
      <input value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="InComm" />

      <label>Slug</label>
      <input
        value={slug}
        onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }}
        className="mono"
        placeholder="incomm"
      />
      <p className="small">Lowercase letters, digits, and hyphens only.  Auto-suggested from name.</p>

      <label>BIN (optional)</label>
      <input
        value={bin}
        onChange={(e) => setBin(e.target.value)}
        className="mono"
        placeholder="491234"
        maxLength={8}
      />

      <label>Contact email (optional)</label>
      <input
        type="email"
        value={contactEmail}
        onChange={(e) => setContactEmail(e.target.value)}
        placeholder="ops@incomm.com"
      />

      <label>Contact name (optional)</label>
      <input
        value={contactName}
        onChange={(e) => setContactName(e.target.value)}
        placeholder="Jane Doe"
      />

      {fi && (
        <>
          <label>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value as 'ACTIVE' | 'SUSPENDED')}>
            <option value="ACTIVE">ACTIVE</option>
            <option value="SUSPENDED">SUSPENDED</option>
          </select>
        </>
      )}

      <div style={{ marginTop: 16 }}>
        <button
          className="btn primary"
          onClick={save}
          disabled={busy || !name || !slug}
        >
          {busy ? 'Saving…' : fi ? 'Save changes' : 'Create FI'}
        </button>
      </div>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}

      {fi && <PartnerCredentialsSection fiId={fi.id} />}
      {fi && <SftpAccessSection fiSlug={fi.slug} />}
    </div>
  );
}

// --- SFTP Access (per-FI) ----------------------------------------------------
//
// Read-only reference panel for the FI's SFTP endpoint.  v1 provisions
// accounts via the vera/SFTP_USERS Secrets Manager secret — no CRUD in
// the UI yet.  Ops mints a key pair for the partner, pastes the public
// key into SFTP_USERS, and restarts the vera-sftp service.  This panel
// shows the partner-facing connection details so support can hand them
// to the integrator without going digging.
function SftpAccessSection({ fiSlug }: { fiSlug: string }) {
  const host = 'sftp.karta.cards';
  return (
    <div style={{ marginTop: 24, padding: 16, border: '1px solid #d3d3d3', borderRadius: 6, background: '#fafafa' }}>
      <h3 style={{ marginTop: 0 }}>SFTP access</h3>
      <p className="small" style={{ marginTop: 0 }}>
        Alternative to the HTTP Partner API.  Partners drop batches into their
        home directory; the ingester picks them up every 30 seconds and creates
        a RECEIVED EmbossingBatch.
      </p>
      <table className="kv" style={{ marginBottom: 8 }}>
        <tbody>
          <tr><th>Host</th><td><code>{host}</code></td></tr>
          <tr><th>Port</th><td><code>22</code></td></tr>
          <tr><th>Username</th><td><code>{fiSlug}</code></td></tr>
          <tr><th>Auth</th><td>SSH public key (ed25519 or RSA-4096)</td></tr>
          <tr>
            <th>Upload path</th>
            <td><code>/upload/&lt;programId&gt;/&lt;templateId&gt;/&lt;filename&gt;</code></td>
          </tr>
        </tbody>
      </table>
      <p className="small" style={{ marginTop: 8 }}>
        To onboard a partner: receive their SSH public key, append it to the{' '}
        <code>vera/SFTP_USERS</code> secret with username=<code>{fiSlug}</code>,
        and restart <code>vera-sftp</code>.  Processed files move to{' '}
        <code>/processed/&lt;date&gt;/</code>; rejects to{' '}
        <code>/failed/&lt;date&gt;/</code> with a <code>.err</code> file.
      </p>
    </div>
  );
}

// --- Partner Credentials (per-FI) -------------------------------------------
//
// Lives inside FinancialInstitutionForm when editing an existing FI.  Lists
// existing credentials, lets admins mint new ones (secret shown ONCE), and
// revoke active ones.  The backend surfaces `secretHash` + `salt` in the
// creation response so partners have everything they need to sign HMACs
// without extra handshakes.

interface PartnerCredentialRow {
  id: string;
  keyId: string;
  description: string | null;
  status: 'ACTIVE' | 'REVOKED';
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  createdBy: string;
  createdAt: string;
}

interface NewCredentialResult {
  id: string;
  keyId: string;
  secret: string;
  secretHash: string;
  salt: string;
}

function PartnerCredentialsSection({ fiId }: { fiId: string }) {
  const [rows, setRows] = useState<PartnerCredentialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newDescription, setNewDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<NewCredentialResult | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.get<PartnerCredentialRow[]>(
        `/admin/financial-institutions/${fiId}/credentials`,
      );
      setRows(r);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, [fiId]);

  useEffect(() => {
    load();
  }, [load]);

  const submitCreate = async () => {
    setErr(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (newDescription.trim()) body.description = newDescription.trim();
      const result = await api.post<NewCredentialResult>(
        `/admin/financial-institutions/${fiId}/credentials`,
        body,
      );
      setFresh(result);
      setCreating(false);
      setNewDescription('');
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (row: PartnerCredentialRow) => {
    const reason = window.prompt(
      `Revoke credential "${row.keyId}"?  Reason (optional):`,
      '',
    );
    // Null ⇒ Cancel.  Empty string ⇒ OK with no reason — we still revoke.
    if (reason === null) return;
    setErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (reason.trim()) body.reason = reason.trim();
      await api.post(
        `/admin/financial-institutions/${fiId}/credentials/${row.id}/revoke`,
        body,
      );
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    }
  };

  return (
    <div style={{ marginTop: 32, paddingTop: 20, borderTop: '1px solid var(--edge)' }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>Partner Credentials</h3>
        {!creating && !fresh && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            Generate Credential
          </button>
        )}
      </div>
      <p className="small" style={{ marginTop: 8 }}>
        API credentials partners use to upload embossing batches via HTTP
        (HMAC-SHA256).  Secrets are shown ONCE at creation — store them
        securely.
      </p>

      {err && <p className="tag err" style={{ marginTop: 8 }}>{err}</p>}

      {fresh && <FreshCredentialPanel result={fresh} onClose={() => setFresh(null)} />}

      {creating && (
        <div className="panel panel-2" style={{ marginTop: 12 }}>
          <label>Description (optional)</label>
          <input
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="InComm production upload pipeline"
            disabled={busy}
          />
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={submitCreate} disabled={busy}>
              {busy ? 'Generating…' : 'Generate'}
            </button>
            <button
              className="btn ghost"
              onClick={() => { setCreating(false); setNewDescription(''); }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="small" style={{ marginTop: 12 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className="small" style={{ marginTop: 12 }}>
          No credentials yet.  Generate one to let a partner upload batches.
        </p>
      ) : (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Key ID</th>
              <th>Description</th>
              <th>Status</th>
              <th>Last Used</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.keyId}</td>
                <td className="small">{r.description ?? <span className="small">—</span>}</td>
                <td>
                  <span className={`tag ${r.status === 'ACTIVE' ? 'ok' : 'err'}`}>
                    {r.status}
                  </span>
                  {r.status === 'REVOKED' && r.revokedReason && (
                    <div className="small" style={{ marginTop: 2 }}>{r.revokedReason}</div>
                  )}
                </td>
                <td className="small">
                  {r.lastUsedAt ? (
                    <>
                      {formatDate(r.lastUsedAt)}
                      {r.lastUsedIp && <div className="small mono">{r.lastUsedIp}</div>}
                    </>
                  ) : (
                    <span className="small">never</span>
                  )}
                </td>
                <td className="small">{formatDate(r.createdAt)}</td>
                <td>
                  {r.status === 'ACTIVE' && (
                    <button className="btn ghost" onClick={() => revoke(r)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * "Shown once" panel displayed after a new credential is minted.  Bright
 * warning treatment (amber) because this is the only time the partner (and
 * the admin relaying it) will ever see the plaintext secret.  Includes
 * copy-buttons for every sensitive field plus a collapsible helper that
 * documents the HMAC signing scheme for partners.
 */
function FreshCredentialPanel({
  result,
  onClose,
}: {
  result: NewCredentialResult;
  onClose: () => void;
}) {
  const style = {
    marginTop: 12,
    padding: 16,
    background: 'rgba(255, 191, 107, 0.08)',
    border: '1px solid var(--warn)',
    borderRadius: 'var(--radius)',
  } as const;
  return (
    <div style={style}>
      <h4 style={{ margin: 0, color: 'var(--warn)' }}>
        Credential created — store these values now
      </h4>
      <p className="small" style={{ marginTop: 6 }}>
        The secret below will NEVER be shown again.  Copy every field into your
        partner's secret manager before closing this panel.
      </p>

      <CopyableField label="Key ID" value={result.keyId} />
      <CopyableField label="Secret (plaintext — shown once)" value={result.secret} sensitive />
      <CopyableField label="Secret Hash (HMAC key — hex)" value={result.secretHash} sensitive />
      <CopyableField label="Salt (hex)" value={result.salt} />

      <details style={{ marginTop: 14 }}>
        <summary className="small" style={{ cursor: 'pointer', color: 'var(--accent)' }}>
          How to sign a partner request (HMAC-SHA256)
        </summary>
        <div style={{ marginTop: 10 }}>
          <p className="small" style={{ marginTop: 0 }}>
            Canonical string to sign (exact newline separators, no trailing
            newline):
          </p>
          <pre className="mono" style={preStyle}>
{`METHOD\\nPATH\\nTIMESTAMP\\nSHA256(body)`}
          </pre>
          <p className="small">
            The HMAC key is the hex-decoded <strong>Secret Hash</strong> above
            (not the plaintext secret).  Replay window: ±60 seconds.
          </p>
          <p className="small">Required headers:</p>
          <ul className="small" style={{ marginTop: 4 }}>
            <li><span className="mono">X-Partner-KeyId</span></li>
            <li><span className="mono">X-Partner-Signature</span> (hex)</li>
            <li><span className="mono">X-Partner-Timestamp</span> (unix seconds)</li>
            <li><span className="mono">X-Partner-TemplateId</span></li>
            <li><span className="mono">X-Partner-ProgramId</span></li>
            <li><span className="mono">X-Partner-FileName</span> (optional)</li>
          </ul>
          <p className="small">Sample curl (bash):</p>
          <pre className="mono" style={preStyle}>
{`BODY_HASH=$(sha256sum batch.csv | awk '{print $1}')
TS=$(date +%s)
CANONICAL="POST\\n/api/partners/embossing-batches\\n\${TS}\\n\${BODY_HASH}"
SIG=$(echo -en "$CANONICAL" | openssl dgst -sha256 -mac HMAC \\
  -macopt "hexkey:\${SECRET_HASH}" | awk '{print $2}')

curl -X POST https://manage.karta.cards/api/partners/embossing-batches \\
  -H "X-Partner-KeyId: \${KEY_ID}" \\
  -H "X-Partner-Signature: \${SIG}" \\
  -H "X-Partner-Timestamp: \${TS}" \\
  -H "X-Partner-TemplateId: \${TEMPLATE_ID}" \\
  -H "X-Partner-ProgramId: \${PROGRAM_ID}" \\
  --data-binary @batch.csv`}
          </pre>
        </div>
      </details>

      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="btn primary" onClick={onClose}>
          I've stored these securely, close
        </button>
      </div>
    </div>
  );
}

const preStyle = {
  background: 'var(--panel-2)',
  border: '1px solid var(--edge)',
  borderRadius: 'var(--radius)',
  padding: 10,
  fontSize: 12,
  overflowX: 'auto' as const,
  whiteSpace: 'pre' as const,
  margin: '6px 0',
};

function CopyableField({
  label,
  value,
  sensitive = false,
}: {
  label: string;
  value: string;
  sensitive?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard may be unavailable — user can still select and copy manually
    }
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div className="small" style={{ color: sensitive ? 'var(--warn)' : 'var(--mute)' }}>
        {label}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', marginTop: 4 }}>
        <code
          className="mono"
          style={{
            flex: 1,
            background: 'var(--panel-2)',
            border: '1px solid var(--edge)',
            borderRadius: 'var(--radius)',
            padding: '8px 10px',
            wordBreak: 'break-all',
            fontSize: 12,
          }}
        >
          {value}
        </code>
        <button className="btn ghost" onClick={copy} style={{ minHeight: 0, padding: '4px 10px' }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
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

type ProgramType =
  | 'RETAIL'
  | 'PREPAID_NON_RELOADABLE'
  | 'PREPAID_RELOADABLE'
  | 'DEBIT'
  | 'CREDIT';

const PROGRAM_TYPE_OPTIONS: { value: ProgramType; label: string }[] = [
  { value: 'RETAIL', label: 'Retail' },
  { value: 'PREPAID_NON_RELOADABLE', label: 'Prepaid (Non-Reloadable)' },
  { value: 'PREPAID_RELOADABLE', label: 'Prepaid (Reloadable)' },
  { value: 'DEBIT', label: 'Debit' },
  { value: 'CREDIT', label: 'Credit' },
];

function programTypeLabel(t: string | undefined | null): string {
  return PROGRAM_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? (t ?? '—');
}

interface Program {
  id: string;
  name: string;
  currency: string;
  programType: ProgramType;
  tierRules: TierRule[];
  preActivationNdefUrlTemplate: string | null;
  postActivationNdefUrlTemplate: string | null;
  financialInstitutionId: string | null;
  financialInstitution?: { id: string; name: string; slug: string } | null;
  embossingTemplateId: string | null;
  embossingTemplate?: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface FinancialInstitution {
  id: string;
  name: string;
  slug: string;
  bin: string | null;
  contactEmail: string | null;
  contactName: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
  updatedAt: string;
  _count?: { programs: number };
  programs?: Program[];
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);

function ProgramsTab() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [fis, setFis] = useState<FinancialInstitution[]>([]);
  const [filterFiId, setFilterFiId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Program | 'new' | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const qs = filterFiId ? `?financialInstitutionId=${encodeURIComponent(filterFiId)}` : '';
      const [pr, fiList] = await Promise.all([
        api.get<Program[]>(`/programs${qs}`),
        api.get<FinancialInstitution[]>('/admin/financial-institutions'),
      ]);
      setPrograms(pr);
      setFis(fiList);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, [filterFiId]);

  useEffect(() => {
    load();
  }, [load]);

  if (editing !== null) {
    return (
      <ProgramForm
        program={editing === 'new' ? null : editing}
        fis={fis}
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
        <button
          className="btn primary"
          onClick={() => setEditing('new')}
          disabled={fis.length === 0}
          title={fis.length === 0 ? 'Create a Financial Institution first' : 'New program'}
        >
          New program
        </button>
      </div>
      <p className="small" style={{ marginTop: 8 }}>
        Card products: currency, tier rules, and NDEF URL templates.  Palisade
        reads the templates at perso time (pre-activation URL baked into the
        card) and after Vera confirms activation (post-activation URL written
        via authenticated APDU).
      </p>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Filter by institution:
          <select value={filterFiId} onChange={(e) => setFilterFiId(e.target.value)}>
            <option value="">All institutions</option>
            {fis.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>
      </div>
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
              <th>Institution</th>
              <th>Name</th>
              <th>Type</th>
              <th>Currency</th>
              <th>Rules</th>
              <th>NDEF templates</th>
              <th>Embossing</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {programs.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.id}</td>
                <td>{p.financialInstitution?.name ?? <span className="small">—</span>}</td>
                <td>{p.name}</td>
                <td className="small">{programTypeLabel(p.programType)}</td>
                <td className="mono">{p.currency}</td>
                <td className="small">{p.tierRules.length} rule{p.tierRules.length === 1 ? '' : 's'}</td>
                <td className="small">
                  {p.preActivationNdefUrlTemplate ? 'pre ✓' : 'pre —'}
                  {' / '}
                  {p.postActivationNdefUrlTemplate ? 'post ✓' : 'post —'}
                </td>
                <td className="small">
                  {p.embossingTemplate?.name ?? <span className="small">—</span>}
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
  fis,
  onSaved,
  onCancel,
}: {
  program: Program | null;
  fis: FinancialInstitution[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(program?.id ?? '');
  const [name, setName] = useState(program?.name ?? '');
  const [currency, setCurrency] = useState(program?.currency ?? 'AUD');
  const [programType, setProgramType] = useState<ProgramType>(
    program?.programType ?? 'PREPAID_RELOADABLE',
  );
  const [financialInstitutionId, setFinancialInstitutionId] = useState<string>(
    program?.financialInstitutionId ?? fis[0]?.id ?? '',
  );
  const [rules, setRules] = useState<TierRule[]>(() =>
    cloneRules(program?.tierRules ?? NEW_PROGRAM_DEFAULT_RULES),
  );
  const [pre, setPre] = useState(program?.preActivationNdefUrlTemplate ?? '');
  const [post, setPost] = useState(program?.postActivationNdefUrlTemplate ?? '');
  const [embossingTemplateId, setEmbossingTemplateId] = useState<string>(
    program?.embossingTemplateId ?? '',
  );
  const [templates, setTemplates] = useState<EmbossingTemplateRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load templates for the selected FI; reset the selection when the FI changes
  // (templates from the previous FI are no longer valid choices).
  useEffect(() => {
    if (!financialInstitutionId) {
      setTemplates([]);
      return;
    }
    api.get<EmbossingTemplateRow[]>(
      `/admin/financial-institutions/${financialInstitutionId}/embossing-templates`,
    )
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, [financialInstitutionId]);

  // If the FI changes away from the one the current embossing template belongs
  // to, clear the selection so we never save a stale cross-FI reference.
  useEffect(() => {
    if (!embossingTemplateId) return;
    if (templates.length > 0 && !templates.some((t) => t.id === embossingTemplateId)) {
      setEmbossingTemplateId('');
    }
  }, [templates, embossingTemplateId]);

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const body = {
        name,
        currency,
        programType,
        tierRules: rules,
        preActivationNdefUrlTemplate: pre.trim() ? pre.trim() : null,
        postActivationNdefUrlTemplate: post.trim() ? post.trim() : null,
        financialInstitutionId: financialInstitutionId || undefined,
        embossingTemplateId: embossingTemplateId ? embossingTemplateId : null,
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

      <label>Financial Institution</label>
      <select
        value={financialInstitutionId}
        onChange={(e) => setFinancialInstitutionId(e.target.value)}
      >
        {fis.length === 0 && <option value="">(none available — create an FI first)</option>}
        {fis.map((f) => (
          <option key={f.id} value={f.id}>{f.name} ({f.slug})</option>
        ))}
      </select>

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

      <label>Program type</label>
      <select
        value={programType}
        onChange={(e) => setProgramType(e.target.value as ProgramType)}
      >
        {PROGRAM_TYPE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {programType === 'RETAIL' && (
        <p className="small">
          Retail cards ship to retailers in a SHIPPED state.  The microsite
          shows info only until ops marks the card as SOLD (admin Cards tab
          or partner <code>POST /api/partners/cards/mark-sold</code>).  Once
          SOLD, the next tap runs the normal WebAuthn activation flow.
        </p>
      )}

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

      <h3 style={{ marginTop: 20 }}>Embossing template</h3>
      <p className="small">
        Defines how batch card-data files are parsed into vault records.
        Templates are FI-scoped — create them under the Embossing Templates
        tab.
      </p>
      <label>Template</label>
      <select
        value={embossingTemplateId}
        onChange={(e) => setEmbossingTemplateId(e.target.value)}
      >
        <option value="">(none — batch uploads disabled)</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.formatType})
          </option>
        ))}
      </select>

      <div style={{ marginTop: 16 }}>
        <button
          className="btn primary"
          onClick={save}
          disabled={busy || (!program && !id) || !name || !currency || !financialInstitutionId}
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
  programId: string | null;
  program: { id: string; name: string } | null;
  createdAt: string;
}

function ChipProfilesTab() {
  const [profiles, setProfiles] = useState<ChipProfile[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [filterProgramId, setFilterProgramId] = useState<string>('');
  const [uploadProgramId, setUploadProgramId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const qs = filterProgramId ? `?programId=${encodeURIComponent(filterProgramId)}` : '';
      const [cp, pg] = await Promise.all([
        api.get<ChipProfile[]>(`/admin/chip-profiles${qs}`),
        api.get<Program[]>('/programs'),
      ]);
      setProfiles(cp);
      setPrograms(pg);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, [filterProgramId]);

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
      if (uploadProgramId) body.programId = uploadProgramId;
      await api.post('/admin/chip-profiles', body);
      setOk(
        `Uploaded chip profile from ${file.name}` +
          (uploadProgramId ? ` (scoped to program)` : ` (global)`),
      );
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            Upload scope:
            <select
              value={uploadProgramId}
              onChange={(e) => setUploadProgramId(e.target.value)}
              disabled={busy}
            >
              <option value="">Global (all programs)</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
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
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Filter by program:
          <select
            value={filterProgramId}
            onChange={(e) => setFilterProgramId(e.target.value)}
          >
            <option value="">All profiles (admin view)</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>{p.name} (scoped + global)</option>
            ))}
          </select>
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
              <th>Program</th>
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
                <td>{p.program ? p.program.name : <span className="small">Global</span>}</td>
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
  const [aid, setAid] = useState('');
  const [appLabel, setAppLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // NOTE: Key ARNs are NOT accepted from this form.  Keys must be imported
  // via the `scripts/import-issuer-keys.ts` CLI tool which uses AWS Payment
  // Cryptography's ImportKey API with TR-31 wrapped key blocks (dual-control
  // key ceremony).  This prevents browser-originated key material / ARNs.
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

      <div className="panel" style={{ marginTop: 20, background: '#fff8e1', borderLeft: '3px solid #f59e0b' }}>
        <strong>🔐 Key ARNs are not set from this form.</strong>
        <p className="small" style={{ margin: '6px 0 0 0' }}>
          AWS Payment Cryptography master keys (TMK, IMK-AC, IMK-SMI, IMK-SMC, IMK-IDN,
          Issuer PK) must be imported via the <code>scripts/import-issuer-keys.ts</code> CLI
          tool using TR-31 wrapped key blocks. This ensures a dual-control key ceremony
          with no key material or ARNs originating from the browser. ARNs populate
          automatically once a key ceremony is completed for this profile.
        </p>
      </div>

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

// --- Microsites tab ---------------------------------------------------------
//
// Program-scoped static site hosting.  Each upload is a zip of the built
// microsite; activating a version copies its files under the `current/`
// prefix so the CDN (microsite.karta.cards) serves them. Disable clears the
// enabled flag without deleting any versions.

interface MicrositeVersion {
  id: string;
  version: string;
  s3Prefix: string;
  uploadedBy: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}

interface MicrositeData {
  programId: string;
  enabled: boolean;
  activeVersion: string | null;
  versions: MicrositeVersion[];
}

interface ProgramRow {
  id: string;
  name: string;
  currency: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function MicrositesTab() {
  const [programs, setPrograms] = useState<ProgramRow[]>([]);
  const [selectedProgramId, setSelectedProgramId] = useState<string>('');
  const [data, setData] = useState<MicrositeData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Upload form state
  const [versionLabel, setVersionLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Per-version action state (keyed by version id)
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);

  // Load programs once
  useEffect(() => {
    api.get<ProgramRow[]>('/programs').then((p) => {
      setPrograms(p);
      if (p.length > 0) setSelectedProgramId((prev) => prev || p[0].id);
    }).catch((e) => setErr(errorMsg(e)));
  }, []);

  const load = useCallback(async () => {
    if (!selectedProgramId) { setData(null); return; }
    try {
      const r = await api.get<MicrositeData>(`/admin/programs/${selectedProgramId}/microsites`);
      setData(r);
    } catch (e) {
      setErr(errorMsg(e));
    }
  }, [selectedProgramId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleUpload = async () => {
    if (!file || !selectedProgramId) return;
    setErr(null);
    setOk(null);
    setUploading(true);
    try {
      const formData = new FormData();
      if (versionLabel.trim()) formData.append('version', versionLabel.trim());
      formData.append('file', file);
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers['authorization'] = `Bearer ${token}`;
      const res = await fetch(`/api/admin/programs/${selectedProgramId}/microsites`, {
        method: 'POST',
        headers,
        body: formData,
      });
      const raw = await res.text();
      const respData = raw ? JSON.parse(raw) : undefined;
      if (!res.ok) {
        throw new Error(respData?.error?.message ?? `HTTP ${res.status}`);
      }
      const newVer = respData as MicrositeVersion;
      setOk(`Uploaded version ${newVer.version} (${newVer.id})`);
      setVersionLabel('');
      setFile(null);
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setUploading(false);
    }
  };

  const handleActivate = async (versionId: string) => {
    if (!selectedProgramId) return;
    setErr(null);
    setOk(null);
    setActivatingId(versionId);
    try {
      await api.post(`/admin/programs/${selectedProgramId}/microsites/${versionId}/activate`);
      setOk(`Activated version ${versionId}`);
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setActivatingId(null);
    }
  };

  const handleDelete = async (versionId: string) => {
    if (!selectedProgramId) return;
    setErr(null);
    setOk(null);
    setDeletingId(versionId);
    try {
      await api.delete(`/admin/programs/${selectedProgramId}/microsites/${versionId}`);
      setOk(`Deleted version ${versionId}`);
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setDeletingId(null);
    }
  };

  const handleDisable = async () => {
    if (!selectedProgramId) return;
    setErr(null);
    setOk(null);
    setDisabling(true);
    try {
      await api.post(`/admin/programs/${selectedProgramId}/microsites/disable`);
      setOk('Microsite disabled');
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setDisabling(false);
    }
  };

  const liveUrl = selectedProgramId
    ? `https://microsite.karta.cards/programs/${selectedProgramId}/`
    : null;

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Microsites</h2>
      <p className="small" style={{ marginTop: 8 }}>
        Per-program static sites served from <span className="mono">microsite.karta.cards</span>.
        Upload a zipped build, then activate a version to publish it. Requires
        a DNS CNAME to the microsite CDN.
      </p>

      <label>Program</label>
      <select
        value={selectedProgramId}
        onChange={(e) => { setSelectedProgramId(e.target.value); setOk(null); setErr(null); }}
      >
        {programs.length === 0 && <option value="">No programs available</option>}
        {programs.map((p) => (
          <option key={p.id} value={p.id}>{p.name} ({p.currency})</option>
        ))}
      </select>

      {ok && <p className="tag ok" style={{ marginTop: 12 }}>{ok}</p>}
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}

      {data && (
        <div
          className="panel"
          style={{ marginTop: 16, background: 'var(--bg-subtle, #fafafa)' }}
        >
          <h3 style={{ margin: 0 }}>Current state</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 12 }}>
            <div>
              <div className="small">Status</div>
              <span className={`tag ${data.enabled ? 'ok' : ''}`}>
                {data.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div>
              <div className="small">Active version</div>
              <div className="mono">{data.activeVersion ?? 'None'}</div>
            </div>
            <div>
              <div className="small">Live URL</div>
              {data.enabled && liveUrl ? (
                <a href={liveUrl} target="_blank" rel="noreferrer" className="mono small">
                  {liveUrl}
                </a>
              ) : (
                <span className="small">—</span>
              )}
            </div>
          </div>
          {data.enabled && (
            <div style={{ marginTop: 12 }}>
              <button className="btn ghost" onClick={handleDisable} disabled={disabling}>
                {disabling ? 'Disabling…' : 'Disable microsite'}
              </button>
            </div>
          )}
        </div>
      )}

      <h3 style={{ marginTop: 20 }}>Upload new version</h3>
      <p className="small">
        Upload a <span className="mono">.zip</span> of the built microsite.
        The version label is optional — if omitted the server assigns one.
      </p>

      <label>Version label (optional)</label>
      <input
        value={versionLabel}
        onChange={(e) => setVersionLabel(e.target.value)}
        className="mono"
        placeholder="v1"
        disabled={uploading}
      />

      <label>Zip file</label>
      <input
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={uploading}
      />

      <div style={{ marginTop: 14 }}>
        <button
          className="btn primary"
          onClick={handleUpload}
          disabled={uploading || !file || !selectedProgramId}
        >
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>

      <h3 style={{ marginTop: 20 }}>Versions</h3>
      {!data || data.versions.length === 0 ? (
        <p className="small">No versions uploaded for this program yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Files</th>
              <th>Size</th>
              <th>Uploaded By</th>
              <th>Uploaded At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.versions.map((v) => {
              const isActive = data.activeVersion === v.id;
              return (
                <tr key={v.id}>
                  <td className="mono">{v.version}</td>
                  <td className="mono">{v.fileCount}</td>
                  <td className="mono">{formatBytes(v.totalBytes)}</td>
                  <td className="small">{v.uploadedBy}</td>
                  <td className="small">{formatDate(v.createdAt)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {isActive ? (
                        <span className="tag ok">✓ Active</span>
                      ) : (
                        <button
                          className="btn primary"
                          onClick={() => handleActivate(v.id)}
                          disabled={activatingId === v.id}
                        >
                          {activatingId === v.id ? 'Activating…' : 'Activate'}
                        </button>
                      )}
                      <button
                        className="btn ghost"
                        onClick={() => handleDelete(v.id)}
                        disabled={isActive || deletingId === v.id}
                        title={isActive ? 'Cannot delete the active version — disable or activate another first' : 'Delete this version'}
                      >
                        {deletingId === v.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- Embossing Templates tab -------------------------------------------------
//
// Templates are FI-scoped schema definitions describing how to parse an
// embossing batch file.  A template can cover multiple card schemes because
// Visa + Mastercard share the same record layout in most formats.  The
// underlying template file is encrypted at rest (separate keyspace from the
// vault PAN DEK) so proprietary layouts don't leak from the DB.

interface EmbossingTemplateRow {
  id: string;
  name: string;
  description: string | null;
  supportsVisa: boolean;
  supportsMastercard: boolean;
  supportsAmex: boolean;
  formatType: string;
  recordLength: number | null;
  fieldCount: number | null;
  templateFileName: string;
  templateSha256: string;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

function EmbossingTemplatesTab() {
  const [fis, setFis] = useState<FinancialInstitution[]>([]);
  const [selectedFiId, setSelectedFiId] = useState<string>('');
  const [templates, setTemplates] = useState<EmbossingTemplateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Upload form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formatType, setFormatType] = useState('episode_six');
  const [supportsVisa, setSupportsVisa] = useState(false);
  const [supportsMastercard, setSupportsMastercard] = useState(false);
  const [supportsAmex, setSupportsAmex] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    api.get<FinancialInstitution[]>('/admin/financial-institutions')
      .then((list) => {
        setFis(list);
        if (list.length > 0) setSelectedFiId((prev) => prev || list[0].id);
      })
      .catch((e) => setErr(errorMsg(e)));
  }, []);

  const load = useCallback(async () => {
    if (!selectedFiId) {
      setTemplates([]);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const r = await api.get<EmbossingTemplateRow[]>(
        `/admin/financial-institutions/${selectedFiId}/embossing-templates`,
      );
      setTemplates(r);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, [selectedFiId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleUpload = async () => {
    if (!selectedFiId || !file) return;
    setErr(null);
    setOk(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (name.trim()) formData.append('name', name.trim());
      if (description.trim()) formData.append('description', description.trim());
      formData.append('formatType', formatType);
      formData.append('supportsVisa', String(supportsVisa));
      formData.append('supportsMastercard', String(supportsMastercard));
      formData.append('supportsAmex', String(supportsAmex));
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers['authorization'] = `Bearer ${token}`;
      const res = await fetch(
        `/api/admin/financial-institutions/${selectedFiId}/embossing-templates`,
        { method: 'POST', headers, body: formData },
      );
      const raw = await res.text();
      const respData = raw ? JSON.parse(raw) : undefined;
      if (!res.ok) {
        throw new Error(respData?.error?.message ?? `HTTP ${res.status}`);
      }
      const newTpl = respData as EmbossingTemplateRow;
      setOk(`Uploaded template "${newTpl.name}"`);
      setName('');
      setDescription('');
      setFile(null);
      setSupportsVisa(false);
      setSupportsMastercard(false);
      setSupportsAmex(false);
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (templateId: string) => {
    if (!selectedFiId) return;
    setErr(null);
    setOk(null);
    try {
      await api.delete(
        `/admin/financial-institutions/${selectedFiId}/embossing-templates/${templateId}`,
      );
      setOk(`Deleted template`);
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    }
  };

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Embossing Templates</h2>
      <p className="small" style={{ marginTop: 8 }}>
        Per-FI schema definitions describing how batch card-data files are
        parsed.  Templates are encrypted at rest; batch uploads reference
        a template so the parser knows the record layout.  Visa + Mastercard
        can share a template when the underlying format is identical.
      </p>

      <label>Financial Institution</label>
      <select
        value={selectedFiId}
        onChange={(e) => { setSelectedFiId(e.target.value); setOk(null); setErr(null); }}
      >
        {fis.length === 0 && <option value="">No FIs available — create one first</option>}
        {fis.map((f) => (
          <option key={f.id} value={f.id}>{f.name} ({f.slug})</option>
        ))}
      </select>

      {ok && <p className="tag ok" style={{ marginTop: 12 }}>{ok}</p>}
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}

      <h3 style={{ marginTop: 20 }}>Upload new template</h3>

      <label>Name</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="InComm Standard v2"
        disabled={uploading}
      />

      <label>Description (optional)</label>
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Record layout for InComm's Q2 2026 cards"
        disabled={uploading}
      />

      <label>Format type</label>
      <select
        value={formatType}
        onChange={(e) => setFormatType(e.target.value)}
        disabled={uploading}
      >
        <option value="episode_six">Episode Six</option>
        <option value="fixed_width">Fixed-width</option>
        <option value="csv">CSV</option>
        <option value="xml">XML</option>
      </select>

      <label>Supported schemes</label>
      <div style={{ display: 'flex', gap: 16, paddingTop: 4 }}>
        <label className="small" style={{ display: 'flex', gap: 4 }}>
          <input
            type="checkbox"
            checked={supportsVisa}
            onChange={(e) => setSupportsVisa(e.target.checked)}
            disabled={uploading}
          />
          Visa
        </label>
        <label className="small" style={{ display: 'flex', gap: 4 }}>
          <input
            type="checkbox"
            checked={supportsMastercard}
            onChange={(e) => setSupportsMastercard(e.target.checked)}
            disabled={uploading}
          />
          Mastercard
        </label>
        <label className="small" style={{ display: 'flex', gap: 4 }}>
          <input
            type="checkbox"
            checked={supportsAmex}
            onChange={(e) => setSupportsAmex(e.target.checked)}
            disabled={uploading}
          />
          Amex
        </label>
      </div>

      <label style={{ marginTop: 12 }}>Template file (max 10 MB)</label>
      <input
        type="file"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={uploading}
      />

      <div style={{ marginTop: 14 }}>
        <button
          className="btn primary"
          onClick={handleUpload}
          disabled={uploading || !file || !selectedFiId || !name.trim()}
        >
          {uploading ? 'Uploading…' : 'Upload template'}
        </button>
      </div>

      <h3 style={{ marginTop: 20 }}>Templates</h3>
      {loading ? (
        <p className="small">Loading…</p>
      ) : templates.length === 0 ? (
        <p className="small">No templates yet for this FI.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Format</th>
              <th>Schemes</th>
              <th>Fields</th>
              <th>Record len</th>
              <th>File</th>
              <th>Uploaded</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.name}
                  {t.description && <div className="small">{t.description}</div>}
                </td>
                <td className="mono">{t.formatType}</td>
                <td>
                  {t.supportsVisa && <span className="tag" style={{ marginRight: 4 }}>Visa</span>}
                  {t.supportsMastercard && <span className="tag" style={{ marginRight: 4 }}>MC</span>}
                  {t.supportsAmex && <span className="tag" style={{ marginRight: 4 }}>Amex</span>}
                  {!t.supportsVisa && !t.supportsMastercard && !t.supportsAmex && (
                    <span className="small">—</span>
                  )}
                </td>
                <td className="mono">{t.fieldCount ?? '—'}</td>
                <td className="mono">{t.recordLength ?? '—'}</td>
                <td className="small">{t.templateFileName}</td>
                <td className="small">{formatDate(t.createdAt)}</td>
                <td>
                  <button className="btn ghost" onClick={() => handleDelete(t.id)}>
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

// --- Embossing Batches tab ---------------------------------------------------
//
// A batch IS an actual card-data file following a template.  The raw file is
// encrypted at rest in S3 (SSE-KMS).  A background worker (separate PR) will
// parse records and route each through the existing vault registerCard flow.
// PANs never land in plaintext on this path — the batch file is the carrier
// and the vault is the destination.

interface EmbossingBatchRow {
  id: string;
  templateId: string;
  programId: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  s3Bucket: string;
  s3Key: string;
  status: string;
  recordCount: number | null;
  recordsSuccess: number;
  recordsFailed: number;
  processingError: string | null;
  uploadedVia: string;
  uploadedBy: string | null;
  uploadedAt: string;
  processedAt: string | null;
  template: { id: string; name: string } | null;
}

function EmbossingBatchesTab() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [selectedProgramId, setSelectedProgramId] = useState<string>('');
  const [templates, setTemplates] = useState<EmbossingTemplateRow[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [batches, setBatches] = useState<EmbossingBatchRow[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const selectedProgram = programs.find((p) => p.id === selectedProgramId) ?? null;

  // Load programs once
  useEffect(() => {
    api.get<Program[]>('/programs')
      .then((p) => {
        setPrograms(p);
        if (p.length > 0) setSelectedProgramId((prev) => prev || p[0].id);
      })
      .catch((e) => setErr(errorMsg(e)));
  }, []);

  // When program changes, refresh the template list (scoped to the program's FI)
  // and default the template selection to the program's configured template.
  useEffect(() => {
    if (!selectedProgram?.financialInstitutionId) {
      setTemplates([]);
      setSelectedTemplateId('');
      return;
    }
    api.get<EmbossingTemplateRow[]>(
      `/admin/financial-institutions/${selectedProgram.financialInstitutionId}/embossing-templates`,
    )
      .then((list) => {
        setTemplates(list);
        setSelectedTemplateId(
          selectedProgram.embossingTemplateId && list.some((t) => t.id === selectedProgram.embossingTemplateId)
            ? selectedProgram.embossingTemplateId
            : list[0]?.id ?? '',
        );
      })
      .catch(() => {
        setTemplates([]);
        setSelectedTemplateId('');
      });
  }, [selectedProgram]);

  const load = useCallback(async () => {
    if (!selectedProgramId) {
      setBatches([]);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const r = await api.get<EmbossingBatchRow[]>(
        `/admin/programs/${selectedProgramId}/embossing-batches`,
      );
      setBatches(r);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, [selectedProgramId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll every 10 s so status transitions driven by the batch-processor
  // worker (RECEIVED → PROCESSING → PROCESSED/FAILED) surface without a
  // manual refresh.  Cheap — the admin is typically watching one program at
  // a time and the endpoint is read-only.
  useEffect(() => {
    if (!selectedProgramId) return;
    const id = window.setInterval(() => {
      // Swallow errors here; the initial `load()` already surfaces them and
      // we don't want a transient network blip to show a banner on every tick.
      api.get<EmbossingBatchRow[]>(`/admin/programs/${selectedProgramId}/embossing-batches`)
        .then(setBatches)
        .catch(() => {});
    }, 10_000);
    return () => window.clearInterval(id);
  }, [selectedProgramId]);

  const handleUpload = async () => {
    if (!selectedProgramId || !file || !selectedTemplateId) return;
    setErr(null);
    setOk(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('templateId', selectedTemplateId);
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers['authorization'] = `Bearer ${token}`;
      const res = await fetch(
        `/api/admin/programs/${selectedProgramId}/embossing-batches`,
        { method: 'POST', headers, body: formData },
      );
      const raw = await res.text();
      const respData = raw ? JSON.parse(raw) : undefined;
      if (!res.ok) {
        throw new Error(respData?.error?.message ?? `HTTP ${res.status}`);
      }
      setOk(`Uploaded batch ${respData.fileName} (${respData.id})`);
      setFile(null);
      await load();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Embossing Batches</h2>
      <p className="small" style={{ marginTop: 8 }}>
        Upload a card-data file for a program.  The raw file is encrypted
        at rest (SSE-KMS in S3); a background worker parses records and
        routes each through the vault's registerCard flow — PANs never land
        in plaintext on this path.
      </p>

      <label>Program</label>
      <select
        value={selectedProgramId}
        onChange={(e) => { setSelectedProgramId(e.target.value); setOk(null); setErr(null); }}
      >
        {programs.length === 0 && <option value="">No programs available</option>}
        {programs.map((p) => (
          <option key={p.id} value={p.id}>{p.name} ({p.currency})</option>
        ))}
      </select>

      {selectedProgram && (
        <p className="small" style={{ marginTop: 8 }}>
          Configured template for this program:{' '}
          {selectedProgram.embossingTemplate ? (
            <span className="mono">{selectedProgram.embossingTemplate.name}</span>
          ) : (
            <span>none — set one on the program to default it here.</span>
          )}
        </p>
      )}

      {ok && <p className="tag ok" style={{ marginTop: 12 }}>{ok}</p>}
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}

      <h3 style={{ marginTop: 20 }}>Upload new batch</h3>

      <label>Template</label>
      <select
        value={selectedTemplateId}
        onChange={(e) => setSelectedTemplateId(e.target.value)}
        disabled={uploading}
      >
        {templates.length === 0 && <option value="">No templates for this FI</option>}
        {templates.map((t) => (
          <option key={t.id} value={t.id}>{t.name} ({t.formatType})</option>
        ))}
      </select>

      <label>Batch file (max 500 MB)</label>
      <input
        type="file"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={uploading}
      />

      <div style={{ marginTop: 14 }}>
        <button
          className="btn primary"
          onClick={handleUpload}
          disabled={uploading || !file || !selectedProgramId || !selectedTemplateId}
        >
          {uploading ? 'Uploading…' : 'Upload batch'}
        </button>
      </div>

      <h3 style={{ marginTop: 20 }}>Batches</h3>
      {loading ? (
        <p className="small">Loading…</p>
      ) : batches.length === 0 ? (
        <p className="small">No batches yet for this program.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Size</th>
              <th>Template</th>
              <th>Status</th>
              <th>Records</th>
              <th>Via</th>
              <th>Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td>
                  <div>{b.fileName}</div>
                  <div className="small mono">{b.sha256.slice(0, 16)}…</div>
                </td>
                <td className="mono">{formatBytes(b.fileSize)}</td>
                <td className="small">{b.template?.name ?? '—'}</td>
                <td><BatchStatusCell batch={b} /></td>
                <td className="mono small"><BatchRecordsCell batch={b} /></td>
                <td className="small">{b.uploadedVia}</td>
                <td className="small">{formatDate(b.uploadedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Colour-coded batch status badge.
 *
 *   RECEIVED   → neutral (gray) — uploaded but not picked up yet
 *   PROCESSING → warn (amber) with a spinner — worker is parsing
 *   PROCESSED  → ok (green) with "N/M records" subline
 *   FAILED     → err (red) with truncated error + full error in title tooltip
 *
 * Keeps visual weight in the status column; the Records column stays a
 * compact "successes / total · failed" tally for PROCESSED rows so admins
 * can spot partial failures at a glance.
 */
function BatchStatusCell({ batch }: { batch: EmbossingBatchRow }) {
  const s = batch.status;
  if (s === 'PROCESSED') {
    return (
      <div>
        <span className="tag ok">PROCESSED</span>
        {batch.recordCount !== null && (
          <div className="small" style={{ marginTop: 2 }}>
            {batch.recordsSuccess}/{batch.recordCount} records
          </div>
        )}
      </div>
    );
  }
  if (s === 'FAILED') {
    const full = batch.processingError ?? 'Processing failed';
    const truncated = full.length > 80 ? `${full.slice(0, 77)}…` : full;
    return (
      <div>
        <span className="tag err">FAILED</span>
        <div className="tag err" style={{ marginTop: 4 }} title={full}>
          {truncated}
        </div>
      </div>
    );
  }
  if (s === 'PROCESSING') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="tag" style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}>
          PROCESSING
        </span>
        <BatchSpinner />
      </div>
    );
  }
  if (s === 'RECEIVED') {
    return <span className="tag">RECEIVED</span>;
  }
  // Unknown statuses fall back to a neutral tag so we never crash on new
  // server-side values we haven't taught the UI about yet.
  return <span className="tag">{s}</span>;
}

function BatchRecordsCell({ batch }: { batch: EmbossingBatchRow }) {
  if (batch.recordCount === null) return <>—</>;
  if (batch.status === 'PROCESSED') {
    // Explicit format from spec: "recordsSuccess / recordCount · recordsFailed failed"
    return (
      <>
        {batch.recordsSuccess} / {batch.recordCount}
        {batch.recordsFailed > 0 && ` · ${batch.recordsFailed} failed`}
      </>
    );
  }
  // For PROCESSING / RECEIVED we still show raw progress if the worker wrote it.
  return (
    <>
      {batch.recordsSuccess}/{batch.recordCount}
      {batch.recordsFailed > 0 && ` (${batch.recordsFailed} failed)`}
    </>
  );
}

/** Tiny inline CSS spinner used in the PROCESSING status cell. */
function BatchSpinner() {
  return (
    <span
      aria-label="processing"
      style={{
        display: 'inline-block',
        width: 12,
        height: 12,
        border: '2px solid var(--edge)',
        borderTopColor: 'var(--accent)',
        borderRadius: '50%',
        animation: 'vera-spin 0.9s linear infinite',
      }}
    />
  );
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
