import { Router } from 'express';
import { prisma } from '@vera/db';

const router: Router = Router();

// Admin-readable card list (no PII, no SDM keys).
router.get('/cards', async (_req, res) => {
  const cards = await prisma.card.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      cardRef: true,
      status: true,
      chipSerial: true,
      programId: true,
      program: { select: { id: true, name: true, currency: true } },
      batchId: true,
      createdAt: true,
      updatedAt: true,
      vaultEntry: {
        select: { id: true, panLast4: true, panBin: true, cardholderName: true },
      },
      credentials: {
        select: { id: true, kind: true, deviceName: true, createdAt: true, lastUsedAt: true },
      },
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

export default router;
