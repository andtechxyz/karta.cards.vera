import { useState } from 'react';
import { api, errorMsg } from '../../utils/api';
import type { Program } from '../programs/types';
import type { ChipProfile } from '../chip-profiles/types';
import {
  HEX_FIELDS,
  SCHEME_OPTIONS,
  isHex,
  type HexField,
  type IssuerProfile,
  type IssuerScheme,
} from './types';

// IssuerProfile detail editor.  Handles both `new` (programs +
// chipProfiles pre-populated from the parent) and `edit` (load the
// full record with unmasked ARNs).  Saves via POST for new,
// PATCH for edit.

interface Props {
  profile: IssuerProfile | 'new';
  programs: Program[];
  chipProfiles: ChipProfile[];
  onSaved: () => void;
  onCancel: () => void;
}

type FormState = Record<string, string>;

function initialState(profile: IssuerProfile | 'new', programs: Program[], chipProfiles: ChipProfile[]): FormState {
  if (profile === 'new') {
    return {
      programId: programs[0]?.id ?? '',
      chipProfileId: chipProfiles[0]?.id ?? '',
      scheme: 'mchip_advance',
      cvn: '18',
      imkAlgorithm: 'TDES_2KEY',
      derivationMethod: 'METHOD_A',
      // PA TRANSFER_SAD metadata tail — decimal strings in the form;
      // parsed back to numbers in `save()`.  Blank on new so the
      // backend stores NULL until an operator fills them in.
      bankId: '',
      progId: '',
      postProvisionUrl: '',
      tmkKeyArn: '',
      imkAcKeyArn: '',
      imkSmiKeyArn: '',
      imkSmcKeyArn: '',
      imkIdnKeyArn: '',
      issuerPkKeyArn: '',
      caPkIndex: '',
      issuerPkCertificate: '',
      issuerPkRemainder: '',
      issuerPkExponent: '',
      aid: '',
      appLabel: '',
      appPreferredName: '',
      appPriority: '',
      appVersionNumber: '',
      aip: '',
      afl: '',
      cvmList: '',
      pdol: '',
      cdol1: '',
      cdol2: '',
      iacDefault: '',
      iacDenial: '',
      iacOnline: '',
      appUsageControl: '',
      currencyCode: '',
      currencyExponent: '',
      countryCode: '',
      sdaTagList: '',
    };
  }
  return {
    programId: profile.programId,
    chipProfileId: profile.chipProfileId,
    scheme: String(profile.scheme),
    cvn: String(profile.cvn),
    imkAlgorithm: profile.imkAlgorithm ?? '',
    derivationMethod: profile.derivationMethod ?? '',
    bankId: profile.bankId == null ? '' : String(profile.bankId),
    progId: profile.progId == null ? '' : String(profile.progId),
    postProvisionUrl: profile.postProvisionUrl ?? '',
    tmkKeyArn: profile.tmkKeyArn ?? '',
    imkAcKeyArn: profile.imkAcKeyArn ?? '',
    imkSmiKeyArn: profile.imkSmiKeyArn ?? '',
    imkSmcKeyArn: profile.imkSmcKeyArn ?? '',
    imkIdnKeyArn: profile.imkIdnKeyArn ?? '',
    issuerPkKeyArn: profile.issuerPkKeyArn ?? '',
    caPkIndex: profile.caPkIndex ?? '',
    issuerPkCertificate: profile.issuerPkCertificate ?? '',
    issuerPkRemainder: profile.issuerPkRemainder ?? '',
    issuerPkExponent: profile.issuerPkExponent ?? '',
    aid: profile.aid ?? '',
    appLabel: profile.appLabel ?? '',
    appPreferredName: profile.appPreferredName ?? '',
    appPriority: profile.appPriority ?? '',
    appVersionNumber: profile.appVersionNumber ?? '',
    aip: profile.aip ?? '',
    afl: profile.afl ?? '',
    cvmList: profile.cvmList ?? '',
    pdol: profile.pdol ?? '',
    cdol1: profile.cdol1 ?? '',
    cdol2: profile.cdol2 ?? '',
    iacDefault: profile.iacDefault ?? '',
    iacDenial: profile.iacDenial ?? '',
    iacOnline: profile.iacOnline ?? '',
    appUsageControl: profile.appUsageControl ?? '',
    currencyCode: profile.currencyCode ?? '',
    currencyExponent: profile.currencyExponent ?? '',
    countryCode: profile.countryCode ?? '',
    sdaTagList: profile.sdaTagList ?? '',
  };
}

// ARN rows render as masked text in read mode, clear on focus so the
// user can paste a replacement.  We keep the raw value in state and
// only swap the visible mask when the field is not focused.
function ArnInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const mask = value.length > 4 ? '***' + value.slice(-4) : value ? '***' : '';
  return (
    <div>
      <label>{label}</label>
      <input
        className="mono"
        value={focused ? value : mask}
        placeholder="arn:aws:payment-cryptography:…"
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
      />
    </div>
  );
}

export function IssuerProfileDetail({
  profile,
  programs,
  chipProfiles,
  onSaved,
  onCancel,
}: Props) {
  const [form, setForm] = useState<FormState>(() => initialState(profile, programs, chipProfiles));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isNew = profile === 'new';

  const set = (key: keyof FormState, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const hexErrors = HEX_FIELDS.filter((f: HexField) => form[f] && !isHex(form[f]));

  // PA TRANSFER_SAD numeric fields — input must parse as a non-negative
  // integer <= 0xFFFFFFFF (matches the backend Zod bounds).  An empty
  // string is legal (clears the column back to NULL on patch, omitted
  // on create).
  const numericBoundsError = (v: string): string | null => {
    if (v === '') return null;
    if (!/^[0-9]+$/.test(v)) return 'must be a decimal integer';
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 0xFFFFFFFF) return 'must fit in 4 bytes (0..4294967295)';
    return null;
  };
  const bankIdErr = numericBoundsError(form.bankId);
  const progIdErr = numericBoundsError(form.progId);

  const save = async () => {
    setErr(null);
    if (hexErrors.length > 0) {
      setErr(`Non-hex characters in: ${hexErrors.join(', ')}`);
      return;
    }
    if (bankIdErr) { setErr(`bankId ${bankIdErr}`); return; }
    if (progIdErr) { setErr(`progId ${progIdErr}`); return; }
    if (!form.programId || !form.chipProfileId || !form.scheme || !form.cvn) {
      setErr('programId, chipProfileId, scheme, and cvn are required');
      return;
    }
    setBusy(true);
    try {
      // Strip empty-string optionals to let backend defaults apply
      // on create.  On edit we keep empties so a user can clear a
      // field (backend treats "" as a legal value for all hex/ARN
      // columns — that's their schema default).
      // bankId + progId are nullable ints on the backend; postProvisionUrl
      // is a nullable string.  On create we already skipped empties above;
      // on edit a cleared field becomes `null` so the column drops back to
      // NULL (cannot encode "clear" as `""` because that's a legal url).
      const NUMERIC_KEYS = new Set(['bankId', 'progId']);
      const NULLABLE_KEYS = new Set(['bankId', 'progId', 'postProvisionUrl']);
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) {
        if (isNew && v === '') continue;
        if (NULLABLE_KEYS.has(k) && v === '') {
          body[k] = null;
          continue;
        }
        if (NUMERIC_KEYS.has(k)) {
          body[k] = Number(v);
          continue;
        }
        body[k] = k === 'cvn' ? Number(v) : v;
      }
      if (isNew) {
        await api.post('/issuer-profiles', body);
      } else {
        // PATCH must not include programId (the backend omits it from
        // the patch schema — a migration would need to land first).
        delete body.programId;
        await api.patch(`/issuer-profiles/${(profile as IssuerProfile).id}`, body);
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
          {isNew
            ? 'New Issuer Profile'
            : `Issuer Profile ${(profile as IssuerProfile).id}`}
        </h2>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>

      <h3 style={{ marginTop: 16 }}>Identity</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label>Program</label>
          <select
            value={form.programId}
            onChange={(e) => set('programId', e.target.value)}
            disabled={!isNew}
          >
            {programs.length === 0 && <option value="">(create a program first)</option>}
            {programs.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
            ))}
          </select>
          {!isNew && (
            <p className="small">Program cannot be moved after creation.</p>
          )}
        </div>
        <div>
          <label>Chip Profile</label>
          <select
            value={form.chipProfileId}
            onChange={(e) => set('chipProfileId', e.target.value)}
          >
            {chipProfiles.length === 0 && <option value="">(create a chip profile first)</option>}
            {chipProfiles.map((cp) => (
              <option key={cp.id} value={cp.id}>{cp.name} ({cp.scheme} / CVN {cp.cvn})</option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginTop: 8 }}>
        <div>
          <label>Scheme</label>
          <select
            value={form.scheme}
            onChange={(e) => set('scheme', e.target.value as IssuerScheme)}
          >
            {SCHEME_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label>CVN</label>
          <select value={form.cvn} onChange={(e) => set('cvn', e.target.value)}>
            <option value="10">10</option>
            <option value="17">17</option>
            <option value="18">18</option>
            <option value="22">22</option>
          </select>
        </div>
        <div>
          <label>IMK Algorithm</label>
          <input
            className="mono"
            value={form.imkAlgorithm}
            onChange={(e) => set('imkAlgorithm', e.target.value)}
            placeholder="TDES_2KEY"
          />
        </div>
        <div>
          <label>Derivation Method</label>
          <input
            className="mono"
            value={form.derivationMethod}
            onChange={(e) => set('derivationMethod', e.target.value)}
            placeholder="METHOD_A"
          />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <label>AID (Tag 9F06, hex)</label>
        <input
          className="mono"
          value={form.aid}
          onChange={(e) => set('aid', e.target.value)}
          placeholder="A0000000041010"
        />
      </div>

      <h3 style={{ marginTop: 20 }}>Labels</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label>App Label (Tag 50)</label>
          <input
            value={form.appLabel}
            onChange={(e) => set('appLabel', e.target.value)}
            placeholder="KARTA PLATINUM"
          />
        </div>
        <div>
          <label>App Preferred Name (Tag 9F12)</label>
          <input
            value={form.appPreferredName}
            onChange={(e) => set('appPreferredName', e.target.value)}
            placeholder="KARTA"
          />
        </div>
      </div>

      <h3 style={{ marginTop: 20 }}>PA TRANSFER_SAD metadata tail</h3>
      <p className="small">
        Real per-FI identifiers the PA applet writes to NVM during
        <code> processTransferSad</code>.  <b>bankId</b> / <b>progId</b> are
        4-byte unsigned integers (decimal here; PA wire format is 4-byte
        big-endian).  <b>postProvisionUrl</b> is the hostname (no protocol)
        baked into the post-activation NDEF URL — capped at 255 bytes by
        the applet.  Legacy rows (pre-Track 2) leave these blank; new rows
        should set them or RCA will refuse to ship the plan unless
        <code> RCA_ALLOW_MINIMAL_SAD=1</code> is set for dev.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label>bankId (decimal, 0 .. 4294967295)</label>
          <input
            className="mono"
            value={form.bankId}
            onChange={(e) => set('bankId', e.target.value)}
            placeholder="e.g. 1122867 for 0x00112233"
            inputMode="numeric"
          />
          {bankIdErr && <p className="small" style={{ color: 'var(--err, #c33)' }}>bankId {bankIdErr}</p>}
        </div>
        <div>
          <label>progId (decimal, 0 .. 4294967295)</label>
          <input
            className="mono"
            value={form.progId}
            onChange={(e) => set('progId', e.target.value)}
            placeholder="e.g. 66 for 0x00000042"
            inputMode="numeric"
          />
          {progIdErr && <p className="small" style={{ color: 'var(--err, #c33)' }}>progId {progIdErr}</p>}
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <label>postProvisionUrl (hostname, no protocol)</label>
        <input
          value={form.postProvisionUrl}
          onChange={(e) => set('postProvisionUrl', e.target.value)}
          placeholder="tap.karta.cards"
          maxLength={255}
        />
      </div>

      <h3 style={{ marginTop: 20 }}>EMV Constants</h3>
      <p className="small">
        All fields are hex (no 0x prefix, no spaces).  Leave blank to accept the
        schema default — the data-prep service validates completeness at SAD
        build time.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label>AIP (Tag 82)</label>
          <input className="mono" value={form.aip} onChange={(e) => set('aip', e.target.value)} placeholder="1C00" />
        </div>
        <div>
          <label>AFL (Tag 94)</label>
          <input className="mono" value={form.afl} onChange={(e) => set('afl', e.target.value)} placeholder="080101001001…" />
        </div>
        <div>
          <label>CVM List (Tag 8E)</label>
          <input className="mono" value={form.cvmList} onChange={(e) => set('cvmList', e.target.value)} />
        </div>
        <div>
          <label>PDOL (Tag 9F38)</label>
          <input className="mono" value={form.pdol} onChange={(e) => set('pdol', e.target.value)} />
        </div>
        <div>
          <label>CDOL1 (Tag 8C)</label>
          <input className="mono" value={form.cdol1} onChange={(e) => set('cdol1', e.target.value)} />
        </div>
        <div>
          <label>CDOL2 (Tag 8D)</label>
          <input className="mono" value={form.cdol2} onChange={(e) => set('cdol2', e.target.value)} />
        </div>
        <div>
          <label>IAC Default (Tag 9F0D)</label>
          <input className="mono" value={form.iacDefault} onChange={(e) => set('iacDefault', e.target.value)} />
        </div>
        <div>
          <label>IAC Denial (Tag 9F0E)</label>
          <input className="mono" value={form.iacDenial} onChange={(e) => set('iacDenial', e.target.value)} />
        </div>
        <div>
          <label>IAC Online (Tag 9F0F)</label>
          <input className="mono" value={form.iacOnline} onChange={(e) => set('iacOnline', e.target.value)} />
        </div>
        <div>
          <label>App Usage Control (Tag 9F07)</label>
          <input className="mono" value={form.appUsageControl} onChange={(e) => set('appUsageControl', e.target.value)} />
        </div>
        <div>
          <label>Currency Code (Tag 9F42)</label>
          <input className="mono" value={form.currencyCode} onChange={(e) => set('currencyCode', e.target.value)} placeholder="0036" />
        </div>
        <div>
          <label>Currency Exponent (Tag 9F44)</label>
          <input className="mono" value={form.currencyExponent} onChange={(e) => set('currencyExponent', e.target.value)} placeholder="02" />
        </div>
        <div>
          <label>Country Code (Tag 5F28)</label>
          <input className="mono" value={form.countryCode} onChange={(e) => set('countryCode', e.target.value)} placeholder="0036" />
        </div>
        <div>
          <label>SDA Tag List (Tag 9F4A)</label>
          <input className="mono" value={form.sdaTagList} onChange={(e) => set('sdaTagList', e.target.value)} />
        </div>
        <div>
          <label>App Version Number (Tag 9F08)</label>
          <input className="mono" value={form.appVersionNumber} onChange={(e) => set('appVersionNumber', e.target.value)} />
        </div>
        <div>
          <label>App Priority (Tag 87)</label>
          <input className="mono" value={form.appPriority} onChange={(e) => set('appPriority', e.target.value)} />
        </div>
      </div>

      <h3 style={{ marginTop: 20 }}>AWS Payment Cryptography Keys</h3>
      <p className="small">
        Paste the full ARN emitted by AWS Payment Cryptography's ImportKey API.
        Stored as-is.  Masked back to last-4 on the list view; the detail
        endpoint returns the full ARN (admin-only).
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <ArnInput label="TMK (iCVV)" value={form.tmkKeyArn} onChange={(v) => set('tmkKeyArn', v)} disabled={busy} />
        <ArnInput label="IMK-AC (ARQC)" value={form.imkAcKeyArn} onChange={(v) => set('imkAcKeyArn', v)} disabled={busy} />
        <ArnInput label="IMK-SMI (MAC)" value={form.imkSmiKeyArn} onChange={(v) => set('imkSmiKeyArn', v)} disabled={busy} />
        <ArnInput label="IMK-SMC (encryption)" value={form.imkSmcKeyArn} onChange={(v) => set('imkSmcKeyArn', v)} disabled={busy} />
        <ArnInput label="IMK-IDN (optional)" value={form.imkIdnKeyArn} onChange={(v) => set('imkIdnKeyArn', v)} disabled={busy} />
        <ArnInput label="Issuer PK (RSA, signs ICC certs)" value={form.issuerPkKeyArn} onChange={(v) => set('issuerPkKeyArn', v)} disabled={busy} />
      </div>

      <h3 style={{ marginTop: 20 }}>Issuer PK Certificate Material</h3>
      <p className="small">
        Pre-computed from CA enrolment.  These TLVs are included in SAD
        verbatim — the chip verifies them at transaction time against the
        scheme CA PK Index.
      </p>
      <div>
        <label>CA PK Index (hex, 1 byte)</label>
        <input
          className="mono"
          value={form.caPkIndex}
          onChange={(e) => set('caPkIndex', e.target.value)}
          style={{ width: 120 }}
        />
      </div>
      <div style={{ marginTop: 8 }}>
        <label>Issuer PK Certificate (Tag 90, hex)</label>
        <textarea
          className="mono"
          value={form.issuerPkCertificate}
          onChange={(e) => set('issuerPkCertificate', e.target.value)}
          rows={4}
          style={{ width: '100%' }}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
        <div>
          <label>Issuer PK Remainder (Tag 92, hex)</label>
          <textarea
            className="mono"
            value={form.issuerPkRemainder}
            onChange={(e) => set('issuerPkRemainder', e.target.value)}
            rows={3}
            style={{ width: '100%' }}
          />
        </div>
        <div>
          <label>Issuer PK Exponent (Tag 9F32, hex)</label>
          <input
            className="mono"
            value={form.issuerPkExponent}
            onChange={(e) => set('issuerPkExponent', e.target.value)}
            placeholder="03"
          />
        </div>
      </div>

      {hexErrors.length > 0 && (
        <p className="tag err" style={{ marginTop: 12 }}>
          Non-hex characters in: {hexErrors.join(', ')}
        </p>
      )}
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}

      <div style={{ marginTop: 16 }}>
        <button
          className="btn primary"
          onClick={save}
          disabled={
            busy
            || hexErrors.length > 0
            || bankIdErr !== null
            || progIdErr !== null
            || !form.programId
            || !form.chipProfileId
          }
        >
          {busy ? 'Saving…' : isNew ? 'Create issuer profile' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
