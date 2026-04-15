import { Router } from 'express';
import storeRouter from './store.routes.js';
import proxyRouter from './proxy.routes.js';
import auditRouter from './audit.routes.js';

// Mount point for /api/vault.  Adding new vault capabilities (aliases,
// reactors, search, webhooks) means a new routes file + a new .use() call
// here — nothing else changes.
const vaultRouter: Router = Router();

vaultRouter.use(storeRouter);
vaultRouter.use(proxyRouter);
vaultRouter.use(auditRouter);

export default vaultRouter;
