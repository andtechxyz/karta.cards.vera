import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import { errorMiddleware } from '@vera/core';
import { getVaultConfig } from './env.js';
import { startAuditSubscriber } from './vault/index.js';
import storeRouter from './routes/store.routes.js';
import tokensRouter from './routes/tokens.routes.js';
import proxyRouter from './routes/proxy.routes.js';
import auditRouter from './routes/audit.routes.js';
import cardsRouter from './routes/cards.routes.js';

const config = getVaultConfig();
const app = express();

app.use(cors({ origin: '*', credentials: false }));
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'vault' });
});

app.use('/api/vault', storeRouter);
app.use('/api/vault', tokensRouter);
app.use('/api/vault', proxyRouter);
app.use('/api/vault', auditRouter);
app.use('/api/vault', cardsRouter);

app.use(errorMiddleware);

startAuditSubscriber();

app.listen(config.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[vault] listening on :${config.PORT}`);
});
