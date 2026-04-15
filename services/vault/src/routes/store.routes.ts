import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@vera/db';
import { validateBody, notFound, badRequest, conflict } from '@vera/core';
import { requireCallerKeyId } from '@vera/service-auth';
import { storeCard } from '../vault/index.js';

const router: Router = Router();

const storeSchema = z.object({
  pan: z.string().min(12).max(23),
  cvc: z.string().optional(),
  expiryMonth: z.string().regex(/^(0[1-9]|1[0-2])$/),
  expiryYear: z.string().regex(/^[0-9]{2,4}$/),
  cardholderName: z.string().min(1).max(128),
  // `purpose` is a free-form audit annotation describing the sub-operation.
  // The *caller identity* is not in the body — it comes from the verified
  // HMAC keyId on req.callerKeyId.  PCI-DSS 10.2.1: only trust cryptographically
  // attested actor identities in the audit log.
  purpose: z.string().min(1).max(256),
  /**
   * Optional — when supplied, vault links the new VaultEntry onto this Card
   * atomically (the admin card-management flow).  When absent, vault just
   * creates the entry and returns its id (the activation flow, where the Card
   * row is created *after* the vault entry).
   */
  cardId: z.string().optional(),
  onDuplicate: z.enum(['error', 'reuse']).optional(),
});

router.post('/store', validateBody(storeSchema), async (req, res) => {
  const body = req.body as z.infer<typeof storeSchema>;
  const actor = requireCallerKeyId(req);

  if (body.cardId) {
    const card = await prisma.card.findUnique({ where: { id: body.cardId } });
    if (!card) throw notFound('card_not_found', 'Card not found');
    if (card.vaultEntryId) {
      throw badRequest('card_already_vaulted', 'This card already has a vault entry');
    }
  }

  const result = await storeCard({
    pan: body.pan,
    cvc: body.cvc,
    expiryMonth: body.expiryMonth,
    expiryYear: body.expiryYear,
    cardholderName: body.cardholderName,
    actor,
    purpose: body.purpose,
    ip: req.ip,
    ua: req.get('user-agent') ?? undefined,
    onDuplicate: body.onDuplicate,
  });

  if (body.cardId) {
    // Conditional update — guards against the race between the pre-check and
    // here, where another caller could have vaulted the same card.  Losing
    // the race orphans *this* call's VaultEntry but at least surfaces the
    // conflict instead of silently clobbering the winner's link.
    const { count } = await prisma.card.updateMany({
      where: { id: body.cardId, vaultEntryId: null },
      data: { vaultEntryId: result.vaultEntryId },
    });
    if (count === 0) {
      throw conflict('card_already_vaulted', 'Card was vaulted concurrently');
    }
  }

  res.status(201).json(result);
});

export default router;
