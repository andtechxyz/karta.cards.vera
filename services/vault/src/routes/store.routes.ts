import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@vera/db';
import { validateBody, notFound, badRequest } from '@vera/core';
import { storeCard } from '../vault/index.js';

const router: Router = Router();

const storeSchema = z.object({
  cardId: z.string().min(1),
  pan: z.string().min(12).max(23),
  cvc: z.string().optional(),
  expiryMonth: z.string().regex(/^(0[1-9]|1[0-2])$/),
  expiryYear: z.string().regex(/^[0-9]{2,4}$/),
  cardholderName: z.string().min(1).max(128),
  onDuplicate: z.enum(['error', 'reuse']).optional(),
});

const storeQuery = z.object({ onDuplicate: z.enum(['error', 'reuse']).optional() });

router.post('/store', validateBody(storeSchema), async (req, res) => {
  const { cardId, onDuplicate: bodyOnDup, ...rest } = req.body as z.infer<typeof storeSchema>;
  const queryOnDup = storeQuery.parse(req.query).onDuplicate;
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card) throw notFound('card_not_found', 'Card not found');
  if (card.vaultEntryId) {
    throw badRequest('card_already_vaulted', 'This card already has a vault entry');
  }

  const result = await storeCard({
    pan: rest.pan,
    cvc: rest.cvc,
    expiryMonth: rest.expiryMonth,
    expiryYear: rest.expiryYear,
    cardholderName: rest.cardholderName,
    actor: 'admin',
    purpose: 'admin vault store',
    ip: req.ip,
    ua: req.get('user-agent') ?? undefined,
    onDuplicate: bodyOnDup ?? queryOnDup,
  });

  await prisma.card.update({
    where: { id: cardId },
    data: { vaultEntryId: result.vaultEntryId },
  });

  res.status(201).json(result);
});

export default router;
