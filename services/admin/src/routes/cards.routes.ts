import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { validateBody, badRequest, notFound, conflict } from '@vera/core';
import { prisma } from '@vera/db';

// PATCH /api/cards/:id — admin-only card update (program reassignment).
// POST  /api/cards/:cardRef/mark-sold — flip a retail card from SHIPPED → SOLD
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

// POST /api/cards/:cardRef/mark-sold
//
// Flips a retail card's retailSaleStatus from SHIPPED to SOLD.  Admin-only
// path — partner API has its own bulk equivalent mounted under /api/partners.
// Idempotent: calling on an already-SOLD card is a no-op (204).  Calling on
// a non-retail card returns 409 so accidental clicks don't silently change
// non-retail behaviour.
router.post('/:cardRef/mark-sold', async (req, res) => {
  const cardRef = req.params.cardRef;
  const card = await prisma.card.findUnique({
    where: { cardRef },
    select: {
      id: true,
      retailSaleStatus: true,
      program: { select: { programType: true } },
    },
  });
  if (!card) throw notFound('card_not_found', `Card ${cardRef} not found`);
  if (card.program?.programType !== 'RETAIL') {
    throw conflict('not_retail', 'Only RETAIL program cards have a sale status');
  }
  if (card.retailSaleStatus === 'SOLD') {
    res.status(204).end();
    return;
  }
  const updated = await prisma.card.update({
    where: { id: card.id },
    data: { retailSaleStatus: 'SOLD', retailSoldAt: new Date() },
    select: { cardRef: true, retailSaleStatus: true, retailSoldAt: true },
  });
  res.json(updated);
});

export default router;
