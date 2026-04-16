/**
 * Integration tests for the Pay service HTTP layer.
 *
 * Builds the Express app from the same route/middleware modules used by
 * services/pay/src/index.ts but avoids importing index.ts directly (it
 * calls .listen() and starts sweepers).  Prisma, vault-client, and the
 * retention module are mocked; what's under test is the HTTP routing,
 * middleware pipeline, serialisation, and security headers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Express } from 'express';
import 'express-async-errors';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing SUT modules.
// vi.hoisted() makes the mock objects available inside vi.mock() factories,
// which are hoisted to the top of the file by Vitest.
// ---------------------------------------------------------------------------

const mockPrisma = vi.hoisted(() => ({
  transaction: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  card: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock('@vera/db', () => ({ prisma: mockPrisma }));

// Vault client
vi.mock('@vera/vault-client', () => ({
  createVaultClient: () => ({}),
  VaultClientError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

// Retention — suppress sweepers
vi.mock('@vera/retention', () => ({
  startSweeper: vi.fn(),
  expirePendingTransactions: vi.fn(),
  purgeExpiredRegistrationChallenges: vi.fn(),
  TRANSACTION_TTL_ELAPSED_REASON: 'ttl_elapsed',
}));

// Programs — needed by transaction.service
vi.mock('@vera/programs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveRulesFromProgram: vi.fn().mockReturnValue({
      rules: [],
      currency: 'AUD',
      programId: 'test-program',
    }),
    normaliseCurrency: (c: string) => c.toUpperCase(),
  };
});

// WebAuthn — mock the registration/authentication modules
vi.mock('../../services/pay/src/webauthn/index.js', () => ({
  beginRegistration: vi.fn().mockResolvedValue({ challenge: 'test' }),
  finishRegistration: vi.fn().mockResolvedValue({
    id: 'cred-1',
    credentialId: 'cred-id',
    kind: 'PASSKEY',
    deviceName: 'test',
  }),
  beginAuthentication: vi.fn().mockResolvedValue({ challenge: 'test' }),
  finishAuthentication: vi.fn().mockResolvedValue({ credentialId: 'cred-id' }),
}));

// Orchestration
vi.mock('../../services/pay/src/orchestration/index.js', () => ({
  orchestratePostAuth: vi.fn().mockResolvedValue({ status: 'completed' }),
}));

// serve-frontend is a no-op in tests (no dist directory)
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
// Build the Express app (mirrors services/pay/src/index.ts without .listen)
// ---------------------------------------------------------------------------

import helmet from 'helmet';
import cors from 'cors';
import { errorMiddleware, validateBody } from '@vera/core';
import { requireAdminKey, ADMIN_KEY_HEADER } from '../../services/pay/src/middleware/require-admin-key.js';
import { authRegisterRouter, authAuthenticateRouter } from '../../services/pay/src/routes/auth.routes.js';
import transactionsRouter from '../../services/pay/src/routes/transactions.routes.js';
import paymentRouter from '../../services/pay/src/routes/payment.routes.js';

const TEST_ADMIN_KEY = '9'.repeat(64); // matches ADMIN_API_KEY from tests/setup.ts

function buildApp(): Express {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: '*', credentials: false, allowedHeaders: ['content-type', ADMIN_KEY_HEADER] }));
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'pay', provider: 'mock' });
  });

  const adminGate = requireAdminKey(TEST_ADMIN_KEY);
  app.use('/api/auth/register', adminGate, authRegisterRouter);
  app.use('/api/auth/authenticate', authAuthenticateRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/payment', paymentRouter);
  app.use(errorMiddleware);

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pay service — integration', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  // ---- Health ----
  describe('GET /api/health', () => {
    it('returns 200 with service identity', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, service: 'pay' });
    });
  });

  // ---- Transactions: auth gate ----
  describe('POST /api/transactions', () => {
    it('rejects without X-Admin-Key', async () => {
      const res = await request(app)
        .post('/api/transactions')
        .send({ cardId: 'c1', amount: 100, merchantRef: 'ref' });
      expect(res.status).toBe(401);
    });

    it('rejects with admin key but invalid body', async () => {
      const res = await request(app)
        .post('/api/transactions')
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .send({ amount: 'not-a-number' }); // missing required fields
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/transactions', () => {
    it('rejects without admin key', async () => {
      const res = await request(app).get('/api/transactions');
      expect(res.status).toBe(401);
    });
  });

  // ---- Transactions: lookup by rlid ----
  describe('GET /api/transactions/:rlid', () => {
    it('returns 200 with transaction DTO for known rlid', async () => {
      const fakeTxn = {
        id: 'txn-1',
        rlid: 'abc123abc123',
        status: 'PENDING',
        tier: 'TAP',
        actualTier: null,
        allowedCredentialKinds: ['NFC'],
        amount: 500,
        currency: 'AUD',
        merchantRef: 'merch-1',
        merchantName: 'Test Merchant',
        challengeNonce: 'nonce-xyz',
        expiresAt: new Date(Date.now() + 300_000),
        cardId: 'card-internal-id',
      };
      mockPrisma.transaction.findUnique.mockResolvedValue(fakeTxn);

      const res = await request(app).get('/api/transactions/abc123abc123');
      expect(res.status).toBe(200);
      // DTO must NOT include cardId (internal)
      expect(res.body).not.toHaveProperty('cardId');
      // Must include rlid and public fields
      expect(res.body).toHaveProperty('rlid', 'abc123abc123');
      expect(res.body).toHaveProperty('amount', 500);
      expect(res.body).toHaveProperty('challengeNonce');
    });

    it('returns 404 for unknown rlid', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(null);

      const res = await request(app).get('/api/transactions/unknown999');
      expect(res.status).toBe(404);
    });
  });

  // ---- Auth: register (admin-gated) ----
  describe('POST /api/auth/register/options', () => {
    it('rejects without admin key', async () => {
      const res = await request(app)
        .post('/api/auth/register/options')
        .send({ cardId: 'c1', kind: 'PASSKEY' });
      expect(res.status).toBe(401);
    });
  });

  // ---- Auth: authenticate (public) ----
  describe('POST /api/auth/authenticate/options', () => {
    it('is accessible without admin key (returns 400 for invalid body)', async () => {
      // No body -> should fail validation, but NOT 401
      const res = await request(app)
        .post('/api/auth/authenticate/options')
        .send({});
      expect(res.status).not.toBe(401);
      // Should be 400 (missing rlid)
      expect(res.status).toBe(400);
    });
  });

  // ---- SSE endpoint ----
  describe('GET /api/payment/status/:rlid', () => {
    it('returns 200 with SSE content-type for a valid transaction', async () => {
      const fakeTxn = {
        id: 'txn-sse',
        rlid: 'sse-rlid-test',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 300_000),
      };
      mockPrisma.transaction.findUnique.mockResolvedValue(fakeTxn);

      // SSE keeps the connection open forever.  Start the app on a random
      // port, issue a raw HTTP GET, read the initial headers, then tear
      // everything down.  This avoids supertest's built-in wait-for-end.
      const http = await import('node:http');
      const { status, headers } = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
        const server = app.listen(0, () => {
          const addr = server.address();
          if (!addr || typeof addr === 'string') { server.close(); return reject(new Error('bad addr')); }
          const req = http.get(`http://127.0.0.1:${addr.port}/api/payment/status/sse-rlid-test`, (res) => {
            resolve({ status: res.statusCode!, headers: res.headers });
            res.destroy();
            req.destroy();
            server.close();
          });
          req.on('error', (err) => { server.close(); reject(err); });
        });
      });
      expect(status).toBe(200);
      expect(headers['content-type']).toContain('text/event-stream');
    });
  });

  // ---- Security headers ----
  describe('Security headers', () => {
    it('sets helmet security headers', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    });
  });
});
