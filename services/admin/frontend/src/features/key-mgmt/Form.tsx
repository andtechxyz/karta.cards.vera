import { useState } from 'react';
import { api, errorMsg } from '../../utils/api';
import type { Program } from '../programs/types';
import type { ChipProfile } from '../chip-profiles/types';

export function IssuerProfileForm({
  programs,
  chipProfiles,
  onSaved,
  onCancel,
}: {
  programs: Program[];
  chipProfiles: ChipProfile[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [programId, setProgramId] = useState(programs[0]?.id ?? '');
  const [chipProfileId, setChipProfileId] = useState(chipProfiles[0]?.id ?? '');
  const [scheme, setScheme] = useState('mchip_advance');
  const [cvn, setCvn] = useState('18');
  const [imkAlgorithm, setImkAlgorithm] = useState('');
  const [derivationMethod, setDerivationMethod] = useState('');
  const [aid, setAid] = useState('');
  const [appLabel, setAppLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // NOTE: Key ARNs are NOT accepted from this form.  Keys must be imported
  // via the `scripts/import-issuer-keys.ts` CLI tool which uses AWS Payment
  // Cryptography's ImportKey API with TR-31 wrapped key blocks (dual-control
  // key ceremony).  This prevents browser-originated key material / ARNs.
  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api.post('/admin/issuer-profiles', {
        programId,
        chipProfileId,
        scheme,
        cvn: Number(cvn),
        imkAlgorithm: imkAlgorithm || undefined,
        derivationMethod: derivationMethod || undefined,
        aid: aid || undefined,
        appLabel: appLabel || undefined,
      });
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
        <h2 style={{ margin: 0 }}>Create Issuer Profile</h2>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>

      <label>Program</label>
      <select value={programId} onChange={(e) => setProgramId(e.target.value)}>
        {programs.length === 0 && <option value="">No programs available</option>}
        {programs.map((p) => (
          <option key={p.id} value={p.id}>{p.name} ({p.currency})</option>
        ))}
      </select>

      <label>Chip Profile</label>
      <select value={chipProfileId} onChange={(e) => setChipProfileId(e.target.value)}>
        {chipProfiles.length === 0 && <option value="">No chip profiles available</option>}
        {chipProfiles.map((cp) => (
          <option key={cp.id} value={cp.id}>{cp.name} ({cp.scheme})</option>
        ))}
      </select>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label>Scheme</label>
          <select value={scheme} onChange={(e) => setScheme(e.target.value)}>
            <option value="mchip_advance">mchip_advance</option>
            <option value="vsdc">vsdc</option>
          </select>
        </div>
        <div>
          <label>CVN</label>
          <select value={cvn} onChange={(e) => setCvn(e.target.value)}>
            <option value="10">10</option>
            <option value="17">17</option>
            <option value="18">18</option>
            <option value="22">22</option>
          </select>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label>IMK Algorithm</label>
          <input value={imkAlgorithm} onChange={(e) => setImkAlgorithm(e.target.value)} className="mono" placeholder="TDES_CBC" />
        </div>
        <div>
          <label>Derivation Method</label>
          <input value={derivationMethod} onChange={(e) => setDerivationMethod(e.target.value)} className="mono" placeholder="OPTION_A" />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 20, background: 'rgba(245, 158, 11, 0.08)', borderLeft: '3px solid var(--warn)' }}>
        <strong>🔐 Key ARNs are not set from this form.</strong>
        <p className="small" style={{ margin: '6px 0 0 0' }}>
          AWS Payment Cryptography master keys (TMK, IMK-AC, IMK-SMI, IMK-SMC, IMK-IDN,
          Issuer PK) must be imported via the <code>scripts/import-issuer-keys.ts</code> CLI
          tool using TR-31 wrapped key blocks. This ensures a dual-control key ceremony
          with no key material or ARNs originating from the browser. ARNs populate
          automatically once a key ceremony is completed for this profile.
        </p>
      </div>

      <h3 style={{ marginTop: 20 }}>EMV Constants</h3>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label>AID</label>
          <input value={aid} onChange={(e) => setAid(e.target.value)} className="mono" placeholder="A0000000041010" />
        </div>
        <div>
          <label>App Label</label>
          <input value={appLabel} onChange={(e) => setAppLabel(e.target.value)} placeholder="Mastercard" />
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <button
          className="btn primary"
          onClick={save}
          disabled={busy || !programId || !chipProfileId}
        >
          {busy ? 'Creating...' : 'Create Issuer Profile'}
        </button>
      </div>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
    </div>
  );
}
