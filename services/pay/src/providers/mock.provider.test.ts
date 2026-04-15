import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VaultClient } from '@vera/vault-client';
import { MockProvider } from './mock.provider.js';

// Build a fully-stubbed VaultClient so MockProvider has no external I/O.
function makeVaultClient(overrides?: {
  consumeToken?: ReturnType<typeof vi.fn>;
}): VaultClient {
  return {
    mintToken: vi.fn(),
    consumeToken: overrides?.consumeToken ?? vi.fn(),
    proxy: vi.fn(),
  } as unknown as VaultClient;
}

function freshConsume(overrides: Partial<{ last4: string; vaultEntryId: string; retrievalTokenId: string }> = {}) {
  return {
    retrievalTokenId: overrides.retrievalTokenId ?? 'rtok_1',
    vaultEntryId: overrides.vaultEntryId ?? 've_1',
    card: {
      pan: '4242424242424242',
      cvc: '123',
      expMonth: '12',
      expYear: '28',
      cardholderName: 'Mock Tester',
      last4: overrides.last4 ?? '4242',
      bin: '424242',
    },
  };
}

describe('MockProvider.createPaymentMethod', () => {
  let consumeToken: ReturnType<typeof vi.fn>;
  let provider: MockProvider;

  beforeEach(() => {
    consumeToken = vi.fn();
    provider = new MockProvider(makeVaultClient({ consumeToken }));
  });

  it('consumes the retrieval token with the expected amount/currency', async () => {
    consumeToken.mockResolvedValue(freshConsume());

    await provider.createPaymentMethod({
      retrievalToken: 'tok_abc',
      expectedAmount: 4900,
      expectedCurrency: 'AUD',
      transactionId: 'txn_x',
    });

    expect(consumeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'tok_abc',
        expectedAmount: 4900,
        expectedCurrency: 'AUD',
        purpose: 'mock provider tokenise',
        transactionId: 'txn_x',
      }),
    );
    expect(consumeToken.mock.calls[0][0]).not.toHaveProperty('actor');
  });

  it('returns a pm_mock_* id + last4 from the consumed card', async () => {
    consumeToken.mockResolvedValue(freshConsume({ last4: '1111' }));

    const result = await provider.createPaymentMethod({
      retrievalToken: 'tok_abc',
      expectedAmount: 100,
      expectedCurrency: 'AUD',
    });

    expect(result.providerPaymentMethodId).toMatch(/^pm_mock_[a-z0-9]{24}$/);
    expect(result.last4).toBe('1111');
  });

  it('bubbles up a consume failure (no pm stored)', async () => {
    consumeToken.mockRejectedValue(new Error('token_expired'));

    await expect(
      provider.createPaymentMethod({
        retrievalToken: 'tok_bad',
        expectedAmount: 100,
        expectedCurrency: 'AUD',
      }),
    ).rejects.toThrow('token_expired');
  });
});

describe('MockProvider.charge', () => {
  let consumeToken: ReturnType<typeof vi.fn>;
  let provider: MockProvider;

  beforeEach(() => {
    consumeToken = vi.fn();
    provider = new MockProvider(makeVaultClient({ consumeToken }));
  });

  it('succeeds for a known pm id and returns txn_mock_* reference', async () => {
    consumeToken.mockResolvedValue(freshConsume());
    const pm = await provider.createPaymentMethod({
      retrievalToken: 'tok_abc',
      expectedAmount: 100,
      expectedCurrency: 'AUD',
    });

    const charge = await provider.charge({
      providerPaymentMethodId: pm.providerPaymentMethodId,
      amount: 100,
      currency: 'AUD',
      idempotencyKey: 'charge_txn_1',
      merchantRef: 'order_1',
    });

    expect(charge.status).toBe('succeeded');
    expect(charge.providerTxnId).toMatch(/^txn_mock_[a-z0-9]{24}$/);
    expect(charge.error).toBeUndefined();
  });

  it('fails fast for an unknown pm id', async () => {
    const charge = await provider.charge({
      providerPaymentMethodId: 'pm_mock_does_not_exist',
      amount: 100,
      currency: 'AUD',
      idempotencyKey: 'charge_txn_1',
      merchantRef: 'order_1',
    });

    expect(charge.status).toBe('failed');
    expect(charge.error).toBe('unknown_payment_method');
    expect(charge.providerTxnId).toBe('');
  });

  it('fails with simulated_failure_negative_amount for negative amounts', async () => {
    consumeToken.mockResolvedValue(freshConsume());
    const pm = await provider.createPaymentMethod({
      retrievalToken: 'tok_abc',
      expectedAmount: 100,
      expectedCurrency: 'AUD',
    });

    const charge = await provider.charge({
      providerPaymentMethodId: pm.providerPaymentMethodId,
      amount: -1,
      currency: 'AUD',
      idempotencyKey: 'charge_txn_1',
      merchantRef: 'order_1',
    });

    expect(charge.status).toBe('failed');
    expect(charge.error).toBe('simulated_failure_negative_amount');
  });

  it('two createPaymentMethod calls produce distinct pm ids', async () => {
    consumeToken.mockResolvedValue(freshConsume());
    const a = await provider.createPaymentMethod({
      retrievalToken: 'tok_a', expectedAmount: 100, expectedCurrency: 'AUD',
    });
    const b = await provider.createPaymentMethod({
      retrievalToken: 'tok_b', expectedAmount: 100, expectedCurrency: 'AUD',
    });
    expect(a.providerPaymentMethodId).not.toBe(b.providerPaymentMethodId);
  });
});
