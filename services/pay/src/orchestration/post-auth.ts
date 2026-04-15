import { TransactionStatus } from '@prisma/client';
import { prisma } from '@vera/db';
import { badRequest } from '@vera/core';
import { createVaultClient } from '@vera/vault-client';
import { updateStatus, reserveAtc } from '../transactions/index.js';
import { generateArqc, validateArqc } from '../arqc/index.js';
import { getPaymentProvider } from '../providers/index.js';
import { publish, sseBus } from '../realtime/index.js';
import { getPayConfig } from '../env.js';

// -----------------------------------------------------------------------------
// Post-auth orchestration — riskiest single function in the system.
// Uses vault-client to mint retrieval tokens (vault keeps PAN decrypt).
// -----------------------------------------------------------------------------

export interface OrchestratePostAuthInput {
  transactionId: string;
  usedCredentialId: string;
  ip?: string;
  ua?: string;
}

export interface OrchestratePostAuthResult {
  rlid: string;
  status: TransactionStatus;
  providerName?: string;
  providerTxnId?: string;
  last4?: string;
}

export async function orchestratePostAuth(
  input: OrchestratePostAuthInput,
): Promise<OrchestratePostAuthResult> {
  const txn = await prisma.transaction.findUniqueOrThrow({
    where: { id: input.transactionId },
    include: { card: { include: { vaultEntry: true } } },
  });

  const rlid = txn.rlid;

  if (!txn.card.vaultEntry || !txn.card.vaultEntryId) {
    await fail(txn.id, rlid, 'card_not_vaulted');
    throw badRequest('card_not_vaulted', 'Card has no vault entry');
  }

  // --- 1. Advance state ---------------------------------------------------
  await updateStatus(txn.id, TransactionStatus.AUTHN_STARTED, {
    usedCredentialId: input.usedCredentialId,
  });
  publish(rlid, 'authn_started');

  await updateStatus(txn.id, TransactionStatus.AUTHN_COMPLETE);
  publish(rlid, 'authn_complete');

  try {
    // --- 2. Generate OBO ARQC ---------------------------------------------
    const atc = await reserveAtc(txn.cardId);
    const arqcInput = {
      bin: txn.card.vaultEntry.panBin,
      cardId: txn.card.id,
      atc,
      amount: txn.amount,
      currency: txn.currency,
      merchantRef: txn.merchantRef,
      nonce: txn.challengeNonce,
    };
    const { arqc } = generateArqc(arqcInput);
    if (!validateArqc(arqcInput, arqc)) {
      throw new Error('arqc_self_validation_failed');
    }
    await updateStatus(txn.id, TransactionStatus.ARQC_VALID, { arqc, atcUsed: atc });
    publish(rlid, 'arqc_valid', { atc });

    // --- 3. Mint retrieval token via vault-client --------------------------
    const config = getPayConfig();
    const vaultClient = createVaultClient(config.VAULT_SERVICE_URL);
    const tokenResult = await vaultClient.mintToken({
      vaultEntryId: txn.card.vaultEntryId,
      amount: txn.amount,
      currency: txn.currency,
      purpose: `orchestration:${rlid}`,
      actor: `transaction:${rlid}`,
      transactionId: txn.id,
      ip: input.ip,
      ua: input.ua,
    });

    // --- 4. Provider tokenise --------------------------------------------
    const provider = getPaymentProvider();
    const pm = await provider.createPaymentMethod({
      retrievalToken: tokenResult.token,
      expectedAmount: txn.amount,
      expectedCurrency: txn.currency,
      actor: `transaction:${rlid}`,
      transactionId: txn.id,
    });
    await updateStatus(txn.id, TransactionStatus.VAULT_RETRIEVED, {
      providerName: provider.name,
      providerPaymentMethodId: pm.providerPaymentMethodId,
    });
    publish(rlid, 'vault_retrieved');
    publish(rlid, 'provider_tokenised', { providerName: provider.name, last4: pm.last4 });

    // --- 5. Charge --------------------------------------------------------
    const charge = await provider.charge({
      providerPaymentMethodId: pm.providerPaymentMethodId,
      amount: txn.amount,
      currency: txn.currency,
      idempotencyKey: `charge_${txn.id}`,
      merchantRef: txn.merchantRef,
    });
    if (charge.status !== 'succeeded') {
      await fail(txn.id, rlid, `provider_charge_failed: ${charge.error ?? 'unknown'}`);
      return { rlid, status: TransactionStatus.FAILED, providerName: provider.name, last4: pm.last4 };
    }
    await updateStatus(txn.id, TransactionStatus.STRIPE_CHARGED, { providerTxnId: charge.providerTxnId });
    publish(rlid, 'charged', { providerTxnId: charge.providerTxnId });

    // --- 6. Complete ------------------------------------------------------
    const completed = await updateStatus(txn.id, TransactionStatus.COMPLETED, { actualTier: txn.tier });
    publish(rlid, 'completed', { providerName: provider.name, providerTxnId: charge.providerTxnId, last4: pm.last4 });
    sseBus.forget(rlid);

    return {
      rlid,
      status: completed.status,
      providerName: provider.name,
      providerTxnId: charge.providerTxnId,
      last4: pm.last4,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await fail(txn.id, rlid, msg);
    throw err;
  }
}

async function fail(id: string, rlid: string, reason: string) {
  try {
    await updateStatus(id, TransactionStatus.FAILED, { failureReason: reason });
  } catch {
    // already terminal
  }
  publish(rlid, 'failed', { reason });
  sseBus.forget(rlid);
}
