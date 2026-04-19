import crypto from 'node:crypto';
import { customAlphabet } from 'nanoid';
import { TransactionStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { prisma } from '@vera/db';
import { badRequest, gone, notFound } from '@vera/core';
import { TRANSACTION_TTL_ELAPSED_REASON } from '@vera/retention';
import { normaliseCurrency, resolveRulesFromTokenisationProgram } from '@vera/programs';
import { evaluateTierRules } from './tier.js';
import { assertTransition } from './state-machine.js';
import { getPayConfig } from '../env.js';
import { lookupCard } from '../cards/index.js';

// Palisade's canonical card lifecycle — mirrored here so pay can enforce
// "must be ACTIVATED" without reaching into Palisade's @prisma/client.  Kept
// as a string literal rather than an imported enum because the two repos
// now have separate Prisma schemas and we deliberately don't depend on
// Palisade's types.
const CARD_STATUS_ACTIVATED = 'ACTIVATED';

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
  // Card state lives in Palisade (Vera owns vault + transactions, not cards).
  // lookupCard throws 404 notFound on unknown ids — we let that propagate.
  const payConfig = getPayConfig();
  const card = await lookupCard(input.cardId, {
    baseUrl: payConfig.PALISADE_BASE_URL,
    keyId: 'pay',
    secret: payConfig.SERVICE_AUTH_PALISADE_SECRET,
  });
  if (card.status !== CARD_STATUS_ACTIVATED) {
    throw badRequest('card_not_activated', `Card status is ${card.status}`);
  }

  // Tier rules live on Vera's TokenisationProgram (Phase 4c).  Palisade
  // admin still edits the card-side Program (NDEF templates, FI, embossing),
  // but tierRules + currency for tx enforcement are resolved here.
  const tokenisationProgram = card.programId
    ? await prisma.tokenisationProgram.findUnique({ where: { id: card.programId } })
    : null;
  const { rules, currency: programCurrency, programId } =
    resolveRulesFromTokenisationProgram(tokenisationProgram);
  const currency = normaliseCurrency(input.currency);
  if (programCurrency && programCurrency !== currency) {
    throw badRequest(
      'currency_mismatch',
      `Card program ${programId} issues in ${programCurrency}; transaction currency was ${input.currency}`,
    );
  }
  const decision = evaluateTierRules(rules, input.amount);

  const ttl = payConfig.TRANSACTION_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const challenge = crypto.randomBytes(32).toString('base64url');
  const rlid = rlidGen();

  return prisma.transaction.create({
    data: {
      rlid,
      cardId: card.id,
      amount: input.amount,
      currency,
      merchantRef: input.merchantRef,
      merchantName: input.merchantName ?? 'Demo Merchant',
      status: TransactionStatus.PENDING,
      tier: decision.tier,
      allowedCredentialKinds: decision.allowedKinds,
      challengeNonce: challenge,
      expiresAt,
    },
  });
}

export async function getTransactionByRlid(rlid: string) {
  const txn = await prisma.transaction.findUnique({ where: { rlid } });
  if (!txn) throw notFound('transaction_not_found', 'Transaction not found');
  if (txn.status === TransactionStatus.PENDING && txn.expiresAt < new Date()) {
    // Race-safe against the retention sweep: if the bulk expire already ran,
    // updateMany affects 0 rows and we fall through to re-read the row as
    // EXPIRED rather than throwing on an EXPIRED→EXPIRED self-transition.
    await prisma.transaction.updateMany({
      where: { id: txn.id, status: TransactionStatus.PENDING },
      data: {
        status: TransactionStatus.EXPIRED,
        failureReason: TRANSACTION_TTL_ELAPSED_REASON,
      },
    });
    return prisma.transaction.findUniqueOrThrow({ where: { id: txn.id } });
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
          cardRef: true,
          vaultEntry: { select: { panLast4: true } },
        },
      },
    },
  });
}

export async function getTransactionCardSummary(rlid: string) {
  const txn = await prisma.transaction.findUnique({
    where: { rlid },
    select: {
      card: {
        select: {
          id: true,
          vaultEntry: { select: { panLast4: true } },
          credentials: { select: { kind: true } },
        },
      },
    },
  });
  if (!txn) throw notFound('transaction_not_found', 'Transaction not found');
  return txn.card;
}

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
