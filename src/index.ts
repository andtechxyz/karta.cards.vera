import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import { getConfig } from './config.js';
import { errorMiddleware } from './middleware/error.js';
import { startAuditSubscriber } from './vault/index.js';

import vaultRouter from './routes/vault/index.js';
import transactionsRouter from './routes/transactions.routes.js';
import authRouter from './routes/auth.routes.js';
import paymentRouter from './routes/payment.routes.js';
import webhooksRouter from './routes/webhooks/index.js';

const config = getConfig();
const app = express();

app.use(
  cors({
    origin: config.WEBAUTHN_ORIGIN,
    credentials: false,
  }),
);

app.set('trust proxy', 1); // Cloudflare Tunnel → need the X-Forwarded-For IP

// ---- Webhooks (raw body) BEFORE express.json() -----------------------------
// Stripe signs the exact request bytes.  Mounting the webhook router first,
// with its own raw body-parser per route, keeps the signature verifiable.
app.use('/api/webhooks', webhooksRouter);

// ---- Everything else: JSON --------------------------------------------------
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    rpId: config.WEBAUTHN_RP_ID,
    provider: config.PAYMENT_PROVIDER,
  });
});

app.use('/api/vault', vaultRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/auth', authRouter);
app.use('/api/payment', paymentRouter);

app.use(errorMiddleware);

// Start the audit subscriber so every vault event writes a VaultAccessLog row.
// Subscriber is process-lifetime; errors in audit are logged but never bubble
// up into vault operations (see src/vault/audit.service.ts).
startAuditSubscriber();

app.listen(config.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[vera] listening on :${config.PORT} — RP ID ${config.WEBAUTHN_RP_ID}, provider=${config.PAYMENT_PROVIDER}`,
  );
});
