import type { Transaction } from '@prisma/client';

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
 * List DTO — omits challengeNonce (not needed in list context) and exposes
 * the denormalised display bits (cardRef + panLast4) directly off the
 * Transaction row.  Pre-split this required a Transaction → Card → VaultEntry
 * join; post-split the fields are stamped at create time in
 * transaction.service.ts::createTransaction so the list query stays a
 * single-table read.
 */
export function toTransactionListDto(txn: Transaction) {
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
    cardRef: txn.cardRef,
    panLast4: txn.panLast4,
  };
}

export type TransactionListDto = ReturnType<typeof toTransactionListDto>;
