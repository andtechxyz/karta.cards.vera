import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — keep narrow to what begin.service.ts actually touches.
// ---------------------------------------------------------------------------

vi.mock('@vera/db', () => ({
  prisma: {
    card: { findUnique: vi.fn() },
    activationSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@vera/webauthn', () => ({
  buildNfcCardRegistrationOptions: vi.fn(() => ({ rpName: 'test' })),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(async () => ({
    challenge: 'CHALLENGE_BYTES',
    rp: { id: 'test', name: 'test' },
    user: { id: 'u', name: 'u', displayName: 'u' },
    pubKeyCredParams: [],
  })),
}));

import { prisma } from '@vera/db';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { beginActivationRegistration } from './begin.service.js';

const cardFind = () => prisma.card.findUnique as unknown as ReturnType<typeof vi.fn>;
const sessFind = () => prisma.activationSession.findUnique as unknown as ReturnType<typeof vi.fn>;
const sessUpdate = () => prisma.activationSession.update as unknown as ReturnType<typeof vi.fn>;

const FRESH_SESSION = {
  id: 'sess_1',
  cardId: 'card_1',
  consumedAt: null,
  expiresAt: new Date(Date.now() + 60_000),
  challenge: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  sessFind().mockResolvedValue(FRESH_SESSION);
  sessUpdate().mockResolvedValue({});
});

describe('beginActivationRegistration', () => {
  it('returns mode=register + options when no preregistered cred exists', async () => {
    cardFind().mockResolvedValue({
      id: 'card_1',
      status: 'PERSONALISED',
      credentials: [],
    });

    const r = await beginActivationRegistration('sess_1');

    expect(r.mode).toBe('register');
    expect(r).toMatchObject({ mode: 'register' });
    if (r.mode === 'register') {
      expect(r.options.challenge).toBe('CHALLENGE_BYTES');
    }
    // Stashed challenge on the session.
    expect(sessUpdate()).toHaveBeenCalledWith({
      where: { id: 'sess_1' },
      data: { challenge: 'CHALLENGE_BYTES' },
    });
    expect(generateRegistrationOptions).toHaveBeenCalled();
  });

  it('returns mode=confirm + clears stale challenge when a preregistered cred exists', async () => {
    cardFind().mockResolvedValue({
      id: 'card_1',
      status: 'PERSONALISED',
      credentials: [
        { credentialId: 'AA', kind: 'CROSS_PLATFORM', preregistered: true },
      ],
    });

    const r = await beginActivationRegistration('sess_1');

    expect(r.mode).toBe('confirm');
    // Challenge cleared, NOT generated.
    expect(sessUpdate()).toHaveBeenCalledWith({
      where: { id: 'sess_1' },
      data: { challenge: null },
    });
    expect(generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('excludes existing user-registered creds from registration options', async () => {
    cardFind().mockResolvedValue({
      id: 'card_1',
      status: 'PERSONALISED',
      credentials: [
        { credentialId: 'USER_CRED', kind: 'CROSS_PLATFORM', preregistered: false },
      ],
    });

    await beginActivationRegistration('sess_1');

    const buildOpts = await import('@vera/webauthn');
    expect(buildOpts.buildNfcCardRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ excludeCredentialIds: ['USER_CRED'] }),
    );
  });

  it('treats preregistered cred as authoritative even when other creds exist', async () => {
    cardFind().mockResolvedValue({
      id: 'card_1',
      status: 'PERSONALISED',
      credentials: [
        { credentialId: 'OLD_USER_CRED', kind: 'CROSS_PLATFORM', preregistered: false },
        { credentialId: 'NEW_PEREG_CRED', kind: 'CROSS_PLATFORM', preregistered: true },
      ],
    });

    const r = await beginActivationRegistration('sess_1');
    expect(r.mode).toBe('confirm');
  });

  it('throws when card is already activated', async () => {
    cardFind().mockResolvedValue({
      id: 'card_1',
      status: 'ACTIVATED',
      credentials: [],
    });
    await expect(beginActivationRegistration('sess_1')).rejects.toMatchObject({
      code: 'card_already_activated',
    });
  });

  it('throws when card row is missing for the session', async () => {
    cardFind().mockResolvedValue(null);
    await expect(beginActivationRegistration('sess_1')).rejects.toMatchObject({
      code: 'card_not_found',
    });
  });
});
