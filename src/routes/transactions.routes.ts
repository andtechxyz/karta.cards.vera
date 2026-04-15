import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import {
  createTransaction,
  getTransactionByRlid,
  getTransactionCardSummary,
  listTransactions,
  toTransactionDto,
} from '../transactions/index.js';
import { currencySchema } from '../programs/index.js';
import { publish } from '../realtime/index.js';
import { getConfig } from '../config.js';

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

// Card summary scoped to a single RLID — feeds the customer page without
// leaking any other card metadata.  Holding the RLID is the only capability.
router.get('/:rlid/card', async (req, res) => {
  res.json(await getTransactionCardSummary(req.params.rlid));
});

router.post('/:rlid/qr', async (req, res) => {
  const txn = await getTransactionByRlid(req.params.rlid);
  const origin = getConfig().WEBAUTHN_ORIGIN;
  const url = `${origin}/pay/${txn.rlid}`;
  const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
  res.json({ url, qr: dataUrl, expiresAt: txn.expiresAt });
});

router.get('/', async (_req, res) => {
  res.json(await listTransactions());
});

export default router;
