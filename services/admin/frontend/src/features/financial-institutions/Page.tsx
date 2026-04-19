import { useCallback, useEffect, useState } from 'react';
import { api as allApi, errorMsg } from '../../utils/api';
const api = allApi.palisade;
import { formatDate } from '../../utils/format';
import { Table, type Column } from '../../components/Table';
import { StatusChip, statusToneFor } from '../../components/StatusChip';
import { FinancialInstitutionForm } from './Form';
import type { FinancialInstitution } from './types';

export function FinancialInstitutionsPage() {
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

  const columns: Column<FinancialInstitution>[] = [
    { key: 'name', header: 'Name', width: '22%', render: (f) => f.name, sort: (f) => f.name },
    { key: 'slug', header: 'Slug', width: '16%', mono: true, copyable: (f) => f.slug, render: (f) => f.slug },
    { key: 'bin', header: 'BIN', width: '10%', mono: true, copyable: (f) => f.bin, render: (f) => f.bin ?? <span className="small">—</span> },
    { key: 'status', header: 'Status', width: '12%', render: (f) => <StatusChip label={f.status} tone={statusToneFor(f.status)} /> },
    { key: 'programs', header: '# Programs', width: '12%', align: 'right', render: (f) => f._count?.programs ?? 0 },
    { key: 'created', header: 'Created', width: '18%', render: (f) => <span className="small">{formatDate(f.createdAt)}</span>, sort: (f) => f.createdAt },
    {
      key: 'actions',
      header: '',
      width: '10%',
      render: (f) => (
        <button
          className="btn ghost"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(f);
          }}
        >
          Edit
        </button>
      ),
    },
  ];

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
      ) : (
        <Table
          columns={columns}
          rows={fis}
          rowKey={(f) => f.id}
          searchPlaceholder="Search FI name, slug, or BIN…"
          searchMatch={(f, q) =>
            f.name.toLowerCase().includes(q) ||
            f.slug.toLowerCase().includes(q) ||
            (f.bin?.toLowerCase().includes(q) ?? false)
          }
          empty={<p className="small">No financial institutions yet. Create one to start grouping programs.</p>}
        />
      )}
    </div>
  );
}
