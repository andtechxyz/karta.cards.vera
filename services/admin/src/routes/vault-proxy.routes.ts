import { Router } from 'express';
import { z } from 'zod';
import { ApiError, validateBody } from '@vera/core';
import { createVaultClient, VaultClientError } from '@vera/vault-client';
import { getAdminConfig } from '../env.js';

// -----------------------------------------------------------------------------
// Admin → vault proxy.  The admin browser authenticates to *this* service with
// the X-Admin-Key header; this router then signs an outbound HMAC request to
// vault as keyId='admin' and relays the response.
//
// PCI-DSS 10.2.1: the vault records 'admin' as the audit actor — not the end
// user.  That's fine at prototype scale because admin has one human operator,
// but the upgrade path is obvious: add an ADMIN_USERS map keyed by API key and
// put the resolved user identity into `purpose` on every vault call.
// -----------------------------------------------------------------------------

const router: Router = Router();

// Lazy vault client so tests can load the module without a real env.
let vaultClient: ReturnType<typeof createVaultClient> | null = null;
function getVault() {
  if (!vaultClient) {
    const cfg = getAdminConfig();
    vaultClient = createVaultClient(cfg.VAULT_SERVICE_URL, {
      keyId: 'admin',
      secret: cfg.SERVICE_AUTH_ADMIN_SECRET,
    });
  }
  return vaultClient;
}

// Mirror vault's HTTP status+code back to the browser by lifting VaultClientError
// into ApiError — express-async-errors + errorMiddleware then serialize it as
// `{ error: { code, message } }`, matching every other route's shape.
async function callVault<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VaultClientError) {
      throw new ApiError(err.status, err.code, err.message);
    }
    throw err;
  }
}

const storeSchema = z.object({
  cardId: z.string().min(1),
  pan: z.string().min(12).max(23),
  cvc: z.string().optional(),
  expiryMonth: z.string().regex(/^(0[1-9]|1[0-2])$/),
  expiryYear: z.string().regex(/^[0-9]{2,4}$/),
  cardholderName: z.string().min(1).max(128),
  onDuplicate: z.enum(['error', 'reuse']).optional(),
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

router.get('/cards', async (_req, res) => {
  const cards = await callVault(() => getVault().listCards());
  res.json(cards);
});

router.get('/audit', async (req, res) => {
  const { limit, offset } = auditQuerySchema.parse(req.query);
  const rows = await callVault(() => getVault().listAudit({ limit, offset }));
  res.json(rows);
});

router.post('/store', validateBody(storeSchema), async (req, res) => {
  const body = req.body as z.infer<typeof storeSchema>;
  const result = await callVault(() =>
    getVault().storeCard({
      cardId: body.cardId,
      pan: body.pan,
      cvc: body.cvc,
      expiryMonth: body.expiryMonth,
      expiryYear: body.expiryYear,
      cardholderName: body.cardholderName,
      onDuplicate: body.onDuplicate,
      purpose: 'admin_vault_ui',
    }),
  );
  res.status(201).json(result);
});

export default router;
