import { describe, it, expect } from 'vitest';
import { TransactionStatus } from '@prisma/client';
import { assertTransition, canTransition, isTerminal } from './state-machine.js';
import { ApiError } from '../middleware/error.js';

// The state machine is small and pure — we test the whole transition table
// rather than a representative slice so a future status addition (e.g. a
// REFUNDED branch) fails loudly here instead of silently widening the graph.

const STATES: readonly TransactionStatus[] = Object.values(TransactionStatus);

const HAPPY_PATH: readonly TransactionStatus[] = [
  TransactionStatus.PENDING,
  TransactionStatus.AUTHN_STARTED,
  TransactionStatus.AUTHN_COMPLETE,
  TransactionStatus.ARQC_VALID,
  TransactionStatus.VAULT_RETRIEVED,
  TransactionStatus.STRIPE_CHARGED,
  TransactionStatus.COMPLETED,
];

const TERMINAL: readonly TransactionStatus[] = [
  TransactionStatus.COMPLETED,
  TransactionStatus.FAILED,
  TransactionStatus.EXPIRED,
];

describe('isTerminal', () => {
  it('returns true for exactly COMPLETED / FAILED / EXPIRED', () => {
    for (const s of STATES) {
      expect(isTerminal(s)).toBe(TERMINAL.includes(s));
    }
  });
});

describe('canTransition — happy path', () => {
  it('allows each sequential step on the happy path', () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
      expect(canTransition(HAPPY_PATH[i], HAPPY_PATH[i + 1])).toBe(true);
    }
  });
});

describe('canTransition — FAILED branch', () => {
  // Every non-terminal state must be able to transition to FAILED so
  // orchestration can bail at any point.
  const NON_TERMINAL = STATES.filter((s) => !TERMINAL.includes(s));

  it('every non-terminal state can transition to FAILED', () => {
    for (const s of NON_TERMINAL) {
      expect(canTransition(s, TransactionStatus.FAILED)).toBe(true);
    }
  });

  // STRIPE_CHARGED is special: the charge succeeded but something after (e.g.
  // the final DB write) failed.  FAILED is still allowed — EXPIRED is not,
  // because a successful charge can't be silently aged out.
  it('STRIPE_CHARGED cannot transition to EXPIRED', () => {
    expect(canTransition(TransactionStatus.STRIPE_CHARGED, TransactionStatus.EXPIRED)).toBe(false);
  });
});

describe('canTransition — EXPIRED branch', () => {
  it('PENDING through VAULT_RETRIEVED can transition to EXPIRED', () => {
    for (const s of [
      TransactionStatus.PENDING,
      TransactionStatus.AUTHN_STARTED,
      TransactionStatus.AUTHN_COMPLETE,
      TransactionStatus.ARQC_VALID,
      TransactionStatus.VAULT_RETRIEVED,
    ]) {
      expect(canTransition(s, TransactionStatus.EXPIRED)).toBe(true);
    }
  });
});

describe('canTransition — terminal states are sinks', () => {
  it('no transition out of any terminal state', () => {
    for (const from of TERMINAL) {
      for (const to of STATES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });
});

describe('canTransition — skipping steps is forbidden', () => {
  it('PENDING cannot jump to COMPLETED', () => {
    expect(canTransition(TransactionStatus.PENDING, TransactionStatus.COMPLETED)).toBe(false);
  });

  it('AUTHN_COMPLETE cannot skip to STRIPE_CHARGED', () => {
    expect(
      canTransition(TransactionStatus.AUTHN_COMPLETE, TransactionStatus.STRIPE_CHARGED),
    ).toBe(false);
  });

  it('cannot loop back (VAULT_RETRIEVED → PENDING)', () => {
    expect(canTransition(TransactionStatus.VAULT_RETRIEVED, TransactionStatus.PENDING)).toBe(false);
  });
});

describe('assertTransition', () => {
  it('returns void on legal transition', () => {
    expect(() => assertTransition(TransactionStatus.PENDING, TransactionStatus.AUTHN_STARTED)).not.toThrow();
  });

  it('throws 409 illegal_transition on illegal transition', () => {
    let caught: unknown;
    try {
      assertTransition(TransactionStatus.COMPLETED, TransactionStatus.FAILED);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(409);
    expect(err.code).toBe('illegal_transition');
    expect(err.message).toContain('COMPLETED');
    expect(err.message).toContain('FAILED');
  });
});
