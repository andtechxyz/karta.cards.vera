import type { TokenisationProgram } from '@prisma/client';
import { DEFAULT_TIER_RULES, parseTierRuleSet, type TierRuleSet } from './tier-rules.js';

// -----------------------------------------------------------------------------
// Pure helpers against a TokenisationProgram row.  Admin owns CRUD through
// the Vera-side admin backend; pay + anything else that has a programId
// handy (or null, for cards not linked to one) collapses the row to a
// { rules, currency, programId } triple via this helper.
//
// Renamed from resolveRulesFromProgram in Phase 4c — tier rules moved from
// the card-domain Program (Palisade) to Vera's TokenisationProgram.
// -----------------------------------------------------------------------------

export interface ResolvedProgramRules {
  rules: TierRuleSet;
  currency: string | null;
  programId: string | null;
}

export function resolveRulesFromTokenisationProgram(
  program: TokenisationProgram | null,
): ResolvedProgramRules {
  if (!program) {
    return { rules: DEFAULT_TIER_RULES, currency: null, programId: null };
  }
  return {
    rules: parseTierRuleSet(program.tierRules),
    currency: program.currency,
    programId: program.id,
  };
}
