import { CREDENTIAL_KINDS } from '../../utils/webauthn';
import type { TierRule } from './types';

export function RuleEditor({
  rules,
  onChange,
}: {
  rules: TierRule[];
  onChange: (r: TierRule[]) => void;
}) {
  const set = (i: number, patch: Partial<TierRule>) => {
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const add = () => {
    if (rules.length === 0) {
      onChange([{ amountMinMinor: 0, amountMaxMinor: null, allowedKinds: ['PLATFORM'] }]);
      return;
    }
    const last = rules[rules.length - 1];
    const nextMin = last.amountMaxMinor ?? 0;
    onChange([
      ...rules.slice(0, -1),
      { ...last, amountMaxMinor: nextMin },
      { amountMinMinor: nextMin, amountMaxMinor: null, allowedKinds: ['CROSS_PLATFORM'] },
    ]);
  };
  const remove = (i: number) => {
    if (rules.length <= 1) return;
    onChange(rules.filter((_, idx) => idx !== i));
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {rules.map((r, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 2fr 2fr auto',
            gap: 8,
            alignItems: 'end',
            padding: 8,
            border: '1px solid var(--edge)',
            borderRadius: 6,
          }}
        >
          <div>
            <label>Min (minor)</label>
            <input
              type="number"
              value={r.amountMinMinor}
              onChange={(e) => set(i, { amountMinMinor: Number(e.target.value) })}
              className="mono"
            />
          </div>
          <div>
            <label>Max (minor, blank = ∞)</label>
            <input
              type="number"
              value={r.amountMaxMinor ?? ''}
              onChange={(e) =>
                set(i, {
                  amountMaxMinor: e.target.value === '' ? null : Number(e.target.value),
                })
              }
              className="mono"
            />
          </div>
          <div>
            <label>Allowed kinds</label>
            <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
              {CREDENTIAL_KINDS.map((k) => (
                <label key={k} className="small" style={{ display: 'flex', gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={r.allowedKinds.includes(k)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...r.allowedKinds, k]
                        : r.allowedKinds.filter((x) => x !== k);
                      set(i, { allowedKinds: next });
                    }}
                  />
                  {k === 'PLATFORM' ? 'Bio' : 'NFC'}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label>Label (optional)</label>
            <input
              value={r.label ?? ''}
              onChange={(e) => set(i, { label: e.target.value || undefined })}
              placeholder="Biometric under AUD 100"
            />
          </div>
          <button
            className="btn ghost"
            onClick={() => remove(i)}
            disabled={rules.length <= 1}
            title={rules.length <= 1 ? 'At least one rule required' : 'Remove rule'}
          >
            ✕
          </button>
        </div>
      ))}
      <div>
        <button className="btn ghost" onClick={add}>+ Add rule</button>
      </div>
    </div>
  );
}
