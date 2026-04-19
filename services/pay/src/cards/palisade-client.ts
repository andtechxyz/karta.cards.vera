import { request } from 'undici';
import { signRequest } from '@vera/service-auth';
import { badRequest, notFound } from '@vera/core';

// -----------------------------------------------------------------------------
// Palisade card-lookup client.
//
// Pay used to read `card.programId` + `card.status` directly from Vera's
// Card table, but in the Vera/Palisade split the card domain moved to
// Palisade's Postgres.  This client calls Palisade activation's
// GET /api/cards/lookup/:cardId endpoint over HMAC-signed HTTP (same wire
// scheme as vault-client, mirrored from the other direction: Palisade →
// Vera vault uses the same VeraHmac envelope).
//
// Response shape matches Palisade's projection — deliberate subset of the
// Card row, no PAN ciphertext, no SDM keys, nothing that would widen pay's
// blast radius.
// -----------------------------------------------------------------------------

export interface CardState {
  id: string;
  cardRef: string;
  status: string;
  programId: string | null;
  retailSaleStatus: string | null;
  chipSerial: string | null;
  panLast4: string | null;
  panBin: string | null;
  cardholderName: string | null;
}

export interface PalisadeClientOptions {
  baseUrl: string;
  keyId: string;
  /** 32-byte hex secret shared with Palisade's PAY_AUTH_KEYS[keyId]. */
  secret: string;
}

export class PalisadeClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PalisadeClientError';
  }
}

/**
 * Look up a card by its Palisade id.  Throws:
 *   - 404 card_not_found if Palisade returns 404.
 *   - 400-mapped upstream error for any other non-2xx status.
 *   - PalisadeClientError for transport-level failures / malformed bodies.
 */
export async function lookupCard(
  cardId: string,
  opts: PalisadeClientOptions,
): Promise<CardState> {
  if (!cardId) throw badRequest('invalid_card_id', 'cardId is required');
  const pathAndQuery = `/api/cards/lookup/${encodeURIComponent(cardId)}`;
  const url = `${opts.baseUrl.replace(/\/$/, '')}${pathAndQuery}`;

  const authorization = signRequest({
    method: 'GET',
    pathAndQuery,
    body: Buffer.alloc(0),
    keyId: opts.keyId,
    secret: opts.secret,
  });

  const { statusCode, body } = await request(url, {
    method: 'GET',
    headers: { authorization },
  });
  const text = await body.text();

  if (statusCode === 404) {
    throw notFound('card_not_found', 'Card not found in Palisade');
  }
  if (statusCode >= 400) {
    let code = 'palisade_error';
    let message = `Palisade lookup returned ${statusCode}`;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (parsed.error?.code) code = parsed.error.code;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // non-JSON error body — fall through with defaults.
    }
    throw new PalisadeClientError(statusCode, code, message);
  }

  try {
    return JSON.parse(text) as CardState;
  } catch {
    throw new PalisadeClientError(statusCode, 'palisade_bad_body', 'Palisade returned a non-JSON body');
  }
}
