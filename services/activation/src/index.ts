import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import { errorMiddleware, serveFrontend } from '@vera/core';
import { captureRawBody, requireSignedRequest } from '@vera/service-auth';
import { purgeExpiredActivationSessions, startSweeper } from '@vera/retention';
import { getActivationConfig } from './env.js';
import activationRouter from './routes/activation.routes.js';
import cardsRouter from './routes/cards.routes.js';

const config = getActivationConfig();
const app = express();

app.use(cors({ origin: '*', credentials: false }));
app.set('trust proxy', 1);
// `verify` captures the raw body bytes so requireSignedRequest can hash them
// for HMAC verification on provisioning-agent endpoints.
app.use(express.json({ limit: '64kb', verify: captureRawBody }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'activation' });
});

app.use('/api/activation', activationRouter);

// Provisioning-agent surface — PAN + UID + SDM keys arrive here.  HMAC-gated
// so only callers with a key in PROVISION_AUTH_KEYS can register cards.
const provisionGate = requireSignedRequest({ keys: config.PROVISION_AUTH_KEYS });
app.use('/api/cards', provisionGate, cardsRouter);

serveFrontend(app, import.meta.url);
app.use(errorMiddleware);

// PCI-DSS 3.1.  Consumed sessions stay as the per-card activation audit trail.
startSweeper({
  name: 'activation-sessions',
  intervalMs: 60_000,
  run: purgeExpiredActivationSessions,
});

app.listen(config.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[activation] listening on :${config.PORT}`);
});
