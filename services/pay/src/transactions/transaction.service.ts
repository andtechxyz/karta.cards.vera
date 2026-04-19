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
import {
  incrementAtc,
  listWebAuthnCredentials,
  lookupCard,
  type PalisadeClientOptions,
} from '../cards/index.js';

// Palisade's canonical card lifecycle — mirrored here so pay can enforce
// "must be ACTIVATED" without reaching into Palisade's @prisma/client.  Kept
// as a string literal rather than an imported enum because the two repos
// now have separate Prisma schemas and we deliberately don't depend on
// Palisade's types.
const CARD_STATUS_ACTIVATED = 'ACTIVATED';

const rlidGen = customAlphabet('23456789abcdefghijkmnpqrstuvwxyz', 12);

/** Build the Palisade client options from the resolved pay config. */
function palisadeOpts(): PalisadeClientOptions {
  const payConfig = getPayConfig();
  return {
    baseUrl: payConfig.PALISADE_BASE_URL,
    keyId: 'pay',
    secret: payConfig.SERVICE_AUTH_PALISADE_SECRET,
  };
}

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
  const card = await lookupCard(input.cardId, palisadeOpts());
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

  // `vaultToken` on the Palisade card-lookup response IS the Vera
  // VaultEntry id (Phase 2 FK-cut; see services/vault/src/routes/register.routes.ts).
  // Stamp it onto Transaction so post-auth can mint a retrieval token
  // without a second lookup.  Nullable: admin-only dev cards that never
  // ran the vault-register path have no VaultEntry — post-auth fails
  // that flow with `card_not_vaulted` before minting.
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
      // Denormalised from the Palisade card-lookup response.
      cardRef: card.cardRef,
      panLast4: card.panLast4,
      panBin: card.panBin,
      cardholderName: card.cardholderName,
      vaultEntryId: card.vaultToken,
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

/**
 * Atomically bump the Palisade-side ATC for a card and return the new value.
 * Pay used to `prisma.card.update` directly; in the post-split world the ATC
 * lives in Palisade's Card row, so we PATCH the Palisade endpoint.
 */
export async function reserveAtc(cardId: string): Promise<number> {
  const result = await incrementAtc(cardId, palisadeOpts());
  return result.atc;
}

/**
 * Admin list view.  Reads the denormalised card display fields straight from
 * the Transaction row — no Card join — so it stays a local query even after
 * the Card table moves out of Vera in Phase 3 Step 3.
 */
export async function listTransactions(limit = 100) {
  return prisma.transaction.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 500),
  });
}

/**
 * Shape returned to the customer-facing payment page.  Combines the locally
 * denormalised card display with a Palisade call for the per-card credential
 * kinds (so the SPA can decide whether to offer register vs. authenticate).
 */
export interface TransactionCardSummary {
  id: string;
  panLast4: string | null;
  credentials: { kind: string }[];
}

export async function getTransactionCardSummary(
  rlid: string,
): Promise<TransactionCardSummary> {
  const txn = await prisma.transaction.findUnique({
    where: { rlid },
    select: { cardId: true, panLast4: true },
  });
  if (!txn) throw notFound('transaction_not_found', 'Transaction not found');

  // Credential kinds still live in Palisade.  One HTTP call per page load
  // (the SPA caches locally), and the list is always small (one or two).
  const creds = await listWebAuthnCredentials(txn.cardId, palisadeOpts());

  return {
    id: txn.cardId,
    panLast4: txn.panLast4,
    credentials: creds.map((c) => ({ kind: c.kind })),
  };
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
