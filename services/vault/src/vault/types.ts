// Public DTOs for the vault module.  External callers only ever see these —
// they never touch Prisma models directly.

export interface CardMetadata {
  id: string;
  panLast4: string;
  panBin: string;
  panExpiryMonth: string;
  panExpiryYear: string;
  cardholderName: string;
  createdAt: Date;
}

export interface StoreInput {
  pan: string;
  cvc?: string;
  expiryMonth: string; // "01".."12"
  expiryYear: string; // "YY" or "YYYY" accepted; normalised to 2-digit
  cardholderName: string;
  actor: string;
  purpose: string;
  ip?: string;
  ua?: string;
  onDuplicate?: 'error' | 'reuse';
  // Cross-service register path (Palisade → Vera).  When supplied, the same
  // key on a retry returns the same vault entry regardless of fingerprint
  // state — takes precedence over onDuplicate.
  idempotencyKey?: string;
}

export interface StoreResult {
  vaultEntryId: string;
  panLast4: string;
  deduped: boolean;
}

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
  expiresAt: Date;
}

/**
 * The full decrypted card data returned only to trusted adapters (payment
 * providers or the outbound proxy).  Never returned to external callers.
 */
export interface DecryptedCard {
  pan: string;
  cvc?: string;
  expMonth: string;
  expYear: string;
  cardholderName: string;
  last4: string;
  bin: string;
}
