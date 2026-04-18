import { useCallback, useEffect, useState } from 'react';
import { api, errorMsg } from '../../utils/api';
import { Table, type Column } from '../../components/Table';
import { ProgramForm } from './Form';
import type { Program } from './types';
import { programTypeLabel } from './types';
import type { FinancialInstitution } from '../financial-institutions/types';

export function ProgramsPage() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [fis, setFis] = useState<FinancialInstitution[]>([]);
  const [filterFiId, setFilterFiId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Program | 'new' | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const qs = filterFiId ? `?financialInstitutionId=${encodeURIComponent(filterFiId)}` : '';
      const [pr, fiList] = await Promise.all([
        api.get<Program[]>(`/programs${qs}`),
        api.get<FinancialInstitution[]>('/admin/financial-institutions'),
      ]);
      setPrograms(pr);
      setFis(fiList);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, [filterFiId]);

  useEffect(() => {
    load();
  }, [load]);

  if (editing !== null) {
    return (
      <ProgramForm
        program={editing === 'new' ? null : editing}
        fis={fis}
        onSaved={async () => {
          setEditing(null);
          await load();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const columns: Column<Program>[] = [
    { key: 'id', header: 'ID', width: '16%', mono: true, copyable: (p) => p.id, render: (p) => p.id, sort: (p) => p.id },
    { key: 'fi', header: 'Institution', width: '14%', render: (p) => p.financialInstitution?.name ?? <span className="small">—</span>, sort: (p) => p.financialInstitution?.name ?? '' },
    { key: 'name', header: 'Name', width: '14%', render: (p) => p.name, sort: (p) => p.name },
    { key: 'type', header: 'Type', width: '12%', render: (p) => <span className="small">{programTypeLabel(p.programType)}</span> },
    { key: 'currency', header: 'Currency', width: '8%', mono: true, render: (p) => p.currency },
    { key: 'rules', header: 'Rules', width: '7%', align: 'right', render: (p) => p.tierRules.length },
    {
      key: 'ndef',
      header: 'NDEF',
      width: '10%',
      render: (p) => (
        <span className="small">
          {p.preActivationNdefUrlTemplate ? 'pre ✓' : 'pre —'}
          {' / '}
          {p.postActivationNdefUrlTemplate ? 'post ✓' : 'post —'}
        </span>
      ),
    },
    { key: 'embossing', header: 'Embossing', width: '10%', render: (p) => p.embossingTemplate?.name ? <span className="small">{p.embossingTemplate.name}</span> : <span className="small">—</span> },
    {
      key: 'actions',
      header: '',
      width: '9%',
      render: (p) => (
        <button
          className="btn ghost"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(p);
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
        <h2 style={{ margin: 0 }}>Programs</h2>
        <button
          className="btn primary"
          onClick={() => setEditing('new')}
          disabled={fis.length === 0}
          title={fis.length === 0 ? 'Create a Financial Institution first' : 'New program'}
        >
          New program
        </button>
      </div>
      <p className="small" style={{ marginTop: 8 }}>
        Card products: currency, tier rules, and NDEF URL templates.  Palisade
        reads the templates at perso time (pre-activation URL baked into the
        card) and after Vera confirms activation (post-activation URL written
        via authenticated APDU).
      </p>
      {err && <p className="tag err" style={{ marginTop: 8 }}>{err}</p>}
      {loading ? (
        <p className="small">Loading…</p>
      ) : (
        <Table
          columns={columns}
          rows={programs}
          rowKey={(p) => p.id}
          searchPlaceholder="Search program id or name…"
          searchMatch={(p, q) =>
            p.id.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q) ||
            p.currency.toLowerCase().includes(q) ||
            (p.financialInstitution?.name.toLowerCase().includes(q) ?? false)
          }
          toolbarExtra={
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              Institution:
              <select
                value={filterFiId}
                onChange={(e) => setFilterFiId(e.target.value)}
                style={{ width: 200 }}
              >
                <option value="">All institutions</option>
                {fis.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </label>
          }
          empty={
            <p className="small">
              No programs yet. Create one to override Vera's built-in default
              (AUD, biometric under AUD 100 / card tap at or above).
            </p>
          }
        />
      )}
    </div>
  );
}
