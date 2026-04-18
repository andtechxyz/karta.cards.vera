import { useCallback, useEffect, useState } from 'react';
import { api, errorMsg } from '../../utils/api';
import { formatDate } from '../../utils/format';
import { Table, type Column } from '../../components/Table';
import { StatusChip, statusToneFor } from '../../components/StatusChip';

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

export function AuditPage() {
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

  const columns: Column<AuditRow>[] = [
    { key: 'event', header: 'Event', width: '20%', render: (r) => <span className="tag">{r.eventType}</span> },
    { key: 'result', header: 'Result', width: '10%', render: (r) => <StatusChip label={r.result} tone={statusToneFor(r.result)} /> },
    { key: 'actor', header: 'Actor', width: '14%', mono: true, copyable: (r) => r.actor, render: (r) => <span className="small">{r.actor}</span> },
    { key: 'card', header: 'Card', width: '12%', mono: true, render: (r) => r.vaultEntry ? <>•••• {r.vaultEntry.panLast4}</> : <span className="small">—</span> },
    {
      key: 'purpose',
      header: 'Purpose',
      width: '26%',
      render: (r) => (
        <span className="small">
          {r.purpose}
          {r.errorMessage && <div className="tag err" style={{ marginTop: 4 }}>{r.errorMessage}</div>}
        </span>
      ),
    },
    { key: 'when', header: 'When', width: '18%', render: (r) => <span className="small">{formatDate(r.createdAt)}</span>, sort: (r) => r.createdAt },
  ];

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
      <Table
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        searchPlaceholder="Search event, actor, or purpose…"
        searchMatch={(r, q) =>
          r.eventType.toLowerCase().includes(q) ||
          r.actor.toLowerCase().includes(q) ||
          r.purpose.toLowerCase().includes(q) ||
          (r.errorMessage?.toLowerCase().includes(q) ?? false)
        }
        empty={<p className="small">No audit events yet.</p>}
      />
    </div>
  );
}
