import { customAlphabet } from 'nanoid';
import { prisma } from '@vera/db';
import { badRequest, gone, notFound, decrypt } from '@vera/core';
import type { EncryptedPayload } from '@vera/core';
import { vaultEvents } from './events.js';
import type { DecryptedCard, MintTokenInput, MintTokenResult } from './types.js';
import { getVaultConfig } from '../env.js';

// Token alphabet: URL-safe, unambiguous (no 0/O/1/l).  32 chars of this gives
// well over 160 bits of entropy — comfortable for a 60-second single-use token.
const tokenId = customAlphabet('23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', 32);

export async function mintRetrievalToken(input: MintTokenInput): Promise<MintTokenResult> {
  const entry = await prisma.vaultEntry.findUnique({ where: { id: input.vaultEntryId } });
  if (!entry) throw notFound('vault_entry_not_found', 'Vault entry not found');

  const ttl = getVaultConfig().RETRIEVAL_TOKEN_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const token = tokenId();

  const row = await prisma.retrievalToken.create({
    data: {
      token,
      amount: input.amount,
      currency: input.currency,
      purpose: input.purpose,
      expiresAt,
      vaultEntryId: entry.id,
    },
  });

  vaultEvents.emit({
    type: 'TOKEN_MINTED',
    vaultEntryId: entry.id,
    retrievalTokenId: row.id,
    transactionId: input.transactionId,
    actor: input.actor,
    purpose: input.purpose,
    ip: input.ip,
    ua: input.ua,
  });

  return { token, retrievalTokenId: row.id, expiresAt };
}

export interface ConsumeContext {
  expectedAmount: number;
  expectedCurrency: string;
  actor: string;
  purpose: string;
  ip?: string;
  ua?: string;
  transactionId?: string;
}

export interface ConsumeResult {
  retrievalTokenId: string;
  vaultEntryId: string;
  card: DecryptedCard;
}

/**
 * Atomically consume a retrieval token.  Returns the decrypted card data.
 *
 * Race-safe via updateMany; count !== 1 means already used, expired, or missing.
 */
export async function consumeRetrievalToken(
  token: string,
  ctx: ConsumeContext,
): Promise<ConsumeResult> {
  const now = new Date();
  const claim = await prisma.retrievalToken.updateMany({
    where: { token, used: false, expiresAt: { gt: now } },
    data: { used: true, usedAt: now },
  });
  if (claim.count !== 1) {
    const row = await prisma.retrievalToken.findUnique({ where: { token } });
    if (!row) {
      vaultEvents.emit({
        type: 'TOKEN_CONSUMED',
        vaultEntryId: 'unknown',
        retrievalTokenId: 'unknown',
        transactionId: ctx.transactionId,
        actor: ctx.actor,
        purpose: ctx.purpose,
        ip: ctx.ip,
        ua: ctx.ua,
        success: false,
        errorMessage: 'token_not_found',
      });
      throw notFound('token_not_found', 'Retrieval token not found');
    }
    vaultEvents.emit({
      type: 'TOKEN_CONSUMED',
      vaultEntryId: row.vaultEntryId,
      retrievalTokenId: row.id,
      transactionId: ctx.transactionId,
      actor: ctx.actor,
      purpose: ctx.purpose,
      ip: ctx.ip,
      ua: ctx.ua,
      success: false,
      errorMessage: row.used ? 'token_already_used' : 'token_expired',
    });
    throw gone(
      row.used ? 'token_already_used' : 'token_expired',
      row.used ? 'Retrieval token was already consumed' : 'Retrieval token expired',
    );
  }

  const row = await prisma.retrievalToken.findUniqueOrThrow({
    where: { token },
    include: { vaultEntry: true },
  });
  if (row.amount !== ctx.expectedAmount || row.currency !== ctx.expectedCurrency) {
    vaultEvents.emit({
      type: 'TOKEN_CONSUMED',
      vaultEntryId: row.vaultEntryId,
      retrievalTokenId: row.id,
      transactionId: ctx.transactionId,
      actor: ctx.actor,
      purpose: ctx.purpose,
      ip: ctx.ip,
      ua: ctx.ua,
      success: false,
      errorMessage: 'amount_or_currency_mismatch',
    });
    throw badRequest(
      'amount_mismatch',
      'Token amount/currency does not match the requested charge',
    );
  }

  const payload: EncryptedPayload = {
    ciphertext: row.vaultEntry.encryptedPan,
    keyVersion: row.vaultEntry.keyVersion,
  };
  const plaintext = decrypt(payload);
  const { pan, cvc } = JSON.parse(plaintext) as { pan: string; cvc?: string };

  const card: DecryptedCard = {
    pan,
    cvc,
    expMonth: row.vaultEntry.panExpiryMonth,
    expYear: row.vaultEntry.panExpiryYear,
    cardholderName: row.vaultEntry.cardholderName,
    last4: row.vaultEntry.panLast4,
    bin: row.vaultEntry.panBin,
  };

  vaultEvents.emit({
    type: 'TOKEN_CONSUMED',
    vaultEntryId: row.vaultEntryId,
    retrievalTokenId: row.id,
    transactionId: ctx.transactionId,
    actor: ctx.actor,
    purpose: ctx.purpose,
    ip: ctx.ip,
    ua: ctx.ua,
    success: true,
  });

  return {
    retrievalTokenId: row.id,
    vaultEntryId: row.vaultEntryId,
    card,
  };
}
