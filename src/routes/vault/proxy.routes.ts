import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../../middleware/validate.js';
import { forwardViaVault } from '../../vault/index.js';

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
});

router.post('/proxy', validateBody(proxySchema), async (req, res) => {
  const body = req.body as z.infer<typeof proxySchema>;
  const result = await forwardViaVault({
    retrievalToken: body.retrievalToken,
    destination: body.destination,
    method: body.method,
    headers: body.headers,
    body: body.body,
    expectedAmount: body.expectedAmount,
    expectedCurrency: body.expectedCurrency,
    actor: 'proxy_caller',
    purpose: body.purpose,
    ip: req.ip,
    ua: req.get('user-agent') ?? undefined,
    transactionId: body.transactionId,
  });

  // Pass through the upstream response verbatim — status, (safe) headers, body.
  // Strip hop-by-hop headers and anything ambiguous.
  const SAFE_OUT_HEADERS = new Set(['content-type']);
  for (const [k, v] of Object.entries(result.responseHeaders)) {
    if (SAFE_OUT_HEADERS.has(k)) res.setHeader(k, v);
  }
  res.status(result.status).send(result.responseBody);
});

export default router;
