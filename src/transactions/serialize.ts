import type { Transaction } from '@prisma/client';

// Client-facing projection of a Transaction row.  Centralised here because
// both the REST endpoints (/api/transactions*) and the SSE `transaction_*`
// events need a single, stable shape; diverging projections were already a
// subtle source of "tier is this one place but allowedCredentialKinds is
// another" bugs.

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
    cardId: txn.cardId,
  };
}

export type TransactionDto = ReturnType<typeof toTransactionDto>;
