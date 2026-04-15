import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { hexKey } from '../config.js';
import { validateBody } from '../middleware/validate.js';
import { registerCard } from '../cards/index.js';
import { prisma } from '../db/prisma.js';
import { badRequest, notFound } from '../middleware/error.js';

const router: Router = Router();

const registerSchema = z.object({
  // Opaque slug — alphanumeric + hyphen/underscore, 4-64 chars.  Embedded in
  // the SDM URL path; never derived from card-side material.
  cardRef: z
    .string()
    .regex(/^[A-Za-z0-9_-]{4,64}$/, 'cardRef must be 4-64 alphanumeric / _ / -'),
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
// Production deployment will gate this on API key / mTLS for the agent identity.
router.post('/register', validateBody(registerSchema), async (req, res) => {
  const result = await registerCard({
    ...req.body,
    ip: req.ip,
    ua: req.get('user-agent') ?? undefined,
  });
  res.status(201).json(result);
});

// PATCH /api/cards/:id — admin-only card update.  The only field currently
// mutable post-registration is the program link, because reassigning a card
// to a different program reconfigures its tier rules without requiring a
// re-perso.  PAN, UID, SDM keys, and cardRef stay immutable.
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
      // Prisma bundles both "card missing" and "program connect missing"
      // under P2025 but distinguishes them in `meta.cause`:
      //   - card missing     → "Record to update not found."
      //   - program missing  → "No 'Program' record(s) ... nested connect ..."
      // Map the program variant to 400 so the admin sees "pick a real program"
      // rather than "this card disappeared".
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
