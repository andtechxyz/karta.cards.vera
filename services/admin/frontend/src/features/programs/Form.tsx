import { useEffect, useState } from 'react';
import { api as allApi, errorMsg } from '../../utils/api';
const api = allApi.palisade;
import { RuleEditor } from './RuleEditor';
import type { Program, ProgramType, TierRule } from './types';
import { PROGRAM_TYPE_OPTIONS, NEW_PROGRAM_DEFAULT_RULES, cloneRules } from './types';
import type { FinancialInstitution } from '../financial-institutions/types';
import type { EmbossingTemplateRow } from '../embossing-templates/types';

export function ProgramForm({
  program,
  fis,
  onSaved,
  onCancel,
}: {
  program: Program | null;
  fis: FinancialInstitution[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(program?.id ?? '');
  const [name, setName] = useState(program?.name ?? '');
  const [currency, setCurrency] = useState(program?.currency ?? 'AUD');
  const [programType, setProgramType] = useState<ProgramType>(
    program?.programType ?? 'PREPAID_RELOADABLE',
  );
  const [financialInstitutionId, setFinancialInstitutionId] = useState<string>(
    program?.financialInstitutionId ?? fis[0]?.id ?? '',
  );
  const [rules, setRules] = useState<TierRule[]>(() =>
    cloneRules(program?.tierRules ?? NEW_PROGRAM_DEFAULT_RULES),
  );
  const [pre, setPre] = useState(program?.preActivationNdefUrlTemplate ?? '');
  const [post, setPost] = useState(program?.postActivationNdefUrlTemplate ?? '');
  const [embossingTemplateId, setEmbossingTemplateId] = useState<string>(
    program?.embossingTemplateId ?? '',
  );
  const [templates, setTemplates] = useState<EmbossingTemplateRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load templates for the selected FI; reset the selection when the FI changes
  // (templates from the previous FI are no longer valid choices).
  useEffect(() => {
    if (!financialInstitutionId) {
      setTemplates([]);
      return;
    }
    api.get<EmbossingTemplateRow[]>(
      `/admin/financial-institutions/${financialInstitutionId}/embossing-templates`,
    )
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, [financialInstitutionId]);

  // If the FI changes away from the one the current embossing template belongs
  // to, clear the selection so we never save a stale cross-FI reference.
  useEffect(() => {
    if (!embossingTemplateId) return;
    if (templates.length > 0 && !templates.some((t) => t.id === embossingTemplateId)) {
      setEmbossingTemplateId('');
    }
  }, [templates, embossingTemplateId]);

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const body = {
        name,
        currency,
        programType,
        tierRules: rules,
        preActivationNdefUrlTemplate: pre.trim() ? pre.trim() : null,
        postActivationNdefUrlTemplate: post.trim() ? post.trim() : null,
        financialInstitutionId: financialInstitutionId || undefined,
        embossingTemplateId: embossingTemplateId ? embossingTemplateId : null,
      };
      if (program) {
        await api.patch<Program>(`/programs/${program.id}`, body);
      } else {
        await api.post<Program>('/programs', { id, ...body });
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
        <h2 style={{ margin: 0 }}>{program ? `Edit ${program.id}` : 'New program'}</h2>
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
          <p className="small">Palisade's programId — alphanumeric + _ - only; immutable after create.</p>
        </>
      )}

      <label>Financial Institution</label>
      <select
        value={financialInstitutionId}
        onChange={(e) => setFinancialInstitutionId(e.target.value)}
      >
        {fis.length === 0 && <option value="">(none available — create an FI first)</option>}
        {fis.map((f) => (
          <option key={f.id} value={f.id}>{f.name} ({f.slug})</option>
        ))}
      </select>

      <label>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mastercard Platinum" />

      <label>Currency (ISO 4217)</label>
      <input
        value={currency}
        onChange={(e) => setCurrency(e.target.value.toUpperCase())}
        className="mono"
        maxLength={3}
        style={{ width: 80 }}
      />

      <label>Program type</label>
      <select
        value={programType}
        onChange={(e) => setProgramType(e.target.value as ProgramType)}
      >
        {PROGRAM_TYPE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {programType === 'RETAIL' && (
        <p className="small">
          Retail cards ship to retailers in a SHIPPED state.  The microsite
          shows info only until ops marks the card as SOLD (admin Cards tab
          or partner <code>POST /api/partners/cards/mark-sold</code>).  Once
          SOLD, the next tap runs the normal WebAuthn activation flow.
        </p>
      )}

      <h3 style={{ marginTop: 20 }}>Tier rules</h3>
      <p className="small">
        Rules must be contiguous (no gaps), start at 0, and end with an
        unbounded last rule (max = blank). Amounts are in minor units — AUD
        100.00 = 10000.
      </p>
      <RuleEditor rules={rules} onChange={setRules} />

      <h3 style={{ marginTop: 20 }}>NDEF URL templates</h3>
      <p className="small">
        Must contain <span className="mono">{'{cardRef}'}</span>. SDM markers{' '}
        <span className="mono">{'{PICCData}'}</span> and{' '}
        <span className="mono">{'{CMAC}'}</span> are passed through verbatim for
        on-card substitution. Leave blank to fall back to Vera defaults.
      </p>

      <label>Pre-activation (baked at perso)</label>
      <input
        value={pre}
        onChange={(e) => setPre(e.target.value)}
        className="mono"
        placeholder="https://tap.karta.cards/activate/{cardRef}?e={PICCData}&m={CMAC}"
      />

      <label>Post-activation (written after WebAuthn registration)</label>
      <input
        value={post}
        onChange={(e) => setPost(e.target.value)}
        className="mono"
        placeholder="https://tap.karta.cards/pay/{cardRef}?e={PICCData}&m={CMAC}"
      />

      <h3 style={{ marginTop: 20 }}>Provisioning applet</h3>
      <p className="small">
        Cards in this program are personalised with the karta.cards T4T+FIDO
        applet bundle.  Perso operators load the CAP file onto each chip
        before shipping; the AIDs below are what the applet exposes at
        runtime, and they're also baked into the chip-profile selector.
      </p>
      <table className="kv" style={{ marginBottom: 8, fontSize: 13 }}>
        <tbody>
          <tr><th style={{ textAlign: 'left' }}>NDEF Tag App AID</th><td><code>D2760000850101</code></td></tr>
          <tr><th style={{ textAlign: 'left' }}>FIDO2 applet AID</th><td><code>A0000006472F0001</code></td></tr>
          <tr><th style={{ textAlign: 'left' }}>Source</th><td><code>external/new-t4t/applet/</code> (sibling project)</td></tr>
          <tr><th style={{ textAlign: 'left' }}>CAP file</th><td><code>external/new-t4t/applet/build/javacard/PalisadeT4T.cap</code></td></tr>
        </tbody>
      </table>
      <p className="small">
        To inject a pre-generated FIDO credential at perso time, see the
        Cards tab → click a row → "Pre-register FIDO credential".  Pre-
        registered cards skip the runtime WebAuthn ceremony — the SUN tap
        + the existing credential together flip the card to ACTIVATED.
      </p>

      <h3 style={{ marginTop: 20 }}>Embossing template</h3>
      <p className="small">
        Defines how batch card-data files are parsed into vault records.
        Templates are FI-scoped — create them under the Embossing Templates
        tab.
      </p>
      <label>Template</label>
      <select
        value={embossingTemplateId}
        onChange={(e) => setEmbossingTemplateId(e.target.value)}
      >
        <option value="">(none — batch uploads disabled)</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.formatType})
          </option>
        ))}
      </select>

      <div style={{ marginTop: 16 }}>
        <button
          className="btn primary"
          onClick={save}
          disabled={busy || (!program && !id) || !name || !currency || !financialInstitutionId}
        >
          {busy ? 'Saving…' : program ? 'Save changes' : 'Create program'}
        </button>
      </div>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
    </div>
  );
}
