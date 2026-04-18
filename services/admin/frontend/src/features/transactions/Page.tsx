import { useCallback, useEffect, useState } from 'react';
import { api, errorMsg } from '../../utils/api';
import { formatDate, formatMoney } from '../../utils/format';
import { Table, type Column } from '../../components/Table';
import { StatusChip, statusToneFor } from '../../components/StatusChip';

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

export function TransactionsPage() {
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

  const columns: Column<TxnRow>[] = [
    { key: 'rlid', header: 'RLID', width: '14%', mono: true, copyable: (t) => t.rlid, render: (t) => t.rlid },
    { key: 'amount', header: 'Amount', width: '12%', mono: true, align: 'right', render: (t) => formatMoney(t.amount, t.currency), sort: (t) => t.amount },
    { key: 'status', header: 'Status', width: '12%', render: (t) => <StatusChip label={t.status} tone={statusToneFor(t.status)} /> },
    { key: 'tier', header: 'Tier', width: '12%', render: (t) => `${t.tier}${t.actualTier && t.actualTier !== t.tier ? ` → ${t.actualTier}` : ''}` },
    {
      key: 'card',
      header: 'Card',
      width: '14%',
      mono: true,
      copyable: (t) => t.card.vaultEntry?.panLast4 ?? t.card.cardRef,
      render: (t) => t.card.vaultEntry ? <>•••• {t.card.vaultEntry.panLast4}</> : t.card.cardRef,
    },
    {
      key: 'provider',
      header: 'Provider',
      width: '18%',
      render: (t) => (
        <>
          {t.providerName ?? <span className="small">—</span>}
          {t.providerTxnId && <div className="mono small" title={t.providerTxnId}>{t.providerTxnId.slice(0, 18)}…</div>}
        </>
      ),
    },
    { key: 'created', header: 'Created', width: '18%', render: (t) => <span className="small">{formatDate(t.createdAt)}</span>, sort: (t) => t.createdAt },
  ];

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Transactions</h2>
        <button className="btn ghost" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
      <Table
        columns={columns}
        rows={rows}
        rowKey={(t) => t.id}
        searchPlaceholder="Search RLID, card, or provider…"
        searchMatch={(t, q) =>
          t.rlid.toLowerCase().includes(q) ||
          t.card.cardRef.toLowerCase().includes(q) ||
          (t.card.vaultEntry?.panLast4.includes(q) ?? false) ||
          (t.providerName?.toLowerCase().includes(q) ?? false) ||
          t.merchantName.toLowerCase().includes(q)
        }
        empty={<p className="small">No transactions yet.</p>}
      />
    </div>
  );
}
