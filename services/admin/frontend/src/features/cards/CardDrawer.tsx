import { useState } from 'react';
import { api as allApi, errorMsg } from '../../utils/api';
const api = allApi.palisade;
import { formatDate } from '../../utils/format';
import { Drawer } from '../../components/Drawer';
import { StatusChip, statusToneFor } from '../../components/StatusChip';
import { CardCredentialsPanel } from './CredentialsPanel';
import type { Card } from './types';
import type { Program } from '../programs/types';

export function CardDrawer({
  card,
  programs,
  onClose,
  onChanged,
}: {
  card: Card | null;
  programs: Program[];
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  return (
    <Drawer
      open={card !== null}
      onClose={onClose}
      title={card ? <span className="mono">{card.cardRef}</span> : ''}
    >
      {card && (
        <CardDrawerBody card={card} programs={programs} onChanged={onChanged} />
      )}
    </Drawer>
  );
}

function CardDrawerBody({
  card,
  programs,
  onChanged,
}: {
  card: Card;
  programs: Program[];
  onChanged: () => Promise<void> | void;
}) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <StatusChip label={card.status} tone={statusToneFor(card.status)} />
        <span className="small">Created {formatDate(card.createdAt)}</span>
      </div>

      {card.vaultEntry && (
        <div style={{ marginBottom: 16 }}>
          <div className="small">Vault PAN</div>
          <div className="mono" style={{ fontSize: 16 }}>
            •••• {card.vaultEntry.panLast4}
          </div>
          <div className="small">{card.vaultEntry.cardholderName}</div>
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <div className="small">Program</div>
        <ProgramPicker card={card} programs={programs} onChanged={onChanged} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <div className="small">Retail sale</div>
        <RetailSaleRow card={card} onChanged={onChanged} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <div className="small">Activation</div>
        <ActivationSummary card={card} />
      </div>

      <hr style={{ border: 0, borderTop: '1px solid var(--edge)', margin: '20px 0' }} />

      <CardCredentialsPanel
        cardRef={card.cardRef}
        cardStatus={card.status}
        onChanged={onChanged}
      />
    </div>
  );
}

/**
 * Per-row program selector.  Empty string = no program (Card.programId null,
 * falls back to DEFAULT_TIER_RULES server-side).  PATCH happens inline on
 * change; failures surface below the select and the row state is reloaded
 * from the server on success so we never render optimistic-but-wrong data.
 */
function ProgramPicker({
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
 * Row for retail sale status.  RETAIL programs can be marked SOLD here.
 * Non-retail cards render an em-dash because the column doesn't apply.
 */
function RetailSaleRow({
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
        <StatusChip label="SOLD" tone="success" />
        {card.retailSoldAt && (
          <div className="small" style={{ marginTop: 2 }}>{formatDate(card.retailSoldAt)}</div>
        )}
      </div>
    );
  }

  return (
    <div>
      <StatusChip label={card.retailSaleStatus ?? 'SHIPPED'} tone="warn" />
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

function ActivationSummary({ card }: { card: Card }) {
  if (card.status === 'ACTIVATED') {
    const consumed = card.activationSessions.find((a) => a.consumedAt);
    return (
      <span className="small">
        ✓ activated{consumed?.consumedDeviceLabel ? ` on ${consumed.consumedDeviceLabel}` : ''}
      </span>
    );
  }
  const latest = card.activationSessions[0];
  if (!latest) return <span className="small">awaiting first tap</span>;
  if (latest.consumedAt) return <span className="small">tap done — credential pending</span>;
  return <span className="small">tap pending</span>;
}
