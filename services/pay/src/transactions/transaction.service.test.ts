import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CredentialKind, Tier, TransactionStatus } from '@vera/db';

// Mock Prisma — the service is otherwise pure wiring around the card record
// resolver, tier-rule evaluator, and state-machine assertions (all three are
// run in real mode so we exercise the same happy-path logic the route does).
vi.mock('@vera/db', async (importActual) => {
  const actual = await importActual<typeof import('@vera/db')>();
  return {
    ...actual,
    prisma: {
      tokenisationProgram: {
        findUnique: vi.fn(),
      },
      transaction: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    },
  };
});

// Card state, ATC, and credentials now come over HTTP from Palisade — mock
// the palisade-client module instead of prisma.card.*.  Shapes match the
// contracts in cards/palisade-client.ts.
vi.mock('../cards/index.js', () => ({
  lookupCard: vi.fn(),
  incrementAtc: vi.fn(),
  listWebAuthnCredentials: vi.fn(),
}));

import { prisma } from '@vera/db';
import {
  createTransaction,
  getTransactionByRlid,
  getTransactionCardSummary,
  getTransactionForAuthOrThrow,
  listTransactions,
  reserveAtc,
  updateStatus,
} from './transaction.service.js';
import { incrementAtc, listWebAuthnCredentials, lookupCard } from '../cards/index.js';
type Mocked<T> = ReturnType<typeof vi.fn> & T;

function activatedCard(
  overrides: Partial<{ programId: string | null; status: string; id: string; vaultToken: string | null }> = {},
) {
  return {
    id: overrides.id ?? 'card_1',
    cardRef: `cardref_${overrides.id ?? 'card_1'}`,
    status: overrides.status ?? 'ACTIVATED',
    programId: overrides.programId ?? null,
    retailSaleStatus: null,
    chipSerial: null,
    panLast4: '4242',
    panBin: '411111',
    cardholderName: 'Test User',
    vaultToken: overrides.vaultToken ?? null,
  };
}

const txnFindUnique = () =>
  prisma.transaction.findUnique as unknown as Mocked<typeof prisma.transaction.findUnique>;
const txnFindUniqueOrThrow = () =>
  prisma.transaction.findUniqueOrThrow as unknown as Mocked<typeof prisma.transaction.findUniqueOrThrow>;
const txnFindMany = () =>
  prisma.transaction.findMany as unknown as Mocked<typeof prisma.transaction.findMany>;
const txnCreate = () =>
  prisma.transaction.create as unknown as Mocked<typeof prisma.transaction.create>;
const txnUpdate = () =>
  prisma.transaction.update as unknown as Mocked<typeof prisma.transaction.update>;
const txnUpdateMany = () =>
  prisma.transaction.updateMany as unknown as Mocked<typeof prisma.transaction.updateMany>;
const lookupCardMock = () => lookupCard as unknown as Mocked<typeof lookupCard>;
const incrementAtcMock = () => incrementAtc as unknown as Mocked<typeof incrementAtc>;
const listCredsMock = () =>
  listWebAuthnCredentials as unknown as Mocked<typeof listWebAuthnCredentials>;
const tokenisationProgramFindUnique = () =>
  prisma.tokenisationProgram.findUnique as unknown as Mocked<typeof prisma.tokenisationProgram.findUnique>;

beforeEach(() => {
  vi.mocked(txnFindUnique()).mockReset();
  vi.mocked(txnFindUniqueOrThrow()).mockReset();
  vi.mocked(txnFindMany()).mockReset();
  vi.mocked(txnCreate()).mockReset().mockImplementation(async (args: unknown) => {
    const typed = args as { data: Record<string, unknown> };
    // Echo data back plus an id — enough for the service to return a "created".
    return { id: 'txn_new', ...typed.data } as never;
  });
  vi.mocked(txnUpdate()).mockReset();
  vi.mocked(txnUpdateMany()).mockReset().mockResolvedValue({ count: 1 } as never);
  vi.mocked(lookupCardMock()).mockReset();
  vi.mocked(incrementAtcMock()).mockReset();
  vi.mocked(listCredsMock()).mockReset();
  vi.mocked(tokenisationProgramFindUnique()).mockReset().mockResolvedValue(null);
});

// --- createTransaction -------------------------------------------------------

describe('createTransaction', () => {
  it('rejects non-positive amount with 400 invalid_amount (no Palisade call)', async () => {
    await expect(
      createTransaction({
        cardId: 'card_1',
        amount: 0,
        currency: 'AUD',
        merchantRef: 'order_1',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_amount' });
    expect(lookupCardMock()).not.toHaveBeenCalled();
  });

  it('rejects unknown card with 404 card_not_found (propagated from Palisade)', async () => {
    // Real lookupCard maps Palisade's 404 to a notFound ApiError — simulate that.
    const notFoundErr = Object.assign(new Error('Card not found in Palisade'), {
      status: 404,
      code: 'card_not_found',
    });
    vi.mocked(lookupCardMock()).mockRejectedValue(notFoundErr);

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
    vi.mocked(lookupCardMock()).mockResolvedValue(
      activatedCard({ status: 'PERSONALISED' }) as never,
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
    vi.mocked(lookupCardMock()).mockResolvedValue(
      activatedCard({ programId: 'prog_usd' }) as never,
    );
    vi.mocked(tokenisationProgramFindUnique()).mockResolvedValue({
      id: 'prog_usd',
      currency: 'USD',
      tierRules: [
        { amountMinMinor: 0, amountMaxMinor: null, allowedKinds: [CredentialKind.PLATFORM] },
      ],
    } as never);

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
    vi.mocked(lookupCardMock()).mockResolvedValue(
      { ...activatedCard(), vaultToken: 've_1' } as never,
    );

    await createTransaction({
      cardId: 'card_1',
      amount: 4900, // under AUD 100 threshold
      currency: 'AUD',
      merchantRef: 'order_1',
      merchantName: 'Verdant Co.',
    });

    // Verify we called Palisade with the right auth parameters.
    expect(lookupCardMock()).toHaveBeenCalledOnce();
    const [cardId, opts] = vi.mocked(lookupCardMock()).mock.calls[0]!;
    expect(cardId).toBe('card_1');
    expect(opts.keyId).toBe('pay');
    expect(opts.baseUrl).toBeTruthy();
    expect(opts.secret).toMatch(/^[0-9a-f]{64}$/);

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

    // Denormalised card display fields are stamped from the Palisade lookup.
    expect(data.cardRef).toBe('cardref_card_1');
    expect(data.panLast4).toBe('4242');
    expect(data.panBin).toBe('411111');
    expect(data.cardholderName).toBe('Test User');
    // vaultEntryId is stamped from Palisade lookupCard's vaultToken
    // response field (opaque Vera VaultEntry id).
    expect(data.vaultEntryId).toBe('ve_1');
  });

  it('stamps null display fields when Palisade projection has nulls', async () => {
    vi.mocked(lookupCardMock()).mockResolvedValue({
      ...activatedCard(),
      panLast4: null,
      panBin: null,
      cardholderName: null,
    } as never);

    await createTransaction({
      cardId: 'card_1',
      amount: 100,
      currency: 'AUD',
      merchantRef: 'order_1',
    });

    const data = vi.mocked(txnCreate()).mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.panLast4).toBeNull();
    expect(data.panBin).toBeNull();
    expect(data.cardholderName).toBeNull();
    // Un-vaulted dev card → vaultEntryId stays null on the row.
    expect(data.vaultEntryId).toBeNull();
  });

  it('routes AUD 100+ to TIER_2 (CROSS_PLATFORM only) via DEFAULT_TIER_RULES', async () => {
    vi.mocked(lookupCardMock()).mockResolvedValue(activatedCard() as never);

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
    vi.mocked(lookupCardMock()).mockResolvedValue(
      activatedCard({ programId: 'prog_x' }) as never,
    );
    vi.mocked(tokenisationProgramFindUnique()).mockResolvedValue({
      id: 'prog_x',
      currency: 'AUD',
      tierRules: [
        // Everything in this program requires both kinds (TIER_3).
        { amountMinMinor: 0, amountMaxMinor: null, allowedKinds: [CredentialKind.PLATFORM, CredentialKind.CROSS_PLATFORM] },
      ],
    } as never);

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
    vi.mocked(txnFindUniqueOrThrow()).mockResolvedValue({
      id: 'txn_1',
      status: TransactionStatus.EXPIRED,
    } as never);

    const out = await getTransactionByRlid('rl_1');
    expect(out.status).toBe(TransactionStatus.EXPIRED);
    expect(txnUpdateMany()).toHaveBeenCalledOnce();
    const call = vi.mocked(txnUpdateMany()).mock.calls[0]![0]!;
    expect(call.where).toEqual({ id: 'txn_1', status: TransactionStatus.PENDING });
    const data = call.data as Record<string, unknown>;
    expect(data.status).toBe(TransactionStatus.EXPIRED);
    expect(data.failureReason).toBe('transaction_ttl_elapsed');
  });

  it('is race-safe against the bulk sweep — a count=0 updateMany just re-reads', async () => {
    vi.mocked(txnFindUnique()).mockResolvedValue({
      id: 'txn_1',
      rlid: 'rl_1',
      status: TransactionStatus.PENDING,
      expiresAt: new Date(Date.now() - 1000),
    } as never);
    // Sweep won: updateMany affected 0 rows because the status is already EXPIRED.
    vi.mocked(txnUpdateMany()).mockResolvedValue({ count: 0 } as never);
    vi.mocked(txnFindUniqueOrThrow()).mockResolvedValue({
      id: 'txn_1',
      status: TransactionStatus.EXPIRED,
    } as never);

    const out = await getTransactionByRlid('rl_1');
    expect(out.status).toBe(TransactionStatus.EXPIRED);
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
  it('PATCHes Palisade atc-increment and returns the new ATC', async () => {
    vi.mocked(incrementAtcMock()).mockResolvedValue({ atc: 7 } as never);

    const atc = await reserveAtc('card_1');
    expect(atc).toBe(7);

    expect(incrementAtcMock()).toHaveBeenCalledOnce();
    const [cardId, opts] = vi.mocked(incrementAtcMock()).mock.calls[0]!;
    expect(cardId).toBe('card_1');
    expect(opts.keyId).toBe('pay');
  });
});

// --- listTransactions -------------------------------------------------------

describe('listTransactions', () => {
  it('reads rows with no Card join — denormalised display fields live on Transaction', async () => {
    vi.mocked(txnFindMany()).mockResolvedValue([
      {
        id: 'txn_1',
        cardRef: 'cardref_card_1',
        panLast4: '4242',
      },
    ] as never);

    const rows = await listTransactions();
    expect(rows).toHaveLength(1);

    // Critical: no `include.card` — the query must be a single-table read.
    const call = vi.mocked(txnFindMany()).mock.calls[0]![0]!;
    expect(call).not.toHaveProperty('include');
    expect(call.orderBy).toEqual({ createdAt: 'desc' });
    expect(call.take).toBe(100);
  });

  it('clamps limit at 500', async () => {
    vi.mocked(txnFindMany()).mockResolvedValue([] as never);
    await listTransactions(10_000);
    const call = vi.mocked(txnFindMany()).mock.calls[0]![0]!;
    expect(call.take).toBe(500);
  });
});

// --- getTransactionCardSummary ----------------------------------------------

describe('getTransactionCardSummary', () => {
  it('reads denormalised panLast4 off Transaction and fetches creds from Palisade', async () => {
    vi.mocked(txnFindUnique()).mockResolvedValue({
      cardId: 'card_1',
      panLast4: '4242',
    } as never);
    vi.mocked(listCredsMock()).mockResolvedValue([
      { kind: 'PLATFORM' },
      { kind: 'CROSS_PLATFORM' },
    ] as never);

    const out = await getTransactionCardSummary('rl_1');

    expect(out).toEqual({
      id: 'card_1',
      panLast4: '4242',
      credentials: [{ kind: 'PLATFORM' }, { kind: 'CROSS_PLATFORM' }],
    });

    expect(listCredsMock()).toHaveBeenCalledWith('card_1', expect.any(Object));
  });

  it('returns null panLast4 when the denorm field is null', async () => {
    vi.mocked(txnFindUnique()).mockResolvedValue({
      cardId: 'card_1',
      panLast4: null,
    } as never);
    vi.mocked(listCredsMock()).mockResolvedValue([] as never);

    const out = await getTransactionCardSummary('rl_1');
    expect(out.panLast4).toBeNull();
    expect(out.credentials).toEqual([]);
  });

  it('throws 404 transaction_not_found when the rlid is unknown', async () => {
    vi.mocked(txnFindUnique()).mockResolvedValue(null);

    await expect(getTransactionCardSummary('rl_missing')).rejects.toMatchObject({
      status: 404,
      code: 'transaction_not_found',
    });
    // No Palisade call when there's no row to locate a cardId on.
    expect(listCredsMock()).not.toHaveBeenCalled();
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
