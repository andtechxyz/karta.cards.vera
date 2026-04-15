import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import { errorMiddleware } from '@vera/core';
import { getAdminConfig } from './env.js';
import programsRouter from './routes/programs.routes.js';
import cardsRouter from './routes/cards.routes.js';

const config = getAdminConfig();
const app = express();

app.use(cors({ origin: '*', credentials: false }));
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'admin' });
});

app.use('/api/programs', programsRouter);
app.use('/api/cards', cardsRouter);

app.use(errorMiddleware);

app.listen(config.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[admin] listening on :${config.PORT}`);
});
