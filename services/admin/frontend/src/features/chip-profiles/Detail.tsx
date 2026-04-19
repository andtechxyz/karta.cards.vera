import { useState } from 'react';
import { api, errorMsg } from '../../utils/api';
import type { ChipProfile } from './types';
import { SCHEME_OPTIONS } from './types';

// ChipProfile detail editor.  Handles both `new` and `edit`.
//
// DGI definitions are rendered as a pretty-printed JSON textarea so
// operators can tweak the applet layout inline.  Create also accepts
// a .json file upload — same shape as the ChipProfile.fromJson input.
//
// Advanced parsers (Mastercard .profile ZIP, Visa VPA XML) are
// explicitly out of scope for this pass per the brief; anything more
// exotic than JSON should go through the JSON editor or a script.

interface Props {
  profile: ChipProfile | 'new';
  onSaved: () => void;
  onCancel: () => void;
}

type FormState = {
  name: string;
  scheme: string;
  vendor: string;
  cvn: string;
  elfAid: string;
  moduleAid: string;
  paAid: string;
  fidoAid: string;
  iccPrivateKeyDgi: string;
  iccPrivateKeyTag: string;
  mkAcDgi: string;
  mkSmiDgi: string;
  mkSmcDgi: string;
  dgiDefinitionsJson: string; // pretty-printed JSON (we parse on save)
};

const DEFAULT_PA_AID = 'D276000085504100';
const DEFAULT_FIDO_AID = 'A0000006472F0001';

function initial(profile: ChipProfile | 'new'): FormState {
  if (profile === 'new') {
    return {
      name: '',
      scheme: 'mchip_advance',
      vendor: 'nxp',
      cvn: '18',
      elfAid: '',
      moduleAid: '',
      paAid: DEFAULT_PA_AID,
      fidoAid: DEFAULT_FIDO_AID,
      iccPrivateKeyDgi: '32769',
      iccPrivateKeyTag: '40776',
      mkAcDgi: '2048',
      mkSmiDgi: '2049',
      mkSmcDgi: '2050',
      dgiDefinitionsJson: '[]',
    };
  }
  return {
    name: profile.name,
    scheme: profile.scheme,
    vendor: profile.vendor,
    cvn: String(profile.cvn),
    elfAid: profile.elfAid ?? '',
    moduleAid: profile.moduleAid ?? '',
    paAid: profile.paAid,
    fidoAid: profile.fidoAid,
    iccPrivateKeyDgi: String(profile.iccPrivateKeyDgi),
    iccPrivateKeyTag: String(profile.iccPrivateKeyTag),
    mkAcDgi: String(profile.mkAcDgi),
    mkSmiDgi: String(profile.mkSmiDgi),
    mkSmcDgi: String(profile.mkSmcDgi),
    dgiDefinitionsJson: JSON.stringify(profile.dgiDefinitions ?? [], null, 2),
  };
}

export function ChipProfileDetail({ profile, onSaved, onCancel }: Props) {
  const [form, setForm] = useState<FormState>(() => initial(profile));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isNew = profile === 'new';

  const set = (k: keyof FormState, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      setForm((f) => ({
        ...f,
        name: typeof parsed.profile_name === 'string' ? parsed.profile_name : f.name,
        scheme: typeof parsed.scheme === 'string' ? parsed.scheme : f.scheme,
        vendor: typeof parsed.applet_vendor === 'string' ? parsed.applet_vendor : f.vendor,
        cvn: parsed.cvn != null ? String(parsed.cvn) : f.cvn,
        elfAid: typeof parsed.elf_aid === 'string' ? parsed.elf_aid : f.elfAid,
        moduleAid: typeof parsed.module_aid === 'string' ? parsed.module_aid : f.moduleAid,
        paAid: typeof parsed.pa_aid === 'string' ? parsed.pa_aid : f.paAid,
        fidoAid: typeof parsed.fido_aid === 'string' ? parsed.fido_aid : f.fidoAid,
        iccPrivateKeyDgi: parsed.icc_private_key_dgi != null ? String(parsed.icc_private_key_dgi) : f.iccPrivateKeyDgi,
        iccPrivateKeyTag: parsed.icc_private_key_tag != null ? String(parsed.icc_private_key_tag) : f.iccPrivateKeyTag,
        mkAcDgi: parsed.mk_ac_dgi != null ? String(parsed.mk_ac_dgi) : f.mkAcDgi,
        mkSmiDgi: parsed.mk_smi_dgi != null ? String(parsed.mk_smi_dgi) : f.mkSmiDgi,
        mkSmcDgi: parsed.mk_smc_dgi != null ? String(parsed.mk_smc_dgi) : f.mkSmcDgi,
        dgiDefinitionsJson: JSON.stringify(parsed.dgi_definitions ?? [], null, 2),
      }));
    } catch (e2) {
      setErr(`Couldn't read file as JSON: ${errorMsg(e2)}`);
    } finally {
      // allow the same file to be re-selected
      e.target.value = '';
    }
  };

  const save = async () => {
    setErr(null);
    let dgiDefinitions: unknown;
    try {
      dgiDefinitions = JSON.parse(form.dgiDefinitionsJson);
    } catch (e2) {
      setErr(`DGI JSON parse error: ${errorMsg(e2)}`);
      return;
    }
    if (!Array.isArray(dgiDefinitions) || dgiDefinitions.length === 0) {
      setErr('dgi_definitions must be a non-empty array');
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        scheme: form.scheme,
        vendor: form.vendor,
        cvn: Number(form.cvn),
        dgiDefinitions,
        iccPrivateKeyDgi: Number(form.iccPrivateKeyDgi),
        iccPrivateKeyTag: Number(form.iccPrivateKeyTag),
        mkAcDgi: Number(form.mkAcDgi),
        mkSmiDgi: Number(form.mkSmiDgi),
        mkSmcDgi: Number(form.mkSmcDgi),
      };
      if (form.elfAid) body.elfAid = form.elfAid;
      if (form.moduleAid) body.moduleAid = form.moduleAid;
      if (form.paAid) body.paAid = form.paAid;
      if (form.fidoAid) body.fidoAid = form.fidoAid;

      if (isNew) {
        await api.post('/chip-profiles', body);
      } else {
        await api.patch(`/chip-profiles/${(profile as ChipProfile).id}`, body);
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
          {isNew ? 'New Chip Profile' : `Chip Profile ${(profile as ChipProfile).id}`}
        </h2>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>

      {isNew && (
        <div style={{ marginTop: 12 }}>
          <label className="btn ghost" style={{ cursor: 'pointer' }}>
            Load from .json file
            <input
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
          </label>
          <p className="small">
            Parses the same shape <code>ChipProfile.fromJson</code> reads
            (see <code>packages/emv/src/chip-profile.ts</code>).  Fills the
            fields below — you can edit before saving.
          </p>
        </div>
      )}

      <h3 style={{ marginTop: 16 }}>Identity</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
        <div>
          <label>Name</label>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="M/Chip Advance CVN 18 (JCOP5)" />
        </div>
        <div>
          <label>Scheme</label>
          <select value={form.scheme} onChange={(e) => set('scheme', e.target.value)}>
            {SCHEME_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label>Vendor</label>
          <input value={form.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder="nxp" />
        </div>
      </div>
      <div style={{ marginTop: 8, width: 120 }}>
        <label>CVN</label>
        <select value={form.cvn} onChange={(e) => set('cvn', e.target.value)}>
          <option value="10">10</option>
          <option value="17">17</option>
          <option value="18">18</option>
          <option value="22">22</option>
        </select>
      </div>

      <h3 style={{ marginTop: 20 }}>AIDs</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label>ELF AID</label>
          <input className="mono" value={form.elfAid} onChange={(e) => set('elfAid', e.target.value)} />
        </div>
        <div>
          <label>Module AID</label>
          <input className="mono" value={form.moduleAid} onChange={(e) => set('moduleAid', e.target.value)} />
        </div>
        <div>
          <label>PA AID</label>
          <input className="mono" value={form.paAid} onChange={(e) => set('paAid', e.target.value)} />
        </div>
        <div>
          <label>FIDO AID</label>
          <input className="mono" value={form.fidoAid} onChange={(e) => set('fidoAid', e.target.value)} />
        </div>
      </div>

      <h3 style={{ marginTop: 20 }}>Special DGIs</h3>
      <p className="small">
        DGI numbers + tag numbers in decimal (the on-disk format).
        0x8001 = 32769 (ICC Private Key); 0x9F48 = 40776 (Tag); 0x0800–0x0802
        = MK-AC / MK-SMI / MK-SMC.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label>ICC Priv DGI</label>
          <input className="mono" value={form.iccPrivateKeyDgi} onChange={(e) => set('iccPrivateKeyDgi', e.target.value)} />
        </div>
        <div>
          <label>ICC Priv Tag</label>
          <input className="mono" value={form.iccPrivateKeyTag} onChange={(e) => set('iccPrivateKeyTag', e.target.value)} />
        </div>
        <div>
          <label>MK-AC DGI</label>
          <input className="mono" value={form.mkAcDgi} onChange={(e) => set('mkAcDgi', e.target.value)} />
        </div>
        <div>
          <label>MK-SMI DGI</label>
          <input className="mono" value={form.mkSmiDgi} onChange={(e) => set('mkSmiDgi', e.target.value)} />
        </div>
        <div>
          <label>MK-SMC DGI</label>
          <input className="mono" value={form.mkSmcDgi} onChange={(e) => set('mkSmcDgi', e.target.value)} />
        </div>
      </div>

      <h3 style={{ marginTop: 20 }}>DGI Definitions</h3>
      <p className="small">
        JSON array.  Each entry matches <code>ChipProfile.fromJson</code>'s
        shape: <code>{'{ dgi_number, name, tags: number[], mandatory, source }'}</code>.
        <code>source</code> is one of <code>per_profile</code>,{' '}
        <code>per_card</code>, <code>pa_internal</code>,{' '}
        <code>per_provisioning</code>.
      </p>
      <textarea
        className="mono"
        value={form.dgiDefinitionsJson}
        onChange={(e) => set('dgiDefinitionsJson', e.target.value)}
        rows={18}
        style={{ width: '100%', fontSize: 12 }}
      />

      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}

      <div style={{ marginTop: 16 }}>
        <button
          className="btn primary"
          onClick={save}
          disabled={busy || !form.name || !form.scheme || !form.vendor}
        >
          {busy ? 'Saving…' : isNew ? 'Create chip profile' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
