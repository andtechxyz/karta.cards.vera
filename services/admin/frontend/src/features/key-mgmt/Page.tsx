import { useCallback, useEffect, useState } from 'react';
import { api as allApi, errorMsg } from '../../utils/api';
const api = allApi.palisade;
import { formatDate } from '../../utils/format';
import { Table, type Column } from '../../components/Table';
import { IssuerProfileForm } from './Form';
import type { Program } from '../programs/types';
import type { ChipProfile } from '../chip-profiles/types';

export interface IssuerProfile {
  id: string;
  programId: string;
  chipProfileId: string;
  scheme: string;
  cvn: number;
  imkAlgorithm: string | null;
  derivationMethod: string | null;
  tmkKeyArn: string | null;
  imkAcKeyArn: string | null;
  imkSmiKeyArn: string | null;
  imkSmcKeyArn: string | null;
  imkIdnKeyArn: string | null;
  issuerPkKeyArn: string | null;
  aid: string | null;
  appLabel: string | null;
  createdAt: string;
  program: { id: string; name: string } | null;
  chipProfile: { id: string; name: string } | null;
}

export function KeyMgmtPage() {
  const [profiles, setProfiles] = useState<IssuerProfile[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [chipProfiles, setChipProfiles] = useState<ChipProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [ip, pg, cp] = await Promise.all([
        api.get<IssuerProfile[]>('/admin/issuer-profiles'),
        api.get<Program[]>('/programs'),
        api.get<ChipProfile[]>('/admin/chip-profiles'),
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

  const truncateArn = (arn: string | null) => {
    if (!arn) return '—';
    return '...' + arn.slice(-8);
  };

  if (showForm) {
    return (
      <IssuerProfileForm
        programs={programs}
        chipProfiles={chipProfiles}
        onSaved={async () => {
          setShowForm(false);
          await load();
        }}
        onCancel={() => setShowForm(false)}
      />
    );
  }

  const arnCol = (key: keyof IssuerProfile, header: string): Column<IssuerProfile> => ({
    key,
    header,
    width: '10%',
    mono: true,
    copyable: (p) => (p[key] as string | null) ?? null,
    render: (p) => <span className="small">{truncateArn(p[key] as string | null)}</span>,
  });

  const columns: Column<IssuerProfile>[] = [
    { key: 'program', header: 'Program', width: '16%', render: (p) => p.program?.name ?? p.programId, sort: (p) => p.program?.name ?? p.programId },
    { key: 'scheme', header: 'Scheme', width: '10%', mono: true, render: (p) => p.scheme },
    { key: 'cvn', header: 'CVN', width: '6%', mono: true, align: 'right', render: (p) => p.cvn },
    arnCol('tmkKeyArn', 'TMK'),
    arnCol('imkAcKeyArn', 'IMK-AC'),
    arnCol('imkSmiKeyArn', 'IMK-SMI'),
    arnCol('imkSmcKeyArn', 'IMK-SMC'),
    arnCol('imkIdnKeyArn', 'IMK-IDN'),
    arnCol('issuerPkKeyArn', 'Issuer PK'),
    { key: 'created', header: 'Created', width: '12%', render: (p) => <span className="small">{formatDate(p.createdAt)}</span>, sort: (p) => p.createdAt },
  ];

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Key Management</h2>
        <button className="btn primary" onClick={() => setShowForm(true)}>
          Create Issuer Profile
        </button>
      </div>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
      {loading ? (
        <p className="small">Loading...</p>
      ) : (
        <Table
          columns={columns}
          rows={profiles}
          rowKey={(p) => p.id}
          searchPlaceholder="Search by program, scheme, or ARN suffix…"
          searchMatch={(p, q) =>
            (p.program?.name.toLowerCase().includes(q) ?? false) ||
            p.scheme.toLowerCase().includes(q) ||
            (p.tmkKeyArn?.toLowerCase().includes(q) ?? false)
          }
          empty={<p className="small">No issuer profiles yet. Create one to link a program to a chip profile with key ARNs.</p>}
        />
      )}
    </div>
  );
}
