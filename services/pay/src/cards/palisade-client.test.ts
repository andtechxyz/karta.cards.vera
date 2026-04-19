import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the SUT.
// ---------------------------------------------------------------------------

vi.mock('undici', () => ({
  request: vi.fn(),
}));

import { request as undiciRequest } from 'undici';
import {
  lookupCard,
  incrementAtc,
  listWebAuthnCredentials,
  getWebAuthnCredentialByCredentialId,
  createWebAuthnCredential,
  updateWebAuthnCredentialCounter,
  createRegistrationChallenge,
  getRegistrationChallenge,
  deleteRegistrationChallenge,
  PalisadeClientError,
} from './palisade-client.js';
import { verifyRequest } from '@vera/service-auth';

type Mocked<T> = ReturnType<typeof vi.fn> & T;
const req = () => undiciRequest as unknown as Mocked<typeof undiciRequest>;

const OPTS = {
  baseUrl: 'http://localhost:3002',
  keyId: 'pay',
  secret: 'f'.repeat(64),
};

function okResponse(body: unknown, statusCode = 200) {
  return {
    statusCode,
    body: { text: async () => JSON.stringify(body) },
  } as never;
}

function errorResponse(body: unknown, statusCode: number) {
  return {
    statusCode,
    body: { text: async () => JSON.stringify(body) },
  } as never;
}

function emptyResponse(statusCode = 204) {
  return {
    statusCode,
    body: { text: async () => '' },
  } as never;
}

/**
 * Round-trip the authorization header against the same verifier the server
 * uses, to catch any drift between signRequest and the canonical input
 * string.  Call once per method test.
 */
function verifySignedCall(params: {
  url: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  expectedUrl: string;
  expectedPath: string;
  body?: Buffer;
  headers: Record<string, string>;
}) {
  expect(params.url).toBe(params.expectedUrl);
  const verified = verifyRequest({
    authorization: params.headers.authorization,
    method: params.method,
    pathAndQuery: params.expectedPath,
    body: params.body ?? Buffer.alloc(0),
    keys: { pay: OPTS.secret },
  });
  expect(verified.keyId).toBe('pay');
}

beforeEach(() => {
  vi.mocked(req()).mockReset();
});

// ---------------------------------------------------------------------------
// lookupCard — retained from the original suite (regression guard for the
// shared transport helper introduced with the extension).
// ---------------------------------------------------------------------------

describe('lookupCard', () => {
  it('calls Palisade with a signed GET and parses the CardState response', async () => {
    vi.mocked(req()).mockResolvedValue(
      okResponse({
        id: 'card_1',
        cardRef: 'cardref_abc',
        status: 'ACTIVATED',
        programId: 'prog_plat_aud',
        retailSaleStatus: null,
        chipSerial: 'JCOP5_00A1B2C3',
        panLast4: '4242',
        panBin: '411111',
        cardholderName: 'Jane Doe',
      }),
    );

    const out = await lookupCard('card_1', OPTS);

    expect(out).toEqual({
      id: 'card_1',
      cardRef: 'cardref_abc',
      status: 'ACTIVATED',
      programId: 'prog_plat_aud',
      retailSaleStatus: null,
      chipSerial: 'JCOP5_00A1B2C3',
      panLast4: '4242',
      panBin: '411111',
      cardholderName: 'Jane Doe',
    });

    expect(req()).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(req()).mock.calls[0]! as unknown as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toMatch(/^VeraHmac keyId=pay,ts=\d+,sig=[0-9a-f]+$/);
    verifySignedCall({
      url,
      method: 'GET',
      expectedUrl: 'http://localhost:3002/api/cards/lookup/card_1',
      expectedPath: '/api/cards/lookup/card_1',
      headers: init.headers,
    });
  });

  it('URL-encodes the cardId path segment', async () => {
    vi.mocked(req()).mockResolvedValue(
      okResponse({
        id: 'weird/id',
        cardRef: 'ref',
        status: 'ACTIVATED',
        programId: null,
        retailSaleStatus: null,
        chipSerial: null,
        panLast4: null,
        panBin: null,
        cardholderName: null,
      }),
    );

    await lookupCard('weird/id', OPTS);
    const [url] = vi.mocked(req()).mock.calls[0]! as unknown as [string, unknown];
    expect(url).toBe('http://localhost:3002/api/cards/lookup/weird%2Fid');
  });

  it('maps 404 to notFound card_not_found', async () => {
    vi.mocked(req()).mockResolvedValue(
      errorResponse({ error: { code: 'card_not_found', message: 'Card not found' } }, 404),
    );

    await expect(lookupCard('card_missing', OPTS)).rejects.toMatchObject({
      status: 404,
      code: 'card_not_found',
    });
  });

  it('throws PalisadeClientError with upstream code for other non-2xx responses', async () => {
    vi.mocked(req()).mockResolvedValue(
      errorResponse({ error: { code: 'missing_auth', message: 'missing_auth' } }, 401),
    );

    const caught = await lookupCard('card_1', OPTS).catch((e) => e);
    expect(caught).toBeInstanceOf(PalisadeClientError);
    expect(caught.status).toBe(401);
    expect(caught.code).toBe('missing_auth');
  });

  it('throws PalisadeClientError palisade_bad_body for a non-JSON 200 body', async () => {
    vi.mocked(req()).mockResolvedValue({
      statusCode: 200,
      body: { text: async () => '<html>not json</html>' },
    } as never);

    const caught = await lookupCard('card_1', OPTS).catch((e) => e);
    expect(caught).toBeInstanceOf(PalisadeClientError);
    expect(caught.code).toBe('palisade_bad_body');
  });

  it('rejects empty cardId with 400 invalid_card_id before any network call', async () => {
    await expect(lookupCard('', OPTS)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_card_id',
    });
    expect(req()).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// incrementAtc
// ---------------------------------------------------------------------------

describe('incrementAtc', () => {
  it('PATCHes the atc-increment endpoint and returns the new atc', async () => {
    vi.mocked(req()).mockResolvedValue(okResponse({ atc: 42 }));

    const out = await incrementAtc('card_1', OPTS);
    expect(out).toEqual({ atc: 42 });

    expect(req()).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(req()).mock.calls[0]! as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: Buffer },
    ];
    expect(init.method).toBe('PATCH');
    expect(init.headers['content-type']).toBe('application/json');
    verifySignedCall({
      url,
      method: 'PATCH',
      expectedUrl: 'http://localhost:3002/api/cards/card_1/atc-increment',
      expectedPath: '/api/cards/card_1/atc-increment',
      body: init.body,
      headers: init.headers,
    });
  });
});

// ---------------------------------------------------------------------------
// listWebAuthnCredentials
// ---------------------------------------------------------------------------

describe('listWebAuthnCredentials', () => {
  it('GETs credentials for a card and inflates counter/dates', async () => {
    vi.mocked(req()).mockResolvedValue(
      okResponse([
        {
          id: 'cred_1',
          credentialId: 'credid_abc',
          publicKey: 'pk_b64',
          counter: '5',
          kind: 'CROSS_PLATFORM',
          transports: ['nfc'],
          deviceName: null,
          preregistered: false,
          cardId: 'card_1',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastUsedAt: null,
        },
      ]),
    );

    const out = await listWebAuthnCredentials('card_1', OPTS);

    expect(out).toHaveLength(1);
    expect(out[0]!.counter).toBe(5n);
    expect(out[0]!.kind).toBe('CROSS_PLATFORM');
    expect(out[0]!.createdAt).toBeInstanceOf(Date);
    expect(out[0]!.lastUsedAt).toBeNull();

    const [url, init] = vi.mocked(req()).mock.calls[0]! as unknown as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(init.method).toBe('GET');
    verifySignedCall({
      url,
      method: 'GET',
      expectedUrl: 'http://localhost:3002/api/cards/card_1/webauthn-credentials',
      expectedPath: '/api/cards/card_1/webauthn-credentials',
      headers: init.headers,
    });
  });
});

// ---------------------------------------------------------------------------
// getWebAuthnCredentialByCredentialId
// ---------------------------------------------------------------------------

describe('getWebAuthnCredentialByCredentialId', () => {
  it('GETs the credential, parses bigint counter and dates', async () => {
    vi.mocked(req()).mockResolvedValue(
      okResponse({
        id: 'cred_1',
        credentialId: 'credid_abc',
        publicKey: 'pk_b64',
        counter: '11',
        kind: 'PLATFORM',
        transports: ['internal', 'hybrid'],
        deviceName: 'Jane iPhone',
        preregistered: false,
        cardId: 'card_1',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: '2026-03-01T12:00:00.000Z',
      }),
    );

    const out = await getWebAuthnCredentialByCredentialId('credid_abc', OPTS);
    expect(out).not.toBeNull();
    expect(out!.counter).toBe(11n);
    expect(out!.kind).toBe('PLATFORM');
    expect(out!.lastUsedAt).toBeInstanceOf(Date);

    const [url, init] = vi.mocked(req()).mock.calls[0]! as unknown as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    verifySignedCall({
      url,
      method: 'GET',
      expectedUrl: 'http://localhost:3002/api/webauthn-credentials/credid_abc',
      expectedPath: '/api/webauthn-credentials/credid_abc',
      headers: init.headers,
    });
  });

  it('returns null on 404 rather than throwing', async () => {
    vi.mocked(req()).mockResolvedValue(
      errorResponse({ error: { code: 'credential_not_found' } }, 404),
    );

    const out = await getWebAuthnCredentialByCredentialId('missing', OPTS);
    expect(out).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createWebAuthnCredential
// ---------------------------------------------------------------------------

describe('createWebAuthnCredential', () => {
  it('POSTs a credential-create payload and parses the response', async () => {
    vi.mocked(req()).mockResolvedValue(
      okResponse({
        id: 'cred_new',
        credentialId: 'credid_new',
        publicKey: 'pk_b64',
        counter: '0',
        kind: 'CROSS_PLATFORM',
        transports: ['nfc'],
        deviceName: null,
        preregistered: false,
        cardId: 'card_1',
        createdAt: '2026-04-19T00:00:00.000Z',
        lastUsedAt: null,
      }),
    );

    const out = await createWebAuthnCredential(
      'card_1',
      {
        credentialId: 'credid_new',
        publicKey: 'pk_b64',
        counter: 0n,
        kind: 'CROSS_PLATFORM',
        transports: ['nfc'],
      },
      OPTS,
    );

    expect(out.id).toBe('cred_new');
    expect(out.counter).toBe(0n);

    const [url, init] = vi.mocked(req()).mock.calls[0]! as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: Buffer },
    ];
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');

    const sent = JSON.parse(init.body.toString('utf8'));
    expect(sent).toEqual({
      credentialId: 'credid_new',
      publicKey: 'pk_b64',
      counter: '0', // bigint → string on wire
      kind: 'CROSS_PLATFORM',
      transports: ['nfc'],
      deviceName: null,
    });

    verifySignedCall({
      url,
      method: 'POST',
      expectedUrl: 'http://localhost:3002/api/cards/card_1/webauthn-credentials',
      expectedPath: '/api/cards/card_1/webauthn-credentials',
      body: init.body,
      headers: init.headers,
    });
  });
});

// ---------------------------------------------------------------------------
// updateWebAuthnCredentialCounter
// ---------------------------------------------------------------------------

describe('updateWebAuthnCredentialCounter', () => {
  it('PATCHes the counter endpoint and parses lastUsedAt as Date', async () => {
    vi.mocked(req()).mockResolvedValue(
      okResponse({ signCounter: 6, lastUsedAt: '2026-04-19T12:34:56.000Z' }),
    );

    const out = await updateWebAuthnCredentialCounter('credid_abc', 6, OPTS);
    expect(out.signCounter).toBe(6);
    expect(out.lastUsedAt).toBeInstanceOf(Date);

    const [url, init] = vi.mocked(req()).mock.calls[0]! as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: Buffer },
    ];
    expect(init.method).toBe('PATCH');
    const sent = JSON.parse(init.body.toString('utf8'));
    expect(sent).toEqual({ signCounter: 6 });

    verifySignedCall({
      url,
      method: 'PATCH',
      expectedUrl: 'http://localhost:3002/api/webauthn-credentials/credid_abc/counter',
      expectedPath: '/api/webauthn-credentials/credid_abc/counter',
      body: init.body,
      headers: init.headers,
    });
  });

  it('surfaces a 404 as PalisadeClientError with the upstream code (not card_not_found)', async () => {
    vi.mocked(req()).mockResolvedValue(
      errorResponse({ error: { code: 'credential_not_found' } }, 404),
    );

    const caught = await updateWebAuthnCredentialCounter('missing', 1, OPTS).catch((e) => e);
    expect(caught).toBeInstanceOf(PalisadeClientError);
    expect(caught.status).toBe(404);
    expect(caught.code).toBe('credential_not_found');
  });
});

// ---------------------------------------------------------------------------
// createRegistrationChallenge
// ---------------------------------------------------------------------------

describe('createRegistrationChallenge', () => {
  it('POSTs a challenge record with ISO-formatted expiresAt', async () => {
    const expiresAt = new Date('2026-04-19T00:05:00.000Z');
    vi.mocked(req()).mockResolvedValue(
      okResponse({
        id: 'chall_1',
        challenge: 'chal_bytes',
        cardId: 'card_1',
        kind: 'PLATFORM',
        expiresAt: expiresAt.toISOString(),
        createdAt: '2026-04-19T00:00:00.000Z',
      }),
    );

    const out = await createRegistrationChallenge(
      { challenge: 'chal_bytes', cardId: 'card_1', kind: 'PLATFORM', expiresAt },
      OPTS,
    );
    expect(out.expiresAt).toBeInstanceOf(Date);
    expect(out.expiresAt.toISOString()).toBe('2026-04-19T00:05:00.000Z');

    const [url, init] = vi.mocked(req()).mock.calls[0]! as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: Buffer },
    ];
    expect(init.method).toBe('POST');

    const sent = JSON.parse(init.body.toString('utf8'));
    expect(sent).toEqual({
      challenge: 'chal_bytes',
      cardId: 'card_1',
      kind: 'PLATFORM',
      expiresAt: '2026-04-19T00:05:00.000Z',
    });

    verifySignedCall({
      url,
      method: 'POST',
      expectedUrl: 'http://localhost:3002/api/registration-challenges',
      expectedPath: '/api/registration-challenges',
      body: init.body,
      headers: init.headers,
    });
  });
});

// ---------------------------------------------------------------------------
// getRegistrationChallenge
// ---------------------------------------------------------------------------

describe('getRegistrationChallenge', () => {
  it('GETs a challenge by id and inflates dates', async () => {
    vi.mocked(req()).mockResolvedValue(
      okResponse({
        id: 'chall_1',
        challenge: 'chal_bytes',
        cardId: 'card_1',
        kind: 'PLATFORM',
        expiresAt: '2026-04-19T00:05:00.000Z',
        createdAt: '2026-04-19T00:00:00.000Z',
      }),
    );

    const out = await getRegistrationChallenge('chal_bytes', OPTS);
    expect(out).not.toBeNull();
    expect(out!.challenge).toBe('chal_bytes');
    expect(out!.expiresAt).toBeInstanceOf(Date);

    const [url, init] = vi.mocked(req()).mock.calls[0]! as unknown as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    verifySignedCall({
      url,
      method: 'GET',
      expectedUrl: 'http://localhost:3002/api/registration-challenges/chal_bytes',
      expectedPath: '/api/registration-challenges/chal_bytes',
      headers: init.headers,
    });
  });

  it('returns null when Palisade responds 404', async () => {
    vi.mocked(req()).mockResolvedValue(
      errorResponse({ error: { code: 'challenge_not_found' } }, 404),
    );

    const out = await getRegistrationChallenge('missing', OPTS);
    expect(out).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteRegistrationChallenge
// ---------------------------------------------------------------------------

describe('deleteRegistrationChallenge', () => {
  it('DELETEs the challenge and resolves on 204', async () => {
    vi.mocked(req()).mockResolvedValue(emptyResponse(204));

    await expect(deleteRegistrationChallenge('chal_bytes', OPTS)).resolves.toBeUndefined();

    const [url, init] = vi.mocked(req()).mock.calls[0]! as unknown as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(init.method).toBe('DELETE');
    verifySignedCall({
      url,
      method: 'DELETE',
      expectedUrl: 'http://localhost:3002/api/registration-challenges/chal_bytes',
      expectedPath: '/api/registration-challenges/chal_bytes',
      headers: init.headers,
    });
  });

  it('silently swallows a 404 (race with sweeper)', async () => {
    vi.mocked(req()).mockResolvedValue(
      errorResponse({ error: { code: 'challenge_not_found' } }, 404),
    );

    await expect(deleteRegistrationChallenge('missing', OPTS)).resolves.toBeUndefined();
  });
});
