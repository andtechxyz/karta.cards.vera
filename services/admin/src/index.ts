import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import { errorMiddleware } from '@vera/core';
import { getAdminConfig } from './env.js';
import { ADMIN_KEY_HEADER, requireAdminKey } from './middleware/require-admin-key.js';
import programsRouter from './routes/programs.routes.js';
import cardsRouter from './routes/cards.routes.js';
import vaultProxyRouter from './routes/vault-proxy.routes.js';

const config = getAdminConfig();
const app = express();

// CORS allows the X-Admin-Key header from the browser.  Origin is wildcard
// for the prototype; tighten to `admin.karta.cards` once the demo is settled.
app.use(cors({ origin: '*', credentials: false, allowedHeaders: ['content-type', ADMIN_KEY_HEADER] }));
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

// Health is the ALB probe — must answer without auth.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'admin' });
});

// Every admin surface is gated on X-Admin-Key.  Mount the gate once so any
// route file added under /api/admin, /api/programs, /api/cards inherits it.
const adminGate = requireAdminKey(config.ADMIN_API_KEY);
app.use('/api/programs', adminGate, programsRouter);
app.use('/api/cards', adminGate, cardsRouter);
app.use('/api/admin/vault', adminGate, vaultProxyRouter);

app.use(errorMiddleware);

app.listen(config.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[admin] listening on :${config.PORT}`);
});
