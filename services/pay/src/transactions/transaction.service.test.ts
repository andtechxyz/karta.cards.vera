import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CardStatus, CredentialKind, Tier, TransactionStatus } from '@vera/db';

// Mock Prisma — the service is otherwise pure wiring around the card record
// resolver, tier-rule evaluator, and state-machine assertions (all three are
// run in real mode so we exercise the same happy-path logic the route does).
vi.mock('@vera/db', async (importActual) => {
  const actual = await importActual<typeof import('@vera/db')>();
  return {
    ...actual,
    prisma: {
      card: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      transaction: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
      },
    },
  };
});

import { prisma } from '@vera/db';
import {
  createTransaction,
  getTransactionByRlid,
  getTransactionForAuthOrThrow,
  reserveAtc,
  updateStatus,
} from './transaction.service.js';
type Mocked<T> = ReturnType<typeof vi.fn> & T;

function activatedCard(overrides: Partial<{ program: unknown; status: CardStatus; id: string }> = {}) {
  return {
    id: overrides.id ?? 'card_1',
    status: overrides.status ?? CardStatus.ACTIVATED,
    program: overrides.program ?? null,
  };
}

const txnFindUnique = () =>
  prisma.transaction.findUnique as unknown as Mocked<typeof prisma.transaction.findUnique>;
const txnFindUniqueOrThrow = () =>
  prisma.transaction.findUniqueOrThrow as unknown as Mocked<typeof prisma.transaction.findUniqueOrThrow>;
const txnCreate = () =>
  prisma.transaction.create as unknown as Mocked<typeof prisma.transaction.create>;
const txnUpdate = () =>
  prisma.transaction.update as unknown as Mocked<typeof prisma.transaction.update>;
const cardFindUnique = () =>
  prisma.card.findUnique as unknown as Mocked<typeof prisma.card.findUnique>;
const cardUpdate = () =>
  prisma.card.update as unknown as Mocked<typeof prisma.card.update>;

beforeEach(() => {
  vi.mocked(txnFindUnique()).mockReset();
  vi.mocked(txnFindUniqueOrThrow()).mockReset();
  vi.mocked(txnCreate()).mockReset().mockImplementation(async (args: unknown) => {
    const typed = args as { data: Record<string, unknown> };
    // Echo data back plus an id — enough for the service to return a "created".
    return { id: 'txn_new', ...typed.data } as never;
  });
  vi.mocked(txnUpdate()).mockReset();
  vi.mocked(cardFindUnique()).mockReset();
  vi.mocked(cardUpdate()).mockReset();
});

// --- createTransaction -------------------------------------------------------

describe('createTransaction', () => {
  it('rejects non-positive amount with 400 invalid_amount (no Prisma calls)', async () => {
    await expect(
      createTransaction({
        cardId: 'card_1',
        amount: 0,
        currency: 'AUD',
        merchantRef: 'order_1',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_amount' });
    expect(cardFindUnique()).not.toHaveBeenCalled();
  });

  it('rejects unknown card with 404 card_not_found', async () => {
    vi.mocked(cardFindUnique()).mockResolvedValue(null);

    await expect(
      createTransaction({
        cardId: 'card_missing',
        amount: 100,
        currency: 'AUD',
        merchantRef: 'order_1',
      }),
    ).rejects.toMatchObject({ status: 404, code: 'card_not_found' });
  });

  it('rejects non-ACTIVATED card with 400 card_not_activated', async () => {
    vi.mocked(cardFindUnique()).mockResolvedValue(
      activatedCard({ status: CardStatus.PERSONALISED }) as never,
    );

    await expect(
      createTransaction({
        cardId: 'card_1',
        amount: 100,
        currency: 'AUD',
        merchantRef: 'order_1',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'card_not_activated' });
  });

  it('rejects currency mismatch when the card program pins a different currency', async () => {
    vi.mocked(cardFindUnique()).mockResolvedValue(
      activatedCard({
        program: {
          id: 'prog_usd',
          currency: 'USD',
          tierRules: [
            { amountMinMinor: 0, amountMaxMinor: null, allowedKinds: [CredentialKind.PLATFORM] },
          ],
        },
      }) as never,
    );

    await expect(
      createTransaction({
        cardId: 'card_1',
        amount: 100,
        currency: 'AUD',
        merchantRef: 'order_1',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'currency_mismatch' });
  });

  it('creates a transaction with default rules + TIER_1 for a small AUD amount on an unlinked card', async () => {
    vi.mocked(cardFindUnique()).mockResolvedValue(activatedCard() as never);

    await createTransaction({
      cardId: 'card_1',
      amount: 4900, // under AUD 100 threshold
      currency: 'AUD',
      merchantRef: 'order_1',
      merchantName: 'Verdant Co.',
    });

    expect(txnCreate()).toHaveBeenCalledOnce();
    const data = vi.mocked(txnCreate()).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.cardId).toBe('card_1');
    expect(data.amount).toBe(4900);
    expect(data.currency).toBe('AUD');
    expect(data.merchantName).toBe('Verdant Co.');
    expect(data.status).toBe(TransactionStatus.PENDING);
    expect(data.tier).toBe(Tier.TIER_1);
    expect(data.allowedCredentialKinds).toEqual([CredentialKind.PLATFORM]);
    expect(typeof data.challengeNonce).toBe('string');
    expect((data.challengeNonce as string).length).toBeGreaterThan(10);
    // rlid should be 12 chars of the chosen alphabet.
    expect(typeof data.rlid).toBe('string');
    expect((data.rlid as string).length).toBe(12);
  });

  it('routes AUD 100+ to TIER_2 (CROSS_PLATFORM only) via DEFAULT_TIER_RULES', async () => {
    vi.mocked(cardFindUnique()).mockResolvedValue(activatedCard() as never);

    await createTransaction({
      cardId: 'card_1',
      amount: 15_000, // above AUD 100
      currency: 'AUD',
      merchantRef: 'order_big',
    });

    const data = vi.mocked(txnCreate()).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.tier).toBe(Tier.TIER_2);
    expect(data.allowedCredentialKinds).toEqual([CredentialKind.CROSS_PLATFORM]);
  });

  it('respects a program-specific rule set when the card is linked', async () => {
    vi.mocked(cardFindUnique()).mockResolvedValue(
      activatedCard({
        program: {
          id: 'prog_x',
          currency: 'AUD',
          tierRules: [
            // Everything in this program requires both kinds (TIER_3).
            { amountMinMinor: 0, amountMaxMinor: null, allowedKinds: [CredentialKind.PLATFORM, CredentialKind.CROSS_PLATFORM] },
          ],
        },
      }) as never,
    );

    await createTransaction({
      cardId: 'card_1',
      amount: 1,
      currency: 'AUD',
      merchantRef: 'order_1',
    });

    const data = vi.mocked(txnCreate()).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.tier).toBe(Tier.TIER_3);
    expect(data.allowedCredentialKinds).toEqual([CredentialKind.PLATFORM, CredentialKind.CROSS_PLATFORM]);
  });
});

// --- getTransactionByRlid ---------------------------------------------------

describe('getTransactionByRlid', () => {
  it('returns the row as-is when still within TTL', async () => {
    vi.mocked(txnFindUnique()).mockResolvedValue({
      id: 'txn_1',
      rlid: 'rl_1',
      status: TransactionStatus.PENDING,
      expiresAt: new Date(Date.now() + 10_000),
    } as never);

    const out = await getTransactionByRlid('rl_1');
    expect(out.status).toBe(TransactionStatus.PENDING);
    expect(txnUpdate()).not.toHaveBeenCalled();
  });

  it('opportunistically transitions PENDING past its TTL to EXPIRED', async () => {
    vi.mocked(txnFindUnique()).mockResolvedValue({
      id: 'txn_1',
      rlid: 'rl_1',
      status: TransactionStatus.PENDING,
      expiresAt: new Date(Date.now() - 1000),
    } as never);
    // updateStatus calls findUniqueOrThrow first, then update — stub both.
    vi.mocked(txnFindUniqueOrThrow()).mockResolvedValue({
      id: 'txn_1',
      status: TransactionStatus.PENDING,
    } as never);
    vi.mocked(txnUpdate()).mockResolvedValue({
      id: 'txn_1',
      status: TransactionStatus.EXPIRED,
    } as never);

    const out = await getTransactionByRlid('rl_1');
    expect(out.status).toBe(TransactionStatus.EXPIRED);
    expect(txnUpdate()).toHaveBeenCalledOnce();
    const updateData = vi.mocked(txnUpdate()).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(updateData.status).toBe(TransactionStatus.EXPIRED);
    expect(updateData.failureReason).toBe('transaction_ttl_elapsed');
  });

  it('does NOT transition non-PENDING rows past TTL (e.g. already COMPLETED)', async () => {
    vi.mocked(txnFindUnique()).mockResolvedValue({
      id: 'txn_1',
      rlid: 'rl_1',
      status: TransactionStatus.COMPLETED,
      expiresAt: new Date(Date.now() - 1000),
    } as never);

    const out = await getTransactionByRlid('rl_1');
    expect(out.status).toBe(TransactionStatus.COMPLETED);
    expect(txnUpdate()).not.toHaveBeenCalled();
  });

  it('throws 404 transaction_not_found when the rlid is unknown', async () => {
    vi.mocked(txnFindUnique()).mockResolvedValue(null);
    await expect(getTransactionByRlid('rl_missing')).rejects.toMatchObject({
      status: 404,
      code: 'transaction_not_found',
    });
  });
});

// --- updateStatus -----------------------------------------------------------

describe('updateStatus', () => {
  it('sets completedAt on COMPLETED', async () => {
    vi.mocked(txnFindUniqueOrThrow()).mockResolvedValue({
      id: 'txn_1',
      status: TransactionStatus.STRIPE_CHARGED,
    } as never);
    vi.mocked(txnUpdate()).mockResolvedValue({ id: 'txn_1' } as never);

    await updateStatus('txn_1', TransactionStatus.COMPLETED);

    const data = vi.mocked(txnUpdate()).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.status).toBe(TransactionStatus.COMPLETED);
    expect(data.completedAt).toBeInstanceOf(Date);
  });

  it('sets failedAt on FAILED', async () => {
    vi.mocked(txnFindUniqueOrThrow()).mockResolvedValue({
      id: 'txn_1',
      status: TransactionStatus.AUTHN_STARTED,
    } as never);
    vi.mocked(txnUpdate()).mockResolvedValue({ id: 'txn_1' } as never);

    await updateStatus('txn_1', TransactionStatus.FAILED, { failureReason: 'boom' });

    const data = vi.mocked(txnUpdate()).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.status).toBe(TransactionStatus.FAILED);
    expect(data.failureReason).toBe('boom');
    expect(data.failedAt).toBeInstanceOf(Date);
  });

  it('refuses an illegal transition via the state-machine (409)', async () => {
    vi.mocked(txnFindUniqueOrThrow()).mockResolvedValue({
      id: 'txn_1',
      status: TransactionStatus.PENDING,
    } as never);

    await expect(
      updateStatus('txn_1', TransactionStatus.COMPLETED),
    ).rejects.toMatchObject({ status: 409, code: 'illegal_transition' });
    expect(txnUpdate()).not.toHaveBeenCalled();
  });
});

// --- reserveAtc -------------------------------------------------------------

describe('reserveAtc', () => {
  it('increments and returns the new ATC', async () => {
    vi.mocked(cardUpdate()).mockResolvedValue({ atc: 7 } as never);

    const atc = await reserveAtc('card_1');
    expect(atc).toBe(7);

    const call = vi.mocked(cardUpdate()).mock.calls[0]![0]!;
    expect(call.where).toEqual({ id: 'card_1' });
    expect(call.data).toEqual({ atc: { increment: 1 } });
  });
});

// --- getTransactionForAuthOrThrow -------------------------------------------

describe('getTransactionForAuthOrThrow', () => {
  it('returns the row when PENDING and within TTL', async () => {
    vi.mocked(txnFindUnique()).mockResolvedValue({
      id: 'txn_1',
      rlid: 'rl_1',
      status: TransactionStatus.PENDING,
      expiresAt: new Date(Date.now() + 10_000),
    } as never);

    const out = await getTransactionForAuthOrThrow('rl_1');
    expect(out.status).toBe(TransactionStatus.PENDING);
  });

  it('throws 410 transaction_expired after TTL', async () => {
    vi.mocked(txnFindUnique()).mockResolvedValue({
      id: 'txn_1',
      rlid: 'rl_1',
      status: TransactionStatus.PENDING,
      expiresAt: new Date(Date.now() - 1000),
    } as never);
    vi.mocked(txnFindUniqueOrThrow()).mockResolvedValue({
      id: 'txn_1',
      status: TransactionStatus.PENDING,
    } as never);
    vi.mocked(txnUpdate()).mockResolvedValue({
      id: 'txn_1',
      status: TransactionStatus.EXPIRED,
    } as never);

    await expect(getTransactionForAuthOrThrow('rl_1')).rejects.toMatchObject({
      status: 410,
      code: 'transaction_expired',
    });
  });

  it('throws 400 transaction_terminal on COMPLETED', async () => {
    vi.mocked(txnFindUnique()).mockResolvedValue({
      id: 'txn_1',
      rlid: 'rl_1',
      status: TransactionStatus.COMPLETED,
      expiresAt: new Date(Date.now() + 10_000),
    } as never);

    await expect(getTransactionForAuthOrThrow('rl_1')).rejects.toMatchObject({
      status: 400,
      code: 'transaction_terminal',
    });
  });

  it('throws 400 transaction_terminal on FAILED', async () => {
    vi.mocked(txnFindUnique()).mockResolvedValue({
      id: 'txn_1',
      rlid: 'rl_1',
      status: TransactionStatus.FAILED,
      expiresAt: new Date(Date.now() + 10_000),
    } as never);

    await expect(getTransactionForAuthOrThrow('rl_1')).rejects.toMatchObject({
      status: 400,
      code: 'transaction_terminal',
    });
  });
});
