import { customAlphabet } from 'nanoid';
import type { VaultClient } from '@vera/vault-client';
import type { ChargeResult, PaymentProvider } from './provider.interface.js';

// Mock provider — consumes retrieval token via vault-client, returns synthetic IDs.
// Charges "succeed" unless amount < 0 (deliberate failure-path hook for tests).

const pmId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);
const txId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);

export class MockProvider implements PaymentProvider {
  readonly name = 'mock';

  constructor(private readonly vaultClient: VaultClient) {}

  private pms = new Map<string, { last4: string; vaultEntryId: string; retrievalTokenId: string }>();

  async createPaymentMethod(input: {
    retrievalToken: string;
    expectedAmount: number;
    expectedCurrency: string;
    transactionId?: string;
    cardholderNameOverride?: string;
  }) {
    const consumed = await this.vaultClient.consumeToken({
      token: input.retrievalToken,
      expectedAmount: input.expectedAmount,
      expectedCurrency: input.expectedCurrency,
      purpose: 'mock provider tokenise',
      transactionId: input.transactionId,
    });
    const id = `pm_mock_${pmId()}`;
    this.pms.set(id, {
      last4: consumed.card.last4,
      vaultEntryId: consumed.vaultEntryId,
      retrievalTokenId: consumed.retrievalTokenId,
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
      return { providerTxnId: '', status: 'failed', error: 'unknown_payment_method' };
    }
    if (input.amount < 0) {
      return { providerTxnId: '', status: 'failed', error: 'simulated_failure_negative_amount' };
    }
    return { providerTxnId: `txn_mock_${txId()}`, status: 'succeeded' };
  }
}
