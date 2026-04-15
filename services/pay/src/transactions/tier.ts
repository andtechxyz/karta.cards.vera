import { CredentialKind, Tier } from '@prisma/client';
import { matchRule, type TierRuleSet } from '../programs/index.js';

// -----------------------------------------------------------------------------
// Tier determination.
//
// The enforcement primitive is `allowedCredentialKinds` (the set of
// CredentialKinds acceptable at the transaction's amount, resolved from the
// card's Program.tierRules in src/programs/).  This file maps that set to
// the display-friendly Tier enum used in admin tables and SSE payloads.
//
//   {PLATFORM}              → TIER_1  (biometric only)
//   {CROSS_PLATFORM}        → TIER_2  (card tap only)
//   {PLATFORM, CROSS_PLATFORM} → TIER_3  (either acceptable — step-up candidate)
//
// Programs that want different semantics (e.g. Bank A: "under AUD 200 bio
// only, AUD 200+ tap only, never both") configure it by setting their rule
// ruleset; this file doesn't need to know about per-program policy.
// -----------------------------------------------------------------------------

export interface TierDecision {
  /** Credential kinds that will be accepted at /authenticate/verify. */
  allowedKinds: CredentialKind[];
  /** Display-friendly summary for admin UI + SSE. */
  tier: Tier;
  /** Optional human-readable rule label, for progress UIs. */
  label?: string;
}

export function evaluateTierRules(
  rules: TierRuleSet,
  amountMinorUnits: number,
): TierDecision {
  const rule = matchRule(rules, amountMinorUnits);
  return {
    allowedKinds: rule.allowedKinds,
    tier: summariseTier(rule.allowedKinds),
    label: rule.label,
  };
}

export function summariseTier(kinds: readonly CredentialKind[]): Tier {
  const hasPlatform = kinds.includes(CredentialKind.PLATFORM);
  const hasCross = kinds.includes(CredentialKind.CROSS_PLATFORM);
  if (hasPlatform && hasCross) return Tier.TIER_3;
  if (hasCross) return Tier.TIER_2;
  return Tier.TIER_1;
}
