import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '@vera/core';
import { requireCallerKeyId } from '@vera/service-auth';
import { storeCard } from '../vault/index.js';

// POST /api/vault/register — Palisade-facing entry point.
//
// Palisade calls this at card personalisation time with the PAN + metadata
// and a caller-supplied idempotencyKey.  We return an opaque `vaultToken`
// that Palisade persists on its Card row (a plain string — no FK back into
// Vera's DB).  The same idempotencyKey on a retry returns the same token.
//
// No cardId: post-split, Vera does not know about Cards.  If two registers
// for the same PAN land with different idempotencyKeys, fingerprint dedup
// still collapses them to one vault entry (onDuplicate='reuse'), so Palisade
// cards sharing a PAN converge on a single vaultToken.  That's intentional —
// one PAN, one vault entry.

const router: Router = Router();

const registerSchema = z.object({
  pan: z.string().min(12).max(23),
  cvc: z.string().optional(),
  expiryMonth: z.string().regex(/^(0[1-9]|1[0-2])$/),
  expiryYear: z.string().regex(/^[0-9]{2,4}$/),
  cardholderName: z.string().min(1).max(128),
  // Caller-supplied. 8..128 chars covers cuids (25), UUIDs (36), and the
  // cardRef-style slugs Palisade already hands out.
  idempotencyKey: z.string().min(8).max(128),
});

router.post('/register', validateBody(registerSchema), async (req, res) => {
  const body = req.body as z.infer<typeof registerSchema>;
  const actor = requireCallerKeyId(req);

  const result = await storeCard({
    pan: body.pan,
    cvc: body.cvc,
    expiryMonth: body.expiryMonth,
    expiryYear: body.expiryYear,
    cardholderName: body.cardholderName,
    idempotencyKey: body.idempotencyKey,
    actor,
    purpose: `register ${body.idempotencyKey}`,
    ip: req.ip,
    ua: req.get('user-agent') ?? undefined,
    onDuplicate: 'reuse',
  });

  res.status(201).json({
    vaultToken: result.vaultEntryId,
    panLast4: result.panLast4,
  });
});

export default router;
