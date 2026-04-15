import { Prisma, type Program } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { conflict, notFound } from '../middleware/error.js';
import { normaliseCurrency } from './currency.js';
import { renderNdefUrls, validateNdefUrlTemplate, type NdefUrlPair } from './ndef.js';
import {
  DEFAULT_TIER_RULES,
  parseTierRuleSet,
  tierRuleSetSchema,
  type TierRuleSet,
} from './tier-rules.js';

// -----------------------------------------------------------------------------
// Program CRUD.  The Palisade provisioning-agent seeds a Program once per
// card product; the admin UI edits tierRules without code changes.  Rule
// shape is validated both on write (here) and on read (parseTierRuleSet) so
// malformed JSON stored out-of-band still fails loud at evaluation time.
// -----------------------------------------------------------------------------

export interface UpsertProgramInput {
  id: string;
  name: string;
  currency: string;
  tierRules: unknown; // Zod-validated inside
  preActivationNdefUrlTemplate?: string | null;
  postActivationNdefUrlTemplate?: string | null;
}

export async function createProgram(input: UpsertProgramInput): Promise<Program> {
  const rules = tierRuleSetSchema.parse(input.tierRules);
  if (input.preActivationNdefUrlTemplate) {
    validateNdefUrlTemplate(input.preActivationNdefUrlTemplate);
  }
  if (input.postActivationNdefUrlTemplate) {
    validateNdefUrlTemplate(input.postActivationNdefUrlTemplate);
  }
  try {
    return await prisma.program.create({
      data: {
        id: input.id,
        name: input.name,
        currency: normaliseCurrency(input.currency),
        tierRules: rules,
        preActivationNdefUrlTemplate: input.preActivationNdefUrlTemplate ?? null,
        postActivationNdefUrlTemplate: input.postActivationNdefUrlTemplate ?? null,
      },
    });
  } catch (err) {
    // Let the unique-constraint race fail loud rather than two concurrent
    // POSTs both passing a prefetch existence check and one 500-ing.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('program_exists', `Program ${input.id} already exists`);
    }
    throw err;
  }
}

export async function updateProgram(
  id: string,
  patch: Partial<Omit<UpsertProgramInput, 'id'>>,
): Promise<Program> {
  const data: Prisma.ProgramUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.currency !== undefined) data.currency = normaliseCurrency(patch.currency);
  if (patch.tierRules !== undefined) data.tierRules = tierRuleSetSchema.parse(patch.tierRules);
  if (patch.preActivationNdefUrlTemplate !== undefined) {
    if (patch.preActivationNdefUrlTemplate) {
      validateNdefUrlTemplate(patch.preActivationNdefUrlTemplate);
    }
    data.preActivationNdefUrlTemplate = patch.preActivationNdefUrlTemplate;
  }
  if (patch.postActivationNdefUrlTemplate !== undefined) {
    if (patch.postActivationNdefUrlTemplate) {
      validateNdefUrlTemplate(patch.postActivationNdefUrlTemplate);
    }
    data.postActivationNdefUrlTemplate = patch.postActivationNdefUrlTemplate;
  }

  try {
    return await prisma.program.update({ where: { id }, data });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw notFound('program_not_found', `Program ${id} not found`);
    }
    throw err;
  }
}

export async function listPrograms(): Promise<Program[]> {
  return prisma.program.findMany({ orderBy: { id: 'asc' } });
}

export async function getProgram(id: string): Promise<Program> {
  const p = await prisma.program.findUnique({ where: { id } });
  if (!p) throw notFound('program_not_found', `Program ${id} not found`);
  return p;
}

/**
 * Pure resolver: given an already-loaded program (or null for unlinked cards)
 * returns the effective ruleset + currency metadata.  Exposed so callers that
 * already fetch the program with their card row don't repeat the lookup.
 */
export function resolveRulesFromProgram(
  program: Program | null,
): { rules: TierRuleSet; currency: string | null; programId: string | null } {
  if (!program) {
    return { rules: DEFAULT_TIER_RULES, currency: null, programId: null };
  }
  return {
    rules: parseTierRuleSet(program.tierRules),
    currency: program.currency,
    programId: program.id,
  };
}

/**
 * Resolve the effective ruleset for a card by id.  Thin wrapper around
 * `resolveRulesFromProgram` for callers that don't already have the card row.
 */
export async function resolveRulesForCard(cardId: string): Promise<{
  rules: TierRuleSet;
  currency: string | null;
  programId: string | null;
}> {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { program: true },
  });
  if (!card) throw notFound('card_not_found', `Card ${cardId} not found`);
  return resolveRulesFromProgram(card.program);
}

/**
 * Return the pre- and post-activation NDEF URLs for a card, with {cardRef}
 * already substituted and SDM markers preserved.  Palisade reads these:
 *   - at perso time (pre-activation URL → baked into the card's NDEF),
 *   - after Vera confirms WebAuthn registration (post-activation URL →
 *     pushed to the card via authenticated APDU by the updater service).
 * Falls back to WEBAUTHN_ORIGIN-derived defaults when the card has no
 * linked program or the program leaves a template null.
 */
export async function resolveNdefUrlsForCard(cardId: string): Promise<NdefUrlPair> {
  return resolveNdefUrlsWhere({ id: cardId }, `Card ${cardId} not found`);
}

/**
 * cardRef-indexed variant.  Palisade's updater already holds the slug; going
 * through this avoids an id-lookup round-trip.
 */
export async function resolveNdefUrlsByCardRef(cardRef: string): Promise<NdefUrlPair> {
  return resolveNdefUrlsWhere(
    { cardRef },
    `Card ref ${cardRef} not found`,
  );
}

async function resolveNdefUrlsWhere(
  where: Prisma.CardWhereUniqueInput,
  missingMessage: string,
): Promise<NdefUrlPair> {
  const card = await prisma.card.findUnique({
    where,
    select: {
      cardRef: true,
      program: {
        select: {
          preActivationNdefUrlTemplate: true,
          postActivationNdefUrlTemplate: true,
        },
      },
    },
  });
  if (!card) throw notFound('card_not_found', missingMessage);
  return renderNdefUrls({
    cardRef: card.cardRef,
    preActivationTemplate: card.program?.preActivationNdefUrlTemplate ?? null,
    postActivationTemplate: card.program?.postActivationNdefUrlTemplate ?? null,
  });
}
