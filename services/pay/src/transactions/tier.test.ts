import { describe, it, expect } from 'vitest';
import { CredentialKind, Tier } from '@prisma/client';
import { evaluateTierRules, summariseTier } from './tier.js';
import type { TierRuleSet } from '../programs/index.js';

// summariseTier is a tiny kind-set → Tier map.  Because the enforcement
// primitive is allowedCredentialKinds (not Tier), any regression here is
// cosmetic — but the admin UI and SSE payloads still read the Tier for a
// label, so we pin the mapping.

describe('summariseTier', () => {
  it('{PLATFORM} → TIER_1', () => {
    expect(summariseTier([CredentialKind.PLATFORM])).toBe(Tier.TIER_1);
  });

  it('{CROSS_PLATFORM} → TIER_2', () => {
    expect(summariseTier([CredentialKind.CROSS_PLATFORM])).toBe(Tier.TIER_2);
  });

  it('{PLATFORM, CROSS_PLATFORM} → TIER_3 (either order)', () => {
    expect(summariseTier([CredentialKind.PLATFORM, CredentialKind.CROSS_PLATFORM])).toBe(Tier.TIER_3);
    expect(summariseTier([CredentialKind.CROSS_PLATFORM, CredentialKind.PLATFORM])).toBe(Tier.TIER_3);
  });

  it('empty kind set defaults to TIER_1 (no cross_platform ⇒ the tier-1 fallback)', () => {
    // Belt-and-braces: the schema refuses empty sets upstream, but summariseTier
    // itself shouldn't throw — it's a pure mapping.
    expect(summariseTier([])).toBe(Tier.TIER_1);
  });
});

describe('evaluateTierRules', () => {
  const rules: TierRuleSet = [
    { amountMinMinor: 0, amountMaxMinor: 10_000, allowedKinds: [CredentialKind.PLATFORM] },
    { amountMinMinor: 10_000, amountMaxMinor: 50_000, allowedKinds: [CredentialKind.PLATFORM, CredentialKind.CROSS_PLATFORM] },
    { amountMinMinor: 50_000, amountMaxMinor: null, allowedKinds: [CredentialKind.CROSS_PLATFORM] },
  ];

  it('picks the first rule for small amounts and returns TIER_1', () => {
    const d = evaluateTierRules(rules, 4900);
    expect(d.allowedKinds).toEqual([CredentialKind.PLATFORM]);
    expect(d.tier).toBe(Tier.TIER_1);
  });

  it('picks the middle rule at the inclusive lower bound (10_000) and returns TIER_3', () => {
    const d = evaluateTierRules(rules, 10_000);
    expect(d.allowedKinds).toEqual([CredentialKind.PLATFORM, CredentialKind.CROSS_PLATFORM]);
    expect(d.tier).toBe(Tier.TIER_3);
  });

  it('picks the unbounded rule at very large amounts and returns TIER_2', () => {
    const d = evaluateTierRules(rules, 1_000_000);
    expect(d.allowedKinds).toEqual([CredentialKind.CROSS_PLATFORM]);
    expect(d.tier).toBe(Tier.TIER_2);
  });
});
