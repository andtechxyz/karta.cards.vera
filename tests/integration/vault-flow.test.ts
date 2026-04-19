/**
 * Integration tests for the Vault service HTTP layer.
 *
 * Builds the Express app from the same route/middleware modules used by
 * services/vault/src/index.ts.  Prisma is mocked; HMAC auth uses real
 * signRequest() with the test secrets from tests/setup.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Express } from 'express';
import 'express-async-errors';
import { signRequest, captureRawBody, requireSignedRequest } from '@vera/service-auth';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPrisma = vi.hoisted(() => ({
  vaultEntry: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  card: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  retrievalToken: {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  vaultAudit: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
}));
vi.mock('@vera/db', () => ({ prisma: mockPrisma }));

// Retention — suppress sweepers
vi.mock('@vera/retention', () => ({
  startSweeper: vi.fn(),
  purgeExpiredRetrievalTokens: vi.fn(),
}));

// Mock the vault's internal services
vi.mock('../../services/vault/src/vault/store.service.js', () => ({
  storeCard: vi.fn().mockResolvedValue({
    vaultEntryId: 'vault-entry-1',
    panLast4: '4242',
    deduped: false,
  }),
  listCards: vi.fn().mockResolvedValue([
    { id: 'card-1', cardRef: 'ref-1', panLast4: '4242' },
  ]),
  getCardMetadata: vi.fn(),
}));

vi.mock('../../services/vault/src/vault/retrieval.service.js', () => ({
  mintRetrievalToken: vi.fn().mockResolvedValue({
    token: 'tok_abc123',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }),
  consumeRetrievalToken: vi.fn().mockResolvedValue({
    card: { pan: '4242424242424242', last4: '4242' },
  }),
}));

vi.mock('../../services/vault/src/vault/proxy.service.js', () => ({
  forwardViaVault: vi.fn(),
}));

vi.mock('../../services/vault/src/vault/audit.service.js', () => ({
  startAuditSubscriber: vi.fn(),
  listAuditEvents: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/vault/src/vault/events.js', () => ({
  vaultEvents: { emit: vi.fn(), on: vi.fn() },
}));

// Mock serve-frontend and rate limiters
vi.mock('@vera/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    serveFrontend: vi.fn(),
    authRateLimit: (_req: any, _res: any, next: any) => next(),
    apiRateLimit: (_req: any, _res: any, next: any) => next(),
  };
});

// ---------------------------------------------------------------------------
// Constants from tests/setup.ts
// ---------------------------------------------------------------------------

const SERVICE_AUTH_KEYS: Record<string, string> = {
  pay: '5'.repeat(64),
  activation: '6'.repeat(64),
  admin: '7'.repeat(64),
  palisade: '8'.repeat(64),
};

// ---------------------------------------------------------------------------
// Build app
// ---------------------------------------------------------------------------

import { errorMiddleware } from '@vera/core';
import storeRouter from '../../services/vault/src/routes/store.routes.js';
import registerRouter from '../../services/vault/src/routes/register.routes.js';
import tokensRouter from '../../services/vault/src/routes/tokens.routes.js';
import cardsRouter from '../../services/vault/src/routes/cards.routes.js';
import auditRouter from '../../services/vault/src/routes/audit.routes.js';

function buildApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb', verify: captureRawBody }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'vault' });
  });

  const vaultRouter = express.Router();
  vaultRouter.use(requireSignedRequest({ keys: SERVICE_AUTH_KEYS }));
  vaultRouter.use(storeRouter);
  vaultRouter.use(registerRouter);
  vaultRouter.use(tokensRouter);
  vaultRouter.use(cardsRouter);
  vaultRouter.use(auditRouter);
  app.use('/api/vault', vaultRouter);

  app.use(errorMiddleware);
  return app;
}

/** Sign a JSON body for the given path using the 'pay' key. */
function signedHeaders(
  method: string,
  path: string,
  body: object | undefined = undefined,
  keyId = 'pay',
): Record<string, string> {
  const bodyBuf = body ? Buffer.from(JSON.stringify(body), 'utf8') : Buffer.alloc(0);
  const authorization = signRequest({
    method,
    pathAndQuery: path,
    body: bodyBuf,
    keyId,
    secret: SERVICE_AUTH_KEYS[keyId],
  });
  return { authorization };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Vault service — integration', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  // ---- Health ----
  describe('GET /api/health', () => {
    it('returns 200', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, service: 'vault' });
    });
  });

  // ---- Store ----
  describe('POST /api/vault/store', () => {
    const storePath = '/api/vault/store';
    const storeBody = {
      pan: '4242424242424242',
      expiryMonth: '12',
      expiryYear: '2028',
      cardholderName: 'Test User',
      purpose: 'integration_test',
    };

    it('rejects without HMAC', async () => {
      const res = await request(app)
        .post(storePath)
        .send(storeBody);
      expect(res.status).toBe(401);
    });

    it('returns 201 with valid HMAC', async () => {
      const headers = signedHeaders('POST', storePath, storeBody);
      const res = await request(app)
        .post(storePath)
        .set(headers)
        .send(storeBody);
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('vaultEntryId');
      expect(res.body).toHaveProperty('panLast4', '4242');
      expect(res.body).toHaveProperty('deduped', false);
    });
  });

  // ---- Register (Palisade-facing) ----
  describe('POST /api/vault/register', () => {
    const registerPath = '/api/vault/register';
    const registerBody = {
      pan: '4242424242424242',
      expiryMonth: '12',
      expiryYear: '2028',
      cardholderName: 'Test User',
      idempotencyKey: 'card_ref_abc123xyz',
    };

    it('rejects without HMAC', async () => {
      const res = await request(app)
        .post(registerPath)
        .send(registerBody);
      expect(res.status).toBe(401);
    });

    it('returns 201 with vaultToken for a Palisade-signed request', async () => {
      const headers = signedHeaders('POST', registerPath, registerBody, 'palisade');
      const res = await request(app)
        .post(registerPath)
        .set(headers)
        .send(registerBody);
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('vaultToken', 'vault-entry-1');
      expect(res.body).toHaveProperty('panLast4', '4242');
      // Palisade boundary — the response MUST NOT leak the internal Prisma
      // field name; vaultEntryId on this surface would signal a schema FK
      // coupling that Phase 2 explicitly cuts.
      expect(res.body).not.toHaveProperty('vaultEntryId');
      expect(res.body).not.toHaveProperty('deduped');
    });

    it('rejects when idempotencyKey is missing', async () => {
      const bad = { ...registerBody };
      delete (bad as Partial<typeof registerBody>).idempotencyKey;
      const headers = signedHeaders('POST', registerPath, bad, 'palisade');
      const res = await request(app)
        .post(registerPath)
        .set(headers)
        .send(bad);
      expect(res.status).toBe(400);
    });
  });

  // ---- Tokens: mint ----
  describe('POST /api/vault/tokens/mint', () => {
    const mintPath = '/api/vault/tokens/mint';
    const mintBody = {
      vaultEntryId: 'vault-entry-1',
      amount: 500,
      currency: 'AUD',
      purpose: 'integration_test',
    };

    it('returns 201 with valid HMAC', async () => {
      const headers = signedHeaders('POST', mintPath, mintBody);
      const res = await request(app)
        .post(mintPath)
        .set(headers)
        .send(mintBody);
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('expiresAt');
    });
  });

  // ---- Tokens: consume ----
  describe('POST /api/vault/tokens/consume', () => {
    const consumePath = '/api/vault/tokens/consume';
    const consumeBody = {
      token: 'tok_abc123',
      expectedAmount: 500,
      expectedCurrency: 'AUD',
      purpose: 'integration_test',
    };

    it('returns 200 with valid token', async () => {
      const headers = signedHeaders('POST', consumePath, consumeBody);
      const res = await request(app)
        .post(consumePath)
        .set(headers)
        .send(consumeBody);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('card');
      expect(res.body.card).toHaveProperty('pan');
      expect(res.body.card).toHaveProperty('last4');
    });
  });

  // ---- Cards ----
  describe('GET /api/vault/cards', () => {
    const cardsPath = '/api/vault/cards';

    it('returns 200 array with valid HMAC', async () => {
      // cards.routes.ts calls prisma.card.findMany directly
      mockPrisma.card.findMany.mockResolvedValue([
        {
          id: 'card-1',
          cardRef: 'ref-1',
          status: 'ACTIVATED',
          chipSerial: null,
          programId: null,
          program: null,
          batchId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          vaultEntry: { id: 've-1', panLast4: '4242', panBin: '424242', cardholderName: 'Test' },
          credentials: [],
          activationSessions: [],
        },
      ]);

      const headers = signedHeaders('GET', cardsPath);
      const res = await request(app)
        .get(cardsPath)
        .set(headers);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // ---- No CORS headers (vault is internal-only) ----
  describe('CORS', () => {
    it('does not set access-control-allow-origin', async () => {
      const res = await request(app)
        .get('/api/health')
        .set('Origin', 'https://evil.com');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
