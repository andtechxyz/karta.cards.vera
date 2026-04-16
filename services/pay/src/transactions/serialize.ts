import type { Transaction, Card, VaultEntry } from '@prisma/client';

// Client-facing projection of a Transaction row.  Centralised here because
// both the REST endpoints (/api/transactions*) and the SSE `transaction_*`
// events need a single, stable shape; diverging projections were already a
// subtle source of "tier is this one place but allowedCredentialKinds is
// another" bugs.

/**
 * Full DTO for single-transaction lookups (GET /:rlid).
 * Includes challengeNonce (needed by the auth ceremony) but NOT cardId.
 */
export function toTransactionDto(txn: Transaction) {
  return {
    id: txn.id,
    rlid: txn.rlid,
    status: txn.status,
    tier: txn.tier,
    actualTier: txn.actualTier,
    allowedCredentialKinds: txn.allowedCredentialKinds,
    amount: txn.amount,
    currency: txn.currency,
    merchantRef: txn.merchantRef,
    merchantName: txn.merchantName,
    challengeNonce: txn.challengeNonce,
    expiresAt: txn.expiresAt,
  };
}

export type TransactionDto = ReturnType<typeof toTransactionDto>;

/**
 * List DTO — omits challengeNonce (not needed in list context) and replaces
 * the internal cardId with the external cardRef + panLast4.
 */
export function toTransactionListDto(
  txn: Transaction & { card: Pick<Card, 'cardRef'> & { vaultEntry: Pick<VaultEntry, 'panLast4'> | null } },
) {
  return {
    id: txn.id,
    rlid: txn.rlid,
    status: txn.status,
    tier: txn.tier,
    actualTier: txn.actualTier,
    allowedCredentialKinds: txn.allowedCredentialKinds,
    amount: txn.amount,
    currency: txn.currency,
    merchantRef: txn.merchantRef,
    merchantName: txn.merchantName,
    expiresAt: txn.expiresAt,
    cardRef: txn.card.cardRef,
    panLast4: txn.card.vaultEntry?.panLast4 ?? null,
  };
}

export type TransactionListDto = ReturnType<typeof toTransactionListDto>;
