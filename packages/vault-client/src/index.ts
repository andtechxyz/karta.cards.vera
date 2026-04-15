import { request } from 'undici';

// -----------------------------------------------------------------------------
// @vera/vault-client — typed HTTP client for the vault service.
//
// Pay service imports this instead of calling vault internals directly.
// The vault service URL is read from VAULT_SERVICE_URL in env.
// -----------------------------------------------------------------------------

export interface MintTokenInput {
  vaultEntryId: string;
  amount: number;
  currency: string;
  purpose: string;
  actor: string;
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
  actor: string;
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
  actor?: string;
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

async function vaultFetch<T>(
  baseUrl: string,
  path: string,
  method: string,
  body: unknown,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const { statusCode, body: responseBody } = await request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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

export function createVaultClient(baseUrl: string) {
  return {
    /** Mint a single-use retrieval token for a vaulted entry. */
    async mintToken(input: MintTokenInput): Promise<MintTokenResult> {
      return vaultFetch<MintTokenResult>(baseUrl, '/api/vault/tokens/mint', 'POST', input);
    },

    /** Atomically consume a retrieval token and return decrypted card data. */
    async consumeToken(input: ConsumeTokenInput): Promise<ConsumeTokenResult> {
      return vaultFetch<ConsumeTokenResult>(baseUrl, '/api/vault/tokens/consume', 'POST', input);
    },

    /** Forward a request through the vault proxy (PAN substitution). */
    async proxy(input: ProxyInput): Promise<ProxyResult> {
      return vaultFetch<ProxyResult>(baseUrl, '/api/vault/proxy', 'POST', input);
    },
  };
}

export type VaultClient = ReturnType<typeof createVaultClient>;
