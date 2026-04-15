import { Tier } from '@prisma/client';

// -----------------------------------------------------------------------------
// Tier determination.  Server-side single source of truth.
//
// Tier 1 — low value, platform biometric (Face ID / Touch ID / Windows Hello)
// Tier 2 — mid value, NFC card tap (CTAP1 over NFC on Android Chrome)
// Tier 3 — high value, platform biometric + step-up
//
// Thresholds in minor units (cents).  Tuneable here without touching callers.
// -----------------------------------------------------------------------------

const TIER_2_THRESHOLD_CENTS = 5_000;   // $50
const TIER_3_THRESHOLD_CENTS = 50_000;  // $500

export function determineTier(amountMinorUnits: number): Tier {
  if (amountMinorUnits >= TIER_3_THRESHOLD_CENTS) return Tier.TIER_3;
  if (amountMinorUnits >= TIER_2_THRESHOLD_CENTS) return Tier.TIER_2;
  return Tier.TIER_1;
}
