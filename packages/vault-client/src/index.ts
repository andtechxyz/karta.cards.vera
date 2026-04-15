import { request } from 'undici';
import { signRequest } from '@vera/service-auth';

// -----------------------------------------------------------------------------
// @vera/vault-client — typed HTTP client for the vault service.
//
// Pay and activation import this instead of calling vault internals directly.
// Every request is HMAC-signed with the caller's keyId + shared secret; the
// vault service rejects anything unsigned, tampered, or outside the replay
// window (PCI-DSS 7.1/7.2/8.2).
// -----------------------------------------------------------------------------

// Every request carries the caller identity implicitly via the HMAC `keyId`
// on the signed-request envelope — the vault records that as the VaultAccessLog
// actor, so the body never carries a self-reported `actor`.  Only `purpose`
// (free-form context) travels in the body.

export interface StoreCardInput {
  pan: string;
  cvc?: string;
  expiryMonth: string;
  expiryYear: string;
  cardholderName: string;
  purpose: string;
  /** If set, vault links the new VaultEntry onto this Card row atomically. */
  cardId?: string;
  onDuplicate?: 'error' | 'reuse';
  ip?: string;
  ua?: string;
}

export interface StoreCardResult {
  vaultEntryId: string;
  panLast4: string;
  deduped: boolean;
}

export interface MintTokenInput {
  vaultEntryId: string;
  amount: number;
  currency: string;
  purpose: string;
  transactionId?: string;
  ip?: string;
  ua?: string;
}

export interface MintTokenResult {
  token: string;
  retrievalTokenId: string;
  expiresAt: string;
}

export interface ConsumeTokenInput {
  token: string;
  expectedAmount: number;
  expectedCurrency: string;
  purpose: string;
  transactionId?: string;
  ip?: string;
  ua?: string;
}

export interface DecryptedCard {
  pan: string;
  cvc?: string;
  expMonth: string;
  expYear: string;
  cardholderName: string | null;
  last4: string;
  bin: string;
}

export interface ConsumeTokenResult {
  retrievalTokenId: string;
  vaultEntryId: string;
  card: DecryptedCard;
}

export interface ProxyInput {
  retrievalToken: string;
  destination: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  expectedAmount: number;
  expectedCurrency: string;
  purpose: string;
  transactionId?: string;
  ip?: string;
  ua?: string;
}

export interface ProxyResult {
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
}

export class VaultClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VaultClientError';
  }
}

export interface VaultClientOptions {
  /** This service's caller identity on the vault (e.g. 'pay', 'activation'). */
  keyId: string;
  /** 32-byte hex secret shared with the vault's SERVICE_AUTH_KEYS[keyId]. */
  secret: string;
}

async function vaultFetch<T>(
  baseUrl: string,
  path: string,
  method: string,
  body: unknown,
  auth: VaultClientOptions,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const bodyBytes = Buffer.from(JSON.stringify(body), 'utf8');
  const authorization = signRequest({
    method,
    pathAndQuery: path,
    body: bodyBytes,
    keyId: auth.keyId,
    secret: auth.secret,
  });
  const { statusCode, body: responseBody } = await request(url, {
    method,
    headers: { 'content-type': 'application/json', authorization },
    body: bodyBytes,
  });
  const text = await responseBody.text();
  if (statusCode >= 400) {
    let code = 'vault_error';
    let message = `Vault service returned ${statusCode}`;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (parsed.error?.code) code = parsed.error.code;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // non-JSON error body
    }
    throw new VaultClientError(statusCode, code, message);
  }
  return JSON.parse(text) as T;
}

export function createVaultClient(baseUrl: string, auth: VaultClientOptions) {
  return {
    /** Vault a PAN.  The verified caller identity (HMAC keyId) is the audit actor. */
    async storeCard(input: StoreCardInput): Promise<StoreCardResult> {
      return vaultFetch<StoreCardResult>(baseUrl, '/api/vault/store', 'POST', input, auth);
    },

    /** Mint a single-use retrieval token for a vaulted entry. */
    async mintToken(input: MintTokenInput): Promise<MintTokenResult> {
      return vaultFetch<MintTokenResult>(baseUrl, '/api/vault/tokens/mint', 'POST', input, auth);
    },

    /** Atomically consume a retrieval token and return decrypted card data. */
    async consumeToken(input: ConsumeTokenInput): Promise<ConsumeTokenResult> {
      return vaultFetch<ConsumeTokenResult>(baseUrl, '/api/vault/tokens/consume', 'POST', input, auth);
    },

    /** Forward a request through the vault proxy (PAN substitution). */
    async proxy(input: ProxyInput): Promise<ProxyResult> {
      return vaultFetch<ProxyResult>(baseUrl, '/api/vault/proxy', 'POST', input, auth);
    },
  };
}

export type VaultClient = ReturnType<typeof createVaultClient>;
