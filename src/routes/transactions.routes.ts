import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import {
  createTransaction,
  getTransactionByRlid,
  listTransactions,
} from '../transactions/index.js';
import { publish } from '../realtime/index.js';
import { getConfig } from '../config.js';

const router: Router = Router();

const createSchema = z.object({
  cardId: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.string().min(3).max(8).default('USD'),
  merchantRef: z.string().min(1).max(128),
  merchantName: z.string().min(1).max(128).optional(),
});

router.post('/', validateBody(createSchema), async (req, res) => {
  const txn = await createTransaction(req.body);
  publish(txn.rlid, 'transaction_created', {
    amount: txn.amount,
    currency: txn.currency,
    tier: txn.tier,
    merchantName: txn.merchantName,
    expiresAt: txn.expiresAt,
  });
  res.status(201).json({
    id: txn.id,
    rlid: txn.rlid,
    status: txn.status,
    tier: txn.tier,
    amount: txn.amount,
    currency: txn.currency,
    merchantRef: txn.merchantRef,
    merchantName: txn.merchantName,
    challengeNonce: txn.challengeNonce,
    expiresAt: txn.expiresAt,
  });
});

router.get('/:rlid', async (req, res) => {
  const txn = await getTransactionByRlid(req.params.rlid);
  res.json({
    id: txn.id,
    rlid: txn.rlid,
    status: txn.status,
    tier: txn.tier,
    actualTier: txn.actualTier,
    amount: txn.amount,
    currency: txn.currency,
    merchantRef: txn.merchantRef,
    merchantName: txn.merchantName,
    challengeNonce: txn.challengeNonce,
    expiresAt: txn.expiresAt,
    cardId: txn.cardId,
  });
});

router.post('/:rlid/qr', async (req, res) => {
  const txn = await getTransactionByRlid(req.params.rlid);
  // The QR encodes the full customer-facing URL at /pay/{rlid} on the RP origin.
  const origin = getConfig().WEBAUTHN_ORIGIN;
  const url = `${origin}/pay/${txn.rlid}`;
  const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
  res.json({ url, qr: dataUrl, expiresAt: txn.expiresAt });
});

router.get('/', async (_req, res) => {
  res.json(await listTransactions());
});

export default router;
