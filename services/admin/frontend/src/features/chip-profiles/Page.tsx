import React, { useCallback, useEffect, useState } from 'react';
import { api, errorMsg } from '../../utils/api';
import { formatDate } from '../../utils/format';
import { Table, type Column } from '../../components/Table';
import { ChipProfileDetail } from './Detail';
import type { ChipProfile } from './types';
import type { Program } from '../programs/types';

// ChipProfile list + upload view.  Reads from /api/chip-profiles (the
// new full CRUD router).  Keeping the JSON upload behaviour from the
// previous version — it's a useful shortcut for shipping a profile
// from a scheme's reference fixtures.  Program filter remains.

type Editing = ChipProfile | 'new' | null;

export function ChipProfilesPage() {
  const [profiles, setProfiles] = useState<ChipProfile[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [filterProgramId, setFilterProgramId] = useState<string>('');
  const [uploadProgramId, setUploadProgramId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const qs = filterProgramId ? `?programId=${encodeURIComponent(filterProgramId)}` : '';
      const [cp, pg] = await Promise.all([
        api.get<ChipProfile[]>(`/chip-profiles${qs}`),
        api.get<Program[]>('/programs'),
      ]);
      setProfiles(cp);
      setPrograms(pg);
    } catch (e) {
      setErr(errorMsg(e));
    } finally {
      setLoading(false);
    }
  }, [filterProgramId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      // Canonical field rename — fromJson uses snake_case, our API
      // takes camelCase + the dgiDefinitions blob as-is.
      const body: Record<string, unknown> = {
        name: parsed.profile_name ?? parsed.name ?? file.name.replace(/\.json$/, ''),
        scheme: parsed.scheme ?? 'mchip_advance',
        vendor: parsed.applet_vendor ?? parsed.vendor ?? 'unknown',
        cvn: parsed.cvn ?? 18,
        dgiDefinitions: parsed.dgi_definitions ?? parsed.dgiDefinitions ?? [],
      };
      if (parsed.elf_aid || parsed.elfAid) body.elfAid = parsed.elf_aid ?? parsed.elfAid;
      if (parsed.module_aid || parsed.moduleAid) body.moduleAid = parsed.module_aid ?? parsed.moduleAid;
      if (parsed.pa_aid || parsed.paAid) body.paAid = parsed.pa_aid ?? parsed.paAid;
      if (parsed.fido_aid || parsed.fidoAid) body.fidoAid = parsed.fido_aid ?? parsed.fidoAid;
      if (parsed.icc_private_key_dgi != null) body.iccPrivateKeyDgi = parsed.icc_private_key_dgi;
      if (parsed.icc_private_key_tag != null) body.iccPrivateKeyTag = parsed.icc_private_key_tag;
      if (parsed.mk_ac_dgi != null) body.mkAcDgi = parsed.mk_ac_dgi;
      if (parsed.mk_smi_dgi != null) body.mkSmiDgi = parsed.mk_smi_dgi;
      if (parsed.mk_smc_dgi != null) body.mkSmcDgi = parsed.mk_smc_dgi;
      if (uploadProgramId) body.programId = uploadProgramId;
      await api.post('/chip-profiles', body);
      setOk(
        `Uploaded chip profile from ${file.name}` +
          (uploadProgramId ? ` (scoped to program)` : ` (global)`),
      );
      await load();
    } catch (e2) {
      setErr(errorMsg(e2));
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  if (editing !== null) {
    return (
      <ChipProfileDetail
        profile={editing}
        onSaved={async () => {
          setEditing(null);
          await load();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const columns: Column<ChipProfile>[] = [
    { key: 'name', header: 'Name', width: '22%', render: (p) => p.name, sort: (p) => p.name },
    {
      key: 'program',
      header: 'Program',
      width: '16%',
      render: (p) => (p.program ? p.program.name : <span className="small">Global</span>),
    },
    { key: 'scheme', header: 'Scheme', width: '14%', mono: true, render: (p) => p.scheme },
    { key: 'vendor', header: 'Vendor', width: '10%', render: (p) => p.vendor },
    { key: 'cvn', header: 'CVN', width: '6%', mono: true, align: 'right', render: (p) => p.cvn },
    {
      key: 'dgi',
      header: 'DGI count',
      width: '8%',
      mono: true,
      align: 'right',
      render: (p) => (Array.isArray(p.dgiDefinitions) ? p.dgiDefinitions.length : '—'),
    },
    {
      key: 'created',
      header: 'Created',
      width: '12%',
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
          onClick={(e) => { e.stopPropagation(); setEditing(p); }}
        >
          Edit
        </button>
      ),
    },
  ];

  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Chip Profiles</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            Upload scope:
            <select
              value={uploadProgramId}
              onChange={(e) => setUploadProgramId(e.target.value)}
              disabled={busy}
              style={{ width: 200 }}
            >
              <option value="">Global (all programs)</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="btn ghost" style={{ cursor: 'pointer' }}>
            {busy ? 'Uploading…' : 'Quick upload'}
            <input
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={handleUpload}
              disabled={busy}
            />
          </label>
          <button className="btn primary" onClick={() => setEditing('new')}>
            New profile
          </button>
        </div>
      </div>
      {ok && <p className="tag ok" style={{ marginTop: 12 }}>{ok}</p>}
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
      {loading ? (
        <p className="small">Loading…</p>
      ) : (
        <Table
          columns={columns}
          rows={profiles}
          rowKey={(p) => p.id}
          searchPlaceholder="Search profile name, scheme, or vendor…"
          searchMatch={(p, q) =>
            p.name.toLowerCase().includes(q) ||
            p.scheme.toLowerCase().includes(q) ||
            p.vendor.toLowerCase().includes(q) ||
            (p.program?.name.toLowerCase().includes(q) ?? false)
          }
          toolbarExtra={
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              Filter:
              <select
                value={filterProgramId}
                onChange={(e) => setFilterProgramId(e.target.value)}
                style={{ width: 240 }}
              >
                <option value="">All profiles (admin view)</option>
                {programs.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} (scoped + global)</option>
                ))}
              </select>
            </label>
          }
          empty={<p className="small">No chip profiles yet. Upload a JSON profile or click New to get started.</p>}
        />
      )}
    </div>
  );
}
