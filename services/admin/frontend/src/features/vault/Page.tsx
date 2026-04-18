import { useEffect, useState } from 'react';
import { api, errorMsg } from '../../utils/api';
import { luhnValid } from '../../utils/luhn';
import { useCards } from '../../hooks/useCards';

export function VaultPage() {
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
