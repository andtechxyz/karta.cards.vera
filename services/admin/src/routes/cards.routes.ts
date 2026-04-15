import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { validateBody, badRequest, notFound } from '@vera/core';
import { prisma } from '@vera/db';

// PATCH /api/cards/:id — admin-only card update (program reassignment).
// Registration (POST /api/cards/register) belongs to the activation service.

const router: Router = Router();

const patchSchema = z
  .object({
    programId: z.string().min(1).max(64).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field must be supplied',
  });

router.patch('/:id', validateBody(patchSchema), async (req, res) => {
  const body = req.body as z.infer<typeof patchSchema>;
  const data: Prisma.CardUpdateInput = {};
  if (body.programId !== undefined) {
    data.program = body.programId
      ? { connect: { id: body.programId } }
      : { disconnect: true };
  }

  try {
    const card = await prisma.card.update({
      where: { id: req.params.id },
      data,
      select: {
        id: true,
        cardRef: true,
        programId: true,
        program: { select: { id: true, name: true, currency: true } },
      },
    });
    res.json(card);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      const cause = typeof err.meta?.cause === 'string' ? err.meta.cause : '';
      if (/No ['"]Program['"] record/i.test(cause)) {
        throw badRequest('program_not_found', `Program ${body.programId} not found`);
      }
      throw notFound('card_not_found', `Card ${req.params.id} not found`);
    }
    throw err;
  }
});

export default router;
