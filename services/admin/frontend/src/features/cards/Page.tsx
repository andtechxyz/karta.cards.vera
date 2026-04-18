import { useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { formatDate } from '../../utils/format';
import { Table, type Column } from '../../components/Table';
import { StatusChip, statusToneFor } from '../../components/StatusChip';
import { useCards } from '../../hooks/useCards';
import { CardDrawer } from './CardDrawer';
import type { Card } from './types';
import type { Program } from '../programs/types';

export function CardsPage() {
  const { cards, loading, reload } = useCards();
  const [programs, setPrograms] = useState<Program[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');

  useEffect(() => {
    api.get<Program[]>('/programs').then(setPrograms).catch(() => setPrograms([]));
  }, []);

  const filtered = useMemo(() => {
    if (!statusFilter) return cards;
    return cards.filter((c) => c.status === statusFilter);
  }, [cards, statusFilter]);

  const selected = cards.find((c) => c.id === selectedId) ?? null;

  const columns: Column<Card>[] = [
    {
      key: 'cardRef',
      header: 'Card ref',
      width: '28%',
      mono: true,
      copyable: (r) => r.cardRef,
      render: (r) => r.cardRef,
      sort: (r) => r.cardRef,
    },
    {
      key: 'status',
      header: 'Status',
      width: '14%',
      render: (r) => <StatusChip label={r.status} tone={statusToneFor(r.status)} />,
      sort: (r) => r.status,
    },
    {
      key: 'retailSale',
      header: 'Retail sale',
      width: '13%',
      render: (r) => {
        if (r.program?.programType !== 'RETAIL') return <span className="small">—</span>;
        const label = r.retailSaleStatus ?? 'SHIPPED';
        const tone = label === 'SOLD' ? 'success' : 'warn';
        return <StatusChip label={label} tone={tone} />;
      },
    },
    {
      key: 'vault',
      header: 'Vault',
      width: '11%',
      mono: true,
      render: (r) =>
        r.vaultEntry ? <>•••• {r.vaultEntry.panLast4}</> : <span className="small">—</span>,
    },
    {
      key: 'program',
      header: 'Program',
      width: '16%',
      render: (r) =>
        r.program ? (
          <span title={`${r.program.name} (${r.program.currency})`}>{r.program.name}</span>
        ) : (
          <span className="small">(default rules)</span>
        ),
      sort: (r) => r.program?.name ?? '',
    },
    {
      key: 'creds',
      header: 'Creds',
      width: '8%',
      align: 'center',
      render: (r) => (r.credentials.length === 0 ? '—' : r.credentials.length),
    },
    {
      key: 'created',
      header: 'Created',
      width: '10%',
      render: (r) => <span className="small">{formatDate(r.createdAt)}</span>,
      sort: (r) => r.createdAt,
    },
  ];

  const statusOptions = ['BLANK', 'PERSONALISED', 'ACTIVATED', 'PROVISIONED', 'SUSPENDED', 'REVOKED'];

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Cards</h2>
      <p className="small" style={{ marginTop: 8 }}>
        Cards are registered by Palisade's provisioning-agent (POST /api/cards/register)
        and activated by the cardholder tapping the physical card. Click a row to see
        credentials, reassign program, or mark-sold retail cards.
      </p>
      {loading ? (
        <p className="small">Loading…</p>
      ) : (
        <Table
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          onRowClick={(r) => setSelectedId(r.id)}
          activeRowKey={selectedId}
          searchPlaceholder="Search card ref or PAN last 4…"
          searchMatch={(r, q) =>
            r.cardRef.toLowerCase().includes(q) ||
            (r.vaultEntry?.panLast4.includes(q) ?? false) ||
            (r.program?.name.toLowerCase().includes(q) ?? false)
          }
          toolbarExtra={
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              Status:
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                style={{ width: 160 }}
              >
                <option value="">All</option>
                {statusOptions.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
          }
          empty={
            <p className="small">
              No cards registered yet. POST a Palisade data-prep package to /api/cards/register.
            </p>
          }
        />
      )}
      <CardDrawer
        card={selected}
        programs={programs}
        onClose={() => setSelectedId(null)}
        onChanged={reload}
      />
    </div>
  );
}
