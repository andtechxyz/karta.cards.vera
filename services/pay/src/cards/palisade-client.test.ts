import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the SUT.
// ---------------------------------------------------------------------------

vi.mock('undici', () => ({
  request: vi.fn(),
}));

import { request as undiciRequest } from 'undici';
import { lookupCard, PalisadeClientError } from './palisade-client.js';
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

beforeEach(() => {
  vi.mocked(req()).mockReset();
});

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

    // Verify the outbound call shape.
    expect(req()).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(req()).mock.calls[0]! as unknown as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(url).toBe('http://localhost:3002/api/cards/lookup/card_1');
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toMatch(/^VeraHmac keyId=pay,ts=\d+,sig=[0-9a-f]+$/);

    // Round-trip the header against the same verifier the server uses, to
    // catch any drift between signRequest and the canonical input string.
    const verified = verifyRequest({
      authorization: init.headers.authorization,
      method: 'GET',
      pathAndQuery: '/api/cards/lookup/card_1',
      body: Buffer.alloc(0),
      keys: { pay: OPTS.secret },
    });
    expect(verified.keyId).toBe('pay');
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
