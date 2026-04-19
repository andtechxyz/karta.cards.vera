import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CredentialKind } from '@vera/db';

// ---------------------------------------------------------------------------
// Post-split wiring:
//   - WebAuthn credentials live on Palisade → mock palisade-client.
//   - Registration challenges live on Vera's local DB → mock prisma.
// ---------------------------------------------------------------------------

vi.mock('../cards/index.js', () => ({
  lookupCard: vi.fn(),
  listWebAuthnCredentials: vi.fn(),
  getWebAuthnCredentialByCredentialId: vi.fn(),
  createWebAuthnCredential: vi.fn(),
  updateWebAuthnCredentialCounter: vi.fn(),
}));

vi.mock('@vera/db', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    prisma: {
      registrationChallenge: {
        create: vi.fn(),
        findUnique: vi.fn(),
        delete: vi.fn(),
      },
    },
  };
});

// The SimpleWebAuthn helpers are mocked too — a real ceremony would require
// fresh attestation material per test.  We care that the service threads the
// values through correctly and hits the right Palisade endpoints.
vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
}));

vi.mock('@vera/webauthn', () => ({
  buildNfcCardRegistrationOptions: vi.fn((i) => ({ tag: 'nfc', ...i })),
  buildPlatformRegistrationOptions: vi.fn((i) => ({ tag: 'platform', ...i })),
  buildAuthenticationOptions: vi.fn((i) => ({ tag: 'auth', ...i })),
  verifyRegistration: vi.fn(),
  verifyAuthentication: vi.fn(),
}));

import {
  beginRegistration,
  finishRegistration,
  beginAuthentication,
  finishAuthentication,
} from './webauthn.service.js';
import {
  lookupCard,
  listWebAuthnCredentials,
  getWebAuthnCredentialByCredentialId,
  createWebAuthnCredential,
  updateWebAuthnCredentialCounter,
} from '../cards/index.js';
import { prisma } from '@vera/db';
import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
} from '@simplewebauthn/server';
import { verifyRegistration, verifyAuthentication } from '@vera/webauthn';

type Mocked<T> = ReturnType<typeof vi.fn> & T;
const m = <T>(fn: T) => fn as unknown as Mocked<T>;

function makeCardState(overrides: Partial<{ id: string; status: string }> = {}) {
  return {
    id: overrides.id ?? 'card_1',
    cardRef: 'cardref_x',
    status: overrides.status ?? 'ACTIVATED',
    programId: null,
    retailSaleStatus: null,
    chipSerial: null,
    panLast4: null,
    panBin: null,
    cardholderName: null,
  };
}

beforeEach(() => {
  vi.mocked(m(lookupCard)).mockReset();
  vi.mocked(m(listWebAuthnCredentials)).mockReset();
  vi.mocked(m(getWebAuthnCredentialByCredentialId)).mockReset();
  vi.mocked(m(createWebAuthnCredential)).mockReset();
  vi.mocked(m(updateWebAuthnCredentialCounter)).mockReset();
  (prisma.registrationChallenge.create as ReturnType<typeof vi.fn>).mockReset();
  (prisma.registrationChallenge.findUnique as ReturnType<typeof vi.fn>).mockReset();
  (prisma.registrationChallenge.delete as ReturnType<typeof vi.fn>).mockReset();
  vi.mocked(m(generateRegistrationOptions)).mockReset();
  vi.mocked(m(generateAuthenticationOptions)).mockReset();
  vi.mocked(m(verifyRegistration)).mockReset();
  vi.mocked(m(verifyAuthentication)).mockReset();
});

// ---------------------------------------------------------------------------
// beginRegistration
// ---------------------------------------------------------------------------

describe('beginRegistration', () => {
  it('looks up the card, filters existing same-kind credentials, creates the challenge', async () => {
    vi.mocked(m(lookupCard)).mockResolvedValue(makeCardState() as never);
    vi.mocked(m(listWebAuthnCredentials)).mockResolvedValue([
      {
        id: 'c1',
        credentialId: 'cred_nfc_1',
        publicKey: '',
        counter: 0n,
        kind: 'CROSS_PLATFORM',
        transports: ['nfc'],
        deviceName: null,
        preregistered: false,
        cardId: 'card_1',
        createdAt: new Date(),
        lastUsedAt: null,
      },
      {
        id: 'c2',
        credentialId: 'cred_plat_1',
        publicKey: '',
        counter: 0n,
        kind: 'PLATFORM',
        transports: ['internal'],
        deviceName: null,
        preregistered: false,
        cardId: 'card_1',
        createdAt: new Date(),
        lastUsedAt: null,
      },
    ] as never);
    vi.mocked(m(generateRegistrationOptions)).mockResolvedValue({
      challenge: 'chal_bytes',
      rp: { id: 'pay.karta.cards', name: 'Palisade Pay' },
    } as never);

    const opts = await beginRegistration({
      cardId: 'card_1',
      kind: CredentialKind.CROSS_PLATFORM,
    });

    expect(opts.challenge).toBe('chal_bytes');

    // Only the CROSS_PLATFORM credential ends up in excludeCredentialIds.
    // buildNfcCardRegistrationOptions is mocked to echo its input, so the
    // shape we read off the generateRegistrationOptions call is the one our
    // service built.
    const genCall = vi.mocked(m(generateRegistrationOptions)).mock.calls[0]![0] as unknown as {
      excludeCredentialIds: string[];
    };
    expect(genCall.excludeCredentialIds).toEqual(['cred_nfc_1']);

    expect(prisma.registrationChallenge.create).toHaveBeenCalledOnce();
    const createArg = (prisma.registrationChallenge.create as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0] as { data: { challenge: string; cardId: string; kind: string; expiresAt: Date } };
    expect(createArg.data).toMatchObject({
      challenge: 'chal_bytes',
      cardId: 'card_1',
      kind: CredentialKind.CROSS_PLATFORM,
    });
    expect(createArg.data.expiresAt).toBeInstanceOf(Date);
    expect(createArg.data.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('throws 404 card_not_found when Palisade lookupCard rejects with notFound', async () => {
    const notFoundErr = Object.assign(new Error('Card not found in Palisade'), {
      status: 404,
      code: 'card_not_found',
    });
    vi.mocked(m(lookupCard)).mockRejectedValue(notFoundErr);

    await expect(
      beginRegistration({ cardId: 'missing', kind: CredentialKind.PLATFORM }),
    ).rejects.toMatchObject({ status: 404, code: 'card_not_found' });

    expect(prisma.registrationChallenge.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// finishRegistration
// ---------------------------------------------------------------------------

function clientDataWith(challenge: string) {
  return Buffer.from(JSON.stringify({ challenge, type: 'webauthn.create' })).toString(
    'base64url',
  );
}

describe('finishRegistration', () => {
  it('validates challenge, verifies, creates credential, and deletes the challenge', async () => {
    const challengeValue = 'chal_live';
    (prisma.registrationChallenge.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'chall_1',
      challenge: challengeValue,
      cardId: 'card_1',
      kind: 'CROSS_PLATFORM',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    } as never);
    vi.mocked(m(verifyRegistration)).mockResolvedValue({
      verified: true,
      registrationInfo: {
        credentialID: 'new_cred_id',
        credentialPublicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
      },
    } as never);
    vi.mocked(m(createWebAuthnCredential)).mockResolvedValue({
      id: 'cred_new',
      credentialId: 'new_cred_id',
      publicKey: 'pk',
      counter: 0n,
      kind: 'CROSS_PLATFORM',
      transports: ['nfc'],
      deviceName: null,
      preregistered: false,
      cardId: 'card_1',
      createdAt: new Date(),
      lastUsedAt: null,
    } as never);
    (prisma.registrationChallenge.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined as never);

    const result = await finishRegistration({
      cardId: 'card_1',
      response: {
        id: 'new_cred_id',
        rawId: 'new_cred_id',
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          attestationObject: 'ao',
          clientDataJSON: clientDataWith(challengeValue),
          transports: ['nfc'],
        },
      } as never,
    });

    expect(result.id).toBe('cred_new');
    expect(result.credentialId).toBe('new_cred_id');

    // Verified the challenge by its exact string — not by an id lookup.
    expect(prisma.registrationChallenge.findUnique).toHaveBeenCalledWith({ where: { challenge: challengeValue } });

    // Credential creation echoed the cardId, the verified pubkey, and transports.
    const createCall = vi.mocked(m(createWebAuthnCredential)).mock.calls[0]!;
    expect(createCall[0]).toBe('card_1');
    expect(createCall[1]).toMatchObject({
      credentialId: 'new_cred_id',
      counter: 0n,
      kind: 'CROSS_PLATFORM',
      transports: ['nfc'],
    });

    // Single-use consumption happens AFTER a successful create.
    expect(prisma.registrationChallenge.delete).toHaveBeenCalledWith({
      where: { challenge: challengeValue },
    });
  });

  it('throws 400 missing_challenge when clientDataJSON has no challenge', async () => {
    await expect(
      finishRegistration({
        cardId: 'card_1',
        response: {
          id: 'x',
          rawId: 'x',
          type: 'public-key',
          clientExtensionResults: {},
          response: {
            attestationObject: 'ao',
            clientDataJSON: Buffer.from(JSON.stringify({})).toString('base64url'),
          },
        } as never,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'missing_challenge' });
  });

  it('throws 401 bad_challenge when Palisade has no matching challenge', async () => {
    (prisma.registrationChallenge.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      finishRegistration({
        cardId: 'card_1',
        response: {
          id: 'x',
          rawId: 'x',
          type: 'public-key',
          clientExtensionResults: {},
          response: {
            attestationObject: 'ao',
            clientDataJSON: clientDataWith('missing_chal'),
          },
        } as never,
      }),
    ).rejects.toMatchObject({ status: 401, code: 'bad_challenge' });

    expect(createWebAuthnCredential).not.toHaveBeenCalled();
    expect(prisma.registrationChallenge.delete).not.toHaveBeenCalled();
  });

  it('throws 401 bad_challenge when challenge belongs to a different card', async () => {
    (prisma.registrationChallenge.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'chall_1',
      challenge: 'chal_value',
      cardId: 'someone_else',
      kind: 'PLATFORM',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    } as never);

    await expect(
      finishRegistration({
        cardId: 'card_1',
        response: {
          id: 'x',
          rawId: 'x',
          type: 'public-key',
          clientExtensionResults: {},
          response: {
            attestationObject: 'ao',
            clientDataJSON: clientDataWith('chal_value'),
          },
        } as never,
      }),
    ).rejects.toMatchObject({ status: 401, code: 'bad_challenge' });
  });

  it('throws 401 challenge_expired when the challenge is past expiry', async () => {
    (prisma.registrationChallenge.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'chall_1',
      challenge: 'chal_value',
      cardId: 'card_1',
      kind: 'PLATFORM',
      expiresAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
    } as never);

    await expect(
      finishRegistration({
        cardId: 'card_1',
        response: {
          id: 'x',
          rawId: 'x',
          type: 'public-key',
          clientExtensionResults: {},
          response: {
            attestationObject: 'ao',
            clientDataJSON: clientDataWith('chal_value'),
          },
        } as never,
      }),
    ).rejects.toMatchObject({ status: 401, code: 'challenge_expired' });
  });

  it('throws 401 registration_verify_failed when verifyRegistration returns verified=false', async () => {
    (prisma.registrationChallenge.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'chall_1',
      challenge: 'chal_value',
      cardId: 'card_1',
      kind: 'PLATFORM',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    } as never);
    vi.mocked(m(verifyRegistration)).mockResolvedValue({ verified: false } as never);

    await expect(
      finishRegistration({
        cardId: 'card_1',
        response: {
          id: 'x',
          rawId: 'x',
          type: 'public-key',
          clientExtensionResults: {},
          response: {
            attestationObject: 'ao',
            clientDataJSON: clientDataWith('chal_value'),
          },
        } as never,
      }),
    ).rejects.toMatchObject({ status: 401, code: 'registration_verify_failed' });
  });
});

// ---------------------------------------------------------------------------
// beginAuthentication
// ---------------------------------------------------------------------------

describe('beginAuthentication', () => {
  it('fetches credentials for the card and returns WebAuthn auth options', async () => {
    vi.mocked(m(listWebAuthnCredentials)).mockResolvedValue([
      {
        id: 'c1',
        credentialId: 'cred_1',
        publicKey: 'pk1',
        counter: 3n,
        kind: 'CROSS_PLATFORM',
        transports: ['nfc'],
        deviceName: null,
        preregistered: false,
        cardId: 'card_1',
        createdAt: new Date(),
        lastUsedAt: null,
      },
    ] as never);
    vi.mocked(m(generateAuthenticationOptions)).mockResolvedValue({
      challenge: 'chal_live',
      allowCredentials: [{ id: 'cred_1', type: 'public-key' }],
    } as never);

    const options = await beginAuthentication({
      cardId: 'card_1',
      challenge: Buffer.from('chal_live').toString('base64url'),
    });

    expect(options.challenge).toBe('chal_live');
    expect(listWebAuthnCredentials).toHaveBeenCalledWith('card_1', expect.any(Object));
  });

  it('filters credentials by allowedKinds when kinds are passed', async () => {
    vi.mocked(m(listWebAuthnCredentials)).mockResolvedValue([
      {
        id: 'c1',
        credentialId: 'cred_nfc',
        publicKey: 'pk',
        counter: 0n,
        kind: 'CROSS_PLATFORM',
        transports: ['nfc'],
        deviceName: null,
        preregistered: false,
        cardId: 'card_1',
        createdAt: new Date(),
        lastUsedAt: null,
      },
      {
        id: 'c2',
        credentialId: 'cred_plat',
        publicKey: 'pk',
        counter: 0n,
        kind: 'PLATFORM',
        transports: ['internal'],
        deviceName: null,
        preregistered: false,
        cardId: 'card_1',
        createdAt: new Date(),
        lastUsedAt: null,
      },
    ] as never);
    vi.mocked(m(generateAuthenticationOptions)).mockResolvedValue({
      challenge: 'chal_live',
      allowCredentials: [],
    } as never);

    await beginAuthentication({
      cardId: 'card_1',
      challenge: Buffer.from('chal_live').toString('base64url'),
      kinds: [CredentialKind.PLATFORM],
    });

    const genCall = vi.mocked(m(generateAuthenticationOptions)).mock.calls[0]![0]!;
    const cred = (genCall as { credentials?: Array<{ id: string; kind: string }> }).credentials;
    // buildAuthenticationOptions is mocked to just echo its input.
    expect(cred).toEqual([
      { id: 'cred_plat', kind: 'PLATFORM', transports: ['internal'] },
    ]);
  });

  it('throws 404 no_credentials when the card has none', async () => {
    vi.mocked(m(listWebAuthnCredentials)).mockResolvedValue([]);

    await expect(
      beginAuthentication({
        cardId: 'card_1',
        challenge: Buffer.from('chal_live').toString('base64url'),
      }),
    ).rejects.toMatchObject({ status: 404, code: 'no_credentials' });
  });
});

// ---------------------------------------------------------------------------
// finishAuthentication
// ---------------------------------------------------------------------------

describe('finishAuthentication', () => {
  it('verifies the authn response and PATCHes the counter on success', async () => {
    vi.mocked(m(getWebAuthnCredentialByCredentialId)).mockResolvedValue({
      id: 'c1',
      credentialId: 'cred_1',
      publicKey: 'pk',
      counter: 3n,
      kind: 'CROSS_PLATFORM',
      transports: ['nfc'],
      deviceName: null,
      preregistered: false,
      cardId: 'card_1',
      createdAt: new Date(),
      lastUsedAt: null,
    } as never);
    vi.mocked(m(verifyAuthentication)).mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 4 },
    } as never);
    vi.mocked(m(updateWebAuthnCredentialCounter)).mockResolvedValue({
      signCounter: 4,
      lastUsedAt: new Date(),
    } as never);

    const out = await finishAuthentication({
      response: {
        id: 'cred_1',
        rawId: 'cred_1',
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          authenticatorData: '',
          clientDataJSON: '',
          signature: '',
        },
      } as never,
      expectedChallenge: 'chal',
    });

    expect(out).toEqual({
      credentialId: 'cred_1',
      cardId: 'card_1',
      kind: CredentialKind.CROSS_PLATFORM,
      newCounter: 4n,
    });

    expect(updateWebAuthnCredentialCounter).toHaveBeenCalledWith(
      'cred_1',
      4,
      expect.any(Object),
    );
  });

  it('throws 404 credential_not_found when Palisade returns null', async () => {
    vi.mocked(m(getWebAuthnCredentialByCredentialId)).mockResolvedValue(null);

    await expect(
      finishAuthentication({
        response: {
          id: 'missing_cred',
          rawId: 'missing_cred',
          type: 'public-key',
          clientExtensionResults: {},
          response: { authenticatorData: '', clientDataJSON: '', signature: '' },
        } as never,
        expectedChallenge: 'chal',
      }),
    ).rejects.toMatchObject({ status: 404, code: 'credential_not_found' });

    expect(updateWebAuthnCredentialCounter).not.toHaveBeenCalled();
  });

  it('throws 401 credential_kind_not_allowed when kind does not match allowedKinds', async () => {
    vi.mocked(m(getWebAuthnCredentialByCredentialId)).mockResolvedValue({
      id: 'c1',
      credentialId: 'cred_1',
      publicKey: 'pk',
      counter: 0n,
      kind: 'CROSS_PLATFORM',
      transports: ['nfc'],
      deviceName: null,
      preregistered: false,
      cardId: 'card_1',
      createdAt: new Date(),
      lastUsedAt: null,
    } as never);

    await expect(
      finishAuthentication({
        response: {
          id: 'cred_1',
          rawId: 'cred_1',
          type: 'public-key',
          clientExtensionResults: {},
          response: { authenticatorData: '', clientDataJSON: '', signature: '' },
        } as never,
        expectedChallenge: 'chal',
        allowedKinds: [CredentialKind.PLATFORM],
      }),
    ).rejects.toMatchObject({ status: 401, code: 'credential_kind_not_allowed' });

    expect(updateWebAuthnCredentialCounter).not.toHaveBeenCalled();
  });

  it('throws 401 auth_verify_failed when verifyAuthentication returns verified=false', async () => {
    vi.mocked(m(getWebAuthnCredentialByCredentialId)).mockResolvedValue({
      id: 'c1',
      credentialId: 'cred_1',
      publicKey: 'pk',
      counter: 0n,
      kind: 'CROSS_PLATFORM',
      transports: ['nfc'],
      deviceName: null,
      preregistered: false,
      cardId: 'card_1',
      createdAt: new Date(),
      lastUsedAt: null,
    } as never);
    vi.mocked(m(verifyAuthentication)).mockResolvedValue({ verified: false } as never);

    await expect(
      finishAuthentication({
        response: {
          id: 'cred_1',
          rawId: 'cred_1',
          type: 'public-key',
          clientExtensionResults: {},
          response: { authenticatorData: '', clientDataJSON: '', signature: '' },
        } as never,
        expectedChallenge: 'chal',
      }),
    ).rejects.toMatchObject({ status: 401, code: 'auth_verify_failed' });

    expect(updateWebAuthnCredentialCounter).not.toHaveBeenCalled();
  });
});
