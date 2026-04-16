import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { errorMiddleware, serveFrontend } from '@vera/core';
import {
  expirePendingTransactions,
  purgeExpiredRegistrationChallenges,
  startSweeper,
} from '@vera/retention';
import { getPayConfig } from './env.js';
import { requireAdminKey, ADMIN_KEY_HEADER } from './middleware/require-admin-key.js';
import { authRegisterRouter, authAuthenticateRouter } from './routes/auth.routes.js';
import transactionsRouter from './routes/transactions.routes.js';
import paymentRouter from './routes/payment.routes.js';
import webhooksRouter from './routes/webhooks/index.js';

const config = getPayConfig();
const app = express();

app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGINS, credentials: false, allowedHeaders: ['content-type', ADMIN_KEY_HEADER] }));
app.set('trust proxy', 1);

// Webhooks must get raw body BEFORE express.json()
app.use('/api/webhooks', webhooksRouter);

app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'pay', provider: config.PAYMENT_PROVIDER });
});

// Registration endpoints are admin-only (credential provisioning).
const adminGate = requireAdminKey(config.ADMIN_API_KEY);
app.use('/api/auth/register', adminGate, authRegisterRouter);
// Authentication endpoints are public (customer payment flow).
app.use('/api/auth/authenticate', authAuthenticateRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/payment', paymentRouter);

serveFrontend(app, import.meta.url);
app.use(errorMiddleware);

// PCI-DSS 3.1.  The read-path in transaction.service.ts also expires on
// access; this bulk sweep catches txns that are never observed again.
startSweeper({
  name: 'registration-challenges',
  intervalMs: 60_000,
  run: purgeExpiredRegistrationChallenges,
});
startSweeper({
  name: 'pending-transactions',
  intervalMs: 30_000,
  run: expirePendingTransactions,
});

app.listen(config.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[pay] listening on :${config.PORT} — provider=${config.PAYMENT_PROVIDER}`);
});
