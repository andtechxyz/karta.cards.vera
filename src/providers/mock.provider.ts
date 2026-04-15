import { customAlphabet } from 'nanoid';
import { consumeRetrievalToken, vaultEvents } from '../vault/index.js';
import type { ChargeResult, PaymentProvider } from './provider.interface.js';

// Mock provider used for local e2e and unit tests.  Faithful to the real
// adapters in shape: consumes the retrieval token inside this module (so the
// vault's TOKEN_CONSUMED / PROVIDER_TOKENISED events fire exactly once), then
// returns synthetic IDs.  Charges "succeed" unless `amount < 0` (a deliberate
// hook for failure-path tests).

const pmId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);
const txId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);

export class MockProvider implements PaymentProvider {
  readonly name = 'mock';

  // In-memory map so charge() can look up what createPaymentMethod produced.
  private pms = new Map<string, { last4: string; vaultEntryId: string; retrievalTokenId: string }>();

  async createPaymentMethod(input: {
    retrievalToken: string;
    expectedAmount: number;
    expectedCurrency: string;
    actor: string;
    transactionId?: string;
    cardholderNameOverride?: string;
  }) {
    const consumed = await consumeRetrievalToken(input.retrievalToken, {
      expectedAmount: input.expectedAmount,
      expectedCurrency: input.expectedCurrency,
      actor: input.actor,
      purpose: 'mock provider tokenise',
      transactionId: input.transactionId,
    });
    const id = `pm_mock_${pmId()}`;
    this.pms.set(id, {
      last4: consumed.card.last4,
      vaultEntryId: consumed.vaultEntryId,
      retrievalTokenId: consumed.retrievalTokenId,
    });

    vaultEvents.emit({
      type: 'PROVIDER_TOKENISED',
      vaultEntryId: consumed.vaultEntryId,
      retrievalTokenId: consumed.retrievalTokenId,
      providerName: this.name,
      transactionId: input.transactionId,
      actor: input.actor,
      purpose: 'mock provider tokenise',
      success: true,
    });

    return { providerPaymentMethodId: id, last4: consumed.card.last4 };
  }

  async charge(input: {
    providerPaymentMethodId: string;
    amount: number;
    currency: string;
    idempotencyKey: string;
    merchantRef: string;
  }): Promise<ChargeResult> {
    const pm = this.pms.get(input.providerPaymentMethodId);
    if (!pm) {
      return {
        providerTxnId: '',
        status: 'failed',
        error: 'unknown_payment_method',
      };
    }
    if (input.amount < 0) {
      return {
        providerTxnId: '',
        status: 'failed',
        error: 'simulated_failure_negative_amount',
      };
    }
    return {
      providerTxnId: `txn_mock_${txId()}`,
      status: 'succeeded',
    };
  }
}
