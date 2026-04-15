import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMsg } from '../utils/api';
import { usePaymentSse } from '../utils/sse';
import { formatCountdown, formatMoney } from '../utils/format';
import { isMobile } from '../utils/device';
import QRCode from '../components/QRCode';
import PaymentStatus from '../components/PaymentStatus';

// -----------------------------------------------------------------------------
// Merchant demo page.
//
//   - Static cart (three items)
//   - Card selector (activated cards only)
//   - "Pay with Palisade" → POST /api/transactions
//   - Desktop: show QR + live SSE progress + countdown
//   - Mobile: redirect directly to /pay/{rlid} (hand-off skipped)
//
// The merchant's job is only to create the transaction and hand off the RLID.
// Authentication, ARQC, tokenisation, and the charge all run server-side,
// kicked off by the customer's /pay/{rlid} → /authenticate/verify call.
// -----------------------------------------------------------------------------

const CART: { title: string; subtitle: string; priceMinor: number }[] = [
  { title: 'Monstera (mature)', subtitle: 'Indoor, filtered light', priceMinor: 4900 },
  { title: 'Terracotta planter', subtitle: 'Hand-thrown, 22cm', priceMinor: 2600 },
  { title: 'Potting mix', subtitle: 'Organic, 10L', priceMinor: 1200 },
];
const CURRENCY = 'USD';

interface Card {
  id: string;
  cardIdentifier: string;
  status: string;
  vaultEntry?: { panLast4: string } | null;
}

interface Transaction {
  id: string;
  rlid: string;
  status: string;
  tier: string;
  amount: number;
  currency: string;
  merchantName: string;
  expiresAt: string;
}

export default function MerchantCheckout() {
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [txn, setTxn] = useState<Transaction | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const total = useMemo(() => CART.reduce((a, b) => a + b.priceMinor, 0), []);
  const mobile = useMemo(isMobile, []);

  // Load activated cards for the dropdown.
  useEffect(() => {
    (async () => {
      try {
        const all = await api.get<Card[]>('/vault/cards');
        const activated = all.filter(
          (c) => c.status === 'ACTIVATED' && c.vaultEntry,
        );
        setCards(activated);
        if (activated[0]) setSelected(activated[0].id);
      } catch (e) {
        setErr(errorMsg(e));
      }
    })();
  }, []);

  const pay = useCallback(async () => {
    if (!selected) return setErr('Pick a card first');
    setBusy(true);
    setErr(null);
    try {
      const t = await api.post<Transaction>('/transactions', {
        cardId: selected,
        amount: total,
        currency: CURRENCY,
        merchantRef: `order_${Date.now()}`,
        merchantName: 'Verdant Co.',
      });
      setTxn(t);
      if (mobile) {
        window.location.href = `/pay/${t.rlid}`;
      }
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setBusy(false);
    }
  }, [selected, total, mobile]);

  return (
    <div className="page">
      <h1>Verdant Co.</h1>
      <p className="small">Demo merchant — checkout via Palisade</p>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Your cart</h2>
        {CART.map((item) => (
          <div key={item.title} className="row" style={{ padding: '8px 0' }}>
            <div>
              <div>{item.title}</div>
              <div className="small">{item.subtitle}</div>
            </div>
            <div className="mono">{formatMoney(item.priceMinor, CURRENCY)}</div>
          </div>
        ))}
        <div
          className="row"
          style={{
            borderTop: '1px solid var(--edge)',
            marginTop: 8,
            paddingTop: 12,
          }}
        >
          <strong>Total</strong>
          <strong className="mono">{formatMoney(total, CURRENCY)}</strong>
        </div>
      </div>

      {!txn && (
        <div className="panel">
          <label>Charge to card</label>
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {cards.length === 0 && (
              <option value="">No activated cards — visit /admin to vault one</option>
            )}
            {cards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.cardIdentifier}
                {c.vaultEntry ? ` — •••• ${c.vaultEntry.panLast4}` : ''}
              </option>
            ))}
          </select>
          <div style={{ marginTop: 14 }}>
            <button
              className="btn primary"
              onClick={pay}
              disabled={busy || !selected}
              style={{ width: '100%', fontSize: 16 }}
            >
              {busy ? 'Creating transaction…' : `Pay with Palisade — ${formatMoney(total, CURRENCY)}`}
            </button>
          </div>
          {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
        </div>
      )}

      {txn && !mobile && (
        <DesktopHandoff
          txn={txn}
          onRegenerate={async () => {
            setTxn(null);
            await pay();
          }}
        />
      )}
    </div>
  );
}

// --- Desktop hand-off --------------------------------------------------------

function DesktopHandoff({
  txn,
  onRegenerate,
}: {
  txn: Transaction;
  onRegenerate: () => void;
}) {
  const { events, terminal } = usePaymentSse(txn.rlid);
  const [qr, setQr] = useState<{ url: string; qr: string } | null>(null);
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.floor((new Date(txn.expiresAt).getTime() - Date.now()) / 1000)),
  );

  // Fetch the backend-rendered QR (same URL we would encode client-side, but
  // the backend is the canonical source for the format).
  useEffect(() => {
    (async () => {
      const r = await api.post<{ url: string; qr: string; expiresAt: string }>(
        `/transactions/${txn.rlid}/qr`,
      );
      setQr(r);
    })();
  }, [txn.rlid]);

  useEffect(() => {
    const expiresAt = new Date(txn.expiresAt).getTime();
    const timer = setInterval(() => {
      const next = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setRemaining((prev) => (prev === next ? prev : next));
      if (next === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [txn.expiresAt]);

  const expired = remaining === 0 && !terminal;

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Scan to pay</h2>
      <p className="small">
        Tier {txn.tier.replace('TIER_', '')} — {formatMoney(txn.amount, txn.currency)}
      </p>

      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
        <div style={{ textAlign: 'center' }}>
          {qr ? (
            <QRCode value={qr.url} />
          ) : (
            <p className="small">Generating QR…</p>
          )}
          {!terminal && (
            <p className="small" style={{ marginTop: 10 }}>
              {expired ? (
                <>
                  QR expired.{' '}
                  <button className="btn ghost" onClick={onRegenerate}>
                    Generate new QR
                  </button>
                </>
              ) : (
                <>Expires in {formatCountdown(remaining)}</>
              )}
            </p>
          )}
          <p className="small mono" style={{ wordBreak: 'break-all' }}>
            {qr?.url}
          </p>
        </div>

        <div>
          <PaymentStatus events={events} />
        </div>
      </div>
    </div>
  );
}

