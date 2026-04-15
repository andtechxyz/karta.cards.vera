import { Prisma, type Program } from '@prisma/client';
import { prisma } from '@vera/db';
import { conflict, notFound } from '@vera/core';
import { normaliseCurrency, tierRuleSetSchema } from '@vera/programs';
import { renderNdefUrls, validateNdefUrlTemplate, type NdefUrlPair } from './ndef.js';

// -----------------------------------------------------------------------------
// Program CRUD — admin service.
// Full read/write access: create, update, list, get, NDEF URL resolution.
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

export async function resolveNdefUrlsForCard(cardId: string): Promise<NdefUrlPair> {
  return resolveNdefUrlsWhere({ id: cardId }, `Card ${cardId} not found`);
}

export async function resolveNdefUrlsByCardRef(cardRef: string): Promise<NdefUrlPair> {
  return resolveNdefUrlsWhere({ cardRef }, `Card ref ${cardRef} not found`);
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
