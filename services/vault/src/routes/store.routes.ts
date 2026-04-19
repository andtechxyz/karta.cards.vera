import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '@vera/core';
import { requireCallerKeyId } from '@vera/service-auth';
import { storeCard } from '../vault/index.js';

const router: Router = Router();

// Phase 1+ split: Card lookups + vault-entry linking to a Card both moved
// off vault.  Card registration flows use POST /api/vault/register (added
// in Phase 2) which mints the VaultEntry + returns an opaque vaultToken
// that Palisade stores on its Card row directly.  /store no longer
// accepts cardId — the admin card-management flow was retired with
// Vera's card-domain schema.
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
  onDuplicate: z.enum(['error', 'reuse']).optional(),
});

router.post('/store', validateBody(storeSchema), async (req, res) => {
  const body = req.body as z.infer<typeof storeSchema>;
  const actor = requireCallerKeyId(req);

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

  res.status(201).json(result);
});

export default router;
