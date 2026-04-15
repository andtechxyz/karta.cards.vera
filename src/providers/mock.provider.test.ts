import { describe, it, expect, vi, beforeEach } from 'vitest';

// The mock provider's only external dependency is the vault barrel (for
// consumeRetrievalToken and vaultEvents).  Stub that and we get a fully
// pure unit test — no Prisma, no DB.
vi.mock('../vault/index.js', () => ({
  consumeRetrievalToken: vi.fn(),
  vaultEvents: { emit: vi.fn() },
}));

import { MockProvider } from './mock.provider.js';
import { consumeRetrievalToken, vaultEvents } from '../vault/index.js';

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
  beforeEach(() => {
    vi.mocked(consumeRetrievalToken).mockReset();
    vi.mocked(vaultEvents.emit).mockReset();
  });

  it('consumes the retrieval token with the expected amount/currency + actor', async () => {
    vi.mocked(consumeRetrievalToken).mockResolvedValue(freshConsume());
    const p = new MockProvider();

    await p.createPaymentMethod({
      retrievalToken: 'tok_abc',
      expectedAmount: 4900,
      expectedCurrency: 'AUD',
      actor: 'transaction:rl_x',
      transactionId: 'txn_x',
    });

    expect(consumeRetrievalToken).toHaveBeenCalledWith(
      'tok_abc',
      expect.objectContaining({
        expectedAmount: 4900,
        expectedCurrency: 'AUD',
        actor: 'transaction:rl_x',
        purpose: 'mock provider tokenise',
        transactionId: 'txn_x',
      }),
    );
  });

  it('returns a pm_mock_* id + last4 from the consumed card', async () => {
    vi.mocked(consumeRetrievalToken).mockResolvedValue(freshConsume({ last4: '1111' }));
    const p = new MockProvider();

    const result = await p.createPaymentMethod({
      retrievalToken: 'tok_abc',
      expectedAmount: 100,
      expectedCurrency: 'AUD',
      actor: 'test',
    });

    expect(result.providerPaymentMethodId).toMatch(/^pm_mock_[a-z0-9]{24}$/);
    expect(result.last4).toBe('1111');
  });

  it('emits a PROVIDER_TOKENISED vault event with the adapter name', async () => {
    vi.mocked(consumeRetrievalToken).mockResolvedValue(
      freshConsume({ vaultEntryId: 've_42', retrievalTokenId: 'rtok_42' }),
    );
    const p = new MockProvider();

    await p.createPaymentMethod({
      retrievalToken: 'tok_abc',
      expectedAmount: 100,
      expectedCurrency: 'AUD',
      actor: 'transaction:rl_y',
      transactionId: 'txn_y',
    });

    expect(vaultEvents.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PROVIDER_TOKENISED',
        vaultEntryId: 've_42',
        retrievalTokenId: 'rtok_42',
        providerName: 'mock',
        transactionId: 'txn_y',
        success: true,
      }),
    );
  });

  it('bubbles up a consume failure (no pm stored, no event)', async () => {
    vi.mocked(consumeRetrievalToken).mockRejectedValue(new Error('token_expired'));
    const p = new MockProvider();

    await expect(
      p.createPaymentMethod({
        retrievalToken: 'tok_bad',
        expectedAmount: 100,
        expectedCurrency: 'AUD',
        actor: 'test',
      }),
    ).rejects.toThrow('token_expired');

    expect(vaultEvents.emit).not.toHaveBeenCalled();
  });
});

describe('MockProvider.charge', () => {
  beforeEach(() => {
    vi.mocked(consumeRetrievalToken).mockReset();
    vi.mocked(vaultEvents.emit).mockReset();
  });

  it('succeeds for a known pm id and returns txn_mock_* reference', async () => {
    vi.mocked(consumeRetrievalToken).mockResolvedValue(freshConsume());
    const p = new MockProvider();
    const pm = await p.createPaymentMethod({
      retrievalToken: 'tok_abc',
      expectedAmount: 100,
      expectedCurrency: 'AUD',
      actor: 'test',
    });

    const charge = await p.charge({
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
    const p = new MockProvider();
    const charge = await p.charge({
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
    vi.mocked(consumeRetrievalToken).mockResolvedValue(freshConsume());
    const p = new MockProvider();
    const pm = await p.createPaymentMethod({
      retrievalToken: 'tok_abc',
      expectedAmount: 100,
      expectedCurrency: 'AUD',
      actor: 'test',
    });

    const charge = await p.charge({
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
    vi.mocked(consumeRetrievalToken).mockResolvedValue(freshConsume());
    const p = new MockProvider();
    const a = await p.createPaymentMethod({
      retrievalToken: 'tok_a', expectedAmount: 100, expectedCurrency: 'AUD', actor: 't',
    });
    const b = await p.createPaymentMethod({
      retrievalToken: 'tok_b', expectedAmount: 100, expectedCurrency: 'AUD', actor: 't',
    });
    expect(a.providerPaymentMethodId).not.toBe(b.providerPaymentMethodId);
  });
});
