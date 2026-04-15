import { Router } from 'express';
import { z } from 'zod';
import { validateBody, hexKey } from '@vera/core';
import { registerCard } from '../cards/index.js';

const router: Router = Router();

const registerSchema = z.object({
  cardRef: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/, 'cardRef must be 4-64 alphanumeric / _ / -'),
  uid: hexKey(7),
  chipSerial: z.string().max(64).optional(),
  sdmMetaReadKey: hexKey(16),
  sdmFileReadKey: hexKey(16),
  programId: z.string().max(64).optional(),
  batchId: z.string().max(64).optional(),
  card: z.object({
    pan: z.string().min(12).max(23),
    cvc: z.string().optional(),
    expiryMonth: z.string().regex(/^(0[1-9]|1[0-2])$/),
    expiryYear: z.string().regex(/^[0-9]{2,4}$/),
    cardholderName: z.string().min(1).max(128),
  }),
});

// POST /api/cards/register — called by Palisade's provisioning-agent.
router.post('/register', validateBody(registerSchema), async (req, res) => {
  const result = await registerCard({
    ...req.body,
    ip: req.ip,
    ua: req.get('user-agent') ?? undefined,
  });
  res.status(201).json(result);
});

export default router;
