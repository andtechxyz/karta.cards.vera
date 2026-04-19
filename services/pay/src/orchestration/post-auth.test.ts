import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransactionStatus } from '@vera/db';

// The orchestration pipeline touches prisma, every transactional helper, the
// vault, and a provider adapter.  We mock every module boundary so the test
// is pure — this is the "riskiest single function" per the build plan, so we
// assert the shape of every outbound call as well as the return/throw behaviour.
//
// ARQC is intentionally NOT mocked — it's a pure HKDF + HMAC helper keyed off
// VERA_ROOT_ARQC_SEED (set in tests/setup.ts), so running the real thing is
// both cheap and more realistic than a stub that would need to know the
// internal input shape.

// vi.hoisted ensures mintTokenMock is available when the vi.mock factory runs
// (vi.mock calls are hoisted above imports by vitest's transform).
const { mintTokenMock } = vi.hoisted(() => ({ mintTokenMock: vi.fn() }));

vi.mock('@vera/db', async (importActual) => {
  const actual = await importActual<typeof import('@vera/db')>();
  return {
    ...actual,
    prisma: {
      transaction: {
        findUniqueOrThrow: vi.fn(),
      },
    },
  };
});

vi.mock('../transactions/index.js', () => ({
  updateStatus: vi.fn(),
  reserveAtc: vi.fn(),
}));

// The new post-auth.ts calls createVaultClient(url) and then vaultClient.mintToken().
// We mock the whole module and return a stub client with a spy mintToken.
vi.mock('@vera/vault-client', () => ({
  createVaultClient: vi.fn(() => ({
    mintToken: mintTokenMock,
    consumeToken: vi.fn(),
    proxy: vi.fn(),
  })),
}));

vi.mock('../providers/index.js', () => ({
  getPaymentProvider: vi.fn(),
}));

vi.mock('../realtime/index.js', () => ({
  publish: vi.fn(),
  sseBus: { forget: vi.fn() },
}));

import { orchestratePostAuth } from './post-auth.js';
import { prisma } from '@vera/db';
import { updateStatus, reserveAtc } from '../transactions/index.js';
import { getPaymentProvider } from '../providers/index.js';
import { publish, sseBus } from '../realtime/index.js';
import { ApiError } from '@vera/core';

type TxnFindMock = ReturnType<typeof vi.fn>;

// Single accessor for the deeply-nested mock — cast once, reuse everywhere.
const findTxn = () =>
  vi.mocked((prisma.transaction as unknown as { findUniqueOrThrow: TxnFindMock }).findUniqueOrThrow);

interface BuildTxnOverrides {
  vaultEntryId?: string | null;
  panBin?: string | null;
}

/**
 * Transaction row as it now appears post-denorm: all the fields the
 * orchestration reads live directly on the Transaction row.  No more
 * `card.vaultEntry` join — see transaction.service.ts::createTransaction
 * for the stamp site.
 */
function buildTxn(overrides: BuildTxnOverrides = {}) {
  return {
    id: 'txn_1',
    rlid: 'rl_happy',
    cardId: 'card_1',
    amount: 4900,
    currency: 'AUD',
    merchantRef: 'order_1',
    challengeNonce: 'challenge_bytes_base64url',
    tier: 'TIER_1',
    vaultEntryId:
      overrides.vaultEntryId === undefined ? 've_1' : overrides.vaultEntryId,
    panBin: overrides.panBin === undefined ? '424242' : overrides.panBin,
  };
}

function buildProvider(behaviour: {
  createPaymentMethod?: () => Promise<{ providerPaymentMethodId: string; last4: string }>;
  charge?: () => Promise<{ providerTxnId: string; status: 'succeeded' | 'failed'; error?: string }>;
} = {}) {
  return {
    name: 'mock',
    createPaymentMethod:
      behaviour.createPaymentMethod ??
      vi.fn().mockResolvedValue({ providerPaymentMethodId: 'pm_mock_xyz', last4: '4242' }),
    charge:
      behaviour.charge ??
      vi.fn().mockResolvedValue({ providerTxnId: 'txn_mock_xyz', status: 'succeeded' }),
  };
}

beforeEach(() => {
  findTxn().mockReset();
  vi.mocked(updateStatus)
    .mockReset()
    // Mirror the real updateStatus shape enough for callers that read .status
    // off the return value (the terminal COMPLETED transition does).
    .mockImplementation(async (_id, to) => ({ status: to } as never));
  vi.mocked(reserveAtc).mockReset().mockResolvedValue(1);
  mintTokenMock.mockReset().mockResolvedValue({
    token: 'rtok_mock',
    retrievalTokenId: 'rtok_id_1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  vi.mocked(getPaymentProvider).mockReset();
  vi.mocked(publish).mockReset();
  vi.mocked(sseBus.forget).mockReset();
});

describe('orchestratePostAuth — happy path', () => {
  it('walks the full pipeline and returns COMPLETED', async () => {
    findTxn()
      .mockResolvedValue(buildTxn());
    const provider = buildProvider();
    vi.mocked(getPaymentProvider).mockReturnValue(provider);

    const result = await orchestratePostAuth({
      transactionId: 'txn_1',
      usedCredentialId: 'cred_1',
    });

    expect(result.status).toBe(TransactionStatus.COMPLETED);
    expect(result.rlid).toBe('rl_happy');
    expect(result.providerName).toBe('mock');
    expect(result.providerTxnId).toBe('txn_mock_xyz');
    expect(result.last4).toBe('4242');
  });

  it('publishes events in the expected order', async () => {
    findTxn()
      .mockResolvedValue(buildTxn());
    vi.mocked(getPaymentProvider).mockReturnValue(buildProvider());

    await orchestratePostAuth({ transactionId: 'txn_1', usedCredentialId: 'cred_1' });

    const order = vi.mocked(publish).mock.calls.map((c) => c[1]);
    expect(order).toEqual([
      'authn_started',
      'authn_complete',
      'arqc_valid',
      'vault_retrieved',
      'provider_tokenised',
      'charged',
      'completed',
    ]);
  });

  it('advances status through every step in order', async () => {
    findTxn()
      .mockResolvedValue(buildTxn());
    vi.mocked(getPaymentProvider).mockReturnValue(buildProvider());

    await orchestratePostAuth({ transactionId: 'txn_1', usedCredentialId: 'cred_1' });

    const statuses = vi.mocked(updateStatus).mock.calls.map((c) => c[1]);
    expect(statuses).toEqual([
      TransactionStatus.AUTHN_STARTED,
      TransactionStatus.AUTHN_COMPLETE,
      TransactionStatus.ARQC_VALID,
      TransactionStatus.VAULT_RETRIEVED,
      TransactionStatus.STRIPE_CHARGED,
      TransactionStatus.COMPLETED,
    ]);
  });

  it('calls provider.charge with an idempotency key derived from txn.id', async () => {
    findTxn()
      .mockResolvedValue(buildTxn());
    const provider = buildProvider();
    vi.mocked(getPaymentProvider).mockReturnValue(provider);

    await orchestratePostAuth({ transactionId: 'txn_1', usedCredentialId: 'cred_1' });

    expect(provider.charge).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'charge_txn_1',
        amount: 4900,
        currency: 'AUD',
        merchantRef: 'order_1',
      }),
    );
  });

  it('persists arqc + atcUsed on the ARQC_VALID transition', async () => {
    findTxn()
      .mockResolvedValue(buildTxn());
    vi.mocked(reserveAtc).mockResolvedValue(42);
    vi.mocked(getPaymentProvider).mockReturnValue(buildProvider());

    await orchestratePostAuth({ transactionId: 'txn_1', usedCredentialId: 'cred_1' });

    const arqcCall = vi.mocked(updateStatus).mock.calls.find(
      (c) => c[1] === TransactionStatus.ARQC_VALID,
    );
    expect(arqcCall).toBeDefined();
    expect(arqcCall![2]).toMatchObject({ atcUsed: 42 });
    expect(typeof (arqcCall![2] as { arqc: string }).arqc).toBe('string');
  });

  it('drops SSE history on completion so a late subscriber sees no replay', async () => {
    findTxn()
      .mockResolvedValue(buildTxn());
    vi.mocked(getPaymentProvider).mockReturnValue(buildProvider());

    await orchestratePostAuth({ transactionId: 'txn_1', usedCredentialId: 'cred_1' });

    expect(sseBus.forget).toHaveBeenCalledWith('rl_happy');
  });
});

describe('orchestratePostAuth — failure branches', () => {
  it('throws 400 card_not_vaulted and publishes failed when card has no vault entry', async () => {
    findTxn()
      .mockResolvedValue(buildTxn({ vaultEntryId: null, panBin: null }));

    await expect(
      orchestratePostAuth({ transactionId: 'txn_1', usedCredentialId: 'cred_1' }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      code: 'card_not_vaulted',
    });

    expect(publish).toHaveBeenCalledWith(
      'rl_happy',
      'failed',
      expect.objectContaining({ reason: 'card_not_vaulted' }),
    );
    expect(sseBus.forget).toHaveBeenCalledWith('rl_happy');
    // Never advanced past the initial guard.
    expect(updateStatus).toHaveBeenCalledWith('txn_1', TransactionStatus.FAILED, expect.anything());
    expect(updateStatus).not.toHaveBeenCalledWith('txn_1', TransactionStatus.AUTHN_STARTED, expect.anything());
  });

  it('returns FAILED (does not throw) when provider.charge returns status=failed', async () => {
    findTxn()
      .mockResolvedValue(buildTxn());
    const provider = buildProvider({
      charge: vi.fn().mockResolvedValue({
        providerTxnId: '',
        status: 'failed',
        error: 'card_declined',
      }),
    });
    vi.mocked(getPaymentProvider).mockReturnValue(provider);

    const result = await orchestratePostAuth({
      transactionId: 'txn_1',
      usedCredentialId: 'cred_1',
    });

    expect(result.status).toBe(TransactionStatus.FAILED);
    expect(result.providerName).toBe('mock');
    expect(result.last4).toBe('4242');

    expect(publish).toHaveBeenCalledWith(
      'rl_happy',
      'failed',
      expect.objectContaining({
        reason: expect.stringContaining('provider_charge_failed'),
      }),
    );
    // completed was never published.
    const evts = vi.mocked(publish).mock.calls.map((c) => c[1]);
    expect(evts).not.toContain('completed');
  });

  it('marks FAILED and re-throws when provider.createPaymentMethod throws', async () => {
    findTxn()
      .mockResolvedValue(buildTxn());
    const provider = buildProvider({
      createPaymentMethod: vi.fn().mockRejectedValue(new Error('token_already_used')),
    });
    vi.mocked(getPaymentProvider).mockReturnValue(provider);

    await expect(
      orchestratePostAuth({ transactionId: 'txn_1', usedCredentialId: 'cred_1' }),
    ).rejects.toThrow('token_already_used');

    expect(publish).toHaveBeenCalledWith(
      'rl_happy',
      'failed',
      expect.objectContaining({ reason: 'token_already_used' }),
    );
    expect(sseBus.forget).toHaveBeenCalledWith('rl_happy');
    // Never reached the vault_retrieved step.
    const evts = vi.mocked(publish).mock.calls.map((c) => c[1]);
    expect(evts).not.toContain('vault_retrieved');
  });

  it('marks FAILED and re-throws when mintToken throws', async () => {
    findTxn()
      .mockResolvedValue(buildTxn());
    mintTokenMock.mockRejectedValue(new Error('vault_entry_not_found'));
    vi.mocked(getPaymentProvider).mockReturnValue(buildProvider());

    await expect(
      orchestratePostAuth({ transactionId: 'txn_1', usedCredentialId: 'cred_1' }),
    ).rejects.toThrow('vault_entry_not_found');

    const evts = vi.mocked(publish).mock.calls.map((c) => c[1]);
    expect(evts).toContain('arqc_valid');
    expect(evts).toContain('failed');
    expect(evts).not.toContain('vault_retrieved');
  });

  it('swallows secondary FAILED update if the transaction is already terminal', async () => {
    findTxn()
      .mockResolvedValue(buildTxn());
    // provider.charge throws → orchestration tries to mark FAILED, and the
    // state-machine guard in the real updateStatus would refuse.  Simulate
    // that refusal and confirm orchestration doesn't surface it.
    vi.mocked(updateStatus).mockImplementation(async (_id, to) => {
      if (to === TransactionStatus.FAILED) {
        throw new ApiError(409, 'illegal_transition', 'already terminal');
      }
      return { status: to } as never;
    });
    const provider = buildProvider({
      charge: vi.fn().mockRejectedValue(new Error('network_timeout')),
    });
    vi.mocked(getPaymentProvider).mockReturnValue(provider);

    await expect(
      orchestratePostAuth({ transactionId: 'txn_1', usedCredentialId: 'cred_1' }),
    ).rejects.toThrow('network_timeout');

    // Still published the failed event even though the DB transition was refused.
    expect(publish).toHaveBeenCalledWith(
      'rl_happy',
      'failed',
      expect.objectContaining({ reason: 'network_timeout' }),
    );
  });
});
