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
//
// TODO(palisade-crossrepo-endpoints): the WebAuthn / ATC / registration-
// challenge endpoints below are consumed by pay but landed by the parallel
// Palisade agent on `feature/palisade-pay-crossrepo-endpoints`.  The method
// signatures here MATCH the endpoint shapes that agent is implementing; once
// that branch merges into Palisade main these calls go live without further
// Vera-side changes.  Tests below mock undici so pay development is not
// blocked on Palisade merge order.
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
  /**
   * Opaque Vera VaultEntry id — the cross-repo FK surrogate from Phase 2's
   * `/api/vault/register` flow.  Null for admin-only dev cards that never
   * ran vault registration.  Pay stamps it onto `Transaction.vaultEntryId`
   * so retrieval-token minting doesn't need a Vera-local Card lookup.
   */
  vaultToken: string | null;
}

/**
 * WebAuthn credential row as projected by Palisade.  Matches the Vera-side
 * Prisma model shape that the webauthn service used to read directly — but
 * lives here as a Vera-local TypeScript type (we deliberately do not import
 * Palisade's @prisma/client).
 *
 * `counter` is serialised as a string by Palisade because JSON can't round-
 * trip BigInt; pay converts back to bigint at the edge.
 */
export interface WebAuthnCredential {
  id: string;
  credentialId: string;
  publicKey: string;
  counter: bigint;
  kind: 'PLATFORM' | 'CROSS_PLATFORM';
  transports: string[];
  deviceName: string | null;
  preregistered: boolean;
  cardId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface CreateCredInput {
  credentialId: string;
  publicKey: string;
  counter: bigint;
  kind: 'PLATFORM' | 'CROSS_PLATFORM';
  transports: string[];
  deviceName?: string | null;
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SendOpts {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  pathAndQuery: string;
  body?: unknown;
  opts: PalisadeClientOptions;
  /** If true, a 404 returns null instead of throwing. */
  allow404?: boolean;
  /**
   * When a 404 is NOT allowed, how should it surface?
   *   - 'card': throws notFound('card_not_found', ...) — legacy behaviour
   *     for lookupCard / incrementAtc / the credentials-by-card endpoints.
   *   - 'generic': throws PalisadeClientError(404, ...) — callers map it
   *     to their own domain-appropriate ApiError.
   * Defaults to 'card'.
   */
  onNotFound?: 'card' | 'generic';
  /** If true, skip JSON parse and return undefined on 2xx (for DELETE / 204). */
  expectEmpty?: boolean;
}

/**
 * Shared transport: build the signed request, fire it, map errors uniformly.
 * Returns the parsed JSON body for 2xx, null for allowed 404s, undefined for
 * expectEmpty 2xx.  All non-success paths go through PalisadeClientError /
 * notFound — keeping the error-surface consistent with the existing
 * lookupCard path so webauthn.service can throw the same ApiError shapes it
 * threw when talking to prisma.
 */
async function sendSigned<T>(args: SendOpts): Promise<T> {
  const url = `${args.opts.baseUrl.replace(/\/$/, '')}${args.pathAndQuery}`;
  const bodyBuf =
    args.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(args.body));

  const authorization = signRequest({
    method: args.method,
    pathAndQuery: args.pathAndQuery,
    body: bodyBuf,
    keyId: args.opts.keyId,
    secret: args.opts.secret,
  });

  const headers: Record<string, string> = { authorization };
  if (args.body !== undefined) headers['content-type'] = 'application/json';

  const init: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    headers: Record<string, string>;
    body?: Buffer;
  } = {
    method: args.method,
    headers,
  };
  if (args.body !== undefined) init.body = bodyBuf;

  const { statusCode, body } = await request(url, init);
  const text = await body.text();

  if (statusCode === 404 && args.allow404) {
    return null as T;
  }
  if (statusCode === 404) {
    if ((args.onNotFound ?? 'card') === 'card') {
      throw notFound('card_not_found', 'Card not found in Palisade');
    }
    // Generic 404 — let caller raise a domain-appropriate error.
    let code = 'not_found';
    let message = 'Resource not found in Palisade';
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (parsed.error?.code) code = parsed.error.code;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // fall through
    }
    throw new PalisadeClientError(404, code, message);
  }
  if (statusCode >= 400) {
    let code = 'palisade_error';
    let message = `Palisade request returned ${statusCode}`;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (parsed.error?.code) code = parsed.error.code;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // non-JSON error body — fall through with defaults.
    }
    throw new PalisadeClientError(statusCode, code, message);
  }

  if (args.expectEmpty) return undefined as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PalisadeClientError(statusCode, 'palisade_bad_body', 'Palisade returned a non-JSON body');
  }
}

// ---------------------------------------------------------------------------
// WebAuthn-credential deserialisation: Palisade serialises `counter` as a
// string (JSON BigInt round-trip), all Date fields as ISO strings.  We
// re-inflate here so callers see the same types they had when reading from
// prisma directly.
// ---------------------------------------------------------------------------

interface WireCredential {
  id: string;
  credentialId: string;
  publicKey: string;
  counter: string | number;
  kind: 'PLATFORM' | 'CROSS_PLATFORM';
  transports: string[];
  deviceName: string | null;
  preregistered: boolean;
  cardId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function parseCredential(wire: WireCredential): WebAuthnCredential {
  return {
    id: wire.id,
    credentialId: wire.credentialId,
    publicKey: wire.publicKey,
    counter: BigInt(wire.counter),
    kind: wire.kind,
    transports: wire.transports,
    deviceName: wire.deviceName,
    preregistered: wire.preregistered,
    cardId: wire.cardId,
    createdAt: new Date(wire.createdAt),
    lastUsedAt: wire.lastUsedAt ? new Date(wire.lastUsedAt) : null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
  return sendSigned<CardState>({
    method: 'GET',
    pathAndQuery: `/api/cards/lookup/${encodeURIComponent(cardId)}`,
    opts,
  });
}

/**
 * Atomically increment the card's ATC and return the new value.  Replaces
 * pay's previous `prisma.card.update({ data: { atc: { increment: 1 } } })`;
 * the ATC counter itself still lives in Palisade's Card table.
 */
export async function incrementAtc(
  cardId: string,
  opts: PalisadeClientOptions,
): Promise<{ atc: number }> {
  if (!cardId) throw badRequest('invalid_card_id', 'cardId is required');
  return sendSigned<{ atc: number }>({
    method: 'PATCH',
    pathAndQuery: `/api/cards/${encodeURIComponent(cardId)}/atc-increment`,
    body: {},
    opts,
  });
}

/**
 * List all WebAuthn credentials registered for a card.  Used by
 * beginAuthentication to project the allowCredentials list.
 */
export async function listWebAuthnCredentials(
  cardId: string,
  opts: PalisadeClientOptions,
): Promise<WebAuthnCredential[]> {
  if (!cardId) throw badRequest('invalid_card_id', 'cardId is required');
  const wire = await sendSigned<WireCredential[]>({
    method: 'GET',
    pathAndQuery: `/api/cards/${encodeURIComponent(cardId)}/webauthn-credentials`,
    opts,
  });
  return wire.map(parseCredential);
}

/**
 * Look up a single credential by its credentialId (the raw WebAuthn id,
 * base64url-encoded).  Returns null when Palisade returns 404 — callers
 * then raise their own 404 with a domain-appropriate code.
 */
export async function getWebAuthnCredentialByCredentialId(
  credentialId: string,
  opts: PalisadeClientOptions,
): Promise<WebAuthnCredential | null> {
  if (!credentialId) {
    throw badRequest('invalid_credential_id', 'credentialId is required');
  }
  const wire = await sendSigned<WireCredential | null>({
    method: 'GET',
    pathAndQuery: `/api/webauthn-credentials/${encodeURIComponent(credentialId)}`,
    opts,
    allow404: true,
  });
  return wire ? parseCredential(wire) : null;
}

/**
 * Register a new WebAuthn credential against a card.  Body mirrors the
 * Prisma create input; Palisade inserts and returns the hydrated row.
 */
export async function createWebAuthnCredential(
  cardId: string,
  input: CreateCredInput,
  opts: PalisadeClientOptions,
): Promise<WebAuthnCredential> {
  if (!cardId) throw badRequest('invalid_card_id', 'cardId is required');
  const wire = await sendSigned<WireCredential>({
    method: 'POST',
    pathAndQuery: `/api/cards/${encodeURIComponent(cardId)}/webauthn-credentials`,
    body: {
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      // BigInt serialisation — string across the wire.
      counter: input.counter.toString(),
      kind: input.kind,
      transports: input.transports,
      deviceName: input.deviceName ?? null,
    },
    opts,
  });
  return parseCredential(wire);
}

/**
 * Bump the sign counter on an existing credential and set lastUsedAt.  Used
 * by finishAuthentication after a successful WebAuthn assertion.  Palisade
 * returns the updated values for belt-and-braces so we can log the new
 * counter back to the caller without a second round-trip.
 */
export async function updateWebAuthnCredentialCounter(
  credentialId: string,
  signCounter: number,
  opts: PalisadeClientOptions,
): Promise<{ signCounter: number; lastUsedAt: Date }> {
  if (!credentialId) {
    throw badRequest('invalid_credential_id', 'credentialId is required');
  }
  const wire = await sendSigned<{ signCounter: number; lastUsedAt: string }>({
    method: 'PATCH',
    pathAndQuery: `/api/webauthn-credentials/${encodeURIComponent(credentialId)}/counter`,
    body: { signCounter },
    opts,
    onNotFound: 'generic',
  });
  return { signCounter: wire.signCounter, lastUsedAt: new Date(wire.lastUsedAt) };
}

