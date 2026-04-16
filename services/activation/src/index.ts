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

app.use(cors({ origin: config.CORS_ORIGINS, credentials: false }));
app.set('trust proxy', 1);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'activation' });
});

// JSON parsing is per-route-group so the HMAC surface gets captureRawBody
// while public activation routes skip the per-request Buffer copy.
app.use('/api/activation', express.json({ limit: '64kb' }), activationRouter);

const provisionGate = requireSignedRequest({ keys: config.PROVISION_AUTH_KEYS });
app.use('/api/cards',
  express.json({ limit: '64kb', verify: captureRawBody }),
  provisionGate,
  cardsRouter,
);

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
