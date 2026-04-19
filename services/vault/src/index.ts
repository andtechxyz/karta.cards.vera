import 'express-async-errors';
import express from 'express';
import { errorMiddleware } from '@vera/core';
import { captureRawBody, requireSignedRequest } from '@vera/service-auth';
import { purgeExpiredRetrievalTokens, startSweeper } from '@vera/retention';
import { getVaultConfig } from './env.js';
import { startAuditSubscriber } from './vault/index.js';
import storeRouter from './routes/store.routes.js';
import registerRouter from './routes/register.routes.js';
import tokensRouter from './routes/tokens.routes.js';
import proxyRouter from './routes/proxy.routes.js';
import auditRouter from './routes/audit.routes.js';

const config = getVaultConfig();
const app = express();

// No CORS — vault is service-to-service only (internal ALB, HMAC-gated).
// Browsers never call vault directly; admin proxies through its own backend.
app.set('trust proxy', 1);
// `verify` captures the raw body bytes so requireSignedRequest can hash them
// without re-stringifying the parsed object (which is lossy — JSON key order
// and whitespace are not canonical).
app.use(express.json({ limit: '64kb', verify: captureRawBody }));

// Health is the ALB probe — must be reachable without auth.  Keep it tiny and
// don't route it through the signed-request middleware.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'vault' });
});

// Every CHD surface is gated by HMAC-signed request auth.  PCI-DSS 7.1/7.2/8.2:
// identify the caller before access; 10.x: the keyId lands on req.callerKeyId
// for audit attribution.
const vaultRouter = express.Router();
vaultRouter.use(requireSignedRequest({ keys: config.SERVICE_AUTH_KEYS }));
vaultRouter.use(storeRouter);
vaultRouter.use(registerRouter);
vaultRouter.use(tokensRouter);
vaultRouter.use(proxyRouter);
vaultRouter.use(auditRouter);
app.use('/api/vault', vaultRouter);

app.use(errorMiddleware);

startAuditSubscriber();

// PCI-DSS 3.1: RetrievalToken TTL isn't DB-enforced.  Sweep cadence matches
// the TTL, so worst-case a consumed/expired token lingers ~2×TTL.
startSweeper({
  name: 'retrieval-tokens',
  intervalMs: 60_000,
  run: purgeExpiredRetrievalTokens,
});

app.listen(config.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[vault] listening on :${config.PORT}`);
});
