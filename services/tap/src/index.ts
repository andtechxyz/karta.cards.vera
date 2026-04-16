import 'express-async-errors';
import express from 'express';
import { errorMiddleware, authRateLimit } from '@vera/core';
import { getTapConfig } from './env.js';
import sunTapRouter from './routes/sun-tap.routes.js';

const config = getTapConfig();
const app = express();

// No CORS — tap handles NFC redirects only (GET → 302).  No browser fetch calls.
app.set('trust proxy', 1);

app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'tap' });
});

// SUN-tap — mounted at root because the URL baked into the NFC chip has
// no /api prefix.  Rate-limit to prevent replay brute-force.
app.use('/activate', authRateLimit);
app.use('/', sunTapRouter);

app.use(errorMiddleware);

app.listen(config.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[tap] listening on :${config.PORT}`);
});
