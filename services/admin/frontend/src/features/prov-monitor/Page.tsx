import { useCallback, useEffect, useState } from 'react';
import { api as allApi, errorMsg } from '../../utils/api';
const api = allApi.palisade;
import { formatDate } from '../../utils/format';
import { Table, type Column } from '../../components/Table';
import { StatusChip, statusToneFor, type Tone } from '../../components/StatusChip';

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

function sessionPhaseTone(phase: string): Tone {
  if (phase === 'COMPLETE') return 'success';
  if (phase === 'FAILED') return 'danger';
  if (phase === 'DATA_PREP' || phase === 'PERSO' || phase === 'PENDING') return 'warn';
  return 'neutral';
}

export function ProvMonitorPage() {
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

  const columns: Column<ProvSession>[] = [
    {
      key: 'id',
      header: 'Session ID',
      width: '22%',
      mono: true,
      copyable: (s) => s.id,
      render: (s) => <span className="small">{s.id.slice(0, 12)}...</span>,
    },
    { key: 'card', header: 'Card', width: '20%', mono: true, copyable: (s) => s.card?.cardRef ?? null, render: (s) => s.card?.cardRef ?? '—' },
    { key: 'phase', header: 'Phase', width: '14%', render: (s) => <StatusChip label={s.phase} tone={sessionPhaseTone(s.phase)} /> },
    { key: 'proxy', header: 'Proxy Card ID', width: '18%', mono: true, copyable: (s) => s.sadRecord?.proxyCardId ?? null, render: (s) => <span className="small">{s.sadRecord?.proxyCardId ?? '—'}</span> },
    {
      key: 'sad',
      header: 'SAD Status',
      width: '12%',
      render: (s) => s.sadRecord ? <StatusChip label={s.sadRecord.status} tone={statusToneFor(s.sadRecord.status)} /> : <span className="small">—</span>,
    },
    { key: 'created', header: 'Created', width: '14%', render: (s) => <span className="small">{formatDate(s.createdAt)}</span>, sort: (s) => s.createdAt },
  ];

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
          <StatCard label="Active Sessions" value={stats.activeSessions} />
          <StatCard label="Provisioned (24h)" value={stats.provisioned24h} />
          <StatCard label="Total Provisioned" value={stats.totalProvisioned} />
          <StatCard label="Failed (24h)" value={stats.failedSessions24h} danger={stats.failedSessions24h > 0} />
        </div>
      )}
      <Table
        columns={columns}
        rows={sessions}
        rowKey={(s) => s.id}
        searchPlaceholder="Search session id, card, or proxy id…"
        searchMatch={(s, q) =>
          s.id.toLowerCase().includes(q) ||
          (s.card?.cardRef.toLowerCase().includes(q) ?? false) ||
          (s.sadRecord?.proxyCardId.toLowerCase().includes(q) ?? false)
        }
        empty={<p className="small" style={{ marginTop: 12 }}>No provisioning sessions yet.</p>}
      />
    </div>
  );
}

function StatCard({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div style={{ padding: 16, border: '1px solid var(--edge)', borderRadius: 8, textAlign: 'center' }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: danger ? 'var(--tone-danger-fg)' : undefined }}>
        {value}
      </div>
      <div className="small">{label}</div>
    </div>
  );
}
