import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { validateBody } from '@vera/core';
import {
  createTransaction,
  getTransactionByRlid,
  getTransactionCardSummary,
  listTransactions,
  toTransactionDto,
} from '../transactions/index.js';
import { currencySchema } from '../programs/index.js';
import { publish } from '../realtime/index.js';
import { getPayConfig } from '../env.js';

const router: Router = Router();

const createSchema = z.object({
  cardId: z.string().min(1),
  amount: z.number().int().positive(),
  currency: currencySchema.default('AUD'),
  merchantRef: z.string().min(1).max(128),
  merchantName: z.string().min(1).max(128).optional(),
});

router.post('/', validateBody(createSchema), async (req, res) => {
  const txn = await createTransaction(req.body);
  publish(txn.rlid, 'transaction_created', {
    amount: txn.amount,
    currency: txn.currency,
    tier: txn.tier,
    allowedCredentialKinds: txn.allowedCredentialKinds,
    merchantName: txn.merchantName,
    expiresAt: txn.expiresAt,
  });
  res.status(201).json(toTransactionDto(txn));
});

router.get('/:rlid', async (req, res) => {
  res.json(toTransactionDto(await getTransactionByRlid(req.params.rlid)));
});

router.get('/:rlid/card', async (req, res) => {
  res.json(await getTransactionCardSummary(req.params.rlid));
});

router.post('/:rlid/qr', async (req, res) => {
  const txn = await getTransactionByRlid(req.params.rlid);
  // Use pay's origin for the QR URL — customer scans to pay.karta.cards
  const origin = `https://pay.karta.cards`;
  const config = getPayConfig();
  const payOrigin = config.NODE_ENV === 'development' ? `http://localhost:5175` : origin;
  const url = `${payOrigin}/pay/${txn.rlid}`;
  const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
  res.json({ url, qr: dataUrl, expiresAt: txn.expiresAt });
});

router.get('/', async (_req, res) => {
  res.json(await listTransactions());
});

export default router;
