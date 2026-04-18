import type { CredentialKind } from '../../utils/webauthn';

// Mirrors the server's Program prisma model + tierRuleSchema
// (see src/programs/tier-rules.ts).  Keep in sync; the backend is the
// source of truth and validates on every write.
export interface TierRule {
  amountMinMinor: number;
  amountMaxMinor: number | null;
  allowedKinds: CredentialKind[];
  label?: string;
}

export type ProgramType =
  | 'RETAIL'
  | 'PREPAID_NON_RELOADABLE'
  | 'PREPAID_RELOADABLE'
  | 'DEBIT'
  | 'CREDIT';

export const PROGRAM_TYPE_OPTIONS: { value: ProgramType; label: string }[] = [
  { value: 'RETAIL', label: 'Retail' },
  { value: 'PREPAID_NON_RELOADABLE', label: 'Prepaid (Non-Reloadable)' },
  { value: 'PREPAID_RELOADABLE', label: 'Prepaid (Reloadable)' },
  { value: 'DEBIT', label: 'Debit' },
  { value: 'CREDIT', label: 'Credit' },
];

export function programTypeLabel(t: string | undefined | null): string {
  return PROGRAM_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? (t ?? '—');
}

export interface Program {
  id: string;
  name: string;
  currency: string;
  programType: ProgramType;
  tierRules: TierRule[];
  preActivationNdefUrlTemplate: string | null;
  postActivationNdefUrlTemplate: string | null;
  financialInstitutionId: string | null;
  financialInstitution?: { id: string; name: string; slug: string } | null;
  embossingTemplateId: string | null;
  embossingTemplate?: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

// Mirrors DEFAULT_TIER_RULES in src/programs/tier-rules.ts — the shape and
// threshold the server applies when a card has no linked program.
export const NEW_PROGRAM_DEFAULT_RULES: readonly TierRule[] = [
  { amountMinMinor: 0, amountMaxMinor: 10_000, allowedKinds: ['PLATFORM'], label: 'Biometric' },
  { amountMinMinor: 10_000, amountMaxMinor: null, allowedKinds: ['CROSS_PLATFORM'], label: 'Card tap' },
];

export function cloneRules(rules: readonly TierRule[]): TierRule[] {
  return rules.map((r) => ({ ...r, allowedKinds: [...r.allowedKinds] }));
}

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
