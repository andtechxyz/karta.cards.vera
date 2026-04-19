import { useCallback, useEffect, useState } from 'react';
import { api, errorMsg } from '../../utils/api';
import { formatDate } from '../../utils/format';
import { Table, type Column } from '../../components/Table';
import { IssuerProfileDetail } from './Detail';
import type { IssuerProfile } from './types';
import type { Program } from '../programs/types';
import type { ChipProfile } from '../chip-profiles/types';

// IssuerProfile list view.  Hits /api/issuer-profiles (masked ARNs) for
// the table, then re-fetches the full /:id record when the user opens
// the detail form so ARN-paste starts from a known value.  Lookups for
// Program + ChipProfile populate dropdowns on the detail form.

type Editing = IssuerProfile | 'new' | null;

export function IssuerProfilesPage() {
  const [profiles, setProfiles] = useState<IssuerProfile[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [chipProfiles, setChipProfiles] = useState<ChipProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [ip, pg, cp] = await Promise.all([
        api.get<IssuerProfile[]>('/issuer-profiles'),
        api.get<Program[]>('/programs'),
        api.get<ChipProfile[]>('/chip-profiles'),
      ]);
      setProfiles(ip);
      setPrograms(pg);
      setChipProfiles(cp);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openForEdit = async (row: IssuerProfile) => {
    // List returns masked ARNs — fetch the full detail record so the
    // edit form starts from the actual value.
    try {
      const full = await api.get<IssuerProfile>(`/issuer-profiles/${row.id}`);
      setEditing(full);
    } catch (e) {
      setErr(errorMsg(e));
    }
  };

  if (editing !== null) {
    return (
      <IssuerProfileDetail
        profile={editing}
        programs={programs}
        chipProfiles={chipProfiles}
        onSaved={async () => {
          setEditing(null);
          await load();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  // "has keys" badge — true iff every cryptographic ARN column on the
  // record is non-empty.  Masked entries still pass this check because
  // they show up as `***xxxx` (non-empty).
  const hasKeys = (p: IssuerProfile) =>
    Boolean(p.tmkKeyArn && p.imkAcKeyArn && p.imkSmiKeyArn && p.imkSmcKeyArn && p.issuerPkKeyArn);

  const columns: Column<IssuerProfile>[] = [
    {
      key: 'program',
      header: 'Program',
      width: '18%',
      render: (p) => p.program?.name ?? p.programId,
      sort: (p) => p.program?.name ?? p.programId,
    },
    {
      key: 'scheme',
      header: 'Scheme',
      width: '14%',
      mono: true,
      render: (p) => p.scheme,
    },
    { key: 'cvn', header: 'CVN', width: '6%', mono: true, align: 'right', render: (p) => p.cvn },
    {
      key: 'chip',
      header: 'Chip Profile',
      width: '20%',
      render: (p) => p.chipProfile?.name ?? <span className="small">—</span>,
    },
    {
      key: 'keys',
      header: 'Keys',
      width: '10%',
      render: (p) => (
        <span className={`tag ${hasKeys(p) ? 'ok' : 'warn'}`}>
          {hasKeys(p) ? 'set' : 'stub'}
        </span>
      ),
    },
    {
      key: 'tmk',
      header: 'TMK',
      width: '10%',
      mono: true,
      render: (p) => <span className="small">{p.tmkKeyArn || '—'}</span>,
    },
    {
      key: 'created',
      header: 'Created',
      width: '14%',
      render: (p) => <span className="small">{formatDate(p.createdAt)}</span>,
      sort: (p) => p.createdAt,
    },
    {
      key: 'actions',
      header: '',
      width: '8%',
      render: (p) => (
        <button
          className="btn ghost"
          onClick={(e) => { e.stopPropagation(); openForEdit(p); }}
        >
          Edit
        </button>
      ),
    },
  ];

  const canCreate = programs.length > 0 && chipProfiles.length > 0;

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Issuer Profiles</h2>
        <button
          className="btn primary"
          onClick={() => setEditing('new')}
          disabled={!canCreate}
          title={
            canCreate
              ? 'New issuer profile'
              : 'Create a Program and a Chip Profile first'
          }
        >
          New issuer profile
        </button>
      </div>
      <p className="small" style={{ marginTop: 8 }}>
        Per-program EMV application config + AWS Payment Cryptography key
        ARNs.  The list shows ARNs masked to last-4; open a row to see the
        full values.
      </p>
      {err && <p className="tag err" style={{ marginTop: 8 }}>{err}</p>}
      {loading ? (
        <p className="small">Loading…</p>
      ) : (
        <Table
          columns={columns}
          rows={profiles}
          rowKey={(p) => p.id}
          searchPlaceholder="Search by program, scheme, or chip profile…"
          searchMatch={(p, q) =>
            (p.program?.name.toLowerCase().includes(q) ?? false) ||
            p.scheme.toLowerCase().includes(q) ||
            (p.chipProfile?.name.toLowerCase().includes(q) ?? false) ||
            p.cvn.toString().includes(q)
          }
          empty={
            <p className="small">
              No issuer profiles yet.  Create one to onboard a new FI — this
              replaces the hand-written SQL insert.
            </p>
          }
        />
      )}
    </div>
  );
}
