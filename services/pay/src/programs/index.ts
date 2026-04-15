// Pay service only needs the tier-rules and currency helpers.
// Program CRUD lives in the admin service.

export {
  DEFAULT_TIER_RULES,
  matchRule,
  parseTierRuleSet,
  tierRuleSchema,
  tierRuleSetSchema,
} from './tier-rules.js';
export type { TierRule, TierRuleSet } from './tier-rules.js';

export { currencySchema, normaliseCurrency } from './currency.js';

// resolveRulesFromProgram is inlined here to avoid dragging in admin's Prisma calls.
import type { Program } from '@prisma/client';
import { DEFAULT_TIER_RULES as DTR, parseTierRuleSet } from './tier-rules.js';
import type { TierRuleSet } from './tier-rules.js';

export function resolveRulesFromProgram(
  program: Program | null,
): { rules: TierRuleSet; currency: string | null; programId: string | null } {
  if (!program) {
    return { rules: DTR, currency: null, programId: null };
  }
  return {
    rules: parseTierRuleSet(program.tierRules),
    currency: program.currency,
    programId: program.id,
  };
}
