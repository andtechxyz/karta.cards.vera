/**
 * Integration tests for the Admin service HTTP layer.
 *
 * Builds the Express app from the same route/middleware modules used by
 * services/admin/src/index.ts.  Prisma and vault-client are mocked.
 * Cognito JWT middleware is bypassed (always passes).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Express } from 'express';
import 'express-async-errors';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPrisma = vi.hoisted(() => ({
  program: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  card: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  chipProfile: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
  },
  issuerProfile: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  provisioningSession: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
}));
vi.mock('@vera/db', () => ({ prisma: mockPrisma }));

// Cognito auth — bypass JWT verification, inject test user
vi.mock('@vera/cognito-auth', () => ({
  createCognitoAuthMiddleware: () => (req: any, _res: any, next: any) => {
    req.cognitoUser = { sub: 'test-admin-sub', email: 'admin@test.com' };
    next();
  },
}));

// Vault client — mock the proxy surface
vi.mock('@vera/vault-client', () => ({
  createVaultClient: () => ({
    listCards: vi.fn().mockResolvedValue([]),
    listAudit: vi.fn().mockResolvedValue([]),
    storeCard: vi.fn().mockResolvedValue({
      vaultEntryId: 'vault-entry-1',
      panLast4: '4242',
      deduped: false,
    }),
  }),
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
// Constants
// ---------------------------------------------------------------------------

const TEST_ADMIN_KEY = '9'.repeat(64); // matches ADMIN_API_KEY from tests/setup.ts
const ADMIN_KEY_HEADER = 'x-admin-key';

// ---------------------------------------------------------------------------
// Build app
// ---------------------------------------------------------------------------

import helmet from 'helmet';
import cors from 'cors';
import { errorMiddleware } from '@vera/core';
import { requireAdminKey } from '../../services/admin/src/middleware/require-admin-key.js';
import programsRouter from '../../services/admin/src/routes/programs.routes.js';
import cardsRouter from '../../services/admin/src/routes/cards.routes.js';
import vaultProxyRouter from '../../services/admin/src/routes/vault-proxy.routes.js';
import provisioningRouter from '../../services/admin/src/routes/provisioning.routes.js';

function buildApp(): Express {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: '*', credentials: false, allowedHeaders: ['content-type', ADMIN_KEY_HEADER, 'authorization'] }));
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'admin' });
  });

  // Cognito middleware is mocked to always pass
  const cognitoAuth = (_req: any, _res: any, next: any) => {
    _req.cognitoUser = { sub: 'test-admin-sub', email: 'admin@test.com' };
    next();
  };
  const adminGate = requireAdminKey(TEST_ADMIN_KEY);

  app.use('/api/programs', cognitoAuth, adminGate, programsRouter);
  app.use('/api/cards', cognitoAuth, adminGate, cardsRouter);
  app.use('/api/admin/vault', cognitoAuth, adminGate, vaultProxyRouter);
  app.use('/api/admin', cognitoAuth, adminGate, provisioningRouter);

  app.use(errorMiddleware);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Admin service — integration', () => {
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
      expect(res.body).toMatchObject({ ok: true, service: 'admin' });
    });
  });

  // ---- Programs: auth gate ----
  describe('GET /api/programs', () => {
    it('rejects without X-Admin-Key', async () => {
      const res = await request(app).get('/api/programs');
      expect(res.status).toBe(401);
    });

    it('returns 200 with admin key', async () => {
      mockPrisma.program.findMany.mockResolvedValue([
        { id: 'test', name: 'Test Program', currency: 'AUD', tierRules: [] },
      ]);

      const res = await request(app)
        .get('/api/programs')
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // ---- Programs: create ----
  describe('POST /api/programs', () => {
    it('returns 201 with valid body', async () => {
      const programData = {
        id: 'new-program',
        name: 'New Program',
        currency: 'AUD',
        tierRules: [
          { amountMinMinor: 0, amountMaxMinor: 10000, allowedKinds: ['PLATFORM'] },
          { amountMinMinor: 10000, amountMaxMinor: null, allowedKinds: ['CROSS_PLATFORM'] },
        ],
      };

      mockPrisma.program.create.mockResolvedValue({
        ...programData,
        createdAt: new Date(),
        updatedAt: new Date(),
        preActivationNdefUrlTemplate: null,
        postActivationNdefUrlTemplate: null,
      });

      const res = await request(app)
        .post('/api/programs')
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .send(programData);
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id', 'new-program');
    });
  });

  // ---- Chip Profiles ----
  describe('GET /api/admin/chip-profiles', () => {
    it('returns 200 with admin key', async () => {
      mockPrisma.chipProfile.findMany.mockResolvedValue([
        { id: 'cp-1', name: 'Test Chip', scheme: 'VISA', vendor: 'NXP', cvn: 18 },
      ]);

      const res = await request(app)
        .get('/api/admin/chip-profiles')
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('POST /api/admin/chip-profiles', () => {
    it('returns 201 with valid body', async () => {
      const profileData = {
        name: 'Test Chip Profile',
        scheme: 'VISA',
        vendor: 'NXP',
        cvn: 18,
        dgiDefinitions: {},
      };

      mockPrisma.chipProfile.create.mockResolvedValue({
        id: 'cp-new',
        ...profileData,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await request(app)
        .post('/api/admin/chip-profiles')
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .send(profileData);
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
    });
  });

  // ---- Provisioning stats ----
  describe('GET /api/admin/provisioning/stats', () => {
    it('returns 200 with stats shape', async () => {
      mockPrisma.provisioningSession.count
        .mockResolvedValueOnce(3)   // activeSessions
        .mockResolvedValueOnce(10)  // provisioned24h
        .mockResolvedValueOnce(50)  // totalProvisioned
        .mockResolvedValueOnce(2);  // failedSessions24h

      const res = await request(app)
        .get('/api/admin/provisioning/stats')
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('activeSessions', 3);
      expect(res.body).toHaveProperty('provisioned24h', 10);
      expect(res.body).toHaveProperty('totalProvisioned', 50);
      expect(res.body).toHaveProperty('failedSessions24h', 2);
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
