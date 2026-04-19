import { useCallback, useEffect, useState } from 'react';
import { api as allApi, errorMsg } from '../../utils/api';
const api = allApi.vera;
import { Table, type Column } from '../../components/Table';
import { RuleEditor } from '../programs/RuleEditor';
import {
  NEW_PROGRAM_DEFAULT_RULES,
  cloneRules,
  type TierRule,
} from '../programs/types';

// Vera-side tier-rule editor (Phase 4c/4d).  Backed by
// POST/GET/PATCH /api/admin/tokenisation-programs on the Vera admin.  The
// `id` convention matches Palisade's Program.id so a card with
// `programId='prog_mc_plat_01'` finds its rules without a cross-repo join.

interface TokenisationProgram {
  id: string;
  name: string;
  currency: string;
  tierRules: TierRule[];
  createdAt: string;
  updatedAt: string;
}

export function TokenisationProgramsPage() {
  const [rows, setRows] = useState<TokenisationProgram[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<TokenisationProgram | 'new' | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.get<TokenisationProgram[]>('/admin/tokenisation-programs');
      setRows(r);
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
      <TokenisationProgramForm
        program={editing === 'new' ? null : editing}
        onSaved={async () => {
          setEditing(null);
          await load();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const columns: Column<TokenisationProgram>[] = [
    {
      key: 'id',
      header: 'ID',
      width: '32%',
      mono: true,
      copyable: (p) => p.id,
      render: (p) => p.id,
      sort: (p) => p.id,
    },
    { key: 'name', header: 'Name', width: '32%', render: (p) => p.name, sort: (p) => p.name },
    { key: 'currency', header: 'Currency', width: '12%', mono: true, render: (p) => p.currency },
    { key: 'rules', header: 'Rules', width: '10%', align: 'right', render: (p) => p.tierRules.length },
    {
      key: 'actions',
      header: '',
      width: '14%',
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
        <h2 style={{ margin: 0 }}>Tokenisation Programs</h2>
        <button className="btn primary" onClick={() => setEditing('new')}>
          New program
        </button>
      </div>
      <p className="small" style={{ marginTop: 8 }}>
        Per-program tier rules and currency.  Pay reads this at transaction
        time via <span className="mono">card.programId</span>; missing entry
        falls back to the built-in default (AUD, biometric under 100.00 /
        card tap above).
      </p>
      {err && <p className="tag err" style={{ marginTop: 8 }}>{err}</p>}
      {loading ? (
        <p className="small">Loading…</p>
      ) : (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          searchPlaceholder="Search id, name, or currency…"
          searchMatch={(p, q) =>
            p.id.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q) ||
            p.currency.toLowerCase().includes(q)
          }
          empty={
            <p className="small">
              No tokenisation programs yet. Create one to override the
              built-in default rule set.
            </p>
          }
        />
      )}
    </div>
  );
}

function TokenisationProgramForm({
  program,
  onSaved,
  onCancel,
}: {
  program: TokenisationProgram | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(program?.id ?? '');
  const [name, setName] = useState(program?.name ?? '');
  const [currency, setCurrency] = useState(program?.currency ?? 'AUD');
  const [rules, setRules] = useState<TierRule[]>(() =>
    cloneRules(program?.tierRules ?? NEW_PROGRAM_DEFAULT_RULES),
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const body = { name, currency, tierRules: rules };
      if (program) {
        await api.patch(`/admin/tokenisation-programs/${program.id}`, body);
      } else {
        await api.post('/admin/tokenisation-programs', { id, ...body });
      }
      onSaved();
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>
          {program ? `Edit ${program.id}` : 'New tokenisation program'}
        </h2>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>

      {!program && (
        <>
          <label>Program ID</label>
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="prog_mc_plat_01"
            className="mono"
          />
          <p className="small">
            Must match Palisade's Program.id for the same product.  Alphanumeric
            + <code>_</code> <code>-</code> only; immutable after create.
          </p>
        </>
      )}

      <label>Name</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Mastercard Platinum — tokenisation"
      />

      <label>Currency (ISO 4217)</label>
      <input
        value={currency}
        onChange={(e) => setCurrency(e.target.value.toUpperCase())}
        className="mono"
        maxLength={3}
        style={{ width: 80 }}
      />

      <h3 style={{ marginTop: 20 }}>Tier rules</h3>
      <p className="small">
        Rules must be contiguous (no gaps), start at 0, and end with an
        unbounded last rule (max = blank). Amounts are in minor units — AUD
        100.00 = 10000.
      </p>
      <RuleEditor rules={rules} onChange={setRules} />

      <div style={{ marginTop: 16 }}>
        <button
          className="btn primary"
          onClick={save}
          disabled={busy || (!program && !id) || !name || !currency}
        >
          {busy ? 'Saving…' : program ? 'Save changes' : 'Create program'}
        </button>
      </div>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
    </div>
  );
}
