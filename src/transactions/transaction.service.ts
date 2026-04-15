import crypto from 'node:crypto';
import { customAlphabet } from 'nanoid';
import { TransactionStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getConfig } from '../config.js';
import { badRequest, gone, notFound } from '../middleware/error.js';
import { determineTier } from './tier.js';
import { assertTransition } from './state-machine.js';

// Short, URL-safe, unambiguous RLID for the QR payload.
const rlidGen = customAlphabet('23456789abcdefghijkmnpqrstuvwxyz', 12);

export interface CreateTxnInput {
  cardId: string;
  amount: number;
  currency: string;
  merchantRef: string;
  merchantName?: string;
}

export async function createTransaction(input: CreateTxnInput) {
  if (input.amount <= 0) {
    throw badRequest('invalid_amount', 'amount must be positive minor units');
  }
  const card = await prisma.card.findUnique({ where: { id: input.cardId } });
  if (!card) throw notFound('card_not_found', 'Card not found');
  if (card.status !== 'ACTIVATED') {
    throw badRequest('card_not_activated', `Card status is ${card.status}`);
  }

  const ttl = getConfig().TRANSACTION_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const tier = determineTier(input.amount);
  const challenge = crypto.randomBytes(32).toString('base64url');
  const rlid = rlidGen();

  return prisma.transaction.create({
    data: {
      rlid,
      cardId: card.id,
      amount: input.amount,
      currency: input.currency,
      merchantRef: input.merchantRef,
      merchantName: input.merchantName ?? 'Demo Merchant',
      status: TransactionStatus.PENDING,
      tier,
      challengeNonce: challenge,
      expiresAt,
    },
  });
}

export async function getTransactionByRlid(rlid: string) {
  const txn = await prisma.transaction.findUnique({
    where: { rlid },
    include: { card: true },
  });
  if (!txn) throw notFound('transaction_not_found', 'Transaction not found');
  // Opportunistic expiry: if a client hits a transaction past its TTL we
  // transition it to EXPIRED on read so the customer page can show a clean
  // "expired" state.
  if (txn.status === TransactionStatus.PENDING && txn.expiresAt < new Date()) {
    const expired = await updateStatus(txn.id, TransactionStatus.EXPIRED, {
      failureReason: 'transaction_ttl_elapsed',
    });
    return { ...expired, card: txn.card };
  }
  return txn;
}

export async function updateStatus(
  id: string,
  to: TransactionStatus,
  extra: Partial<Prisma.TransactionUpdateInput> = {},
) {
  const current = await prisma.transaction.findUniqueOrThrow({ where: { id } });
  assertTransition(current.status, to);
  const now = new Date();
  const patch: Prisma.TransactionUpdateInput = { ...extra, status: to };
  if (to === TransactionStatus.COMPLETED) patch.completedAt = now;
  if (to === TransactionStatus.FAILED) patch.failedAt = now;
  return prisma.transaction.update({ where: { id }, data: patch });
}

/** Atomically claim + increment the card's ATC for an ARQC generation. */
export async function reserveAtc(cardId: string): Promise<number> {
  const updated = await prisma.card.update({
    where: { id: cardId },
    data: { atc: { increment: 1 } },
    select: { atc: true },
  });
  return updated.atc;
}

export async function listTransactions(limit = 100) {
  return prisma.transaction.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 500),
    include: {
      card: {
        select: {
          id: true,
          cardIdentifier: true,
          vaultEntry: { select: { panLast4: true } },
        },
      },
    },
  });
}

/** Used by auth verify to fetch a txn and assert it's authable (not expired). */
export async function getTransactionForAuthOrThrow(rlid: string) {
  const txn = await getTransactionByRlid(rlid);
  if (txn.status === TransactionStatus.EXPIRED) {
    throw gone('transaction_expired', 'Transaction has expired');
  }
  if (
    txn.status === TransactionStatus.COMPLETED ||
    txn.status === TransactionStatus.FAILED
  ) {
    throw badRequest('transaction_terminal', `Transaction already ${txn.status}`);
  }
  return txn;
}
