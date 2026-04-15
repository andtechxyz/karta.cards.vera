import { TransactionStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { badRequest } from '../middleware/error.js';
import { updateStatus, reserveAtc } from '../transactions/index.js';
import { generateArqc, validateArqc } from '../arqc/index.js';
import { mintRetrievalToken } from '../vault/index.js';
import { getPaymentProvider } from '../providers/index.js';
import { publish, sseBus } from '../realtime/index.js';

// -----------------------------------------------------------------------------
// Post-auth orchestration — the riskiest single function in the system.
//
// Called from POST /api/auth/authenticate/verify AFTER the WebAuthn assertion
// has already been verified.  Runs, in order:
//
//   1. Advance state PENDING → AUTHN_STARTED → AUTHN_COMPLETE
//   2. Reserve an ATC, generate OBO ARQC, self-validate
//   3. Mint a single-use retrieval token (60s, amount-bound)
//   4. Hand to provider.createPaymentMethod — the adapter consumes the token
//      inside its own trust boundary and returns a provider reference
//   5. provider.charge with an idempotency key derived from txn.id
//   6. Transition to COMPLETED, publish final SSE, drop history
//
// Failure at any step → FAILED (terminal), publish "failed", drop history.
// Retrieval-token consumption is not reversible: once step 4 starts, a
// subsequent provider-side error still terminates the transaction.  This is
// the explicit tradeoff in the plan — PAN has left the vault, we don't try
// to "undo" that by minting a second token.
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

  // --- 1. Advance PENDING → AUTHN_STARTED → AUTHN_COMPLETE -------------------
  await updateStatus(txn.id, TransactionStatus.AUTHN_STARTED, {
    usedCredentialId: input.usedCredentialId,
  });
  publish(rlid, 'authn_started');

  await updateStatus(txn.id, TransactionStatus.AUTHN_COMPLETE);
  publish(rlid, 'authn_complete');

  try {
    // --- 2. Generate OBO ARQC ------------------------------------------------
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
      // Should be impossible (symmetric) but guards against future divergence.
      throw new Error('arqc_self_validation_failed');
    }
    await updateStatus(txn.id, TransactionStatus.ARQC_VALID, {
      arqc,
      atcUsed: atc,
    });
    publish(rlid, 'arqc_valid', { atc });

    // --- 3. Mint retrieval token ---------------------------------------------
    const token = await mintRetrievalToken({
      vaultEntryId: txn.card.vaultEntryId,
      amount: txn.amount,
      currency: txn.currency,
      purpose: `orchestration:${rlid}`,
      actor: `transaction:${rlid}`,
      transactionId: txn.id,
      ip: input.ip,
      ua: input.ua,
    });

    // --- 4. Provider tokenise (consumes token inside adapter) ----------------
    const provider = getPaymentProvider();
    const pm = await provider.createPaymentMethod({
      retrievalToken: token.token,
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
    publish(rlid, 'provider_tokenised', {
      providerName: provider.name,
      last4: pm.last4,
    });

    // --- 5. Charge -----------------------------------------------------------
    const charge = await provider.charge({
      providerPaymentMethodId: pm.providerPaymentMethodId,
      amount: txn.amount,
      currency: txn.currency,
      idempotencyKey: `charge_${txn.id}`,
      merchantRef: txn.merchantRef,
    });
    if (charge.status !== 'succeeded') {
      await fail(txn.id, rlid, `provider_charge_failed: ${charge.error ?? 'unknown'}`);
      return {
        rlid,
        status: TransactionStatus.FAILED,
        providerName: provider.name,
        last4: pm.last4,
      };
    }
    await updateStatus(txn.id, TransactionStatus.STRIPE_CHARGED, {
      providerTxnId: charge.providerTxnId,
    });
    publish(rlid, 'charged', { providerTxnId: charge.providerTxnId });

    // --- 6. Complete ---------------------------------------------------------
    const completed = await updateStatus(txn.id, TransactionStatus.COMPLETED, {
      actualTier: txn.tier,
    });
    publish(rlid, 'completed', {
      providerName: provider.name,
      providerTxnId: charge.providerTxnId,
      last4: pm.last4,
    });
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
    // state-machine refused: txn already terminal.  Don't layer a second
    // failure on top of the first.
  }
  publish(rlid, 'failed', { reason });
  sseBus.forget(rlid);
}
