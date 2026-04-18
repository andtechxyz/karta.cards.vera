/**
 * Integration test — full pre-registered FIDO credential flow.
 *
 * Walks the new perso-time path end-to-end:
 *   1. Admin POSTs a credential against a PERSONALISED card.
 *   2. Activation /begin sees the preregistered cred, returns mode=confirm
 *      WITHOUT issuing a WebAuthn challenge.
 *   3. Activation /finish with { confirm: true } flips the card to
 *      ACTIVATED and bumps the credential's lastUsedAt.
 *
 * Both routers are mounted in the same Express app and share a single
 * mocked Prisma surface — what admin writes is what activation reads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import 'express-async-errors';

// ---------------------------------------------------------------------------
// Shared Prisma mock — small in-memory store for cards + credentials.
// ---------------------------------------------------------------------------

interface FakeCard {
  id: string;
  cardRef: string;
  status: string;
  programId: string | null;
  program?: {
    id: string;
    preActivationNdefUrlTemplate: string | null;
    postActivationNdefUrlTemplate: string | null;
    micrositeEnabled: boolean;
    micrositeActiveVersion: string | null;
  } | null;
}

interface FakeCred {
  id: string;
  credentialId: string;
  publicKey: string;
  cardId: string;
  kind: string;
  transports: string[];
  deviceName: string | null;
  preregistered: boolean;
  counter: bigint;
  createdAt: Date;
  lastUsedAt: Date | null;
}

interface FakeSession {
  id: string;
  cardId: string;
  challenge: string | null;
  consumedAt: Date | null;
  consumedDeviceLabel: string | null;
  expiresAt: Date;
  createdAt: Date;
}

const store = vi.hoisted(() => ({
  cards: new Map<string, any>(),
  credentials: new Map<string, any>(),
  sessions: new Map<string, any>(),
}));

const mockPrisma = vi.hoisted(() => ({
  card: {
    findUnique: vi.fn(async ({ where, select }: any) => {
      const id = where.id ?? Array.from(store.cards.values()).find((c: FakeCard) => c.cardRef === where.cardRef)?.id;
      const c = id ? store.cards.get(id) : undefined;
      if (!c) return null;
      // For activation /begin's nested credentials select, hydrate them.
      if (select?.credentials) {
        return {
          ...c,
          credentials: Array.from(store.credentials.values()).filter((cr: FakeCred) => cr.cardId === c.id),
        };
      }
      return c;
    }),
    update: vi.fn(async ({ where, data, select }: any) => {
      const c = store.cards.get(where.id);
      if (!c) throw new Error('card_not_found');
      Object.assign(c, data);
      if (select) {
        return {
          ...c,
          program: c.program ?? null,
        };
      }
      return c;
    }),
  },
  webAuthnCredential: {
    findFirst: vi.fn(async ({ where }: any) => {
      const list = Array.from(store.credentials.values()) as FakeCred[];
      return list.find((c) =>
        c.cardId === where.cardId
        && (where.preregistered === undefined || c.preregistered === where.preregistered),
      ) ?? null;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      return store.credentials.get(where.id) ?? null;
    }),
    findMany: vi.fn(async ({ where }: any) => {
      const list = Array.from(store.credentials.values()) as FakeCred[];
      return list.filter((c) => c.cardId === where.cardId);
    }),
    create: vi.fn(async ({ data, select }: any) => {
      const id = `cred_${store.credentials.size + 1}`;
      const row: FakeCred = {
        id,
        credentialId: data.credentialId,
        publicKey: data.publicKey,
        cardId: data.cardId,
        kind: data.kind,
        transports: data.transports ?? ['nfc'],
        deviceName: data.deviceName ?? null,
        preregistered: data.preregistered ?? false,
        counter: BigInt(data.counter ?? 0),
        createdAt: new Date(),
        lastUsedAt: null,
      };
      store.credentials.set(id, row);
      return select ? Object.fromEntries(Object.keys(select).map((k) => [k, (row as any)[k]])) : row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const c = store.credentials.get(where.id);
      if (!c) throw new Error('cred_not_found');
      Object.assign(c, data);
      return c;
    }),
    delete: vi.fn(async ({ where }: any) => {
      store.credentials.delete(where.id);
      return {} as any;
    }),
  },
  activationSession: {
    findUnique: vi.fn(async ({ where }: any) => store.sessions.get(where.id) ?? null),
    update: vi.fn(async ({ where, data }: any) => {
      const s = store.sessions.get(where.id);
      if (!s) throw new Error('session_not_found');
      Object.assign(s, data);
      return s;
    }),
  },
  $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
}));

vi.mock('@vera/db', () => ({ prisma: mockPrisma }));

// Mock @vera/webauthn — we never run real attestation in this test.  The
// preregistered path doesn't touch verifyRegistration anyway.
vi.mock('@vera/webauthn', () => ({
  buildNfcCardRegistrationOptions: vi.fn(() => ({ rpName: 'test' })),
  verifyRegistration: vi.fn(),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(async () => ({
    challenge: 'CHALLENGE_BYTES',
    rp: { id: 'test', name: 'test' },
    user: { id: 'u', name: 'u', displayName: 'u' },
    pubKeyCredParams: [],
  })),
}));

// Activation env — supply a microsite URL so finish.service can build one.
vi.mock('../../services/activation/src/env.js', () => ({
  getActivationConfig: vi.fn(() => ({
    MICROSITE_CDN_URL: 'https://microsite.karta.cards',
  })),
}));

// ---------------------------------------------------------------------------
// Build app — mount admin cards router + activation routes router together.
// ---------------------------------------------------------------------------

import { errorMiddleware } from '@vera/core';
import adminCardsRouter from '../../services/admin/src/routes/cards.routes.js';
import activationRouter from '../../services/activation/src/routes/activation.routes.js';

function buildApp(): Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  // No auth gates in the test harness — production wraps both with the
  // appropriate middleware.  We're testing flow correctness, not authz.
  app.use('/api/cards', adminCardsRouter);
  app.use('/api/activation', activationRouter);
  app.use(errorMiddleware);
  return app;
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function seedCard(): FakeCard {
  const card: FakeCard = {
    id: 'card_1',
    cardRef: 'kc_e2e_1',
    status: 'PERSONALISED',
    programId: null,
    program: null,
  };
  store.cards.set(card.id, card);
  return card;
}

function seedSession(cardId: string): FakeSession {
  const sess: FakeSession = {
    id: 'sess_1',
    cardId,
    challenge: null,
    consumedAt: null,
    consumedDeviceLabel: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
  };
  store.sessions.set(sess.id, sess);
  return sess;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pre-registered FIDO credential — full activation flow', () => {
  let app: Express;

  beforeEach(() => {
    store.cards.clear();
    store.credentials.clear();
    store.sessions.clear();
    app = buildApp();
  });

  it('happy path: inject cred → /begin returns confirm → /finish flips ACTIVATED', async () => {
    const card = seedCard();
    const sess = seedSession(card.id);

    // 1. Admin pre-registers a credential.
    const inject = await request(app)
      .post(`/api/cards/${card.cardRef}/credentials`)
      .send({
        credentialId: 'AAECAwQFBgcICQoLDA0ODw',
        publicKey: 'pAEDAzkBACBYIBfgEHRkBQ-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        transports: ['nfc'],
        deviceName: 'Pre-registered (perso)',
      });
    expect(inject.status).toBe(201);
    expect(store.credentials.size).toBe(1);

    // 2. Activation /begin sees the preregistered cred, returns confirm mode.
    const begin = await request(app).post(`/api/activation/sessions/${sess.id}/begin`);
    expect(begin.status).toBe(200);
    expect(begin.body).toEqual({ mode: 'confirm' });
    // No challenge issued → still null on session.
    expect(store.sessions.get(sess.id)!.challenge).toBeNull();

    // 3. Activation /finish with { confirm: true } flips ACTIVATED.
    const finish = await request(app)
      .post(`/api/activation/sessions/${sess.id}/finish`)
      .send({ confirm: true, deviceLabel: 'Pixel 8' });
    expect(finish.status).toBe(200);
    expect(finish.body.cardActivated).toBe(true);
    expect(finish.body.mode).toBe('confirm');
    expect(finish.body.credentialId).toBe('AAECAwQFBgcICQoLDA0ODw');

    // Card row reflects ACTIVATED.
    expect(store.cards.get(card.id)!.status).toBe('ACTIVATED');
    // Session consumed.
    expect(store.sessions.get(sess.id)!.consumedAt).not.toBeNull();
    // Credential lastUsedAt bumped.
    const cred = Array.from(store.credentials.values())[0] as FakeCred;
    expect(cred.lastUsedAt).not.toBeNull();
  });

  it('register mode is preserved when no preregistered cred exists', async () => {
    const card = seedCard();
    const sess = seedSession(card.id);

    const begin = await request(app).post(`/api/activation/sessions/${sess.id}/begin`);
    expect(begin.status).toBe(200);
    expect(begin.body.mode).toBe('register');
    expect(begin.body.options.challenge).toBe('CHALLENGE_BYTES');
    // Challenge stashed for later /finish verification.
    expect(store.sessions.get(sess.id)!.challenge).toBe('CHALLENGE_BYTES');
  });

  it('refuses confirm-mode finish if admin DELETEd the cred between /begin and /finish', async () => {
    const card = seedCard();
    const sess = seedSession(card.id);

    // Inject + /begin — confirms preregistered exists.
    await request(app)
      .post(`/api/cards/${card.cardRef}/credentials`)
      .send({
        credentialId: 'AAECAwQFBgcICQoLDA0ODw',
        publicKey: 'pAEDAzkBACBYIBfgEHRkBQ-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      });
    const begin = await request(app).post(`/api/activation/sessions/${sess.id}/begin`);
    expect(begin.body.mode).toBe('confirm');

    // Admin races a DELETE before /finish lands.
    const credRow = Array.from(store.credentials.values())[0] as FakeCred;
    const del = await request(app)
      .delete(`/api/cards/${card.cardRef}/credentials/${credRow.id}`);
    expect(del.status).toBe(204);

    // /finish should now refuse rather than silently ACTIVATE without a cred.
    const finish = await request(app)
      .post(`/api/activation/sessions/${sess.id}/finish`)
      .send({ confirm: true });
    expect(finish.status).toBe(400);
    expect(finish.body.error.code).toBe('no_preregistered_credential');
    // Card should NOT have flipped to ACTIVATED.
    expect(store.cards.get(card.id)!.status).toBe('PERSONALISED');
  });

  it('rejects pre-registration after card is ACTIVATED', async () => {
    const card = seedCard();
    card.status = 'ACTIVATED';

    const inject = await request(app)
      .post(`/api/cards/${card.cardRef}/credentials`)
      .send({
        credentialId: 'AAECAwQFBgcICQoLDA0ODw',
        publicKey: 'pAEDAzkBACBYIBfgEHRkBQ-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      });
    expect(inject.status).toBe(409);
    expect(inject.body.error.code).toBe('card_not_personalised');
  });

  it('rejects { response } in confirm mode (and vice versa) — schema enforces XOR', async () => {
    const card = seedCard();
    const sess = seedSession(card.id);
    await request(app)
      .post(`/api/cards/${card.cardRef}/credentials`)
      .send({
        credentialId: 'AAECAwQFBgcICQoLDA0ODw',
        publicKey: 'pAEDAzkBACBYIBfgEHRkBQ-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      });
    await request(app).post(`/api/activation/sessions/${sess.id}/begin`);

    // Sending BOTH response and confirm:true → 400 (schema refine).
    const both = await request(app)
      .post(`/api/activation/sessions/${sess.id}/finish`)
      .send({ confirm: true, response: { fake: true } });
    expect(both.status).toBe(400);

    // Sending NEITHER → 400 (schema refine).
    const neither = await request(app)
      .post(`/api/activation/sessions/${sess.id}/finish`)
      .send({});
    expect(neither.status).toBe(400);
  });
});
