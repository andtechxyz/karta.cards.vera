import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { validateBody, notFound, conflict } from '@vera/core';
import { prisma } from '@vera/db';
import { currencySchema, normaliseCurrency, tierRuleSetSchema } from '@vera/programs';

// ---------------------------------------------------------------------------
// TokenisationProgram admin CRUD.  Phase 4c: tier limits are a Vera-side
// token-control concern, set by an operator through the admin UI.  Keyed
// by the same id convention as Palisade's card-domain Program so the two
// sides correlate without a runtime join.
// ---------------------------------------------------------------------------

const router: Router = Router();

const baseSchema = z.object({
  name: z.string().min(1).max(128),
  currency: currencySchema,
  tierRules: tierRuleSetSchema,
});

const createSchema = baseSchema.extend({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/i, 'program id must be alphanumeric + _ -'),
});

const patchSchema = baseSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field must be supplied',
  });

router.get('/', async (_req, res) => {
  res.json(
    await prisma.tokenisationProgram.findMany({ orderBy: { id: 'asc' } }),
  );
});

router.get('/:id', async (req, res) => {
  const row = await prisma.tokenisationProgram.findUnique({
    where: { id: req.params.id },
  });
  if (!row) throw notFound('tokenisation_program_not_found', `Program ${req.params.id} not found`);
  res.json(row);
});

router.post('/', validateBody(createSchema), async (req, res) => {
  const body = req.body as z.infer<typeof createSchema>;
  try {
    const row = await prisma.tokenisationProgram.create({
      data: {
        id: body.id,
        name: body.name,
        currency: normaliseCurrency(body.currency),
        tierRules: body.tierRules,
      },
    });
    res.status(201).json(row);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('tokenisation_program_exists', `Program ${body.id} already exists`);
    }
    throw err;
  }
});

router.patch('/:id', validateBody(patchSchema), async (req, res) => {
  const patch = req.body as z.infer<typeof patchSchema>;
  const data: Prisma.TokenisationProgramUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.currency !== undefined) data.currency = normaliseCurrency(patch.currency);
  if (patch.tierRules !== undefined) data.tierRules = patch.tierRules;

  try {
    const row = await prisma.tokenisationProgram.update({
      where: { id: req.params.id },
      data,
    });
    res.json(row);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw notFound('tokenisation_program_not_found', `Program ${req.params.id} not found`);
    }
    throw err;
  }
});

export default router;
