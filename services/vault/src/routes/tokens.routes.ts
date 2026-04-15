import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '@vera/core';
import { requireCallerKeyId } from '@vera/service-auth';
import { mintRetrievalToken, consumeRetrievalToken } from '../vault/index.js';

// Internal endpoints consumed exclusively by @vera/vault-client (pay service).
// Not exposed to browsers — vault sits behind an internal network boundary.
//
// The actor for every audit row is the verified HMAC keyId (req.callerKeyId);
// callers cannot self-report an identity.  `purpose` remains free-form context.

const router: Router = Router();

const mintSchema = z.object({
  vaultEntryId: z.string().min(1),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(3).max(8),
  purpose: z.string().min(1).max(256),
  transactionId: z.string().optional(),
  ip: z.string().optional(),
  ua: z.string().optional(),
});

router.post('/tokens/mint', validateBody(mintSchema), async (req, res) => {
  const body = req.body as z.infer<typeof mintSchema>;
  const actor = requireCallerKeyId(req);
  const result = await mintRetrievalToken({ ...body, actor });
  res.status(201).json(result);
});

const consumeSchema = z.object({
  token: z.string().min(1),
  expectedAmount: z.number().int().nonnegative(),
  expectedCurrency: z.string().min(3).max(8),
  purpose: z.string().min(1).max(256),
  transactionId: z.string().optional(),
  ip: z.string().optional(),
  ua: z.string().optional(),
});

router.post('/tokens/consume', validateBody(consumeSchema), async (req, res) => {
  const body = req.body as z.infer<typeof consumeSchema>;
  const actor = requireCallerKeyId(req);
  const result = await consumeRetrievalToken(body.token, {
    expectedAmount: body.expectedAmount,
    expectedCurrency: body.expectedCurrency,
    actor,
    purpose: body.purpose,
    transactionId: body.transactionId,
    ip: body.ip,
    ua: body.ua,
  });
  res.json(result);
});

export default router;
