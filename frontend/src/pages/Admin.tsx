import { useCallback, useEffect, useState } from 'react';
import { api, errorMsg } from '../utils/api';
import { formatDate, formatMoney } from '../utils/format';
import { luhnValid } from '../utils/luhn';
import type { CredentialKind } from '../utils/webauthn';

// Admin UI — read-only view of cards, vault entries, transactions, and the
// vault audit tail.
//
// Cards are NOT created from this page in the production lifecycle —
// Palisade's provisioning-agent calls POST /api/cards/register after data-
// prep + perso.  Activation is entirely cardholder-driven: tap the card →
// SDM URL fires → /activate?session=<token>.  Admin sees the resulting
// state but cannot mint sessions or links itself.

type TabKey = 'cards' | 'vault' | 'transactions' | 'audit';

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
  batchId: string | null;
  createdAt: string;
  vaultEntry?: { id: string; panLast4: string; panBin: string; cardholderName: string } | null;
  credentials: { id: string; kind: CredentialKind; deviceName: string | null; createdAt: string; lastUsedAt: string | null }[];
  activationSessions: ActivationSessionRow[];
}

export default function Admin() {
  const [tab, setTab] = useState<TabKey>('cards');
  return (
    <div className="page">
      <h1>Vera Admin</h1>
      <p className="small">Cards, vault, WebAuthn credentials, transactions, audit.</p>
      <div className="tabs">
        {(['cards', 'vault', 'transactions', 'audit'] as const).map((t) => (
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
      {tab === 'transactions' && <TransactionsTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

const labels: Record<TabKey, string> = {
  cards: 'Cards',
  vault: 'Vault',
  transactions: 'Transactions',
  audit: 'Audit',
};

// --- Cards tab ---------------------------------------------------------------

function CardsTab() {
  const { cards, loading } = useCards();

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Cards</h2>
      <p className="small" style={{ marginTop: 8 }}>
        Cards are registered by Palisade's provisioning-agent (POST /api/cards/register)
        and activated by the cardholder tapping the physical card. Admin is read-only.
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
        '/vault/store',
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
      const r = await api.get<AuditRow[]>('/vault/audit?limit=200');
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

// --- Helpers -----------------------------------------------------------------

function useCards() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const r = await api.get<Card[]>('/vault/cards');
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
