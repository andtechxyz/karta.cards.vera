import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { validateBody } from '../../middleware/validate.js';
import { storeCard } from '../../vault/index.js';
import { notFound, badRequest } from '../../middleware/error.js';

const router: Router = Router();

// --- Cards (admin read-only) -----------------------------------------------
//
// Cards are NOT created here.  In the production lifecycle, Palisade's
// provisioning-agent calls `POST /api/cards/register` after data-prep + perso;
// in dev / testing, the same endpoint is the only way in.  Admin sees an
// opaque view (no PICC UID, no SDM key material) — just enough to reason
// about state, credentials, and the linked vault entry.

router.get('/cards', async (_req, res) => {
  const cards = await prisma.card.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      cardRef: true,
      status: true,
      chipSerial: true,
      programId: true,
      batchId: true,
      createdAt: true,
      updatedAt: true,
      vaultEntry: {
        select: { id: true, panLast4: true, panBin: true, cardholderName: true },
      },
      credentials: {
        select: { id: true, kind: true, deviceName: true, createdAt: true, lastUsedAt: true },
      },
      // Latest in-flight activation session, if any — drives the admin UI's
      // "tap pending / activated / never tapped" indicator.  Only the most
      // recent matters; older sessions are either consumed or expired noise.
      activationSessions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          expiresAt: true,
          consumedAt: true,
          consumedDeviceLabel: true,
          createdAt: true,
        },
      },
    },
  });
  res.json(cards);
});

// --- Vault (tokenise) ------------------------------------------------------

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

  // Link the vault entry to the card.  Status stays as-is (typically
  // PERSONALISED) — the cardholder promotes it to ACTIVATED via the SUN-tap
  // activation flow, not as a side effect of vaulting.
  await prisma.card.update({
    where: { id: cardId },
    data: { vaultEntryId: result.vaultEntryId },
  });

  res.status(201).json(result);
});

export default router;
