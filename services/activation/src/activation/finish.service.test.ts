import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@vera/db', () => ({
  prisma: {
    activationSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    card: {
      update: vi.fn(),
    },
    webAuthnCredential: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    // $transaction with an array of operations: returns the resolved
    // values of each in order.  Tests pass the explicit array.
    $transaction: vi.fn((ops: any[]) => Promise.all(ops)),
  },
}));

vi.mock('@vera/webauthn', () => ({
  verifyRegistration: vi.fn(),
}));

vi.mock('../env.js', () => ({
  getActivationConfig: vi.fn(() => ({
    MICROSITE_CDN_URL: 'https://microsite.karta.cards',
  })),
}));

vi.mock('../programs/ndef.js', () => ({
  renderNdefUrls: vi.fn(() => ({ preActivation: null, postActivation: 'POST_NDEF_URL' })),
}));

import { prisma } from '@vera/db';
import { verifyRegistration } from '@vera/webauthn';
import { finishActivationRegistration } from './finish.service.js';

const sessFind = () => prisma.activationSession.findUnique as unknown as ReturnType<typeof vi.fn>;
const sessUpdate = () => prisma.activationSession.update as unknown as ReturnType<typeof vi.fn>;
const cardUpdate = () => prisma.card.update as unknown as ReturnType<typeof vi.fn>;
const credFindFirst = () => prisma.webAuthnCredential.findFirst as unknown as ReturnType<typeof vi.fn>;
const credCreate = () => prisma.webAuthnCredential.create as unknown as ReturnType<typeof vi.fn>;
const credUpdate = () => prisma.webAuthnCredential.update as unknown as ReturnType<typeof vi.fn>;

const FRESH_SESSION = {
  id: 'sess_1',
  cardId: 'card_1',
  consumedAt: null,
  expiresAt: new Date(Date.now() + 60_000),
  challenge: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  // Default: session returns the bare row; tests override challenge as needed.
  sessUpdate().mockResolvedValue({});
  cardUpdate().mockResolvedValue({
    cardRef: 'kc_test',
    program: { id: 'p_1', preActivationNdefUrlTemplate: null, postActivationNdefUrlTemplate: 'X', micrositeEnabled: false, micrositeActiveVersion: null },
  });
});

// ---------------------------------------------------------------------------
// Confirm mode (preregistered cred path) — the new code path
// ---------------------------------------------------------------------------

describe('finishActivationRegistration — confirm mode', () => {
  it('flips the card to ACTIVATED without verifying any attestation', async () => {
    sessFind().mockResolvedValueOnce(FRESH_SESSION);
    credFindFirst().mockResolvedValueOnce({ id: 'cred_1', credentialId: 'PREREG_CRED' });
    credUpdate().mockResolvedValueOnce({});

    const r = await finishActivationRegistration({
      sessionToken: 'sess_1',
      confirm: true,
      deviceLabel: 'Pixel 8',
    });

    expect(r.mode).toBe('confirm');
    expect(r.cardActivated).toBe(true);
    expect(r.credentialId).toBe('PREREG_CRED');
    // Did NOT call WebAuthn verify (no attestation to check).
    expect(verifyRegistration).not.toHaveBeenCalled();
    // Card flipped to ACTIVATED.
    expect(cardUpdate()).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'card_1' },
      data: { status: 'ACTIVATED' },
    }));
    // Bumped lastUsedAt on the cred.
    expect(credUpdate()).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'cred_1' },
    }));
  });

  it('refuses confirm-mode finish when no preregistered cred exists (race vs admin DELETE)', async () => {
    sessFind().mockResolvedValueOnce(FRESH_SESSION);
    credFindFirst().mockResolvedValueOnce(null);

    await expect(finishActivationRegistration({
      sessionToken: 'sess_1',
      confirm: true,
    })).rejects.toMatchObject({ code: 'no_preregistered_credential' });
  });

  it('confirm mode does NOT require a stashed challenge', async () => {
    // session.challenge is null — register mode would 400 here, but confirm
    // mode doesn't care about the challenge at all.
    sessFind().mockResolvedValueOnce({ ...FRESH_SESSION, challenge: null });
    credFindFirst().mockResolvedValueOnce({ id: 'cred_1', credentialId: 'PREREG_CRED' });
    credUpdate().mockResolvedValueOnce({});

    const r = await finishActivationRegistration({ sessionToken: 'sess_1', confirm: true });
    expect(r.cardActivated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Register mode — existing path; smoke-tested to make sure refactor didn't break it.
// ---------------------------------------------------------------------------

describe('finishActivationRegistration — register mode', () => {
  it('rejects when neither response nor confirm supplied', async () => {
    sessFind().mockResolvedValueOnce(FRESH_SESSION);
    await expect(finishActivationRegistration({ sessionToken: 'sess_1' } as any))
      .rejects.toMatchObject({ code: 'missing_response' });
  });

  it('rejects when challenge is missing from session', async () => {
    sessFind().mockResolvedValueOnce(FRESH_SESSION); // challenge: null
    await expect(finishActivationRegistration({
      sessionToken: 'sess_1',
      response: { id: 'fake' } as any,
    })).rejects.toMatchObject({ code: 'no_pending_challenge' });
  });

  it('verifies, inserts cred, and flips ACTIVATED', async () => {
    sessFind().mockResolvedValueOnce({ ...FRESH_SESSION, challenge: 'CHALLENGE' });
    vi.mocked(verifyRegistration).mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credentialID: 'NEW_CRED_ID',
        credentialPublicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
      } as any,
    } as any);
    credCreate().mockResolvedValueOnce({});

    const r = await finishActivationRegistration({
      sessionToken: 'sess_1',
      response: { response: { transports: ['nfc'] } } as any,
      deviceLabel: 'Pixel 8',
    });

    expect(r.mode).toBe('register');
    expect(r.credentialId).toBe('NEW_CRED_ID');
    expect(verifyRegistration).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: 'CHALLENGE',
    }));
  });

  it('throws on failed attestation verification', async () => {
    sessFind().mockResolvedValueOnce({ ...FRESH_SESSION, challenge: 'CHALLENGE' });
    vi.mocked(verifyRegistration).mockResolvedValueOnce({ verified: false } as any);
    await expect(finishActivationRegistration({
      sessionToken: 'sess_1',
      response: { response: { transports: ['nfc'] } } as any,
    })).rejects.toMatchObject({ code: 'registration_verify_failed' });
  });
});
