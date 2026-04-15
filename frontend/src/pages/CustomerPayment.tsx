import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, errorMsg } from '../utils/api';
import { usePaymentSse } from '../utils/sse';
import { formatMoney } from '../utils/format';
import { detectDevice, type Device } from '../utils/device';
import { authenticate, registerCredential, type CredentialKind } from '../utils/webauthn';
import PaymentStatus from '../components/PaymentStatus';

// -----------------------------------------------------------------------------
// Customer payment page.  Reached via QR scan (desktop → phone) or redirect
// (merchant page on mobile).
//
// Flow:
//   1. Fetch the transaction by RLID, render summary + status.
//   2. Fetch the card's credentials; decide which ceremonies this device
//      supports based on tier + platform.
//   3. If no credential exists for the chosen ceremony, run inline
//      registration first (first-time-on-this-device fallback).
//   4. On "Confirm & Pay" → startAuthentication → POST /authenticate/verify.
//   5. Backend runs post-auth orchestration; we stream SSE events live.
//
// All WebAuthn goes through @simplewebauthn/browser v10 via utils/webauthn.ts
// — no hand-rolled base64url conversion (Android Chrome NFC bug).
// -----------------------------------------------------------------------------

interface Transaction {
  id: string;
  rlid: string;
  status: string;
  tier: 'TIER_1' | 'TIER_2' | 'TIER_3';
  actualTier: 'TIER_1' | 'TIER_2' | 'TIER_3' | null;
  amount: number;
  currency: string;
  merchantName: string;
  merchantRef: string;
  expiresAt: string;
  cardId: string;
}

interface CardSummary {
  id: string;
  cardIdentifier: string;
  status: string;
  vaultEntry?: { panLast4: string; panBin: string; cardholderName: string } | null;
  credentials: {
    id: string;
    kind: CredentialKind;
    deviceName: string | null;
    createdAt: string;
    lastUsedAt: string | null;
  }[];
}

/**
 * Pick which ceremony to offer for this (tier, device) combination.
 * Returns null if the combination isn't supported (e.g. Tier 2 on iOS Safari).
 */
function preferredKind(
  tier: Transaction['tier'],
  device: Device,
): CredentialKind | null {
  if (tier === 'TIER_2') {
    // Mid-tier is NFC card tap.  Android Chrome is the only reliable path
    // per the New T4T learnings (CTAP1 over NFC).
    if (device === 'android') return 'CROSS_PLATFORM';
    return null; // iOS Safari + desktop can't tap an NFC card through a browser reliably
  }
  // Tiers 1 and 3 — platform biometric.  Works on all three device classes.
  return 'PLATFORM';
}

export default function CustomerPayment() {
  const { rlid } = useParams();
  const [txn, setTxn] = useState<Transaction | null>(null);
  const [card, setCard] = useState<CardSummary | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const device = useMemo(detectDevice, []);

  // Load the transaction + the card's credentials in parallel.  In production
  // the card lookup would be its own endpoint scoped by RLID so unrelated card
  // metadata isn't leaked to the customer device — fine for the demo.
  const load = useCallback(async () => {
    if (!rlid) return;
    try {
      const [t, allCards] = await Promise.all([
        api.get<Transaction>(`/transactions/${rlid}`),
        api.get<CardSummary[]>('/vault/cards'),
      ]);
      setTxn(t);
      setCard(allCards.find((x) => x.id === t.cardId) ?? null);
    } catch (e) {
      setLoadErr(errorMsg(e));
    }
  }, [rlid]);
  useEffect(() => {
    load();
  }, [load]);

  const { events, last, terminal } = usePaymentSse(txn?.rlid);

  const preferred = txn ? preferredKind(txn.tier, device) : null;
  const hasCredential = Boolean(
    card && preferred && card.credentials.some((c) => c.kind === preferred),
  );

  const doRegister = async () => {
    if (!card || !preferred) return;
    setBusy(true);
    setAuthErr(null);
    try {
      await registerCredential({
        cardId: card.id,
        kind: preferred,
        userName: card.vaultEntry?.cardholderName ?? 'Cardholder',
        deviceName: preferredDeviceName(device),
      });
      await load(); // refresh credentials
    } catch (e) {
      setAuthErr(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const doConfirm = async () => {
    if (!txn || !preferred) return;
    setBusy(true);
    setAuthErr(null);
    try {
      await authenticate({ rlid: txn.rlid, kinds: [preferred] });
      // Orchestration happens server-side; SSE drives the UI from here.
    } catch (e) {
      setAuthErr(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (loadErr) {
    return (
      <div className="page">
        <h1>Payment</h1>
        <div className="panel">
          <p className="tag err">{loadErr}</p>
        </div>
      </div>
    );
  }

  if (!txn || !card) {
    return (
      <div className="page">
        <h1>Loading…</h1>
      </div>
    );
  }

  const expired = txn.status === 'EXPIRED' || (last?.type === 'expired');

  return (
    <div className="page">
      <h1>Confirm payment</h1>
      <div className="panel">
        <div className="row">
          <div>
            <div className="small">Pay to</div>
            <div style={{ fontSize: 18 }}>{txn.merchantName}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="small">Amount</div>
            <div className="mono" style={{ fontSize: 22 }}>
              {formatMoney(txn.amount, txn.currency)}
            </div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div>
            <div className="small">Card</div>
            <div className="mono">
              {card.vaultEntry ? `•••• ${card.vaultEntry.panLast4}` : '—'}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="small">Tier</div>
            <div className="tag">{tierLabel(txn.tier)}</div>
          </div>
        </div>
      </div>

      {expired && (
        <div className="panel">
          <p className="tag err">This transaction has expired.</p>
          <p className="small">Ask the merchant to generate a new QR and scan again.</p>
        </div>
      )}

      {!expired && !terminal && (
        <div className="panel">
          {preferred === null ? (
            <>
              <p className="tag warn">Tier 2 NFC tap requires Android Chrome.</p>
              <p className="small">
                Open this payment link on an Android phone running Chrome, and tap
                your Palisade card to authenticate.
              </p>
            </>
          ) : !hasCredential ? (
            <>
              <h2 style={{ marginTop: 0 }}>First time on this device</h2>
              <p className="small">
                Passkeys are device-scoped, so we need to register one here before
                you can pay. {ceremonyHint(preferred, device)}
              </p>
              <button className="btn primary" onClick={doRegister} disabled={busy} style={{ width: '100%' }}>
                {busy ? 'Waiting…' : `Register ${ceremonyShort(preferred)}`}
              </button>
            </>
          ) : (
            <>
              <h2 style={{ marginTop: 0 }}>Ready to pay</h2>
              <p className="small">{ceremonyHint(preferred, device)}</p>
              <button className="btn primary" onClick={doConfirm} disabled={busy} style={{ width: '100%', fontSize: 16 }}>
                {busy ? 'Waiting for authentication…' : 'Confirm & Pay'}
              </button>
            </>
          )}
          {authErr && <p className="tag err" style={{ marginTop: 12 }}>{authErr}</p>}
        </div>
      )}

      {(events.length > 0 || terminal) && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Progress</h2>
          <PaymentStatus events={events} />
        </div>
      )}
    </div>
  );
}

// --- Helpers -----------------------------------------------------------------

function tierLabel(t: Transaction['tier']): string {
  if (t === 'TIER_1') return 'Tier 1 — platform biometric';
  if (t === 'TIER_2') return 'Tier 2 — NFC card tap';
  return 'Tier 3 — biometric + step-up';
}

function ceremonyHint(kind: CredentialKind, device: Device): string {
  if (kind === 'CROSS_PLATFORM') return 'Tap your Palisade card against the back of your phone.';
  if (device === 'ios') return 'You will be prompted for Face ID or Touch ID.';
  if (device === 'android') return 'You will be prompted for your phone biometric.';
  return 'You will be prompted for your platform biometric (Touch ID / Windows Hello).';
}

function ceremonyShort(kind: CredentialKind): string {
  return kind === 'CROSS_PLATFORM' ? 'NFC card' : 'platform passkey';
}

function preferredDeviceName(device: Device): string {
  if (device === 'ios') return 'iPhone / iPad';
  if (device === 'android') return 'Android phone';
  return 'Desktop browser';
}
