import { useState } from 'react';
import { api, errorMsg } from '../../utils/api';
import { slugify } from '../programs/types';
import { PartnerCredentialsSection } from './PartnerCredentials';
import { SftpAccessSection } from './SftpAccess';
import type { FinancialInstitution } from './types';

export function FinancialInstitutionForm({
  fi,
  onSaved,
  onCancel,
}: {
  fi: FinancialInstitution | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(fi?.name ?? '');
  const [slug, setSlug] = useState(fi?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(Boolean(fi));
  const [bin, setBin] = useState(fi?.bin ?? '');
  const [contactEmail, setContactEmail] = useState(fi?.contactEmail ?? '');
  const [contactName, setContactName] = useState(fi?.contactName ?? '');
  const [status, setStatus] = useState<'ACTIVE' | 'SUSPENDED'>(fi?.status ?? 'ACTIVE');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onNameChange = (v: string) => {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  };

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      if (fi) {
        const body: Record<string, unknown> = {
          name,
          slug,
          status,
        };
        if (bin.trim()) body.bin = bin.trim();
        if (contactEmail.trim()) body.contactEmail = contactEmail.trim();
        if (contactName.trim()) body.contactName = contactName.trim();
        await api.patch<FinancialInstitution>(`/admin/financial-institutions/${fi.id}`, body);
      } else {
        const body: Record<string, unknown> = { name, slug };
        if (bin.trim()) body.bin = bin.trim();
        if (contactEmail.trim()) body.contactEmail = contactEmail.trim();
        if (contactName.trim()) body.contactName = contactName.trim();
        await api.post<FinancialInstitution>('/admin/financial-institutions', body);
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
        <h2 style={{ margin: 0 }}>{fi ? `Edit ${fi.name}` : 'New Financial Institution'}</h2>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>

      <label>Name</label>
      <input value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="InComm" />

      <label>Slug</label>
      <input
        value={slug}
        onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }}
        className="mono"
        placeholder="incomm"
      />
      <p className="small">Lowercase letters, digits, and hyphens only.  Auto-suggested from name.</p>

      <label>BIN (optional)</label>
      <input
        value={bin}
        onChange={(e) => setBin(e.target.value)}
        className="mono"
        placeholder="491234"
        maxLength={8}
      />

      <label>Contact email (optional)</label>
      <input
        type="email"
        value={contactEmail}
        onChange={(e) => setContactEmail(e.target.value)}
        placeholder="ops@incomm.com"
      />

      <label>Contact name (optional)</label>
      <input
        value={contactName}
        onChange={(e) => setContactName(e.target.value)}
        placeholder="Jane Doe"
      />

      {fi && (
        <>
          <label>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value as 'ACTIVE' | 'SUSPENDED')}>
            <option value="ACTIVE">ACTIVE</option>
            <option value="SUSPENDED">SUSPENDED</option>
          </select>
        </>
      )}

      <div style={{ marginTop: 16 }}>
        <button
          className="btn primary"
          onClick={save}
          disabled={busy || !name || !slug}
        >
          {busy ? 'Saving…' : fi ? 'Save changes' : 'Create FI'}
        </button>
      </div>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}

      {fi && <PartnerCredentialsSection fiId={fi.id} />}
      {fi && <SftpAccessSection fiSlug={fi.slug} />}
    </div>
  );
}
