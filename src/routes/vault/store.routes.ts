import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { validateBody } from '../../middleware/validate.js';
import { storeCard, listCards } from '../../vault/index.js';
import { CardStatus } from '@prisma/client';
import { notFound, badRequest } from '../../middleware/error.js';

const router: Router = Router();

// --- Card lifecycle (admin) ------------------------------------------------

const createCardSchema = z.object({
  // If omitted, we generate a random 14-hex (7-byte) PICC UID.
  cardIdentifier: z
    .string()
    .regex(/^[0-9a-fA-F]{14}$/)
    .optional(),
});

function randomPiccUid(): string {
  // 7 random bytes, lowercase hex — matches the UID format New T4T stores.
  const buf = Buffer.alloc(7);
  for (let i = 0; i < 7; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf.toString('hex');
}

router.post('/cards', validateBody(createCardSchema), async (req, res) => {
  const identifier = req.body.cardIdentifier ?? randomPiccUid();
  const exists = await prisma.card.findUnique({ where: { cardIdentifier: identifier } });
  if (exists) throw badRequest('card_exists', 'A card with that identifier already exists');

  const card = await prisma.card.create({
    data: { cardIdentifier: identifier, status: CardStatus.BLANK },
  });
  res.status(201).json(card);
});

router.get('/cards', async (_req, res) => {
  const cards = await prisma.card.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      vaultEntry: {
        select: { id: true, panLast4: true, panBin: true, cardholderName: true },
      },
      credentials: {
        select: { id: true, kind: true, deviceName: true, createdAt: true, lastUsedAt: true },
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

  // Link the vault entry to the card and mark card ACTIVATED.
  await prisma.card.update({
    where: { id: cardId },
    data: { vaultEntryId: result.vaultEntryId, status: CardStatus.ACTIVATED },
  });

  res.status(201).json(result);
});

router.get('/cards-meta', async (_req, res) => {
  res.json(await listCards());
});

export default router;
