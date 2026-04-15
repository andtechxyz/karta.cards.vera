import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '@vera/core';
import { requireCallerKeyId } from '@vera/service-auth';
import { forwardViaVault } from '../vault/index.js';

const router: Router = Router();

const proxySchema = z.object({
  retrievalToken: z.string().min(16),
  destination: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  expectedAmount: z.number().int().nonnegative(),
  expectedCurrency: z.string().min(3).max(8),
  purpose: z.string().min(1).max(256),
  transactionId: z.string().optional(),
  ip: z.string().optional(),
  ua: z.string().optional(),
});

router.post('/proxy', validateBody(proxySchema), async (req, res) => {
  const body = req.body as z.infer<typeof proxySchema>;
  const actor = requireCallerKeyId(req);
  const result = await forwardViaVault({
    retrievalToken: body.retrievalToken,
    destination: body.destination,
    method: body.method,
    headers: body.headers,
    body: body.body,
    expectedAmount: body.expectedAmount,
    expectedCurrency: body.expectedCurrency,
    actor,
    purpose: body.purpose,
    ip: body.ip ?? req.ip,
    ua: body.ua ?? req.get('user-agent') ?? undefined,
    transactionId: body.transactionId,
  });

  const SAFE_OUT_HEADERS = new Set(['content-type']);
  for (const [k, v] of Object.entries(result.responseHeaders)) {
    if (SAFE_OUT_HEADERS.has(k)) res.setHeader(k, v);
  }
  res.status(result.status).send(result.responseBody);
});

export default router;
