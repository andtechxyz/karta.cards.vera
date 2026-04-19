import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { errorMiddleware, serveFrontend, apiRateLimit } from '@vera/core';
import { createCognitoAuthMiddleware } from '@vera/cognito-auth';
import { getAdminConfig } from './env.js';
import vaultProxyRouter from './routes/vault-proxy.routes.js';
import payProxyRouter from './routes/pay-proxy.routes.js';

// Vera-side admin — vault audit + transaction tabs only.  Card-domain admin
// (programs, cards, embossing, partner, provisioning, microsites) moved to
// Palisade in Phase 4a.  Frontend talks to both backends; capability gating
// is Phase 4d.

const config = getAdminConfig();
const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'connect-src': ["'self'", 'https://cognito-idp.ap-southeast-2.amazonaws.com'],
    },
  },
}));
app.use(cors({ origin: config.CORS_ORIGINS, credentials: false, allowedHeaders: ['content-type', 'authorization'] }));
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

// Health is the ALB probe — must answer without auth.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'admin' });
});

// Rate limit all API routes before auth checks.
app.use('/api', apiRateLimit);

// Cognito JWT with 'admin' group membership required.
const adminAuth = createCognitoAuthMiddleware({
  userPoolId: config.COGNITO_USER_POOL_ID,
  clientId: config.COGNITO_CLIENT_ID,
  requiredGroup: 'admin',
});
app.use('/api/admin/vault', adminAuth, vaultProxyRouter);
// Pay service proxy for admin UI's transaction tabs
app.use('/api', adminAuth, payProxyRouter);

serveFrontend(app, import.meta.url);
app.use(errorMiddleware);

app.listen(config.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[admin] listening on :${config.PORT}`);
});
