import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import { errorMiddleware } from '@vera/core';
import { getActivationConfig } from './env.js';
import activationRouter from './routes/activation.routes.js';
import cardsRouter from './routes/cards.routes.js';

const config = getActivationConfig();
const app = express();

app.use(cors({ origin: '*', credentials: false }));
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'activation' });
});

app.use('/api/activation', activationRouter);
app.use('/api/cards', cardsRouter);

app.use(errorMiddleware);

app.listen(config.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[activation] listening on :${config.PORT}`);
});
